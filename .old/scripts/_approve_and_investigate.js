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

(async () => {
  // 1. Approve all new RESEARCH_AGENCY proposals
  const proposals = [872, 877, 878, 879, 881, 882, 884];
  console.log("=== APPROVING NEW RESEARCH PROPOSALS ===");
  for (const pid of proposals) {
    try {
      await approveProposal(pid);
      console.log(`  Approved #${pid}`);
    } catch (e) {
      console.log(`  Failed #${pid}: ${e.message}`);
    }
  }

  // 2. Also approve the other pending proposals
  const otherProposals = [859, 862, 850, 847];
  console.log("\n=== APPROVING OTHER PENDING PROPOSALS ===");
  for (const pid of otherProposals) {
    try {
      await approveProposal(pid);
      console.log(`  Approved #${pid}`);
    } catch (e) {
      console.log(`  Failed #${pid}: ${e.message}`);
    }
  }

  // 3. Investigate stuck cases - check activity logs for pattern
  console.log("\n=== INVESTIGATING STUCK CASES ===\n");
  for (const id of [25164, 25153, 25211]) {
    const logs = await pool.query(`
      SELECT event_type, description, logged_at
      FROM activity_log WHERE case_id = $1
      ORDER BY logged_at DESC LIMIT 10
    `, [id]);

    const c = await pool.query(`SELECT agency_name, case_name FROM cases WHERE id = $1`, [id]);

    console.log(`#${id} ${c.rows[0].agency_name}`);
    console.log(`  Case: ${(c.rows[0].case_name || "").slice(0, 80)}`);
    for (const l of logs.rows) {
      console.log(`  [${l.event_type}] ${(l.description || "").slice(0, 150)}`);
    }
    console.log();
  }

  await pool.end();
})();
