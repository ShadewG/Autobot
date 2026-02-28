#!/usr/bin/env node
/**
 * Phone Call Queue E2E Test
 *
 * End-to-end test that:
 * 1. Connects to Railway DB via DATABASE_URL from .env
 * 2. Finds cases associated with "Samuel Hylton" (tries multiple fields/patterns)
 * 3. Picks 3 that are NOT already in phone_call_queue
 * 4. For each case, exercises the full phone call queue flow via supertest:
 *    - Creates a phone_call_queue entry via the DB service
 *    - Tests GET /api/phone-calls
 *    - Claims via POST /api/phone-calls/:id/claim
 *    - Completes via POST /api/phone-calls/:id/complete (varied outcomes)
 *    - Verifies final state
 * 5. Prints a detailed report
 * 6. Cleans up all test entries from phone_call_queue
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const express = require('express');
const supertest = require('supertest');
const db = require('../services/database');
const { transitionCaseRuntime } = require('../services/case-runtime');

// ── Helpers ──────────────────────────────────────────────────────────────────

const SEPARATOR = '='.repeat(72);
const SUB_SEPARATOR = '-'.repeat(60);
const report = [];

function logStep(stepNum, label, detail = '') {
    const line = `[Step ${stepNum}] ${label}${detail ? ' -- ' + detail : ''}`;
    console.log(line);
    report.push(line);
}

function logOk(msg, detail = '') {
    const line = `  [PASS] ${msg}${detail ? ' -- ' + detail : ''}`;
    console.log(line);
    report.push(line);
}

function logFail(msg, detail = '') {
    const line = `  [FAIL] ${msg}${detail ? ' -- ' + detail : ''}`;
    console.log(line);
    report.push(line);
}

function logInfo(msg) {
    const line = `  [INFO] ${msg}`;
    console.log(line);
    report.push(line);
}

// Outcomes we will assign to the 3 test cases
const OUTCOMES = [
    { outcome: 'connected',  notes: 'Spoke with records division, they confirmed request is being processed.' },
    { outcome: 'voicemail',  notes: 'Left voicemail with main office, will call back tomorrow.' },
    { outcome: 'resolved',   notes: 'Records were emailed during the call. Case resolved.' }
];

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
    console.log(SEPARATOR);
    console.log('  Phone Call Queue -- End-to-End Test');
    console.log('  ' + new Date().toISOString());
    console.log(SEPARATOR);

    // ── 1. Verify DB connection ──────────────────────────────────────────────

    logStep(1, 'Connect to Railway database');
    const health = await db.healthCheck();
    if (!health.healthy) {
        logFail('Database health check', health.error);
        process.exit(1);
    }
    logOk('Database connected', `timestamp=${health.timestamp}`);
    logInfo(`DATABASE_URL present: ${!!process.env.DATABASE_URL}`);

    // ── 2. Search for cases related to "Samuel Hylton" ──────────────────────

    console.log('\n' + SUB_SEPARATOR);
    logStep(2, 'Search for cases associated with "Samuel Hylton"');

    // Try multiple search patterns across relevant text fields
    const searchPatterns = [
        { label: 'case_name ILIKE "%Samuel Hylton%"', sql: `SELECT id, case_name, subject_name, agency_name, status FROM cases WHERE case_name ILIKE $1 ORDER BY id DESC`, param: '%Samuel Hylton%' },
        { label: 'subject_name ILIKE "%Samuel Hylton%"', sql: `SELECT id, case_name, subject_name, agency_name, status FROM cases WHERE subject_name ILIKE $1 ORDER BY id DESC`, param: '%Samuel Hylton%' },
        { label: 'case_name ILIKE "%Hylton%"', sql: `SELECT id, case_name, subject_name, agency_name, status FROM cases WHERE case_name ILIKE $1 ORDER BY id DESC`, param: '%Hylton%' },
        { label: 'subject_name ILIKE "%Hylton%"', sql: `SELECT id, case_name, subject_name, agency_name, status FROM cases WHERE subject_name ILIKE $1 ORDER BY id DESC`, param: '%Hylton%' },
        { label: 'case_name ILIKE "%Samuel%"', sql: `SELECT id, case_name, subject_name, agency_name, status FROM cases WHERE case_name ILIKE $1 ORDER BY id DESC`, param: '%Samuel%' },
        { label: 'subject_name ILIKE "%Samuel%"', sql: `SELECT id, case_name, subject_name, agency_name, status FROM cases WHERE subject_name ILIKE $1 ORDER BY id DESC`, param: '%Samuel%' },
        { label: 'additional_details ILIKE "%Hylton%"', sql: `SELECT id, case_name, subject_name, agency_name, status FROM cases WHERE additional_details ILIKE $1 ORDER BY id DESC`, param: '%Hylton%' },
    ];

    let allMatchedCases = new Map(); // id -> row
    for (const p of searchPatterns) {
        try {
            const result = await db.query(p.sql, [p.param]);
            if (result.rows.length > 0) {
                logInfo(`${p.label} => ${result.rows.length} match(es)`);
                for (const row of result.rows) {
                    if (!allMatchedCases.has(row.id)) {
                        allMatchedCases.set(row.id, row);
                    }
                }
            }
        } catch (err) {
            // skip errors like type mismatch on text[] columns
        }
    }

    let candidateCases = [...allMatchedCases.values()];
    logInfo(`Matched ${candidateCases.length} case(s) via name search`);

    // If fewer than 3, supplement with recent cases
    if (candidateCases.length < 3) {
        const candidateIds = new Set(candidateCases.map(c => c.id));
        const needed = 20; // fetch extra so we have room after filtering
        const fallback = await db.query(
            `SELECT id, case_name, subject_name, agency_name, status
             FROM cases
             ORDER BY id DESC
             LIMIT $1`, [needed]
        );
        for (const row of fallback.rows) {
            if (!candidateIds.has(row.id)) {
                candidateCases.push(row);
                candidateIds.add(row.id);
            }
        }
        logInfo(`Supplemented with recent cases. Total candidates: ${candidateCases.length}`);
    }

    logInfo(`Total candidate cases: ${candidateCases.length}`);
    for (const c of candidateCases.slice(0, 10)) {
        logInfo(`  case #${c.id}: "${c.case_name?.substring(0, 80)}..." | subject="${c.subject_name}" | status=${c.status}`);
    }
    if (candidateCases.length > 10) {
        logInfo(`  ... and ${candidateCases.length - 10} more`);
    }

    // ── 3. Pick 3 cases NOT already in phone_call_queue ──────────────────────

    console.log('\n' + SUB_SEPARATOR);
    logStep(3, 'Pick 3 cases NOT already in phone_call_queue');

    // Get existing phone_call_queue case_ids
    const existingResult = await db.query(`SELECT DISTINCT case_id FROM phone_call_queue`);
    const existingCaseIds = new Set(existingResult.rows.map(r => r.case_id));
    logInfo(`Cases already in phone_call_queue: ${existingCaseIds.size}`);

    let eligibleCases = candidateCases.filter(c => !existingCaseIds.has(c.id));
    logInfo(`Eligible (not already in queue): ${eligibleCases.length}`);

    if (eligibleCases.length < 3) {
        // If still not enough, allow cases already in queue (we will clean up)
        const needed = 3 - eligibleCases.length;
        const extras = candidateCases.filter(c => existingCaseIds.has(c.id)).slice(0, needed);
        if (extras.length > 0) {
            logInfo(`Adding ${extras.length} case(s) already in queue to reach 3 (will clean up).`);
            eligibleCases.push(...extras);
        }
    }

    if (eligibleCases.length === 0) {
        logFail('No cases available to test with. Aborting.');
        await db.close();
        process.exit(1);
    }

    const selectedCases = eligibleCases.slice(0, 3);
    logOk(`Selected ${selectedCases.length} cases for testing:`);
    for (const c of selectedCases) {
        logInfo(`  case #${c.id}: "${c.case_name?.substring(0, 80)}..." | status=${c.status}`);
    }

    // ── 4. Set up Express app with supertest ─────────────────────────────────

    console.log('\n' + SUB_SEPARATOR);
    logStep(4, 'Create Express app with phone-calls routes');

    const phoneCallRoutes = require('../routes/phone-calls');
    const app = express();
    app.use(express.json());
    app.use('/api/phone-calls', phoneCallRoutes);

    const request = supertest(app);
    logOk('Express app created with /api/phone-calls routes mounted');

    // ── 5. Run the full flow for each case ───────────────────────────────────

    const createdEntryIds = []; // track IDs for cleanup
    const caseStatusBackups = []; // track original case statuses to restore
    let passCount = 0;
    let failCount = 0;

    function check(condition, passMsg, failMsg) {
        if (condition) {
            logOk(passMsg);
            passCount++;
        } else {
            logFail(failMsg || passMsg);
            failCount++;
        }
    }

    for (let i = 0; i < selectedCases.length; i++) {
        const testCase = selectedCases[i];
        const outcomeConfig = OUTCOMES[i];

        console.log('\n' + SEPARATOR);
        console.log(`  CASE ${i + 1} of ${selectedCases.length}: #${testCase.id} - "${testCase.case_name?.substring(0, 80)}..."`);
        console.log(`  Target outcome: ${outcomeConfig.outcome}`);
        console.log(SEPARATOR);

        // Save original case status for restoration
        try {
            const origCase = await db.getCaseById(testCase.id);
            if (origCase) {
                caseStatusBackups.push({
                    id: origCase.id,
                    status: origCase.status,
                    substatus: origCase.substatus || null,
                    pause_reason: origCase.pause_reason || null,
                });
            }
        } catch (err) {
            logInfo(`Could not backup case #${testCase.id} status: ${err.message}`);
        }

        // ── 4a. Create phone_call_queue entry ────────────────────────────────

        logStep('4a', `Create phone_call_queue entry for case #${testCase.id}`);
        let entry;
        try {
            entry = await db.createPhoneCallTask({
                case_id: testCase.id,
                agency_name: testCase.agency_name || 'Unknown Agency',
                agency_phone: '555-0' + String(100 + i),
                agency_state: 'TX',
                reason: 'no_email_response',
                priority: i + 1,
                notes: `E2E_TEST: phone call e2e test #${i + 1}`,
                days_since_sent: 10 + i * 5
            });
            createdEntryIds.push(entry.id);
            check(!!entry && !!entry.id,
                `Created entry id=${entry.id}, status=${entry.status}, priority=${entry.priority}`,
                'Failed to create phone_call_queue entry');
            check(entry.status === 'pending',
                `Initial status is "pending"`,
                `Expected status "pending", got "${entry?.status}"`);
            check(entry.reason === 'no_email_response',
                `Reason stored correctly: "${entry.reason}"`,
                `Reason mismatch: "${entry?.reason}"`);
            check(entry.days_since_sent === 10 + i * 5,
                `days_since_sent stored: ${entry.days_since_sent}`,
                `days_since_sent mismatch: ${entry?.days_since_sent}`);
        } catch (err) {
            logFail(`createPhoneCallTask threw: ${err.message}`);
            failCount++;
            continue;
        }

        // ── 4b. GET /api/phone-calls - verify entry appears ─────────────────

        logStep('4b', 'GET /api/phone-calls - list pending phone calls');
        try {
            const res = await request.get('/api/phone-calls');
            check(res.status === 200,
                `HTTP 200 OK`,
                `Expected HTTP 200, got ${res.status}`);
            check(res.body.success === true,
                `Response success=true`,
                `Response success=${res.body.success}`);
            check(Array.isArray(res.body.tasks),
                `Tasks is an array with ${res.body.tasks?.length} entries`,
                `Tasks is not an array`);

            const found = res.body.tasks?.find(t => t.id === entry.id);
            check(!!found,
                `New entry #${entry.id} found in pending list`,
                `Entry #${entry.id} NOT found in pending list`);
            if (found) {
                check(!!found.case_name,
                    `JOIN populates case_name: "${found.case_name?.substring(0, 60)}..."`,
                    `case_name missing from JOIN`);
            }

            // Check stats are included
            check(!!res.body.stats,
                `Stats included: pending=${res.body.stats?.pending}, claimed=${res.body.stats?.claimed}, completed=${res.body.stats?.completed}`,
                `Stats missing from response`);
        } catch (err) {
            logFail(`GET /api/phone-calls threw: ${err.message}`);
            failCount++;
        }

        // ── 4b+. GET /api/phone-calls/:id - single entry ────────────────────

        logStep('4b+', `GET /api/phone-calls/${entry.id} - fetch single entry`);
        try {
            const res = await request.get(`/api/phone-calls/${entry.id}`);
            check(res.status === 200,
                `HTTP 200 for single entry`,
                `Expected 200, got ${res.status}`);
            check(res.body.task?.id === entry.id,
                `Returned correct entry id=${res.body.task?.id}`,
                `ID mismatch: expected ${entry.id}, got ${res.body.task?.id}`);
            check(!!res.body.task?.agency_name,
                `agency_name populated: "${res.body.task?.agency_name?.substring(0, 50)}"`,
                `agency_name missing`);
        } catch (err) {
            logFail(`GET single entry threw: ${err.message}`);
            failCount++;
        }

        // ── 4c. GET /api/phone-calls/stats ───────────────────────────────────

        logStep('4c', 'GET /api/phone-calls/stats');
        try {
            const res = await request.get('/api/phone-calls/stats');
            check(res.status === 200 && res.body.success,
                `Stats: pending=${res.body.stats?.pending}, claimed=${res.body.stats?.claimed}, completed=${res.body.stats?.completed}, skipped=${res.body.stats?.skipped}`,
                `Stats request failed: ${res.status}`);
        } catch (err) {
            logFail(`GET /stats threw: ${err.message}`);
            failCount++;
        }

        // ── 4d. POST /api/phone-calls/:id/claim ─────────────────────────────

        logStep('4d', `POST /api/phone-calls/${entry.id}/claim - claim by "Samuel Hylton"`);
        try {
            const res = await request
                .post(`/api/phone-calls/${entry.id}/claim`)
                .send({ assignedTo: 'Samuel Hylton' });
            check(res.status === 200 && res.body.success,
                `Claim succeeded: message="${res.body.message}"`,
                `Claim failed: status=${res.status}, error=${res.body.error}`);
            check(res.body.task?.status === 'claimed',
                `Status changed to "claimed"`,
                `Status is "${res.body.task?.status}", expected "claimed"`);
            check(res.body.task?.assigned_to === 'Samuel Hylton',
                `assigned_to = "Samuel Hylton"`,
                `assigned_to = "${res.body.task?.assigned_to}"`);
        } catch (err) {
            logFail(`POST claim threw: ${err.message}`);
            failCount++;
        }

        // ── 4d+. Try claiming again - should get 409 ────────────────────────

        logStep('4d+', `POST /api/phone-calls/${entry.id}/claim again - expect 409`);
        try {
            const res = await request
                .post(`/api/phone-calls/${entry.id}/claim`)
                .send({ assignedTo: 'Someone Else' });
            check(res.status === 409,
                `Correctly returned 409 Conflict (task already claimed)`,
                `Expected 409, got ${res.status}: ${res.body.error}`);
        } catch (err) {
            logFail(`POST re-claim threw: ${err.message}`);
            failCount++;
        }

        // ── 4e. POST /api/phone-calls/:id/complete ──────────────────────────

        logStep('4e', `POST /api/phone-calls/${entry.id}/complete - outcome="${outcomeConfig.outcome}"`);
        try {
            const res = await request
                .post(`/api/phone-calls/${entry.id}/complete`)
                .send({
                    outcome: outcomeConfig.outcome,
                    notes: outcomeConfig.notes,
                    completedBy: 'Samuel Hylton'
                });
            check(res.status === 200 && res.body.success,
                `Complete succeeded: message="${res.body.message}"`,
                `Complete failed: status=${res.status}, error=${res.body.error}`);
            check(res.body.task?.status === 'completed',
                `Status changed to "completed"`,
                `Status is "${res.body.task?.status}", expected "completed"`);
            check(res.body.task?.call_outcome === outcomeConfig.outcome,
                `call_outcome = "${outcomeConfig.outcome}"`,
                `call_outcome = "${res.body.task?.call_outcome}"`);
            check(res.body.task?.call_notes === outcomeConfig.notes,
                `call_notes stored correctly`,
                `call_notes mismatch`);
            check(res.body.task?.completed_by === 'Samuel Hylton',
                `completed_by = "Samuel Hylton"`,
                `completed_by = "${res.body.task?.completed_by}"`);
        } catch (err) {
            logFail(`POST complete threw: ${err.message}`);
            failCount++;
        }

        // ── 4e+. Try completing again - should get 409 ──────────────────────

        logStep('4e+', `POST /api/phone-calls/${entry.id}/complete again - expect 409`);
        try {
            const res = await request
                .post(`/api/phone-calls/${entry.id}/complete`)
                .send({ outcome: 'connected', notes: 'retry', completedBy: 'test' });
            check(res.status === 409,
                `Correctly returned 409 Conflict (already completed)`,
                `Expected 409, got ${res.status}: ${res.body.error}`);
        } catch (err) {
            logFail(`POST re-complete threw: ${err.message}`);
            failCount++;
        }

        // ── 4f. Verify final state in DB ─────────────────────────────────────

        logStep('4f', `Verify final state of entry #${entry.id} directly from DB`);
        try {
            const final = await db.getPhoneCallById(entry.id);
            check(!!final,
                `Entry still exists in DB`,
                `Entry #${entry.id} not found`);
            check(final?.status === 'completed',
                `DB status = "completed"`,
                `DB status = "${final?.status}"`);
            check(final?.call_outcome === outcomeConfig.outcome,
                `DB call_outcome = "${outcomeConfig.outcome}"`,
                `DB call_outcome = "${final?.call_outcome}"`);
            check(final?.assigned_to === 'Samuel Hylton',
                `DB assigned_to = "Samuel Hylton"`,
                `DB assigned_to = "${final?.assigned_to}"`);
            check(!!final?.claimed_at,
                `DB claimed_at is set: ${final?.claimed_at}`,
                `DB claimed_at is null`);
            check(!!final?.completed_at,
                `DB completed_at is set: ${final?.completed_at}`,
                `DB completed_at is null`);
            check(final?.completed_by === 'Samuel Hylton',
                `DB completed_by = "Samuel Hylton"`,
                `DB completed_by = "${final?.completed_by}"`);
        } catch (err) {
            logFail(`DB verification threw: ${err.message}`);
            failCount++;
        }

        // Also check via GET /api/phone-calls?status=completed
        logStep('4f+', 'GET /api/phone-calls?status=completed - verify entry appears');
        try {
            const res = await request.get('/api/phone-calls?status=completed');
            const found = res.body.tasks?.find(t => t.id === entry.id);
            check(!!found,
                `Entry #${entry.id} found in completed list`,
                `Entry #${entry.id} NOT in completed list`);
        } catch (err) {
            logFail(`GET completed list threw: ${err.message}`);
            failCount++;
        }
    }

    // ── 6. Cleanup ───────────────────────────────────────────────────────────

    console.log('\n' + SEPARATOR);
    logStep(6, 'Cleanup - removing test entries and restoring case statuses');

    // Delete phone_call_queue entries
    let cleanedCount = 0;
    for (const id of createdEntryIds) {
        try {
            await db.query(`DELETE FROM phone_call_queue WHERE id = $1`, [id]);
            cleanedCount++;
            logInfo(`Deleted phone_call_queue entry #${id}`);
        } catch (err) {
            logFail(`Failed to delete entry #${id}: ${err.message}`);
        }
    }

    // Clean any stragglers with our test marker
    try {
        const stragglers = await db.query(`DELETE FROM phone_call_queue WHERE notes LIKE '%E2E_TEST%' RETURNING id`);
        if (stragglers.rowCount > 0) {
            logInfo(`Cleaned ${stragglers.rowCount} additional straggler entries`);
        }
    } catch (err) {
        logInfo(`Straggler cleanup: ${err.message}`);
    }

    logOk(`Cleaned up ${cleanedCount}/${createdEntryIds.length} phone_call_queue entries`);

    // Restore original case statuses (the "complete" endpoint may have changed them)
    for (const backup of caseStatusBackups) {
        try {
            const escalationStatuses = new Set(['needs_human_review', 'needs_phone_call', 'pending_fee_decision', 'needs_rebuttal']);
            if (backup.status === 'portal_in_progress') {
                await transitionCaseRuntime(backup.id, 'PORTAL_STARTED', {
                    ...(backup.substatus ? { substatus: backup.substatus } : {}),
                });
            } else if (backup.status === 'responded') {
                await transitionCaseRuntime(backup.id, 'CASE_RESPONDED', {
                    ...(backup.substatus ? { substatus: backup.substatus } : {}),
                    lastResponseDate: new Date().toISOString(),
                });
            } else if (backup.status === 'needs_human_fee_approval') {
                await transitionCaseRuntime(backup.id, 'FEE_QUOTE_RECEIVED', {
                    ...(backup.substatus ? { substatus: backup.substatus } : {}),
                });
            } else if (escalationStatuses.has(backup.status)) {
                await transitionCaseRuntime(backup.id, 'CASE_ESCALATED', {
                    targetStatus: backup.status,
                    ...(backup.substatus ? { substatus: backup.substatus } : {}),
                    pauseReason: backup.pause_reason || (backup.status === 'pending_fee_decision' ? 'FEE_DECISION_NEEDED' : 'UNSPECIFIED'),
                });
            } else {
                await transitionCaseRuntime(backup.id, 'CASE_RECONCILED', {
                    targetStatus: backup.status,
                    ...(backup.substatus ? { substatus: backup.substatus } : {}),
                });
            }
            logInfo(`Restored case #${backup.id} status to "${backup.status}"`);
        } catch (err) {
            logInfo(`Could not restore case #${backup.id}: ${err.message}`);
        }
    }

    // Verify cleanup
    for (const id of createdEntryIds) {
        const verify = await db.query(`SELECT id FROM phone_call_queue WHERE id = $1`, [id]);
        check(verify.rows.length === 0,
            `Entry #${id} confirmed deleted`,
            `Entry #${id} still exists after cleanup!`);
    }

    // ── Final Report ─────────────────────────────────────────────────────────

    console.log('\n' + SEPARATOR);
    console.log('  FINAL REPORT');
    console.log(SEPARATOR);
    console.log(`  Cases tested:    ${selectedCases.length}`);
    console.log(`  Entries created: ${createdEntryIds.length}`);
    console.log(`  Entries cleaned: ${cleanedCount}`);
    console.log(`  Checks passed:   ${passCount}`);
    console.log(`  Checks failed:   ${failCount}`);
    console.log(`  Total checks:    ${passCount + failCount}`);
    console.log(SEPARATOR);

    if (failCount > 0) {
        console.log('\n  FAILED CHECKS:');
        report.filter(l => l.includes('[FAIL]')).forEach(l => console.log('    ' + l));
        console.log('');
    }

    console.log(failCount === 0
        ? '\n  ALL CHECKS PASSED\n'
        : `\n  ${failCount} CHECK(S) FAILED\n`);

    await db.close();
    process.exit(failCount > 0 ? 1 : 0);
}

// ── Entry ────────────────────────────────────────────────────────────────────

main().catch(async (err) => {
    console.error('\nFATAL ERROR:', err);
    try { await db.close(); } catch (_) {}
    process.exit(1);
});
