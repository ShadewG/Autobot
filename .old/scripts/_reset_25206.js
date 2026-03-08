const { Pool } = require("pg");
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  const c = await pool.query("SELECT constraints FROM cases WHERE id = 25206");
  console.log("Constraints:", c.rows[0]?.constraints);

  await pool.query("UPDATE proposals SET human_decision = NULL WHERE id = 517");
  console.log("Cleared human_decision on #517");

  const constraints = c.rows[0]?.constraints || [];
  const filtered = constraints.filter(con => con.indexOf("RESEARCH") === -1);
  if (filtered.length !== constraints.length) {
    await pool.query("UPDATE cases SET constraints = $1 WHERE id = 25206", [filtered]);
    console.log("Removed RESEARCH constraints. Remaining:", filtered);
  } else {
    console.log("No RESEARCH constraints to remove");
  }

  pool.end();
}
main().catch(e => { console.error(e); process.exit(1); });
