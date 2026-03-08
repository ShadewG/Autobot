const { Pool } = require("pg");
const pool = new Pool({ connectionString: "postgresql://postgres:EsoRieVyRUVqLZEaGcecTqCDALRGxXXH@switchback.proxy.rlwy.net:39529/railway" });
const API_BASE = "https://sincere-strength-production.up.railway.app";

async function approveProposal(pid) {
  const res = await fetch(`${API_BASE}/api/monitor/proposals/${pid}/decision`, {
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
  // 1. Approve all pending RESEARCH_AGENCY proposals
  const proposals = [886, 892, 894, 895, 896, 897, 899];
  console.log("=== APPROVING RESEARCH PROPOSALS (ROUND 2) ===");
  for (const pid of proposals) {
    try {
      await approveProposal(pid);
      console.log(`  Approved #${pid}`);
    } catch (e) {
      console.log(`  Failed #${pid}: ${e.message}`);
    }
  }

  // 2. Fix #25210 - use research_agency action instead of custom
  console.log("\n=== FIXING #25210 ===");
  await pool.query(`
    UPDATE cases SET
      status = 'needs_human_review',
      substatus = 'Need Norcross PD GA contact research.',
      pause_reason = 'UNSPECIFIED',
      requires_human = true
    WHERE id = 25210
  `);
  // Use research_agency action directly instead of custom
  await resolveReview(25210, "research_agency", "Research the correct contact information for Norcross Police Department, Gwinnett County, Georgia. Find their email and/or records request portal.");
  console.log("  Reprocessed #25210 with research_agency action");

  console.log("\n=== DONE ===");
  await pool.end();
})();
