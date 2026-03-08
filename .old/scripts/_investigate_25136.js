require("dotenv").config();
const db = require("../services/database");

(async () => {
  const c = await db.query("SELECT * FROM cases WHERE id = 25136");
  console.log("=== CASE #25136 ===");
  const row = c.rows[0];
  if (!row) { console.log("NOT FOUND"); process.exit(0); }
  console.log("Name:", row.case_name);
  console.log("Agency:", row.agency_name, "|", row.agency_email);
  console.log("Subject:", row.subject_name);
  console.log("State:", row.state);
  console.log("Status:", row.status, "|", row.substatus);
  console.log("Portal:", row.portal_url);
  console.log("Records:", row.requested_records);
  console.log("Scope items:", JSON.stringify(row.scope_items_jsonb));
  console.log("Send date:", row.send_date);
  console.log("Created:", row.created_at);

  const msgs = await db.query("SELECT id, direction, from_email, to_email, subject, message_type, sent_at, received_at, LEFT(body_text, 200) AS preview FROM messages WHERE case_id = 25136 ORDER BY COALESCE(received_at, sent_at, created_at) ASC");
  console.log("\n=== MESSAGES ===");
  msgs.rows.forEach(m => {
    console.log("  #" + m.id + " " + m.direction + " | " + m.from_email + " -> " + m.to_email);
    console.log("    Subject:", m.subject);
    console.log("    Type:", m.message_type, "| Date:", m.sent_at || m.received_at);
    console.log("    Preview:", (m.preview || "").substring(0, 150));
    console.log("");
  });

  const proposals = await db.query("SELECT * FROM proposals WHERE case_id = 25136 ORDER BY created_at DESC");
  console.log("=== PROPOSALS ===");
  proposals.rows.forEach(p => {
    console.log("  #" + p.id + " | " + p.action_type + " | status: " + p.status);
    console.log("    confidence:", p.confidence);
    console.log("    draft_subject:", p.draft_subject);
    console.log("    draft_body:", (p.draft_body_text || "NULL").substring(0, 150));
    console.log("    trigger_message_id:", p.trigger_message_id);
    console.log("    run_id:", p.run_id);
    console.log("    created:", p.created_at);
    console.log("");
  });

  const runs = await db.query("SELECT id, trigger_type, status, started_at, ended_at, error, message_id, proposal_id FROM agent_runs WHERE case_id = 25136 ORDER BY started_at DESC");
  console.log("=== AGENT RUNS ===");
  runs.rows.forEach(r => {
    console.log("  run #" + r.id + " | " + r.trigger_type + " | " + r.status);
    console.log("    started:", r.started_at, "| ended:", r.ended_at);
    console.log("    error:", r.error);
    console.log("    msg:", r.message_id, "| proposal:", r.proposal_id);
    console.log("");
  });

  const analyses = await db.query("SELECT ra.id, ra.message_id, ra.intent, ra.confidence_score, ra.full_analysis_json->>'summary' AS summary FROM response_analysis ra WHERE ra.case_id = 25136 ORDER BY ra.created_at");
  console.log("=== ANALYSES ===");
  analyses.rows.forEach(a => {
    console.log("  analysis #" + a.id + " msg #" + a.message_id + " | intent: " + a.intent + " | conf: " + a.confidence_score);
    console.log("    summary:", a.summary);
  });

  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
