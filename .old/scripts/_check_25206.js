const { Pool } = require("pg");
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  const p = await pool.query("SELECT id, action_type, status, reasoning, draft_subject, draft_body_text, waitpoint_token, gate_options FROM proposals WHERE case_id = 25206 AND status = $1 LIMIT 1", ["PENDING_APPROVAL"]);
  const prop = p.rows[0];
  if (!prop) {
    console.log("No PENDING_APPROVAL proposal found");
    pool.end();
    return;
  }
  console.log("Proposal #" + prop.id);
  console.log("  action_type:", prop.action_type);
  console.log("  status:", prop.status);
  console.log("  gate_options:", JSON.stringify(prop.gate_options));
  console.log("  has_waitpoint:", prop.waitpoint_token ? "yes" : "no");
  console.log("  reasoning:", JSON.stringify(prop.reasoning));
  console.log("  draft_subject:", prop.draft_subject);
  console.log("  draft_body:", (prop.draft_body_text || "null").substring(0, 300));
  pool.end();
}
main().catch(e => { console.error(e); pool.end(); });
