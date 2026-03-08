const { Pool } = require("pg");
const pool = new Pool({ connectionString: "postgresql://postgres:EsoRieVyRUVqLZEaGcecTqCDALRGxXXH@switchback.proxy.rlwy.net:39529/railway" });

(async () => {
  for (const id of [25243, 25246, 25249, 25250, 25252]) {
    const c = await pool.query(`
      SELECT id, agency_name, contact_research_notes
      FROM cases WHERE id = $1
    `, [id]);
    const r = c.rows[0];
    const notes = r.contact_research_notes;
    let parsed = null;
    if (typeof notes === "string") {
      try { parsed = JSON.parse(notes); } catch {}
    } else {
      parsed = notes;
    }

    console.log(`\n=== #${id} ${r.agency_name} ===`);
    if (parsed) {
      console.log(JSON.stringify(parsed, null, 2).slice(0, 800));
    } else {
      console.log("No parsed research notes");
    }
  }

  await pool.end();
})();
