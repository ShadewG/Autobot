const { Pool } = require("pg");
const pool = new Pool({ connectionString: "postgresql://postgres:EsoRieVyRUVqLZEaGcecTqCDALRGxXXH@switchback.proxy.rlwy.net:39529/railway" });

(async () => {
  for (const id of [25164, 25153, 25211]) {
    const c = await pool.query(`
      SELECT id, agency_name, status, substatus, pause_reason,
             portal_url, portal_provider, last_portal_status, agency_email
      FROM cases WHERE id = $1
    `, [id]);
    const r = c.rows[0];

    // Get latest run details
    const run = await pool.query(`
      SELECT id, status, trigger_type, metadata FROM agent_runs
      WHERE case_id = $1 ORDER BY updated_at DESC LIMIT 1
    `, [id]);
    const lr = run.rows[0];

    // Get inbound messages
    const msgs = await pool.query(`
      SELECT id, subject, body_text, direction, created_at FROM messages
      WHERE case_id = $1 ORDER BY created_at DESC LIMIT 3
    `, [id]);

    // Get classification from latest run metadata
    const meta = lr?.metadata;

    console.log(`\n=== #${id} ${r.agency_name} ===`);
    // classification is in run metadata, not cases table
    console.log(`  status: ${r.status} | substatus: ${r.substatus}`);
    console.log(`  pause_reason: ${r.pause_reason}`);
    console.log(`  portal: ${r.portal_url || "none"} | provider: ${r.portal_provider || "none"} | last_status: ${r.last_portal_status || "none"}`);
    console.log(`  email: ${r.agency_email}`);
    console.log(`  latest run: #${lr?.id} ${lr?.status} ${lr?.trigger_type}`);
    console.log(`  run metadata: ${JSON.stringify(meta)?.slice(0, 300)}`);
    console.log(`  messages (${msgs.rows.length}):`);
    for (const m of msgs.rows) {
      console.log(`    [${m.direction}] ${(m.subject || "").slice(0, 60)} | ${(m.body_text || "").slice(0, 100)}`);
    }
  }

  await pool.end();
})();
