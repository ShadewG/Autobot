const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

(async () => {
    const caseIds = [60, 726, 1658, 1660, 2593, 25136, 25151, 25167, 25170];

    for (const caseId of caseIds) {
        const caseData = await pool.query('SELECT id, status, agency_name, portal_url FROM cases WHERE id = $1', [caseId]);
        if (!caseData.rows[0]) { console.log(`Case #${caseId}: NOT FOUND`); continue; }
        const c = caseData.rows[0];

        const msgs = await pool.query(
            `SELECT id, subject, from_email, portal_notification, portal_notification_type, received_at
             FROM messages WHERE case_id = $1 AND direction = 'inbound' AND processed_at IS NULL AND last_error IS NULL
             ORDER BY received_at DESC`,
            [caseId]
        );

        const runs = await pool.query(
            'SELECT id, status, trigger_type, error, started_at, ended_at FROM agent_runs WHERE case_id = $1 ORDER BY id DESC LIMIT 3',
            [caseId]
        );

        console.log(`\nCase #${caseId} (${c.status}) - ${c.agency_name}`);
        console.log(`  Portal URL: ${c.portal_url || 'none'}`);
        console.log(`  Unprocessed msgs: ${msgs.rows.length}`);
        for (const m of msgs.rows) {
            const type = m.portal_notification ? `PORTAL:${m.portal_notification_type}` : 'DIRECT';
            console.log(`    Msg #${m.id} [${type}] rcvd:${m.received_at ? m.received_at.toISOString().substring(0,16) : '?'} | ${(m.subject||'').substring(0,60)}`);
        }
        console.log(`  Recent runs:`);
        if (runs.rows.length === 0) console.log('    NONE');
        for (const r of runs.rows) {
            console.log(`    Run #${r.id} ${r.status} ${r.trigger_type}${r.error ? ' ERR:' + (r.error+'').substring(0,80) : ''}`);
        }
    }

    // Also check: are there BullMQ jobs stuck? Check queue stats via Redis
    console.log('\n=== OVERALL QUEUE HEALTH ===');
    const totalUnprocessed = await pool.query(
        `SELECT COUNT(*) as cnt FROM messages WHERE direction = 'inbound' AND processed_at IS NULL AND last_error IS NULL AND case_id IS NOT NULL`
    );
    const stuckRuns = await pool.query(
        `SELECT COUNT(*) as cnt FROM agent_runs WHERE status IN ('queued', 'running') AND started_at < NOW() - interval '30 minutes'`
    );
    console.log(`Unprocessed matched messages: ${totalUnprocessed.rows[0].cnt}`);
    console.log(`Stuck runs (queued/running >30min): ${stuckRuns.rows[0].cnt}`);

    await pool.end();
})();
