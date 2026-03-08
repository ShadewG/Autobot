const { Pool } = require("pg");
const pool = new Pool({ connectionString: "postgresql://postgres:EsoRieVyRUVqLZEaGcecTqCDALRGxXXH@switchback.proxy.rlwy.net:39529/railway" });

(async () => {
  const ids = [25211, 25159, 25161, 25169];
  for (const id of ids) {
    const c = await pool.query(`
      SELECT c.id, c.case_name, c.agency_name, c.agency_email, c.status, c.substatus,
             c.portal_url, c.requires_human, c.pause_reason
      FROM cases c WHERE c.id = $1
    `, [id]);
    const r = c.rows[0];

    const outbound = await pool.query(`SELECT COUNT(*) as cnt FROM messages WHERE case_id = $1 AND direction = 'outbound'`, [id]);
    const inbound = await pool.query(`SELECT COUNT(*) as cnt FROM messages WHERE case_id = $1 AND direction = 'inbound'`, [id]);
    const portals = await pool.query(`SELECT COUNT(*) as cnt FROM portal_tasks WHERE case_id = $1`, [id]);
    const lastAct = await pool.query(`SELECT description FROM activity_log WHERE case_id = $1 ORDER BY created_at DESC LIMIT 1`, [id]);

    console.log(`\n=== #${r.id} ===`);
    console.log(`  agency: ${r.agency_name} | email: ${r.agency_email}`);
    console.log(`  status: ${r.status} | sub: ${r.substatus}`);
    console.log(`  portal: ${r.portal_url || "none"}`);
    console.log(`  msgs out: ${outbound.rows[0].cnt} in: ${inbound.rows[0].cnt} | portals: ${portals.rows[0].cnt}`);
    console.log(`  last: ${(lastAct.rows[0]?.description || "").slice(0, 150)}`);
  }
  await pool.end();
})();
