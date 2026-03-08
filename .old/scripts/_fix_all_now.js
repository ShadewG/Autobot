const { Pool } = require("pg");
const pool = new Pool({ connectionString: "postgresql://postgres:EsoRieVyRUVqLZEaGcecTqCDALRGxXXH@switchback.proxy.rlwy.net:39529/railway" });

async function log(id, msg) {
  await pool.query(`INSERT INTO activity_log (case_id, event_type, description) VALUES ($1, 'manual_fix', $2)`, [id, msg]);
}

(async () => {
  // ──────────────────────────────────────────────
  // 1. Check all the new cases with "Police Department" generic agency
  // ──────────────────────────────────────────────
  const newCases = await pool.query(`
    SELECT c.id, c.case_name, c.agency_name, c.agency_email, c.status, c.substatus,
           c.portal_url, c.state,
           (SELECT p.action_type FROM proposals p WHERE p.case_id = c.id ORDER BY p.created_at DESC LIMIT 1) as last_proposal_action,
           (SELECT p.reasoning FROM proposals p WHERE p.case_id = c.id ORDER BY p.created_at DESC LIMIT 1) as last_reasoning
    FROM cases c
    WHERE c.id IN (25253, 25252, 25250, 25249, 25246, 25243)
    ORDER BY c.id
  `);

  console.log("=== NEW CASES FROM RESEARCH TOOL ===\n");
  for (const r of newCases.rows) {
    console.log(`#${r.id} ${(r.case_name || "").slice(0, 80)}`);
    console.log(`  agency: ${r.agency_name} | email: ${r.agency_email} | state: ${r.state}`);
    console.log(`  status: ${r.status} | sub: ${r.substatus}`);
    console.log(`  portal: ${r.portal_url || "none"}`);
    console.log(`  last proposal: ${r.last_proposal_action}`);
    console.log(`  reasoning: ${(JSON.stringify(r.last_reasoning) || "").slice(0, 200)}`);
    console.log();
  }

  // ──────────────────────────────────────────────
  // 2. Check the stale cases that are now in needs_human_review
  //    and trigger reprocess via resolve-review API
  // ──────────────────────────────────────────────
  const staleCases = [25152, 25164, 25153, 25210, 25140, 25159, 25161, 25211, 25169];

  console.log("=== STALE CASES STATUS ===\n");
  for (const id of staleCases) {
    const c = await pool.query(`
      SELECT id, case_name, agency_name, agency_email, status, substatus, portal_url,
             pause_reason, requires_human
      FROM cases WHERE id = $1
    `, [id]);
    const r = c.rows[0];
    console.log(`#${r.id} ${r.status} | ${r.agency_name} | sub: ${(r.substatus||"").slice(0,60)}`);
  }

  await pool.end();
})();
