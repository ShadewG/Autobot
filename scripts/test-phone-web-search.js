#!/usr/bin/env node
/**
 * Test: compare Notion phone numbers vs GPT-5 web search results.
 */
require('dotenv').config();

const notionService = require('../services/notion-service');

const agencies = [
  { name: 'Huntington Police Department', state: 'WV', notionPhone: '(304) 696-4470' },
  { name: 'West Terre Haute Police Department', state: 'IN', notionPhone: '(812) 533-2114' },
  { name: 'Evansville Police Department', state: 'IN', notionPhone: '(812) 436-7896' },
  { name: "Richmond County Sheriff's Office", state: 'GA', notionPhone: '(706) 821-1000' },
];

async function run() {
  const results = [];

  for (const a of agencies) {
    console.log(`\n=== Web search: ${a.name}, ${a.state} ===`);
    try {
      const result = await notionService.searchForAgencyPhone(a.name, a.state);
      const aiPhone = result.phone || 'NOT FOUND';
      const match = aiPhone.replace(/\D/g, '').includes(a.notionPhone.replace(/\D/g, '')) ? 'MATCH' : 'DIFFERENT';
      console.log(`  AI: ${aiPhone} [${result.confidence}] - ${result.reasoning}`);
      console.log(`  Notion: ${a.notionPhone}`);
      console.log(`  ${match}`);
      results.push({
        agency: a.name,
        state: a.state,
        notion: a.notionPhone,
        ai_search: aiPhone,
        confidence: result.confidence,
        match
      });
    } catch (e) {
      console.log(`  Error: ${e.message}`);
      results.push({ agency: a.name, state: a.state, notion: a.notionPhone, ai_search: 'ERROR', confidence: '-', match: '-' });
    }
  }

  console.log('\n=== COMPARISON ===');
  console.table(results);
}

run().catch(e => { console.error(e); process.exit(1); });
