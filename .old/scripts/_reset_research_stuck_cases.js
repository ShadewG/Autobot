#!/usr/bin/env node
/**
 * Reset 7 stuck RESEARCH_AGENCY cases back to needs_human_review
 * so they can be reprocessed with the new Firecrawl-direct pipeline.
 */
const { Pool } = require("pg");

const DATABASE_URL = process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("Set DATABASE_PUBLIC_URL or DATABASE_URL");
  process.exit(1);
}

const pool = new Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } });

const STUCK_CASE_IDS = [25243, 25246, 25249, 25250, 25252, 25253, 25210];

async function main() {
  const client = await pool.connect();
  try {
    for (const caseId of STUCK_CASE_IDS) {
      // Check current state
      const { rows: [c] } = await client.query(
        `SELECT id, status, agency_email, portal_url, agency_name FROM cases WHERE id = $1`,
        [caseId]
      );
      if (!c) {
        console.log(`Case ${caseId}: NOT FOUND, skipping`);
        continue;
      }
      console.log(`Case ${caseId}: status=${c.status} email=${c.agency_email} portal=${c.portal_url}`);

      // Reset to needs_human_review
      await client.query(
        `UPDATE cases SET status = 'needs_human_review', substatus = NULL, pause_reason = NULL WHERE id = $1`,
        [caseId]
      );

      // Dismiss any pending RESEARCH_AGENCY proposals
      const { rowCount } = await client.query(
        `UPDATE proposals SET status = 'DISMISSED',
         human_decision = jsonb_build_object('auto_dismiss_reason', 'reset_for_firecrawl_fix')
         WHERE case_id = $1 AND action_type = 'RESEARCH_AGENCY' AND status IN ('PENDING_APPROVAL', 'BLOCKED')`,
        [caseId]
      );
      console.log(`  → Reset to needs_human_review, dismissed ${rowCount} pending research proposals`);
    }
    console.log("\nDone. Reprocess each case via resolve-review API with research_agency action.");
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch(e => { console.error(e); process.exit(1); });
