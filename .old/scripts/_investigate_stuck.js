const { Pool } = require("pg");
const pool = new Pool({ connectionString: "postgresql://postgres:EsoRieVyRUVqLZEaGcecTqCDALRGxXXH@switchback.proxy.rlwy.net:39529/railway" });

(async () => {
  // Check activity_log columns first
  const cols = await pool.query(`
    SELECT column_name FROM information_schema.columns
    WHERE table_name = 'activity_log' ORDER BY ordinal_position
  `);
  console.log("activity_log columns:", cols.rows.map(r => r.column_name).join(", "));

  for (const id of [25164, 25153, 25211]) {
    const c = await pool.query(`SELECT agency_name, case_name FROM cases WHERE id = $1`, [id]);
    const logs = await pool.query(`
      SELECT event_type, description, created_at
      FROM activity_log WHERE case_id = $1
      ORDER BY created_at DESC LIMIT 8
    `, [id]);

    console.log(`\n#${id} ${c.rows[0].agency_name}`);
    console.log(`  Case: ${(c.rows[0].case_name || "").slice(0, 80)}`);
    console.log("  Recent activity:");
    for (const l of logs.rows) {
      const ts = new Date(l.created_at).toISOString().slice(0, 16);
      console.log(`    [${ts}] ${l.event_type}: ${(l.description || "").slice(0, 130)}`);
    }
  }

  await pool.end();
})();
