#!/usr/bin/env node
/**
 * Audit all cases for mismatched inbound emails.
 * Finds emails whose subject request number doesn't match the case's stored NR.
 *
 * Usage:
 *   node scripts/_audit_mismatched_emails.js           # audit only
 *   node scripts/_audit_mismatched_emails.js --fix      # unlink mismatched messages
 */
const { Pool } = require('pg');

const DB_URL = process.env.DATABASE_PUBLIC_URL
    || process.env.DATABASE_URL
    || 'postgresql://postgres:EsoRieVyRUVqLZEaGcecTqCDALRGxXXH@switchback.proxy.rlwy.net:39529/railway';

const pool = new Pool({ connectionString: DB_URL });
const fixMode = process.argv.includes('--fix');

function extractNR(subject) {
    if (!subject) return null;
    const match = subject.match(/#(\d+-\d+)/);
    return match ? match[1] : null;
}

async function run() {
    // Get all inbound messages that are in threads
    const result = await pool.query(`
        SELECT
            m.id as msg_id,
            m.subject,
            m.from_email,
            m.created_at,
            m.thread_id,
            et.case_id,
            c.case_name,
            c.agency_name,
            c.portal_request_number as case_nr
        FROM messages m
        JOIN email_threads et ON et.id = m.thread_id
        JOIN cases c ON c.id = et.case_id
        WHERE m.direction = 'inbound'
        ORDER BY et.case_id, m.created_at
    `);

    console.log(`Scanning ${result.rows.length} inbound messages across all cases...\n`);

    const mismatches = [];
    const caseStats = {};

    for (const row of result.rows) {
        const subjectNR = extractNR(row.subject);

        if (!caseStats[row.case_id]) {
            caseStats[row.case_id] = {
                agency: row.agency_name,
                caseNR: row.case_nr,
                msgs: 0,
                mismatched: 0,
                nrs: new Set()
            };
        }
        caseStats[row.case_id].msgs++;
        if (subjectNR) caseStats[row.case_id].nrs.add(subjectNR);

        // Check for definite mismatch: subject NR != case stored NR
        if (subjectNR && row.case_nr) {
            const storedNRs = row.case_nr.replace(/\s/g, '').split(',');
            if (!storedNRs.includes(subjectNR)) {
                mismatches.push({
                    msgId: row.msg_id,
                    threadId: row.thread_id,
                    caseId: row.case_id,
                    subjectNR,
                    caseNR: row.case_nr,
                    subject: row.subject.slice(0, 100),
                    agency: row.agency_name
                });
                caseStats[row.case_id].mismatched++;
            }
        }
    }

    // Report cases with multiple distinct NRs
    console.log('=== CASES WITH MULTIPLE DISTINCT NRs IN THEIR THREAD ===');
    let multiNRCount = 0;
    for (const [caseId, stats] of Object.entries(caseStats)) {
        if (stats.nrs.size > 1) {
            multiNRCount++;
            console.log(`Case #${caseId} (${stats.agency}): stored NR=${stats.caseNR || 'NULL'}, found NRs: ${[...stats.nrs].join(', ')} (${stats.msgs} msgs, ${stats.mismatched} mismatched)`);
        }
    }
    if (multiNRCount === 0) console.log('None found.');

    // Report definite mismatches
    console.log(`\n=== DEFINITE MISMATCHES (subject NR != case NR) ===`);
    if (mismatches.length === 0) {
        console.log('None found!');
    } else {
        for (const m of mismatches) {
            console.log(`MSG #${m.msgId} in case #${m.caseId}: subject NR=${m.subjectNR} vs case NR=${m.caseNR}`);
            console.log(`  Agency: ${m.agency}`);
            console.log(`  Subject: ${m.subject}`);
        }
    }

    // Fix mode: unlink mismatched messages
    if (fixMode && mismatches.length > 0) {
        console.log(`\n=== FIXING: Unlinking ${mismatches.length} mismatched messages ===`);
        for (const m of mismatches) {
            await pool.query('UPDATE messages SET thread_id = NULL, case_id = NULL WHERE id = $1', [m.msgId]);
            console.log(`  Unlinked MSG #${m.msgId} (NR ${m.subjectNR}) from case #${m.caseId}`);
        }
        console.log('Done.');
    } else if (mismatches.length > 0 && !fixMode) {
        console.log(`\nRe-run with --fix to unlink mismatched messages.`);
    }

    // Also check: orphaned inbound messages (no thread) that could be rematched
    const orphaned = await pool.query(`
        SELECT m.id, m.subject, m.from_email, m.created_at
        FROM messages m
        WHERE m.direction = 'inbound' AND m.thread_id IS NULL
        ORDER BY m.created_at DESC
        LIMIT 20
    `);
    if (orphaned.rows.length > 0) {
        console.log(`\n=== ORPHANED INBOUND MESSAGES (no thread, latest 20) ===`);
        for (const o of orphaned.rows) {
            const nr = extractNR(o.subject);
            console.log(`MSG #${o.id} NR=${nr || 'none'} ${o.created_at.toISOString().slice(0, 16)}`);
            console.log(`  From: ${o.from_email} | Subject: ${o.subject.slice(0, 100)}`);
        }
    }

    console.log(`\n=== SUMMARY ===`);
    console.log(`Messages scanned: ${result.rows.length}`);
    console.log(`Definite mismatches: ${mismatches.length}`);
    console.log(`Cases with multiple NRs: ${multiNRCount}`);
    console.log(`Orphaned inbound messages: ${orphaned.rows.length}`);

    await pool.end();
}

run().catch(err => {
    console.error(err);
    pool.end();
    process.exit(1);
});
