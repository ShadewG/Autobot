const { Pool } = require("pg");
const pool = new Pool({ connectionString: "postgresql://postgres:EsoRieVyRUVqLZEaGcecTqCDALRGxXXH@switchback.proxy.rlwy.net:39529/railway" });

const API_BASE = process.env.API_BASE || "https://sincere-strength-production.up.railway.app";

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

async function dismissProposal(proposalId, reason) {
  const res = await fetch(`${API_BASE}/api/monitor/proposals/${proposalId}/decision`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "DISMISS", dismiss_reason: reason }),
  });
  const data = await res.json();
  if (!res.ok || !data.success) throw new Error(data.error || `Failed (${res.status})`);
  return data;
}

async function log(id, msg) {
  await pool.query(`INSERT INTO activity_log (case_id, event_type, description) VALUES ($1, 'manual_fix', $2)`, [id, msg]);
}

(async () => {
  // ──────────────────────────────────────────────
  // PART 1: Fix new cases with wrong "Police Department" agency
  // ──────────────────────────────────────────────
  console.log("=== PART 1: FIX NEW CASES WITH WRONG AGENCY ===\n");

  const newCaseFixes = [
    {
      id: 25243, name: "Georgia school shooter father",
      correctAgency: "Barrow County Sheriff's Office",
      correctState: "GA",
      instruction: "Wrong agency assigned. This case is about the Apalachee High School shooting in Barrow County, Georgia. Research the correct agency (Barrow County Sheriff's Office, Georgia) and submit the FOIA request to them, not Lubbock TX."
    },
    {
      id: 25246, name: "Parkland shooting BSO",
      correctAgency: "Broward County Sheriff's Office",
      correctState: "FL",
      instruction: "Wrong agency assigned. This case is about the Parkland/Marjory Stoneman Douglas shooting in Broward County, Florida. Research the correct agency (Broward County Sheriff's Office, Florida) and submit the public records request to them, not Lubbock TX."
    },
    {
      id: 25249, name: "Montana murder-for-hire",
      correctAgency: null,
      correctState: "MT",
      instruction: "Wrong agency assigned. This is a federal murder-for-hire case in Montana. Research the correct law enforcement agency that investigated this case and submit the FOIA request to them, not Lubbock TX."
    },
    {
      id: 25250, name: "Highland Park parade shooting",
      correctAgency: "Highland Park Police Department",
      correctState: "IL",
      instruction: "Wrong agency assigned. This case is about the Highland Park, Illinois July 4th parade mass shooting. Research the correct agency (Highland Park Police Department, Illinois or Lake County Sheriff) and submit the FOIA request to them, not Lubbock TX."
    },
    {
      id: 25252, name: "Marion County triple murder (dup 1)",
      correctAgency: "Marion County Sheriff's Office",
      correctState: "FL",
      instruction: "Wrong agency assigned. This case is about the 2023 Ocklawaha triple murder in Marion County, Florida. Research the correct agency (Marion County Sheriff's Office, Florida) and submit the public records request to them, not Lubbock TX."
    },
    {
      id: 25253, name: "Marion County triple murder (dup 2)",
      correctAgency: "Marion County Sheriff's Office",
      correctState: "FL",
      instruction: "Wrong agency assigned. Duplicate of case 25252 — same Marion County triple murder. Research the correct agency (Marion County Sheriff's Office, Florida) and submit the public records request to them, not Lubbock TX."
    },
  ];

  // First dismiss all bad proposals
  const badProposals = await pool.query(`
    SELECT p.id, p.case_id FROM proposals p
    WHERE p.case_id IN (25243, 25246, 25249, 25250, 25252, 25253)
    AND p.status IN ('PENDING_APPROVAL', 'BLOCKED')
  `);

  for (const p of badProposals.rows) {
    try {
      await dismissProposal(p.id, "Wrong agency — proposal targets Lubbock TX instead of correct jurisdiction");
      console.log(`  Dismissed proposal #${p.id} for case #${p.case_id}`);
    } catch (e) {
      console.log(`  Failed to dismiss proposal #${p.id}: ${e.message}`);
    }
  }

  // Update agency info and clear wrong data
  for (const fix of newCaseFixes) {
    try {
      // Clear the wrong agency data (keep email placeholder to satisfy constraint)
      await pool.query(`
        UPDATE cases SET
          agency_name = $2,
          agency_email = 'pending-research@placeholder.invalid',
          portal_url = NULL,
          portal_provider = NULL,
          state = $3,
          status = 'needs_human_review',
          substatus = 'Wrong agency corrected. Needs research + send.',
          pause_reason = 'UNSPECIFIED',
          requires_human = true
        WHERE id = $1
      `, [fix.id, fix.correctAgency || "Unknown — needs research", fix.correctState]);

      await log(fix.id, `Fixed wrong agency: was 'Police Department'/Lubbock TX. Corrected to ${fix.correctAgency || "needs research"} (${fix.correctState}).`);
      console.log(`  Fixed #${fix.id} (${fix.name}): agency → ${fix.correctAgency || "needs research"}`);
    } catch (e) {
      console.log(`  Failed to fix #${fix.id}: ${e.message}`);
    }
  }

  // ──────────────────────────────────────────────
  // PART 2: Reprocess stale cases via resolve-review API
  // ──────────────────────────────────────────────
  console.log("\n=== PART 2: REPROCESS STALE CASES ===\n");

  const staleReprocesses = [
    { id: 25152, instruction: "Send initial FOIA request. Use portal (Roanoke PD FOIA form) or email (police.foia@roanokeva.gov). This case was never sent." },
    { id: 25164, instruction: "Send initial FOIA request via JustFOIA portal (mobileal.justfoia.com) or email (recordsrequests@cityofmobile.org). Has inbound but 0 outbound." },
    { id: 25153, instruction: "Send initial FOIA request via portal or email (openrecords@columbiacountywi.gov). Has inbound but 0 outbound." },
    { id: 25140, instruction: "Agency responded. Process the inbound response and decide next action. Don't research agency again — contact info is already known." },
    { id: 25159, instruction: "Deadline passed 5+ days ago with no response. Send a follow-up to Madison County Sheriff's Office." },
    { id: 25161, instruction: "Fee negotiation was sent. Check for any inbound response. If agency responded about the fee, process it. If no response, follow up." },
    { id: 25211, instruction: "Phone call was made and deferred. Agency has portal. Try submitting via portal or sending email follow-up." },
    { id: 25169, instruction: "Agency has records ready and needs APRA form + delivery method. Try resending the email to 911audio@portercountyin.gov with the form attached." },
  ];

  for (const s of staleReprocesses) {
    try {
      await resolveReview(s.id, "custom", s.instruction);
      console.log(`  Reprocessed #${s.id}`);
    } catch (e) {
      console.log(`  Failed to reprocess #${s.id}: ${e.message}`);
    }
  }

  // Also handle 25210 — needs agency fix first
  console.log("\n#25210 — needs agency research (Norcross/Gwinnett County, GA)");
  try {
    await pool.query(`
      UPDATE cases SET
        agency_name = 'Norcross Police Department',
        state = 'GA',
        substatus = 'Agency corrected to Norcross PD, GA. Needs research + send.'
      WHERE id = 25210
    `);
    await log(25210, "Fixed wrong agency: was generic 'Police Department'. Case is about Norcross, GA murder. Corrected agency name.");
    await resolveReview(25210, "custom", "Agency corrected to Norcross Police Department, Georgia. Research this agency for contact info and submit the records request.");
    console.log("  Fixed and reprocessed #25210");
  } catch (e) {
    console.log(`  Failed on #25210: ${e.message}`);
  }

  // ──────────────────────────────────────────────
  // PART 3: Trigger reprocess for new cases after agency fix
  // ──────────────────────────────────────────────
  console.log("\n=== PART 3: REPROCESS NEW CASES ===\n");

  for (const fix of newCaseFixes) {
    try {
      await resolveReview(fix.id, "custom", fix.instruction);
      console.log(`  Reprocessed #${fix.id} (${fix.name})`);
    } catch (e) {
      console.log(`  Failed to reprocess #${fix.id}: ${e.message}`);
    }
  }

  console.log("\n=== ALL DONE ===");
  await pool.end();
})();
