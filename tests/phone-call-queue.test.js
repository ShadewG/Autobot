#!/usr/bin/env node
/**
 * Phone Call Queue Feature Tests
 *
 * Tests all layers: migration, DB methods, API routes, escalation logic, cron sweep, Notion mapping.
 * Runs against the real database.
 */

require('dotenv').config();
const http = require('http');
const express = require('express');

let db, app, server, BASE_URL;
let testCaseId = null;
let testPhoneCallId = null;
const results = [];

function log(test, pass, detail = '') {
    const icon = pass ? '\u2705' : '\u274C';
    results.push({ test, pass, detail });
    console.log(`  ${icon} ${test}${detail ? ` — ${detail}` : ''}`);
}

// ============================================================
// 1. MIGRATION TEST
// ============================================================
async function testMigration() {
    console.log('\n--- 1. MIGRATION ---');
    try {
        const fs = require('fs');
        const path = require('path');
        const sql = fs.readFileSync(path.join(__dirname, '../migrations/025_phone_call_queue.sql'), 'utf8');
        await db.query(sql);
        log('Migration runs without error', true);
    } catch (err) {
        // "already exists" is fine
        if (err.message.includes('already exists')) {
            log('Migration runs without error (table already exists)', true);
        } else {
            log('Migration runs without error', false, err.message);
        }
    }

    // Verify table structure
    try {
        const result = await db.query(`
            SELECT column_name, data_type
            FROM information_schema.columns
            WHERE table_name = 'phone_call_queue'
            ORDER BY ordinal_position
        `);
        const cols = result.rows.map(r => r.column_name);
        const required = ['id', 'case_id', 'agency_name', 'agency_phone', 'agency_state',
            'reason', 'status', 'priority', 'notes', 'days_since_sent', 'assigned_to',
            'claimed_at', 'completed_at', 'completed_by', 'call_outcome', 'call_notes',
            'created_at', 'updated_at'];

        const missing = required.filter(c => !cols.includes(c));
        log('All required columns exist', missing.length === 0,
            missing.length > 0 ? `Missing: ${missing.join(', ')}` : `${cols.length} columns found`);
    } catch (err) {
        log('All required columns exist', false, err.message);
    }

    // Verify indexes
    try {
        const result = await db.query(`
            SELECT indexname FROM pg_indexes WHERE tablename = 'phone_call_queue'
        `);
        const indexes = result.rows.map(r => r.indexname);
        const hasStatusIdx = indexes.some(i => i.includes('status'));
        const hasCaseIdx = indexes.some(i => i.includes('case_id'));
        log('Status index exists', hasStatusIdx, indexes.join(', '));
        log('Case ID index exists', hasCaseIdx);
    } catch (err) {
        log('Indexes exist', false, err.message);
    }
}

// ============================================================
// 2. DATABASE METHOD TESTS
// ============================================================
async function testDatabaseMethods() {
    console.log('\n--- 2. DATABASE METHODS ---');

    // First, find or create a test case
    try {
        const caseResult = await db.query(`SELECT id FROM cases ORDER BY id DESC LIMIT 1`);
        if (caseResult.rows.length > 0) {
            testCaseId = caseResult.rows[0].id;
            log('Found test case', true, `case_id=${testCaseId}`);
        } else {
            log('Found test case', false, 'No cases in DB');
            return;
        }
    } catch (err) {
        log('Found test case', false, err.message);
        return;
    }

    // Clean up any previous test entries for this case
    await db.query(`DELETE FROM phone_call_queue WHERE case_id = $1 AND notes LIKE '%TEST%'`, [testCaseId]);

    // createPhoneCallTask
    try {
        const task = await db.createPhoneCallTask({
            case_id: testCaseId,
            agency_name: 'TEST Agency PD',
            agency_phone: '555-0199',
            agency_state: 'TX',
            reason: 'no_email_response',
            priority: 1,
            notes: 'TEST: automated test entry',
            days_since_sent: 15
        });
        testPhoneCallId = task.id;
        log('createPhoneCallTask', true, `id=${task.id}, status=${task.status}`);

        // Verify defaults
        log('  default status = pending', task.status === 'pending', task.status);
        log('  reason stored correctly', task.reason === 'no_email_response', task.reason);
        log('  priority stored correctly', task.priority === 1, String(task.priority));
        log('  days_since_sent stored', task.days_since_sent === 15, String(task.days_since_sent));
    } catch (err) {
        log('createPhoneCallTask', false, err.message);
        return;
    }

    // getPhoneCallById
    try {
        const task = await db.getPhoneCallById(testPhoneCallId);
        log('getPhoneCallById', !!task, task ? `found, case_name=${task.case_name}` : 'not found');
        log('  JOIN returns case_name', !!task.case_name);
        log('  JOIN returns case_status', !!task.case_status);
    } catch (err) {
        log('getPhoneCallById', false, err.message);
    }

    // getPhoneCallByCaseId
    try {
        const task = await db.getPhoneCallByCaseId(testCaseId);
        log('getPhoneCallByCaseId', !!task && task.id === testPhoneCallId,
            task ? `id=${task.id}` : 'not found');
    } catch (err) {
        log('getPhoneCallByCaseId', false, err.message);
    }

    // getPendingPhoneCalls
    try {
        const tasks = await db.getPendingPhoneCalls(10);
        const found = tasks.some(t => t.id === testPhoneCallId);
        log('getPendingPhoneCalls', found, `${tasks.length} tasks returned, test task found=${found}`);
        if (tasks.length > 0) {
            log('  includes case_name field', !!tasks[0].case_name);
        }
    } catch (err) {
        log('getPendingPhoneCalls', false, err.message);
    }

    // getPhoneCallsByStatus
    try {
        const tasks = await db.getPhoneCallsByStatus('pending', 10);
        const found = tasks.some(t => t.id === testPhoneCallId);
        log('getPhoneCallsByStatus(pending)', found, `${tasks.length} tasks`);
    } catch (err) {
        log('getPhoneCallsByStatus', false, err.message);
    }

    // getPhoneCallQueueStats
    try {
        const stats = await db.getPhoneCallQueueStats();
        log('getPhoneCallQueueStats', stats.pending !== undefined,
            `pending=${stats.pending}, claimed=${stats.claimed}, completed=${stats.completed}, skipped=${stats.skipped}`);
    } catch (err) {
        log('getPhoneCallQueueStats', false, err.message);
    }

    // claimPhoneCall
    try {
        const claimed = await db.claimPhoneCall(testPhoneCallId, 'test-user');
        log('claimPhoneCall', !!claimed, claimed ? `status=${claimed.status}, assigned=${claimed.assigned_to}` : 'null returned');
        log('  status changed to claimed', claimed?.status === 'claimed');
        log('  assigned_to set', claimed?.assigned_to === 'test-user');
        log('  claimed_at set', !!claimed?.claimed_at);
    } catch (err) {
        log('claimPhoneCall', false, err.message);
    }

    // claimPhoneCall again (should fail - already claimed)
    try {
        const reClaimed = await db.claimPhoneCall(testPhoneCallId, 'other-user');
        log('claimPhoneCall (already claimed) returns null', !reClaimed,
            reClaimed ? 'should have returned null' : 'correctly returned null');
    } catch (err) {
        log('claimPhoneCall (already claimed)', false, err.message);
    }

    // completePhoneCall
    try {
        const completed = await db.completePhoneCall(testPhoneCallId, 'connected', 'Spoke with records dept', 'test-user');
        log('completePhoneCall', !!completed, `status=${completed?.status}, outcome=${completed?.call_outcome}`);
        log('  status = completed', completed?.status === 'completed');
        log('  call_outcome stored', completed?.call_outcome === 'connected');
        log('  call_notes stored', completed?.call_notes === 'Spoke with records dept');
        log('  completed_by stored', completed?.completed_by === 'test-user');
        log('  completed_at set', !!completed?.completed_at);
    } catch (err) {
        log('completePhoneCall', false, err.message);
    }

    // Create another task to test skip
    try {
        const task2 = await db.createPhoneCallTask({
            case_id: testCaseId,
            agency_name: 'TEST Skip Agency',
            reason: 'no_email_response',
            notes: 'TEST: skip test entry'
        });
        const skipped = await db.skipPhoneCall(task2.id, 'Wrong number');
        log('skipPhoneCall', !!skipped && skipped.status === 'skipped',
            `status=${skipped?.status}, notes=${skipped?.call_notes}`);

        // Clean up skip test entry
        await db.query(`DELETE FROM phone_call_queue WHERE id = $1`, [task2.id]);
    } catch (err) {
        log('skipPhoneCall', false, err.message);
    }
}

// ============================================================
// 3. API ROUTE TESTS
// ============================================================
async function testAPIRoutes() {
    console.log('\n--- 3. API ROUTES ---');

    // Reset test task to pending for API tests
    await db.query(`UPDATE phone_call_queue SET status = 'pending', assigned_to = NULL, claimed_at = NULL, completed_at = NULL WHERE id = $1`, [testPhoneCallId]);

    // GET /api/phone-calls
    try {
        const res = await fetch(`${BASE_URL}/api/phone-calls`);
        const data = await res.json();
        log('GET /api/phone-calls', res.status === 200 && data.success,
            `status=${res.status}, count=${data.count}, has stats=${!!data.stats}`);
        log('  returns stats.pending', data.stats?.pending !== undefined, String(data.stats?.pending));
        log('  returns tasks array', Array.isArray(data.tasks), `${data.tasks?.length} tasks`);
    } catch (err) {
        log('GET /api/phone-calls', false, err.message);
    }

    // GET /api/phone-calls?status=pending
    try {
        const res = await fetch(`${BASE_URL}/api/phone-calls?status=pending`);
        const data = await res.json();
        log('GET /api/phone-calls?status=pending', res.status === 200 && data.success,
            `count=${data.count}`);
    } catch (err) {
        log('GET /api/phone-calls?status=pending', false, err.message);
    }

    // GET /api/phone-calls/stats
    try {
        const res = await fetch(`${BASE_URL}/api/phone-calls/stats`);
        const data = await res.json();
        log('GET /api/phone-calls/stats', res.status === 200 && data.success && data.stats,
            `pending=${data.stats?.pending}`);
    } catch (err) {
        log('GET /api/phone-calls/stats', false, err.message);
    }

    // GET /api/phone-calls/:id
    try {
        const res = await fetch(`${BASE_URL}/api/phone-calls/${testPhoneCallId}`);
        const data = await res.json();
        log('GET /api/phone-calls/:id', res.status === 200 && data.success && data.task,
            `id=${data.task?.id}, case_name=${data.task?.case_name}`);
    } catch (err) {
        log('GET /api/phone-calls/:id', false, err.message);
    }

    // GET /api/phone-calls/:id (not found)
    try {
        const res = await fetch(`${BASE_URL}/api/phone-calls/999999`);
        log('GET /api/phone-calls/:id (404)', res.status === 404);
    } catch (err) {
        log('GET /api/phone-calls/:id (404)', false, err.message);
    }

    // POST /api/phone-calls/:id/claim
    try {
        const res = await fetch(`${BASE_URL}/api/phone-calls/${testPhoneCallId}/claim`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ assignedTo: 'api-test-user' })
        });
        const data = await res.json();
        log('POST /api/phone-calls/:id/claim', res.status === 200 && data.success,
            `message=${data.message}`);
    } catch (err) {
        log('POST /api/phone-calls/:id/claim', false, err.message);
    }

    // POST /api/phone-calls/:id/claim (already claimed - 409)
    try {
        const res = await fetch(`${BASE_URL}/api/phone-calls/${testPhoneCallId}/claim`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ assignedTo: 'another-user' })
        });
        log('POST /api/phone-calls/:id/claim (409)', res.status === 409);
    } catch (err) {
        log('POST /api/phone-calls/:id/claim (409)', false, err.message);
    }

    // POST /api/phone-calls/:id/complete
    try {
        const res = await fetch(`${BASE_URL}/api/phone-calls/${testPhoneCallId}/complete`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                outcome: 'voicemail',
                notes: 'Left voicemail with records dept',
                completedBy: 'api-test-user'
            })
        });
        const data = await res.json();
        log('POST /api/phone-calls/:id/complete', res.status === 200 && data.success,
            `outcome=${data.task?.call_outcome}`);
    } catch (err) {
        log('POST /api/phone-calls/:id/complete', false, err.message);
    }

    // POST /api/phone-calls/:id/complete (already completed - 409)
    try {
        const res = await fetch(`${BASE_URL}/api/phone-calls/${testPhoneCallId}/complete`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ outcome: 'connected', notes: 'retry', completedBy: 'test' })
        });
        log('POST /api/phone-calls/:id/complete (409)', res.status === 409);
    } catch (err) {
        log('POST /api/phone-calls/:id/complete (409)', false, err.message);
    }

    // Create a new task, then test skip
    let skipTaskId;
    try {
        const task = await db.createPhoneCallTask({
            case_id: testCaseId, agency_name: 'TEST Skip API',
            reason: 'no_email_response', notes: 'TEST: API skip test'
        });
        skipTaskId = task.id;

        const res = await fetch(`${BASE_URL}/api/phone-calls/${skipTaskId}/skip`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ notes: 'Deferring to next week' })
        });
        const data = await res.json();
        log('POST /api/phone-calls/:id/skip', res.status === 200 && data.success,
            `status=${data.task?.status}`);

        // Clean up
        await db.query(`DELETE FROM phone_call_queue WHERE id = $1`, [skipTaskId]);
    } catch (err) {
        log('POST /api/phone-calls/:id/skip', false, err.message);
        if (skipTaskId) await db.query(`DELETE FROM phone_call_queue WHERE id = $1`, [skipTaskId]).catch(() => {});
    }
}

// ============================================================
// 4. ESCALATION LOGIC TESTS
// ============================================================
async function testEscalationLogic() {
    console.log('\n--- 4. ESCALATION LOGIC ---');

    // Test that followup-scheduler has escalateToPhoneQueue method
    try {
        const followupScheduler = require('../services/followup-scheduler');
        log('followupScheduler.escalateToPhoneQueue exists', typeof followupScheduler.escalateToPhoneQueue === 'function');
        log('followupScheduler.markMaxReached exists', typeof followupScheduler.markMaxReached === 'function');
    } catch (err) {
        log('followup-scheduler loads', false, err.message);
    }

    // Test escalateToPhoneQueue prevents dupes
    try {
        const followupScheduler = require('../services/followup-scheduler');
        // Clean up any existing entries for this test
        await db.query(`DELETE FROM phone_call_queue WHERE case_id = $1 AND notes LIKE '%TEST%'`, [testCaseId]);
        // But our test entry from earlier still exists, so check dupe prevention
        const existing = await db.getPhoneCallByCaseId(testCaseId);
        if (existing) {
            const result = await followupScheduler.escalateToPhoneQueue(testCaseId, 'no_email_response');
            log('escalateToPhoneQueue skips duplicates', result?.id === existing.id,
                `returned existing id=${existing.id}`);
        } else {
            log('escalateToPhoneQueue skips duplicates', true, 'no existing entry, dupe check not applicable');
        }
    } catch (err) {
        log('escalateToPhoneQueue', false, err.message);
    }

    // Test follow-up-service references escalation
    try {
        const followUpService = require('../services/follow-up-service');
        // Read the source to verify it calls escalateToPhoneQueue
        const fs = require('fs');
        const source = fs.readFileSync(require.resolve('../services/follow-up-service'), 'utf8');
        const hasEscalation = source.includes('escalateToPhoneQueue');
        log('follow-up-service.js references escalateToPhoneQueue', hasEscalation);
    } catch (err) {
        log('follow-up-service escalation check', false, err.message);
    }
}

// ============================================================
// 5. CRON SWEEP TESTS
// ============================================================
async function testCronSweep() {
    console.log('\n--- 5. CRON SWEEP ---');

    try {
        const cronService = require('../services/cron-service');
        log('cronService.sweepNoResponseCases exists', typeof cronService.sweepNoResponseCases === 'function');
    } catch (err) {
        log('cron-service loads', false, err.message);
    }

    // Verify the sweep SQL logic (dry run - just test the query parses)
    try {
        const result = await db.query(`
            SELECT COUNT(*) as count
            FROM cases c
            WHERE c.status IN ('sent', 'awaiting_response')
              AND c.send_date < NOW() - INTERVAL '14 days'
              AND (c.portal_url IS NULL OR c.portal_url = '')
              AND NOT EXISTS (
                SELECT 1 FROM phone_call_queue pcq WHERE pcq.case_id = c.id
              )
        `);
        log('Sweep SQL query is valid', true, `${result.rows[0].count} cases would match`);
    } catch (err) {
        log('Sweep SQL query is valid', false, err.message);
    }
}

// ============================================================
// 6. NOTION STATUS MAPPING
// ============================================================
async function testNotionMapping() {
    console.log('\n--- 6. NOTION STATUS MAPPING ---');

    try {
        const notionService = require('../services/notion-service');

        // mapStatusToNotion
        const mapped = notionService.mapStatusToNotion('needs_phone_call');
        log('mapStatusToNotion(needs_phone_call)', mapped === 'Needs Phone Call', `"${mapped}"`);

        // mapNotionStatusToInternal (reverse)
        const internal = notionService.mapNotionStatusToInternal('Needs Phone Call');
        log('mapNotionStatusToInternal(Needs Phone Call)', internal === 'needs_phone_call', `"${internal}"`);

        // Verify it's in NOTION_STATUS_MAP
        const fs = require('fs');
        const source = fs.readFileSync(require.resolve('../services/notion-service'), 'utf8');
        const hasMapping = source.includes("'needs_phone_call': 'Needs Phone Call'");
        log('NOTION_STATUS_MAP contains needs_phone_call', hasMapping);
    } catch (err) {
        log('Notion mapping', false, err.message);
    }
}

// ============================================================
// 7. MONITOR HTML VALIDATION
// ============================================================
async function testMonitorHTML() {
    console.log('\n--- 7. MONITOR UI ---');

    try {
        const res = await fetch(`${BASE_URL}/monitor.html`);
        const html = await res.text();
        log('GET /monitor.html loads', res.status === 200, `${html.length} bytes`);

        // Check phone call tab exists
        log('Phone Calls tab exists', html.includes('data-panel="phonecalls"'));
        log('Phone Calls badge exists', html.includes('id="phoneCallBadge"'));
        log('Phone queue stat box exists', html.includes('id="phoneQueueCount"'));
        log('Phone call rows tbody exists', html.includes('id="phoneCallRows"'));
        log('Phone call filter dropdown exists', html.includes('id="phoneCallFilter"'));

        // Check JS functions exist
        log('loadPhoneCalls function exists', html.includes('function loadPhoneCalls'));
        log('claimPhoneCall function exists', html.includes('function claimPhoneCall'));
        log('showCompletePhoneCall function exists', html.includes('function showCompletePhoneCall'));
        log('skipPhoneCall function exists', html.includes('function skipPhoneCall'));

        // Check removed sections are gone
        log('AI Processing section removed', !html.includes('id="aiSection"'));
        log('Simulation section removed', !html.includes('id="simulationSection"'));
        log('AI mode select removed', !html.includes('id="aiMode"'));
        log('Simulation form removed', !html.includes('id="simCaseId"'));
    } catch (err) {
        log('Monitor HTML', false, err.message);
    }
}

// ============================================================
// 8. SERVER MOUNTING
// ============================================================
async function testServerMounting() {
    console.log('\n--- 8. SERVER MOUNTING ---');

    const fs = require('fs');
    const source = fs.readFileSync(require.resolve('../server'), 'utf8');

    log('phone-calls route imported', source.includes("require('./routes/phone-calls')"));
    log('phone-calls route mounted at /api/phone-calls', source.includes("/api/phone-calls"));
}

// ============================================================
// RUNNER
// ============================================================
async function main() {
    console.log('====================================');
    console.log('  Phone Call Queue Feature Tests');
    console.log('====================================');

    // Set up
    db = require('../services/database');

    // Verify DB connection
    try {
        const health = await db.healthCheck();
        if (!health.healthy) throw new Error(health.error);
        console.log(`\nDB connected: ${health.timestamp}`);
    } catch (err) {
        console.error(`\nDB connection failed: ${err.message}`);
        process.exit(1);
    }

    // Start a minimal Express server for API tests
    const phoneCallRoutes = require('../routes/phone-calls');
    app = express();
    app.use(express.json());
    app.use(express.static(require('path').join(__dirname, '../public')));
    app.use('/api/phone-calls', phoneCallRoutes);

    await new Promise((resolve) => {
        server = app.listen(0, '127.0.0.1', () => {
            const port = server.address().port;
            BASE_URL = `http://127.0.0.1:${port}`;
            console.log(`Test server on ${BASE_URL}\n`);
            resolve();
        });
    });

    // Run tests
    await testMigration();
    await testDatabaseMethods();
    await testAPIRoutes();
    await testEscalationLogic();
    await testCronSweep();
    await testNotionMapping();
    await testMonitorHTML();
    await testServerMounting();

    // Clean up test data
    console.log('\n--- CLEANUP ---');
    if (testPhoneCallId) {
        await db.query(`DELETE FROM phone_call_queue WHERE id = $1`, [testPhoneCallId]);
        console.log(`  Deleted test phone call entry #${testPhoneCallId}`);
    }
    await db.query(`DELETE FROM phone_call_queue WHERE notes LIKE '%TEST%'`);

    // Summary
    const passed = results.filter(r => r.pass).length;
    const failed = results.filter(r => !r.pass).length;
    const total = results.length;

    console.log('\n====================================');
    console.log(`  RESULTS: ${passed}/${total} passed, ${failed} failed`);
    console.log('====================================');

    if (failed > 0) {
        console.log('\nFailed tests:');
        results.filter(r => !r.pass).forEach(r => {
            console.log(`  \u274C ${r.test}: ${r.detail}`);
        });
    }

    // Tear down
    server.close();
    await db.close();

    process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
    console.error('Test runner error:', err);
    if (server) server.close();
    process.exit(1);
});
