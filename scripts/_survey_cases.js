#!/usr/bin/env node
/**
 * Survey all cases with inbound messages to understand the reprocessing landscape.
 */
require('dotenv').config();
const db = require('../services/database');

(async () => {
  const result = await db.query(`
    SELECT
      c.id, c.case_name, c.agency_name, c.status, c.state,
      c.contact_research_notes IS NOT NULL as has_research,
      (SELECT COUNT(*) FROM messages m WHERE m.case_id = c.id AND m.direction = 'inbound') as inbound_count,
      (SELECT m.id FROM messages m WHERE m.case_id = c.id AND m.direction = 'inbound' ORDER BY m.received_at DESC LIMIT 1) as latest_inbound_id,
      (SELECT m.subject FROM messages m WHERE m.case_id = c.id AND m.direction = 'inbound' ORDER BY m.received_at DESC LIMIT 1) as latest_inbound_subject,
      (SELECT p.action_type FROM proposals p WHERE p.case_id = c.id ORDER BY p.created_at DESC LIMIT 1) as latest_proposal_action,
      (SELECT p.status FROM proposals p WHERE p.case_id = c.id ORDER BY p.created_at DESC LIMIT 1) as latest_proposal_status,
      (SELECT p.id FROM proposals p WHERE p.case_id = c.id ORDER BY p.created_at DESC LIMIT 1) as latest_proposal_id,
      (SELECT ra.intent FROM response_analysis ra JOIN messages m ON ra.message_id = m.id WHERE m.case_id = c.id ORDER BY ra.created_at DESC LIMIT 1) as latest_analysis_intent,
      (SELECT (ra.full_analysis_json->>'denial_subtype') FROM response_analysis ra JOIN messages m ON ra.message_id = m.id WHERE m.case_id = c.id ORDER BY ra.created_at DESC LIMIT 1) as latest_denial_subtype
    FROM cases c
    WHERE EXISTS (SELECT 1 FROM messages m WHERE m.case_id = c.id AND m.direction = 'inbound')
    ORDER BY c.id DESC
  `);

  console.log(`Found ${result.rows.length} cases with inbound messages\n`);

  const stats = { total: 0, denial: 0, hasSubtype: 0, needsReanalysis: 0 };

  for (const r of result.rows) {
    stats.total++;
    const isDenial = r.latest_analysis_intent === 'denial';
    if (isDenial) stats.denial++;
    if (r.latest_denial_subtype) stats.hasSubtype++;
    if (isDenial && !r.latest_denial_subtype) stats.needsReanalysis++;

    console.log(`Case #${r.id}: ${(r.case_name || '').substring(0, 55)}`);
    console.log(`  Agency: ${r.agency_name} | Status: ${r.status} | State: ${r.state}`);
    console.log(`  Inbound msgs: ${r.inbound_count} | Latest: ${(r.latest_inbound_subject || '').substring(0, 60)}`);
    console.log(`  Analysis: intent=${r.latest_analysis_intent} | denial_subtype=${r.latest_denial_subtype}`);
    console.log(`  Proposal: ${r.latest_proposal_action} (${r.latest_proposal_status}) [id=${r.latest_proposal_id}]`);
    console.log(`  Has research: ${r.has_research}`);
    console.log();
  }

  console.log('='.repeat(60));
  console.log('SUMMARY');
  console.log('='.repeat(60));
  console.log(`Total cases with inbound: ${stats.total}`);
  console.log(`Denials: ${stats.denial}`);
  console.log(`Denials with subtype: ${stats.hasSubtype}`);
  console.log(`Denials needing re-analysis: ${stats.needsReanalysis}`);

  await db.pool.end();
})();
