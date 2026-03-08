const { Pool } = require("pg");
const pool = new Pool({ connectionString: "postgresql://postgres:EsoRieVyRUVqLZEaGcecTqCDALRGxXXH@switchback.proxy.rlwy.net:39529/railway" });

async function fixCase(id, updates, reason) {
  const sets = Object.entries(updates).map(([k, v], i) => `${k} = $${i + 2}`);
  const vals = Object.values(updates);
  await pool.query(`UPDATE cases SET ${sets.join(", ")} WHERE id = $1`, [id, ...vals]);
  await pool.query(
    `INSERT INTO activity_log (case_id, event_type, description) VALUES ($1, 'manual_fix', $2)`,
    [id, reason]
  );
  console.log(`  Fixed #${id}: ${reason}`);
}

(async () => {
  console.log("=== FIXING REMAINING STALE CASES ===\n");

  // #25210 - generic agency name, 3 portal tasks, 0 outbound
  console.log("#25210 - Esteban Avila-Vega / 'Police Department'");
  await fixCase(25210, {
    status: "needs_human_review",
    substatus: "Generic agency name. 3 portal tasks, 0 outbound. Fix agency.",
    pause_reason: "UNSPECIFIED",
    requires_human: true,
  }, "Fixed stale: generic agency 'Police Department', 3 failed portals, 0 outbound. Needs agency correction.");

  // #25140 - Lawrence County SO - responded + agency_research_complete
  console.log("#25140 - Timothy McCary / Lawrence County SO");
  await fixCase(25140, {
    status: "needs_human_review",
    substatus: "Responded but stuck at agency_research_complete. Reprocess.",
    pause_reason: "UNSPECIFIED",
    requires_human: true,
  }, "Fixed stale: responded but idle at agency_research_complete. Moved to human review.");

  // #25169 - Porter County 911 - email send failing
  console.log("#25169 - Porter County 911");
  await fixCase(25169, {
    substatus: "Email send failing. Agency has records ready, needs form.",
    pause_reason: "UNSPECIFIED",
  }, "Updated substatus: email send tool failing. Agency has records ready.");

  // #25159 - Madison County SO - deadline passed
  console.log("#25159 - Paula Plemmons / Madison County SO");
  await fixCase(25159, {
    status: "needs_human_review",
    substatus: "Deadline passed 5+ days ago. 2 sent, 0 responses. Follow up.",
    pause_reason: "UNSPECIFIED",
    requires_human: true,
  }, "Fixed stale: deadline passed 5+ days ago, no response, no active run. Moved to human review.");

  // #25161 - Bryan PD - fee negotiation sent, stale
  console.log("#25161 - Brandon Dickerson / Bryan PD");
  await fixCase(25161, {
    status: "needs_human_review",
    substatus: "Fee negotiation sent, stale. DECLINE_FEE dismissed. Review.",
    pause_reason: "FEE_QUOTE",
    requires_human: true,
  }, "Fixed stale: fee negotiation sent but idle after manual proposal dismissal.");

  // #25211 - Kearney PD - phone call deferred
  console.log("#25211 - Karen Geisler / Kearney PD");
  await fixCase(25211, {
    status: "needs_human_review",
    substatus: "Phone call deferred to next week. Portal + 5 inbound.",
    pause_reason: "UNSPECIFIED",
    requires_human: true,
  }, "Fixed stale: phone call deferred 24h+ ago with no active run. Moved to human review.");

  console.log("\n=== DONE ===");

  // Verify all 10
  const result = await pool.query(`
    SELECT id, status, substatus, requires_human
    FROM cases
    WHERE id IN (25166, 25152, 25164, 25153, 25210, 25140, 25169, 25159, 25161, 25211)
    ORDER BY id
  `);
  console.log("\nVerification:");
  result.rows.forEach(r => console.log(`  #${r.id}: ${r.status} | ${(r.substatus || "").slice(0, 70)} | human: ${r.requires_human}`));

  await pool.end();
})();
