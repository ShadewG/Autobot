require("dotenv").config();
const { Pool } = require("pg");
const pool = new Pool({ connectionString: process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL });

(async () => {
  try {
    const r = await pool.query(
      `SELECT c.id, c.status,
        (SELECT count(*)::int FROM messages m WHERE m.case_id = c.id AND m.direction = 'inbound') as inbound_count,
        (SELECT count(*)::int FROM proposals p WHERE p.case_id = c.id AND p.status = 'PENDING_APPROVAL') as pending_proposals,
        (SELECT count(*)::int FROM agent_runs ar WHERE ar.case_id = c.id AND ar.status IN ('created', 'queued', 'running')) as active_runs
      FROM cases c
      WHERE (c.agent_handled IS NULL OR c.agent_handled = false)
        AND c.status != 'completed'
      ORDER BY c.id`
    );
    const catA = [], catB = [], catD = [];
    let catC = 0, catE = 0;
    r.rows.forEach(c => {
      if (c.inbound_count > 0 && c.pending_proposals === 0) catA.push(c);
      else if (c.pending_proposals > 0) catB.push(c);
      else if (["sent","awaiting_response"].includes(c.status) && c.inbound_count === 0) catC++;
      else if (["needs_phone_call"].includes(c.status)) catE++;
      else catD.push(c);
    });
    console.log("Cat A (inbound msgs, no pending proposal - NEED run-inbound): " + catA.length);
    catA.forEach(c => console.log("  #" + c.id + " " + c.status + " inbound=" + c.inbound_count + " active=" + c.active_runs));
    console.log("\nCat B (have pending proposals already): " + catB.length);
    catB.forEach(c => console.log("  #" + c.id + " " + c.status + " proposals=" + c.pending_proposals));
    console.log("\nCat C (sent/awaiting, no inbound - skip): " + catC);
    console.log("\nCat D (other states, no inbound): " + catD.length);
    catD.forEach(c => console.log("  #" + c.id + " " + c.status));
    console.log("\nCat E (needs_phone_call - skip): " + catE);
  } catch(e) { console.error(e.message); }
  pool.end();
})();
