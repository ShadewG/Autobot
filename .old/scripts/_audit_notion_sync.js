#!/usr/bin/env node
/**
 * Audit Notion ↔ DB status sync
 * Compares Live Status in Notion with the status in the local DB for all active cases.
 * Reports mismatches so we can identify where sync has broken.
 */
require("dotenv").config();
const { Client } = require("@notionhq/client");
const { Pool } = require("pg");

const pool = new Pool({ connectionString: process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL });
const notion = new Client({ auth: process.env.NOTION_API_KEY });

const NOTION_STATUS_MAP = {
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

function mapDbToNotion(dbStatus) {
  return NOTION_STATUS_MAP[dbStatus] || null;
}

async function getNotionLiveStatus(pageId) {
  try {
    const page = await notion.pages.retrieve({ page_id: pageId });
    const props = page.properties;

    // Try "Live Status" first, then "Status"
    const liveStatusProp = props["Live Status"] || props["live_status"];
    if (liveStatusProp) {
      if (liveStatusProp.type === "status" && liveStatusProp.status) {
        return liveStatusProp.status.name;
      }
      if (liveStatusProp.type === "select" && liveStatusProp.select) {
        return liveStatusProp.select.name;
      }
    }

    // Fallback to "Status"
    const statusProp = props["Status"];
    if (statusProp) {
      if (statusProp.type === "status" && statusProp.status) {
        return statusProp.status.name;
      }
      if (statusProp.type === "select" && statusProp.select) {
        return statusProp.select.name;
      }
    }

    return null;
  } catch (err) {
    if (err.code === "object_not_found") return "[PAGE NOT FOUND]";
    if (err.status === 404) return "[PAGE NOT FOUND]";
    throw err;
  }
}

async function main() {
  console.log("Fetching cases from DB...\n");

  // Get all cases that have a notion_page_id and are not test cases
  const { rows: cases } = await pool.query(`
    SELECT id, case_name, agency_name, status, substatus, notion_page_id, updated_at
    FROM cases
    WHERE notion_page_id IS NOT NULL
      AND notion_page_id != ''
      AND notion_page_id NOT LIKE 'test-%'
    ORDER BY updated_at DESC
    LIMIT 100
  `);

  console.log(`Found ${cases.length} cases with Notion page IDs.\n`);

  const results = { match: 0, mismatch: 0, unmapped: 0, notFound: 0, errors: 0 };
  const mismatches = [];
  const notFound = [];

  for (let i = 0; i < cases.length; i++) {
    const c = cases[i];
    const expectedNotion = mapDbToNotion(c.status);

    process.stdout.write(`[${i + 1}/${cases.length}] #${c.id} ${c.case_name?.substring(0, 30)}... `);

    if (!expectedNotion) {
      console.log(`UNMAPPED status: "${c.status}"`);
      results.unmapped++;
      mismatches.push({
        id: c.id,
        case_name: c.case_name,
        db_status: c.status,
        expected_notion: "(unmapped)",
        actual_notion: "N/A",
        issue: "unmapped_status",
      });
      continue;
    }

    try {
      const actualNotion = await getNotionLiveStatus(c.notion_page_id);

      if (actualNotion === "[PAGE NOT FOUND]") {
        console.log("PAGE NOT FOUND in Notion");
        results.notFound++;
        notFound.push({ id: c.id, case_name: c.case_name, notion_page_id: c.notion_page_id });
        continue;
      }

      if (!actualNotion) {
        console.log(`NO STATUS in Notion (expected: "${expectedNotion}")`);
        results.mismatch++;
        mismatches.push({
          id: c.id,
          case_name: c.case_name,
          db_status: c.status,
          expected_notion: expectedNotion,
          actual_notion: "(empty)",
          issue: "missing_notion_status",
        });
        continue;
      }

      if (actualNotion === expectedNotion) {
        console.log("OK");
        results.match++;
      } else {
        console.log(`MISMATCH: DB="${c.status}" → expected "${expectedNotion}", Notion has "${actualNotion}"`);
        results.mismatch++;
        mismatches.push({
          id: c.id,
          case_name: c.case_name,
          db_status: c.status,
          expected_notion: expectedNotion,
          actual_notion: actualNotion,
          issue: "status_mismatch",
        });
      }

      // Rate limit: Notion API is 3 req/s
      if ((i + 1) % 3 === 0) await new Promise((r) => setTimeout(r, 1100));
    } catch (err) {
      console.log(`ERROR: ${err.message}`);
      results.errors++;
    }
  }

  // Summary
  console.log("\n" + "=".repeat(60));
  console.log("AUDIT SUMMARY");
  console.log("=".repeat(60));
  console.log(`Total cases checked: ${cases.length}`);
  console.log(`  Matching:    ${results.match}`);
  console.log(`  Mismatched:  ${results.mismatch}`);
  console.log(`  Unmapped:    ${results.unmapped}`);
  console.log(`  Not Found:   ${results.notFound}`);
  console.log(`  Errors:      ${results.errors}`);

  if (mismatches.length > 0) {
    console.log("\n" + "-".repeat(60));
    console.log("MISMATCHES:");
    console.log("-".repeat(60));
    for (const m of mismatches) {
      console.log(`  #${m.id} "${m.case_name}"`);
      console.log(`    DB: ${m.db_status} → Expected Notion: "${m.expected_notion}"`);
      console.log(`    Actual Notion: "${m.actual_notion}" [${m.issue}]`);
    }
  }

  if (notFound.length > 0) {
    console.log("\n" + "-".repeat(60));
    console.log("NOTION PAGES NOT FOUND:");
    console.log("-".repeat(60));
    for (const nf of notFound) {
      console.log(`  #${nf.id} "${nf.case_name}" — page: ${nf.notion_page_id}`);
    }
  }

  await pool.end();
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
