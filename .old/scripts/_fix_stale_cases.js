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
  console.log("=== FIXING STALE CASES ===\n");

  // #25166 - "Closed by user" but awaiting_response with 0 msgs. Should be closed.
  console.log("#25166 - Altonio Johnson / Wilmington PD - Closed by user, no outbound");
  await fixCase(25166, {
    status: "closed",
    substatus: "Closed by user",
    requires_human: false,
    pause_reason: null,
  }, "Fixed stale case: was awaiting_response with 0 outbound and substatus 'Closed by user'. Marked closed.");

  // #25152 - "On hold (manual)" but awaiting_response with 0 msgs. Put in review.
  console.log("#25152 - John-Bayleigh Smith / Roanoke PD - On hold, no outbound");
  await fixCase(25152, {
    status: "needs_human_review",
    substatus: "On hold — never sent initial request. Has portal + email. Ready to send.",
    pause_reason: "UNSPECIFIED",
    requires_human: true,
  }, "Fixed stale case: was awaiting_response with 0 outbound msgs. Never sent. Moved to human review.");

  // #25164 - Mobile PD - "Reset to inbound; reprocessing" but no-action path, 0 outbound, has inbound
  console.log("#25164 - Isaac Parker / Mobile PD - Reset to inbound, no-action path, 0 outbound");
  await fixCase(25164, {
    status: "needs_human_review",
    substatus: "Stuck after reprocess — has inbound but never sent outbound. Has portal (JustFOIA).",
    pause_reason: "UNSPECIFIED",
    requires_human: true,
  }, "Fixed stale case: no-action path after reprocess, 0 outbound. Has portal + inbound. Moved to human review.");

  // #25153 - Columbia County SO - same pattern as 25164
  console.log("#25153 - Jason Kijewski / Columbia County SO - Reset to inbound, no-action, 0 outbound");
  await fixCase(25153, {
    status: "needs_human_review",
    substatus: "Stuck after reprocess — has inbound but never sent outbound. Has portal + email.",
    pause_reason: "UNSPECIFIED",
    requires_human: true,
  }, "Fixed stale case: no-action path after reprocess, 0 outbound. Has portal + email. Moved to human review.");

  // #25210 - "Police Department" generic agency name, has 3 portal tasks but 0 outbound
  console.log("#25210 - Esteban Avila-Vega / 'Police Department' - generic agency, 3 portal tasks, 0 outbound");
  await fixCase(25210, {
    status: "needs_human_review",
    substatus: "Stuck — generic agency name 'Police Department', 3 portal tasks but 0 outbound. Needs agency correction.",
    pause_reason: "UNSPECIFIED",
    requires_human: true,
  }, "Fixed stale case: generic agency name, 3 failed portal tasks, 0 outbound. Moved to human review for agency correction.");

  // #25140 - Lawrence County SO - responded + agency_research_complete, has outbound+inbound
  // This one actually has messages. It's "responded" which is valid. But substatus
  // agency_research_complete suggests it got stuck after research. Needs reprocess.
  console.log("#25140 - Timothy McCary / Lawrence County SO - responded + agency_research_complete, no active run");
  await fixCase(25140, {
    status: "needs_human_review",
    substatus: "Agency responded but stuck at agency_research_complete with no active run. Needs reprocess.",
    pause_reason: "UNSPECIFIED",
    requires_human: true,
  }, "Fixed stale case: responded but idle at agency_research_complete. Moved to human review for reprocess.");

  // #25169 - Porter County 911 - needs_human_review but stuck at "Resolving: reprocess"
  // Email send tool was failing. Already in human review. Just update substatus.
  console.log("#25169 - Porter County 911 - already in review, email send failing");
  await fixCase(25169, {
    substatus: "Email send tool failing — agency has records ready, needs APRA form + delivery method. Try resend or manual.",
    pause_reason: "UNSPECIFIED",
  }, "Updated substatus: email send tool was failing. Agency has records ready.");

  // #25159 - Madison County SO - awaiting_response, 2 outbound, deadline passed
  // Has sent messages. Deadline passed. Research proposal dismissed. Needs follow-up.
  console.log("#25159 - Paula Plemmons / Madison County SO - deadline passed, 5 days stale");
  await fixCase(25159, {
    status: "needs_human_review",
    substatus: "Deadline passed (1d overdue as of 5 days ago). 2 emails sent, 0 responses. Needs follow-up.",
    pause_reason: "UNSPECIFIED",
    requires_human: true,
  }, "Fixed stale case: deadline passed 5+ days ago with no response and no active run. Moved to human review.");

  // #25161 - Bryan PD - fee_negotiation_sent, stale DECLINE_FEE dismissed
  // Has 1 outbound, 2 inbound. Fee negotiation was sent. Waiting for response is valid
  // but it's been 27+ hours with a dismissed proposal and no active run.
  console.log("#25161 - Brandon Dickerson / Bryan PD - fee negotiation sent, stale");
  await fixCase(25161, {
    status: "needs_human_review",
    substatus: "Fee negotiation sent but stale — DECLINE_FEE proposal was manually dismissed. Needs review.",
    pause_reason: "FEE_QUOTE",
    requires_human: true,
  }, "Fixed stale case: fee negotiation sent but idle after manual proposal dismissal. Moved to human review.");

  // #25211 - Kearney PD - phone call deferred to next week, has portal + inbound
  // "Phone call: connected — retry" — phone call was made but deferred. Valid hold state
  // but it's been 24h. Flag for review.
  console.log("#25211 - Karen Geisler / Kearney PD - phone call deferred, 24h+ stale");
  await fixCase(25211, {
    status: "needs_human_review",
    substatus: "Phone call connected but deferred to next week. Has portal + 5 inbound. Review if ready to proceed.",
    pause_reason: "UNSPECIFIED",
    requires_human: true,
  }, "Fixed stale case: phone call deferred, 24h+ idle with no active run. Moved to human review.");

  console.log("\n=== DONE — All 10 stale cases fixed ===");

  // Verify
  const result = await pool.query(`
    SELECT id, status, substatus, requires_human
    FROM cases
    WHERE id IN (25166, 25152, 25164, 25153, 25210, 25140, 25169, 25159, 25161, 25211)
    ORDER BY id
  `);
  console.log("\nVerification:");
  result.rows.forEach(r => console.log(`  #${r.id}: ${r.status} | ${(r.substatus || "").slice(0, 80)} | human: ${r.requires_human}`));

  await pool.end();
})();
