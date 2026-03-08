#!/usr/bin/env node
/**
 * One-time script: Generate drafts for all PENDING_APPROVAL proposals missing draft content.
 */
require('dotenv').config();
const db = require('../services/database');
const { draftResponseNode } = require('../langgraph/nodes/draft-response');

async function main() {
  const result = await db.query(`
    SELECT * FROM proposals
    WHERE status = 'PENDING_APPROVAL'
      AND draft_body_text IS NULL
      AND draft_subject IS NULL
    ORDER BY case_id
  `);

  const proposals = result.rows;
  console.log(`Found ${proposals.length} proposals missing drafts\n`);

  for (const p of proposals) {
    console.log(`=== Proposal #${p.id} | Case #${p.case_id} | ${p.action_type} ===`);

    const state = {
      caseId: p.case_id,
      proposalActionType: p.action_type,
      constraints: p.metadata?.constraints || [],
      scopeItems: p.metadata?.scope_items || [],
      extractedFeeAmount: p.metadata?.fee_amount || null,
      latestInboundMessageId: p.trigger_message_id || null,
      adjustmentInstruction: null,
      llmStubs: null
    };

    try {
      console.log('  Calling draftResponseNode...');
      const draftResult = await draftResponseNode(state);

      if (draftResult.errors && draftResult.errors.length > 0) {
        console.log('  ERRORS:', draftResult.errors);
        continue;
      }

      if (!draftResult.draftBodyText && !draftResult.draftSubject) {
        console.log('  Draft generation returned empty content');
        continue;
      }

      console.log(`  Subject: ${draftResult.draftSubject}`);
      console.log(`  Body preview: ${(draftResult.draftBodyText || '').substring(0, 200)}...`);

      await db.query(`
        UPDATE proposals
        SET draft_subject = $1, draft_body_text = $2, draft_body_html = $3, updated_at = NOW()
        WHERE id = $4
      `, [draftResult.draftSubject, draftResult.draftBodyText, draftResult.draftBodyHtml || null, p.id]);

      console.log(`  Draft saved to proposal #${p.id}\n`);
    } catch (err) {
      console.log(`  ERROR: ${err.message}\n`);
    }
  }

  await db.pool.end();
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
