#!/usr/bin/env node
/**
 * Fix existing Notion sync mismatches by re-syncing all cases.
 * Safe to run — only pushes current DB status to Notion.
 */
require("dotenv").config();
const db = require("../services/database");
const notionService = require("../services/notion-service");

async function main() {
  console.log("Fetching cases with Notion page IDs...\n");

  const { rows: cases } = await db.query(`
    SELECT id, case_name, status, notion_page_id
    FROM cases
    WHERE notion_page_id IS NOT NULL
      AND notion_page_id != ''
      AND notion_page_id NOT LIKE 'test-%'
    ORDER BY updated_at DESC
  `);

  console.log(`Found ${cases.length} cases. Re-syncing all to Notion...\n`);

  let synced = 0;
  let failed = 0;

  for (const c of cases) {
    try {
      process.stdout.write(`[${synced + failed + 1}/${cases.length}] #${c.id} ${c.status} → `);
      await notionService.syncStatusToNotion(c.id);
      console.log("OK");
      synced++;
    } catch (err) {
      console.log(`FAILED: ${err.message}`);
      failed++;
    }

    // Rate limit: Notion API is 3 req/s
    if ((synced + failed) % 3 === 0) await new Promise((r) => setTimeout(r, 1100));
  }

  console.log(`\nDone. Synced: ${synced}, Failed: ${failed}`);
  process.exit(0);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
