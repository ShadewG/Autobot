#!/usr/bin/env node
/**
 * Check what status options exist on the Notion "Live Status" property.
 */
require("dotenv").config();
const { Client } = require("@notionhq/client");

const notion = new Client({ auth: process.env.NOTION_API_KEY });
const databaseId = process.env.NOTION_CASES_DATABASE_ID;

async function main() {
  const db = await notion.databases.retrieve({ database_id: databaseId });

  console.log("Database:", db.title?.[0]?.plain_text || "Unknown");
  console.log("\nProperties with status/select options:\n");

  for (const [name, prop] of Object.entries(db.properties)) {
    if (prop.type === "status") {
      console.log(`"${name}" (type: status)`);
      console.log("  Options:", prop.status.options.map(o => o.name));
      console.log("  Groups:", prop.status.groups.map(g => `${g.name}: [${g.option_ids.length} options]`));
    }
    if (prop.type === "select" && (name.toLowerCase().includes("status") || name.toLowerCase().includes("live"))) {
      console.log(`"${name}" (type: select)`);
      console.log("  Options:", prop.select.options.map(o => o.name));
    }
  }

  // Also check a specific failing case to see what properties it has
  console.log("\n--- Checking failing case #25151 ---");
  const { rows } = await require("pg").Pool.prototype.query || [];
  // Use a direct Notion page check instead
  const pageId = "2c287c20-070a-808d-a2ff-c2f2308fea15"; // #25151 from DB - we'll look it up

  // Let me just query the DB for the page IDs of the failing cases
  const pgPool = new (require("pg").Pool)({ connectionString: process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL });
  const failingIds = [25151, 57, 25163, 25167, 726, 25157];

  for (const id of failingIds) {
    const { rows } = await pgPool.query("SELECT id, case_name, status, notion_page_id FROM cases WHERE id = $1", [id]);
    if (!rows[0]) { console.log(`  #${id}: not found in DB`); continue; }
    const c = rows[0];
    console.log(`\n  #${c.id} — DB status: "${c.status}", page: ${c.notion_page_id}`);

    try {
      const page = await notion.pages.retrieve({ page_id: c.notion_page_id });
      const liveStatus = page.properties["Live Status"];
      console.log(`    Live Status property type: ${liveStatus?.type}`);
      if (liveStatus?.type === "status") {
        console.log(`    Live Status value: "${liveStatus.status?.name || '(empty)'}"`);
      } else if (liveStatus?.type === "select") {
        console.log(`    Live Status value: "${liveStatus.select?.name || '(empty)'}"`);
      } else {
        console.log(`    Live Status raw:`, JSON.stringify(liveStatus));
      }
    } catch (err) {
      console.log(`    Notion error: ${err.message}`);
    }

    // Rate limit
    await new Promise(r => setTimeout(r, 400));
  }

  await pgPool.end();
}

main().catch(err => { console.error(err); process.exit(1); });
