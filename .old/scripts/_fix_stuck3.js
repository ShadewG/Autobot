const { Pool } = require("pg");
const pool = new Pool({ connectionString: "postgresql://postgres:EsoRieVyRUVqLZEaGcecTqCDALRGxXXH@switchback.proxy.rlwy.net:39529/railway" });
const API_BASE = "https://sincere-strength-production.up.railway.app";

async function resolveReview(caseId, action, instruction) {
  const res = await fetch(`${API_BASE}/api/requests/${caseId}/resolve-review`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action, instruction }),
  });
  const data = await res.json();
  if (!res.ok || !data.success) throw new Error(data.error || `Failed (${res.status})`);
  return data;
}

(async () => {
  // First, check what's going on with each stuck case
  for (const id of [25164, 25153, 25211]) {
    const c = await pool.query(`
      SELECT id, agency_name, agency_email, portal_url, status, substatus, state
      FROM cases WHERE id = $1
    `, [id]);
    const r = c.rows[0];

    const runs = await pool.query(`
      SELECT id, status, trigger_type, updated_at FROM agent_runs
      WHERE case_id = $1 ORDER BY updated_at DESC LIMIT 3
    `, [id]);

    const msgs = await pool.query(`
      SELECT direction, COUNT(*) as cnt FROM messages WHERE case_id = $1 GROUP BY direction
    `, [id]);

    console.log(`\n#${id} ${r.agency_name}`);
    console.log(`  email: ${r.agency_email} | portal: ${r.portal_url || "none"} | state: ${r.state}`);
    console.log(`  status: ${r.status} | sub: ${r.substatus}`);
    console.log(`  messages: ${msgs.rows.map(m => `${m.direction}:${m.cnt}`).join(", ") || "none"}`);
    console.log(`  recent runs: ${runs.rows.map(r => `#${r.id}(${r.status}/${r.trigger_type})`).join(", ")}`);
  }

  // Fix each one with very specific instructions
  console.log("\n=== FIXING STUCK CASES ===\n");

  // #25164 - Mobile PD - has email and portal, keeps choosing no-action
  console.log("#25164 - Mobile PD");
  await pool.query(`
    UPDATE cases SET
      status = 'needs_human_review',
      substatus = 'Must send FOIA. Use email or portal.',
      pause_reason = 'UNSPECIFIED',
      requires_human = true
    WHERE id = 25164
  `);
  await resolveReview(25164, "custom", "You MUST send the initial FOIA request to Mobile Police Department. Email: recordsrequests@cityofmobile.org. Send an email with the FOIA request. Do NOT choose no-action. The request has NEVER been sent.");
  console.log("  Reprocessed");

  // #25153 - Columbia County SO - has email, dismissed research proposal
  console.log("#25153 - Columbia County SO");
  await pool.query(`
    UPDATE cases SET
      status = 'needs_human_review',
      substatus = 'Must send FOIA. Use email.',
      pause_reason = 'UNSPECIFIED',
      requires_human = true
    WHERE id = 25153
  `);
  await resolveReview(25153, "custom", "You MUST send the initial records request to Columbia County Sheriff's Office. Email: openrecords@columbiacountywi.gov. Send an email with the open records request under Wisconsin law. Do NOT choose no-action. The request has NEVER been sent.");
  console.log("  Reprocessed");

  // #25211 - Kearney PD - phone call was deferred, portal submitted before
  console.log("#25211 - Kearney PD");
  await pool.query(`
    UPDATE cases SET
      status = 'needs_human_review',
      substatus = 'Portal submitted prev. Try email follow-up.',
      pause_reason = 'UNSPECIFIED',
      requires_human = true
    WHERE id = 25211
  `);
  await resolveReview(25211, "custom", "A portal submission was previously attempted for Kearney Police Department. Try sending a follow-up email to peynetich@kearneygov.org asking about the status of the records request. Do NOT choose no-action.");
  console.log("  Reprocessed");

  console.log("\n=== DONE ===");
  await pool.end();
})();
