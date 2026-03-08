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

(async () => {
  // Approve all pending RESEARCH_AGENCY proposals
  const proposals = [856, 858, 861, 864, 867, 869, 870];
  console.log("=== APPROVING ALL RESEARCH PROPOSALS ===");
  for (const pid of proposals) {
    try {
      await approveProposal(pid);
      console.log(`  Approved #${pid}`);
    } catch (e) {
      console.log(`  Failed #${pid}: ${e.message}`);
    }
  }
  console.log("\nDone");
})();
