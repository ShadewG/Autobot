#!/usr/bin/env node
/**
 * One-time script: look up phone numbers for all phone queue entries missing them.
 * Runs BOTH Notion PD page and GPT-5 web search in parallel.
 * Populates phone_options JSONB with both results.
 */
require('dotenv').config();

const notionService = require('../services/notion-service');
const db = require('../services/database');

const tasks = [
  { id: 4, case_id: 45, agency_name: 'Huntington Police Department', state: 'WV', notion_page_id: '21187c20-070a-8107-8783-db0596039925', agency_id: 8 },
  { id: 5, case_id: 49, agency_name: 'West Terre Haute Police Department', state: 'IN', notion_page_id: '21187c20-070a-8182-a559-fd39408096c5', agency_id: 18 },
  { id: 6, case_id: 50, agency_name: 'Evansville Police Department', state: 'IN', notion_page_id: '21187c20-070a-819a-91a1-efc58ffa7110', agency_id: 5 },
  { id: 7, case_id: 55, agency_name: "Richmond County Sheriff's Office", state: 'GA', notion_page_id: '21e87c20-070a-8037-b7a2-d9f138f3b11f', agency_id: 15 },
];

async function run() {
  const results = [];

  for (const t of tasks) {
    console.log(`\n=== Phone task #${t.id}: ${t.agency_name}, ${t.state} ===`);

    // Run both lookups in parallel
    const [notionResult, webResult] = await Promise.allSettled([
      notionService.lookupPhoneFromNotion(t.notion_page_id),
      notionService.searchForAgencyPhone(t.agency_name, t.state)
    ]);

    const notion = notionResult.status === 'fulfilled' ? notionResult.value : { phone: null, pdPageId: null };
    const web = webResult.status === 'fulfilled' ? webResult.value : { phone: null, confidence: 'low', reasoning: 'lookup failed' };

    if (notionResult.status === 'rejected') {
      console.log(`  Notion error: ${notionResult.reason?.message || 'unknown'}`);
    } else if (notion.phone) {
      console.log(`  NOTION FOUND: ${notion.phone} (PD page: ${notion.pdPageId})`);
    } else {
      console.log(`  Notion: no phone found${notion.pdPageId ? ` (PD page: ${notion.pdPageId})` : ''}`);
    }

    if (webResult.status === 'rejected') {
      console.log(`  Web search error: ${webResult.reason?.message || 'unknown'}`);
    } else if (web.phone) {
      console.log(`  WEB SEARCH FOUND: ${web.phone} [${web.confidence}] - ${web.reasoning}`);
    } else {
      console.log(`  Web search: no phone found - ${web.reasoning || 'unknown'}`);
    }

    // Build phone_options JSONB
    const phoneOptions = {
      notion: {
        phone: notion.phone || null,
        source: 'Notion PD Card',
        pd_page_id: notion.pdPageId || null,
        pd_page_url: notion.pdPageId
          ? `https://www.notion.so/${notion.pdPageId.replace(/-/g, '')}`
          : null
      },
      web_search: {
        phone: web.phone || null,
        source: 'Web Search (GPT)',
        confidence: web.confidence || null,
        reasoning: web.reasoning || null
      }
    };

    // Pick best default: Notion preferred, else web search
    const bestPhone = notion.phone || web.phone || null;

    // Save to DB
    console.log(`  Saving phone_options to phone_call_queue #${t.id}...`);
    const setClauses = ['phone_options = $1', 'updated_at = NOW()'];
    const values = [JSON.stringify(phoneOptions)];
    let paramIdx = 2;

    if (bestPhone) {
      setClauses.push(`agency_phone = $${paramIdx}`);
      values.push(bestPhone);
      paramIdx++;
    }

    values.push(t.id);
    await db.query(
      `UPDATE phone_call_queue SET ${setClauses.join(', ')} WHERE id = $${paramIdx}`,
      values
    );

    if (bestPhone && t.agency_id) {
      await db.query("UPDATE agencies SET phone = $1 WHERE id = $2 AND (phone IS NULL OR phone = '')", [bestPhone, t.agency_id]);
    }

    console.log(`  SAVED (selected: ${bestPhone || 'NONE'})`);

    results.push({
      id: t.id,
      agency: t.agency_name,
      state: t.state,
      notion_phone: notion.phone || '-',
      web_phone: web.phone || '-',
      selected: bestPhone || 'NOT FOUND'
    });
  }

  console.log('\n=== RESULTS ===');
  console.table(results);

  await db.close();
}

run().catch(e => { console.error(e); process.exit(1); });
