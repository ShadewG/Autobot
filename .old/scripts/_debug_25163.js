const { Pool } = require("pg");
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

(async () => {
  const thread = (await pool.query("SELECT id FROM email_threads WHERE case_id = 25163")).rows[0];

  if (thread) {
    const msgs = (await pool.query("SELECT id, direction, from_email, to_email, subject, body_text, sent_at FROM messages WHERE thread_id = $1 ORDER BY sent_at DESC LIMIT 5", [thread.id])).rows;
    console.log("=== MESSAGES ===");
    msgs.forEach(m => {
      console.log("---");
      console.log("id:", m.id, "| dir:", m.direction, "| from:", m.from_email);
      console.log("subject:", m.subject);
      console.log("sent_at:", m.sent_at);
      console.log("body:", (m.body_text || "").slice(0, 400));
    });
  } else {
    console.log("No thread found");
  }

  const decs = (await pool.query("SELECT id, reasoning, action_taken, confidence, trigger_type, outcome, created_at FROM agent_decisions WHERE case_id = 25163 ORDER BY created_at DESC LIMIT 5")).rows;
  console.log("\n=== AGENT DECISIONS ===");
  decs.forEach(d => {
    console.log("---");
    console.log("action:", d.action_taken, "| confidence:", d.confidence, "| trigger:", d.trigger_type);
    const r = typeof d.reasoning === "string" ? d.reasoning : JSON.stringify(d.reasoning);
    console.log("reasoning:", (r || "").slice(0, 400));
    console.log("outcome:", d.outcome);
    console.log("at:", d.created_at);
  });

  const analysis = (await pool.query("SELECT intent, key_points, sentiment FROM message_analysis WHERE message_id = 681")).rows[0];
  if (analysis) {
    console.log("\n=== ANALYSIS of msg 681 ===");
    console.log("intent:", analysis.intent);
    console.log("key_points:", JSON.stringify(analysis.key_points));
    console.log("sentiment:", analysis.sentiment);
  }

  const caseData = (await pool.query("SELECT constraints, scope_items, contact_research_notes FROM cases WHERE id = 25163")).rows[0];
  console.log("\n=== CONSTRAINTS ===");
  console.log(JSON.stringify(caseData.constraints, null, 2));

  await pool.end();
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
