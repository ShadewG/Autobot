#!/usr/bin/env node
/**
 * Test Parallel Search API integration in generateAgencyResearchBrief
 */
require('dotenv').config();
process.env.PARALLEL_API_KEY = process.env.PARALLEL_API_KEY || 'PaTt1KWSXjPk7ok5-eh9-L_kFKBvzdPN7xlK44Sc';

const aiService = require('../services/ai-service');

async function main() {
  console.log('PARALLEL_API_KEY set?', !!process.env.PARALLEL_API_KEY);
  console.log('Testing generateAgencyResearchBrief for Highland Park PD...\n');

  const result = await aiService.generateAgencyResearchBrief({
    agencyName: 'Highland Park Police Department',
    state: 'IL',
    subjectContext: 'Highland Park parade mass shooter Robert Crimo sentenced to life without parole'
  });

  console.log('researchFailed?', result.researchFailed || false);
  console.log('\nSuggested agencies:');
  if (result.suggested_agencies) {
    result.suggested_agencies.forEach(a => {
      console.log('  -', a.name, '(confidence:', a.confidence + ')');
    });
  }
  console.log('\nResearch notes (first 500 chars):', (result.research_notes || '').substring(0, 500));
  console.log('\nFull result keys:', Object.keys(result));
}

main().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
