/**
 * Cleanup script: Archive 90+ day old cases
 *
 * 1. Set Notion Live Status to "Archived" (NOT blank — blank maps to ready_to_send)
 * 2. DELETE FROM cases — CASCADE handles child tables
 * 3. Verify deletion
 *
 * Cases: 41, 42, 45, 46, 48, 49, 50, 51, 54, 55, 57, 60, 726, 1658, 1660, 2593
 */

const db = require('../services/database');
const notionService = require('../services/notion-service');

const OLD_CASE_IDS = [41, 42, 45, 46, 48, 49, 50, 51, 54, 55, 57, 60, 726, 1658, 1660, 2593];

async function main() {
  console.log(`\n=== Archiving ${OLD_CASE_IDS.length} old cases ===\n`);

  // Step 1: Set Notion status to "Archived" for each case
  for (const caseId of OLD_CASE_IDS) {
    const caseData = await db.getCaseById(caseId);
    if (!caseData) {
      console.log(`Case ${caseId}: NOT FOUND in DB — skipping`);
      continue;
    }

    const pageId = caseData.notion_page_id;
    if (pageId && !pageId.startsWith('test-')) {
      try {
        await notionService.updatePage(pageId, { live_status: 'Archived' });
        console.log(`Case ${caseId} (${caseData.case_name}): Notion → Archived ✓`);
      } catch (err) {
        console.error(`Case ${caseId}: Notion update FAILED — ${err.message}`);
        // Continue anyway — we still want to delete from DB
      }
    } else {
      console.log(`Case ${caseId}: No valid Notion page — skipping Notion update`);
    }
  }

  // Step 2: Nullify inbound_queue references (no CASCADE on matched_case_id)
  try {
    const nullified = await db.query(
      `UPDATE inbound_queue SET matched_case_id = NULL WHERE matched_case_id = ANY($1::int[])`,
      [OLD_CASE_IDS]
    );
    console.log(`\nNullified ${nullified.rowCount} inbound_queue references`);
  } catch (err) {
    console.warn(`inbound_queue cleanup: ${err.message}`);
  }

  // Step 3: Delete cases (CASCADE handles proposals, portal_tasks, messages, etc.)
  const deleted = await db.query(
    `DELETE FROM cases WHERE id = ANY($1::int[]) RETURNING id, case_name`,
    [OLD_CASE_IDS]
  );
  console.log(`\nDeleted ${deleted.rowCount} cases:`);
  for (const row of deleted.rows) {
    console.log(`  - Case ${row.id}: ${row.case_name}`);
  }

  // Step 4: Verify
  const remaining = await db.query(
    `SELECT id FROM cases WHERE id = ANY($1::int[])`,
    [OLD_CASE_IDS]
  );
  if (remaining.rows.length === 0) {
    console.log(`\n✓ All ${OLD_CASE_IDS.length} cases confirmed deleted from DB`);
  } else {
    console.error(`\n✗ ${remaining.rows.length} cases still exist:`, remaining.rows.map(r => r.id));
  }

  // Step 5: Also fix case 25156 data (Warren County Sheriff MS mismatch)
  console.log('\n=== Fixing case 25156 data ===');
  const case25156 = await db.getCaseById(25156);
  if (case25156) {
    // Clear the mismatched portal_url and email, set for research
    await db.updateCase(25156, {
      portal_url: null,
      agency_email: null,
      agency_id: null,
      substatus: 'needs_agency_research',
    });
    await db.updateCaseStatus(25156, 'needs_human_review', {
      substatus: 'Agency mismatch detected — needs manual correction',
      requires_human: true,
    });
    console.log('Case 25156: Cleared mismatched portal_url/email/agency_id, set to needs_human_review');
  } else {
    console.log('Case 25156: NOT FOUND');
  }

  console.log('\n=== Done ===');
  process.exit(0);
}

main().catch(err => {
  console.error('FATAL:', err);
  process.exit(1);
});
