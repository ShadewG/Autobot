const { Client } = require("pg");
const c = new Client("postgresql://postgres:EsoRieVyRUVqLZEaGcecTqCDALRGxXXH@switchback.proxy.rlwy.net:39529/railway");

async function main() {
  await c.connect();

  const r = await c.query(`
    SELECT c.id, c.case_name, c.agency_name, c.status, c.pause_reason,
           c.requires_human, c.autopilot_mode, c.state,
           c.updated_at,
           p.id as proposal_id, p.action_type, p.status as proposal_status,
           LEFT(p.draft_subject, 60) as draft_subject,
           p.draft_body_text IS NOT NULL as has_draft,
           LEFT(p.reasoning::text, 200) as reasoning,
           p.created_at as proposal_created
    FROM cases c
    LEFT JOIN LATERAL (
      SELECT * FROM proposals
      WHERE case_id = c.id
      ORDER BY created_at DESC LIMIT 1
    ) p ON true
    WHERE c.status NOT IN ('closed', 'withdrawn', 'completed')
    ORDER BY c.id
  `);

  console.log("Total active cases:", r.rows.length);
  console.log("");

  const issues = [];

  for (const row of r.rows) {
    let flag = "";
    const noDraft = row.has_draft === false;
    if (row.proposal_status === "PENDING_APPROVAL" && row.action_type === "ESCALATE") {
      flag = " *** STUCK ESCALATE ***";
      issues.push({ id: row.id, issue: "STUCK_ESCALATE", name: row.case_name });
    } else if (row.proposal_status === "PENDING_APPROVAL" && noDraft && (row.action_type || "").startsWith("SEND")) {
      flag = " *** NO DRAFT ***";
      issues.push({ id: row.id, issue: "NO_DRAFT", name: row.case_name });
    } else if (row.status === "needs_human_review" && row.proposal_status !== "PENDING_APPROVAL") {
      flag = " [needs review but no pending proposal]";
      issues.push({ id: row.id, issue: "REVIEW_NO_PROPOSAL", name: row.case_name });
    }

    console.log(`Case ${row.id}: ${(row.case_name || "").substring(0, 60)}`);
    console.log(`  Status: ${row.status} | Pause: ${row.pause_reason || "none"} | Autopilot: ${row.autopilot_mode}`);
    console.log(`  Latest proposal: ${row.action_type || "none"} (${row.proposal_status || "n/a"}) | Has draft: ${row.has_draft}${flag}`);
    if (row.reasoning) console.log(`  Reasoning: ${row.reasoning.substring(0, 150)}`);
    console.log("");
  }

  // Also count proposals per case to detect churn
  const churn = await c.query(`
    SELECT case_id, COUNT(*) as total_proposals,
           COUNT(*) FILTER (WHERE status = 'DISMISSED') as dismissed,
           COUNT(*) FILTER (WHERE action_type = 'ESCALATE') as escalate_count
    FROM proposals
    WHERE case_id IN (SELECT id FROM cases WHERE status NOT IN ('closed', 'withdrawn', 'completed'))
    GROUP BY case_id
    HAVING COUNT(*) > 5 OR COUNT(*) FILTER (WHERE action_type = 'ESCALATE') > 2
    ORDER BY COUNT(*) DESC
  `);

  if (churn.rows.length > 0) {
    console.log("=== HIGH CHURN / REPEATED ESCALATION CASES ===");
    for (const ch of churn.rows) {
      console.log(`  Case ${ch.case_id}: ${ch.total_proposals} proposals, ${ch.dismissed} dismissed, ${ch.escalate_count} escalations`);
    }
    console.log("");
  }

  console.log("=== SUMMARY OF ISSUES ===");
  if (issues.length === 0) {
    console.log("No issues detected.");
  } else {
    for (const i of issues) {
      console.log(`  Case ${i.id} [${i.issue}]: ${(i.name || "").substring(0, 50)}`);
    }
  }

  await c.end();
}

main().catch(e => { console.error(e); process.exit(1); });
