const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

(async () => {
    const msgs = await pool.query(`
        SELECT m.id, m.case_id, m.subject, m.summary,
               m.portal_notification, m.portal_notification_type,
               c.status as case_status, c.agency_name
        FROM messages m
        JOIN cases c ON c.id = m.case_id
        WHERE m.direction = 'inbound' AND m.processed_at IS NULL AND m.last_error IS NULL
        ORDER BY m.case_id, m.received_at DESC NULLS LAST
    `);
    console.log('Total unprocessed matched:', msgs.rows.length);

    const byCaseId = {};
    for (const m of msgs.rows) {
        if (!(m.case_id in byCaseId)) byCaseId[m.case_id] = { case_status: m.case_status, agency: m.agency_name, msgs: [] };
        byCaseId[m.case_id].msgs.push(m);
    }

    for (const [caseId, info] of Object.entries(byCaseId)) {
        console.log(`\nCase #${caseId} (${info.case_status}) - ${info.agency} - ${info.msgs.length} unprocessed`);
        for (const m of info.msgs) {
            const type = m.portal_notification ? `PORTAL:${m.portal_notification_type}` : 'DIRECT';
            console.log(`  Msg #${m.id} [${type}] ${m.summary ? 'has-summary' : 'no-summary'} | ${(m.subject||'').substring(0,65)}`);
        }
    }

    // Also check what the webhook does when it matches - does it enqueue?
    // Check for stuck agent_runs
    console.log('\n=== STUCK/FAILED AGENT RUNS FOR THESE CASES ===');
    const caseIds = Object.keys(byCaseId).map(Number);
    if (caseIds.length > 0) {
        const runs = await pool.query(`
            SELECT ar.id, ar.case_id, ar.status, ar.trigger_type, ar.started_at, ar.ended_at
            FROM agent_runs ar
            WHERE ar.case_id = ANY($1) AND ar.trigger_type IN ('inbound_message', 'inbound')
            ORDER BY ar.case_id, ar.started_at DESC NULLS LAST
        `, [caseIds]);
        for (const r of runs.rows) {
            console.log(`  Run #${r.id} Case #${r.case_id} ${r.trigger_type} ${r.status} started:${r.started_at ? r.started_at.toISOString().substring(0,16) : '?'}`);
        }
        if (runs.rows.length === 0) console.log('  NONE - no agent runs found for these cases');
    }

    await pool.end();
})();
