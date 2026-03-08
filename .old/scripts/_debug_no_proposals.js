#!/usr/bin/env node
const { Pool } = require('pg');
const pool = new Pool({ connectionString: 'postgresql://postgres:EsoRieVyRUVqLZEaGcecTqCDALRGxXXH@switchback.proxy.rlwy.net:39529/railway' });

(async () => {
    const caseIds = [25172, 25154];

    // 1. response_analysis for messages from these cases
    console.log('=== RESPONSE ANALYSIS ===');
    const analyses = await pool.query(
        `SELECT ra.*, m.case_id FROM response_analysis ra
         JOIN messages m ON m.id = ra.message_id
         WHERE m.case_id = ANY($1)
         ORDER BY ra.created_at`,
        [caseIds]
    );
    console.log(`Found: ${analyses.rows.length} analysis records`);
    for (const a of analyses.rows) {
        console.log(`\nCase #${a.case_id} | MSG #${a.message_id}`);
        for (const [k, v] of Object.entries(a)) {
            if (v !== null && !['id', 'message_id', 'case_id', 'created_at', 'updated_at'].includes(k)) {
                const display = typeof v === 'string' ? v.slice(0, 200) : JSON.stringify(v).slice(0, 200);
                console.log(`  ${k}: ${display}`);
            }
        }
    }

    // 2. agent_runs full result
    console.log('\n=== AGENT RUNS ===');
    const runs = await pool.query(
        `SELECT id, case_id, status, result, error, trigger_message_id, created_at
         FROM agent_runs WHERE case_id = ANY($1) ORDER BY created_at`,
        [caseIds]
    );
    for (const r of runs.rows) {
        console.log(`\nRun #${r.id} | Case #${r.case_id} | Status: ${r.status} | Trigger MSG: ${r.trigger_message_id} | ${r.created_at.toISOString().slice(0,19)}`);
        console.log(`  result: ${JSON.stringify(r.result)}`);
        if (r.error) console.log(`  error: ${r.error}`);
    }

    // 3. agent_decisions
    console.log('\n=== AGENT DECISIONS ===');
    const decisions = await pool.query(
        `SELECT * FROM agent_decisions WHERE case_id = ANY($1) ORDER BY created_at`,
        [caseIds]
    );
    console.log(`Found: ${decisions.rows.length} decisions`);
    for (const d of decisions.rows) {
        console.log();
        for (const [k, v] of Object.entries(d)) {
            if (v !== null) {
                const display = typeof v === 'string' ? v.slice(0, 200) : JSON.stringify(v).slice(0, 200);
                console.log(`  ${k}: ${display}`);
            }
        }
    }

    // 4. ALL activity_log entries for these cases (not filtered by event_type)
    console.log('\n=== ALL ACTIVITY LOG ===');
    for (const cid of caseIds) {
        const acts = await pool.query(
            `SELECT event_type, description, created_at FROM activity_log
             WHERE details::text LIKE $1 ORDER BY created_at`,
            [`%"case_id":${cid}%`]
        );
        console.log(`\nCase #${cid}: ${acts.rows.length} activity entries`);
        for (const a of acts.rows) {
            console.log(`  ${a.created_at.toISOString().slice(0,19)} ${a.event_type} | ${(a.description || '').slice(0, 120)}`);
        }
    }

    // 5. Compare with a WORKING case
    console.log('\n=== WORKING CASE COMPARISON ===');
    const working = await pool.query(
        `SELECT DISTINCT case_id FROM proposals WHERE status NOT IN ('DISMISSED') LIMIT 1`
    );
    if (working.rows.length > 0) {
        const wid = working.rows[0].case_id;
        console.log(`Working case #${wid}`);

        const wRuns = await pool.query(
            `SELECT id, status, result, trigger_message_id FROM agent_runs WHERE case_id = $1 ORDER BY created_at LIMIT 3`,
            [wid]
        );
        for (const r of wRuns.rows) {
            console.log(`  Run #${r.id} [${r.status}] trigger MSG: ${r.trigger_message_id}`);
            console.log(`  result: ${JSON.stringify(r.result).slice(0, 400)}`);
        }

        const wActs = await pool.query(
            `SELECT event_type, description, created_at FROM activity_log
             WHERE details::text LIKE $1 ORDER BY created_at LIMIT 10`,
            [`%"case_id":${wid}%`]
        );
        console.log(`Activity entries: ${wActs.rows.length}`);
        for (const a of wActs.rows) {
            console.log(`  ${a.created_at.toISOString().slice(0,19)} ${a.event_type}`);
        }
    }

    await pool.end();
})();
