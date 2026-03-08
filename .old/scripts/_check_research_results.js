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
  // Check if research updated the contact info
  const cases = await pool.query(`
    SELECT id, agency_name, agency_email, portal_url, state, contact_research_notes
    FROM cases
    WHERE id IN (25169, 25243, 25246, 25249, 25250, 25252, 25253, 25210)
    ORDER BY id
  `);

  console.log("=== RESEARCH RESULTS ===\n");
  for (const c of cases.rows) {
    const research = c.contact_research_notes;
    let parsed = null;
    if (typeof research === "string") {
      try { parsed = JSON.parse(research); } catch {}
    } else {
      parsed = research;
    }
    const channels = parsed?.execution?.new_channels || {};
    const outcome = parsed?.execution?.outcome || "none";

    console.log(`#${c.id} ${c.agency_name} (${c.state})`);
    console.log(`  email: ${c.agency_email}`);
    console.log(`  portal: ${c.portal_url || "none"}`);
    console.log(`  research outcome: ${outcome}`);
    if (channels.email) console.log(`  discovered email: ${channels.email}`);
    if (channels.portal) console.log(`  discovered portal: ${channels.portal}`);
    if (channels.phone) console.log(`  discovered phone: ${channels.phone}`);
    console.log();
  }

  // Approve remaining proposals
  const proposals = [901, 903, 909, 910, 911, 912, 913];
  console.log("=== APPROVING ROUND 3 ===");
  for (const pid of proposals) {
    try {
      await approveProposal(pid);
      console.log(`  Approved #${pid}`);
    } catch (e) {
      console.log(`  Failed #${pid}: ${e.message}`);
    }
  }

  await pool.end();
})();
