#!/usr/bin/env node
/**
 * Fix remaining mismatches by directly updating Notion via API
 * (bypasses the notion-service cache)
 */
require("dotenv").config();
const { Client } = require("@notionhq/client");
const { Pool } = require("pg");

const notion = new Client({ auth: process.env.NOTION_API_KEY });
const pool = new Pool({ connectionString: process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL });

const STATUS_MAP = {
  ready_to_send: "Ready to Send",
  sent: "Sent",
  awaiting_response: "Awaiting Response",
  responded: "Responded",
  completed: "Completed",
  error: "Error",
  fee_negotiation: "Fee Negotiation",
  needs_human_fee_approval: "Needs Human Approval",
  needs_human_review: "Needs Human Review",
  portal_in_progress: "Portal Submission",
  portal_submission_failed: "Portal Issue",
  needs_phone_call: "Needs Phone Call",
  needs_contact_info: "Needs Human Review",
};

async function main() {
  // Only fix the remaining mismatched cases
  const failingIds = [57, 25163, 25167, 726, 25157];

  for (const id of failingIds) {
    const { rows } = await pool.query(
      "SELECT id, case_name, status, notion_page_id FROM cases WHERE id = $1",
      [id]
    );
    if (!rows[0]) { console.log(`#${id}: not found`); continue; }
    const c = rows[0];
    const notionStatus = STATUS_MAP[c.status];
    if (!notionStatus) { console.log(`#${id}: unmapped status "${c.status}"`); continue; }

    console.log(`#${c.id} "${c.case_name?.substring(0, 40)}..."`);
    console.log(`  DB: ${c.status} → Notion target: "${notionStatus}"`);

    try {
      const result = await notion.pages.update({
        page_id: c.notion_page_id,
        properties: {
          "Live Status": { select: { name: notionStatus } }
        }
      });
      const after = result.properties["Live Status"]?.select?.name;
      console.log(`  Updated OK → Notion now: "${after}"`);
    } catch (err) {
      console.log(`  FAILED: ${err.message}`);
    }

    await new Promise(r => setTimeout(r, 500));
  }

  await pool.end();
  console.log("\nDone.");
}

main().catch(err => { console.error(err); process.exit(1); });
