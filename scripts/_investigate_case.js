const db = require("../services/database");

async function investigate() {
    const caseId = 25136;

    const caseResult = await db.query("SELECT * FROM cases WHERE id = $1", [caseId]);
    const c = caseResult.rows[0];
    if (!c) { console.log("Case not found"); process.exit(0); }

    console.log("=== CASE #" + caseId + " ===");
    console.log("  case_name:", c.case_name);
    console.log("  subject_name:", c.subject_name);
    console.log("  agency_name:", c.agency_name);
    console.log("  agency_email:", c.agency_email);
    console.log("  status:", c.status);
    console.log("  portal_url:", c.portal_url);
    console.log("  portal_provider:", c.portal_provider);
    console.log("  state:", c.state);
    console.log("  incident_location:", c.incident_location);
    console.log("  alternate_agency_email:", c.alternate_agency_email);
    console.log("  contact_research_notes:", c.contact_research_notes);
    console.log("  last_contact_research_at:", c.last_contact_research_at);
    console.log("  created_at:", c.created_at);

    console.log("\n=== PROPOSALS ===");
    const proposals = await db.query("SELECT * FROM proposals WHERE case_id = $1 ORDER BY created_at DESC", [caseId]);
    for (const p of proposals.rows) {
        console.log("---");
        console.log("  id:", p.id);
        console.log("  action_type:", p.action_type);
        console.log("  status:", p.status);
        console.log("  summary:", p.summary);
        console.log("  proposed_content:", (p.proposed_content || "").substring(0, 800));
        console.log("  details:", JSON.stringify(p.details, null, 2));
        console.log("  reasoning:", p.reasoning);
        console.log("  created_at:", p.created_at);
    }

    console.log("\n=== AGENT DECISIONS ===");
    const decisions = await db.query("SELECT * FROM agent_decisions WHERE case_id = $1 ORDER BY created_at DESC LIMIT 5", [caseId]);
    for (const d of decisions.rows) {
        console.log("---");
        console.log("  id:", d.id);
        console.log("  decision_type:", d.decision_type);
        console.log("  action:", d.action);
        console.log("  reasoning:", (d.reasoning || "").substring(0, 500));
        console.log("  created_at:", d.created_at);
    }

    console.log("\n=== RECENT ACTIVITY ===");
    const activity = await db.query(
        "SELECT * FROM activity_log WHERE details::text LIKE $1 ORDER BY created_at DESC LIMIT 10",
        ["%" + caseId + "%"]
    );
    for (const a of activity.rows) {
        console.log("---");
        console.log("  type:", a.activity_type);
        console.log("  description:", a.description);
        console.log("  details:", JSON.stringify(a.details));
        console.log("  created_at:", a.created_at);
    }

    console.log("\n=== MESSAGES ===");
    const msgs = await db.query(
        "SELECT id, direction, from_email, to_email, subject, body_text, created_at FROM messages WHERE case_id = $1 ORDER BY created_at DESC LIMIT 5",
        [caseId]
    );
    for (const m of msgs.rows) {
        console.log("---");
        console.log("  id:", m.id, "| direction:", m.direction);
        console.log("  from:", m.from_email);
        console.log("  to:", m.to_email);
        console.log("  subject:", m.subject);
        console.log("  body (first 500):", (m.body_text || "").substring(0, 500));
        console.log("  created_at:", m.created_at);
    }

    process.exit(0);
}

investigate().catch(err => { console.error(err.message); process.exit(1); });
