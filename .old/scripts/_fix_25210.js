const { Pool } = require("pg");
const pool = new Pool({ connectionString: "postgresql://postgres:EsoRieVyRUVqLZEaGcecTqCDALRGxXXH@switchback.proxy.rlwy.net:39529/railway" });
const API_BASE = "https://sincere-strength-production.up.railway.app";

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
  // Fix #25210 - wrong email (Lubbock's ORR@ instead of Norcross PD)
  await pool.query(`
    UPDATE cases SET
      agency_email = 'pending-research@placeholder.invalid',
      portal_url = NULL,
      portal_provider = NULL,
      substatus = 'Wrong email corrected. Needs research for Norcross PD GA.',
      status = 'needs_human_review',
      pause_reason = 'UNSPECIFIED',
      requires_human = true
    WHERE id = 25210
  `);
  await pool.query(
    `INSERT INTO activity_log (case_id, event_type, description) VALUES ($1, 'manual_fix', $2)`,
    [25210, "Corrected wrong email: was ORR@mylubbock.us (Lubbock TX). Needs Norcross PD GA contact info."]
  );

  await resolveReview(25210, "custom", "Agency corrected to Norcross Police Department, Georgia. The previous email (ORR@mylubbock.us) was for Lubbock TX, which is wrong. Research the correct contact info for Norcross Police Department in Gwinnett County, Georgia and submit the records request.");
  console.log("Fixed and reprocessed #25210");

  await pool.end();
})();
