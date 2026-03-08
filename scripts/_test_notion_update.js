#!/usr/bin/env node
/**
 * Directly test updating Live Status on a failing case
 */
require("dotenv").config();
const { Client } = require("@notionhq/client");
const { Pool } = require("pg");

const notion = new Client({ auth: process.env.NOTION_API_KEY });
const pool = new Pool({ connectionString: process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL });

async function main() {
  // Test with case #25151 (DB=needs_human_review, Notion=Sent)
  const { rows } = await pool.query("SELECT id, status, notion_page_id FROM cases WHERE id = 25151");
  const c = rows[0];
  console.log(`Case #${c.id}: DB status="${c.status}", page=${c.notion_page_id}`);

  // Step 1: Read current Live Status
  const before = await notion.pages.retrieve({ page_id: c.notion_page_id });
  const lsBefore = before.properties["Live Status"];
  console.log(`\nBEFORE: Live Status = "${lsBefore?.select?.name || '(none)'}" (type: ${lsBefore?.type})`);

  // Step 2: Directly update Live Status to "Needs Human Review"
  console.log('\nAttempting to update Live Status to "Needs Human Review"...');
  try {
    const result = await notion.pages.update({
      page_id: c.notion_page_id,
      properties: {
        "Live Status": {
          select: { name: "Needs Human Review" }
        }
      }
    });
    console.log("Update response status:", result.object);
    const lsAfter = result.properties["Live Status"];
    console.log(`Update response Live Status: "${lsAfter?.select?.name || '(none)'}"`);
  } catch (err) {
    console.log("Update FAILED:", err.message);
    console.log("Full error:", JSON.stringify(err, null, 2));
  }

  // Step 3: Verify by reading again
  await new Promise(r => setTimeout(r, 2000));
  const after = await notion.pages.retrieve({ page_id: c.notion_page_id });
  const lsAfterVerify = after.properties["Live Status"];
  console.log(`\nAFTER (verified): Live Status = "${lsAfterVerify?.select?.name || '(none)'}"`);

  await pool.end();
}

main().catch(err => { console.error(err); process.exit(1); });
