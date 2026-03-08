const API_BASE = "https://sincere-strength-production.up.railway.app";
const { Pool } = require("pg");
const pool = new Pool({ connectionString: "postgresql://postgres:EsoRieVyRUVqLZEaGcecTqCDALRGxXXH@switchback.proxy.rlwy.net:39529/railway" });

async function approveProposal(proposalId) {
  const res = await fetch(`${API_BASE}/api/monitor/proposals/${proposalId}/decision`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "APPROVE" }),
  });
  const data = await res.json();
  if (!res.ok || !data.success) throw new Error(data.error || `Failed (${res.status})`);
  return data;
}

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
  // 1. Approve RESEARCH_AGENCY proposals for new cases
  const researchProposals = [854, 849, 852]; // 25246, 25252, 25253
  console.log("=== APPROVING RESEARCH PROPOSALS ===");
  for (const pid of researchProposals) {
    try {
      await approveProposal(pid);
      console.log(`  Approved #${pid}`);
    } catch (e) {
      console.log(`  Failed #${pid}: ${e.message}`);
    }
  }

  // 2. Fix #25164 — stuck at no-action. Force it into human review with clearer instruction
  console.log("\n=== FIXING #25164 (Mobile PD) ===");
  try {
    await pool.query(`
      UPDATE cases SET
        status = 'needs_human_review',
        substatus = 'No-action path twice. Has JustFOIA portal + email. Send initial request.',
        pause_reason = 'UNSPECIFIED',
        requires_human = true
      WHERE id = 25164
    `);
    await pool.query(`INSERT INTO activity_log (case_id, event_type, description) VALUES (25164, 'manual_fix', 'Stuck at no-action path after reprocess. Re-flagging for human review with stronger instruction.')`)
    await resolveReview(25164, "custom", "IMPORTANT: You must send the initial FOIA records request NOW. Use the JustFOIA portal at mobileal.justfoia.com/publicportal to submit, or email recordsrequests@cityofmobile.org. Do NOT choose no-action. The request has never been sent.");
    console.log("  Fixed and reprocessed #25164");
  } catch (e) {
    console.log(`  Failed: ${e.message}`);
  }

  console.log("\n=== DONE ===");
  await pool.end();
})();
