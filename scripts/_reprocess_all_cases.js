#!/usr/bin/env node
/**
 * Reprocess all cases through the updated denial-subtype-aware pipeline.
 *
 * What this does:
 * 1. For each case with inbound messages, loads the latest analysis
 * 2. Runs through classify-inbound (stubbed from existing analysis) → decide-next-action
 * 3. Compares old proposal to new routing
 * 4. If routing changed, creates a new proposal (supersedes old PENDING ones)
 * 5. For RESEARCH_AGENCY/REFORMULATE_REQUEST, also runs draft-response with live AI
 *
 * Safety:
 * - Does NOT auto-execute anything
 * - Does NOT delete old proposals — marks them SUPERSEDED
 * - All new proposals created as PENDING_APPROVAL (human gate)
 * - Dry-run mode by default (--execute to actually write)
 *
 * Usage:
 *   node scripts/_reprocess_all_cases.js            # Dry run (show what would change)
 *   node scripts/_reprocess_all_cases.js --execute   # Actually create new proposals
 */

require('dotenv').config();
const db = require('../services/database');
const aiService = require('../services/ai-service');
const logger = require('../services/logger');
const { DRAFT_REQUIRED_ACTIONS } = require('../constants/action-types');

const ACTIONS_NEEDING_DRAFT = [...DRAFT_REQUIRED_ACTIONS, 'RESEARCH_AGENCY', 'REFORMULATE_REQUEST'];

const EXECUTE = process.argv.includes('--execute');

// Import the nodes we need
const { classifyInboundNode } = require('../langgraph/nodes/classify-inbound');
const { decideNextActionNode } = require('../langgraph/nodes/decide-next-action');
const { draftResponseNode } = require('../langgraph/nodes/draft-response');

async function getAllCasesWithInbound() {
  const result = await db.query(`
    SELECT
      c.id,
      c.case_name,
      c.agency_name,
      c.status,
      c.state,
      c.contact_research_notes,
      c.portal_url,
      c.agency_email,
      (SELECT m.id FROM messages m WHERE m.case_id = c.id AND m.direction = 'inbound'
       ORDER BY m.received_at DESC LIMIT 1) as latest_inbound_id,
      (SELECT m.subject FROM messages m WHERE m.case_id = c.id AND m.direction = 'inbound'
       ORDER BY m.received_at DESC LIMIT 1) as latest_inbound_subject
    FROM cases c
    WHERE EXISTS (SELECT 1 FROM messages m WHERE m.case_id = c.id AND m.direction = 'inbound')
    ORDER BY c.id DESC
  `);
  return result.rows;
}

async function getLatestAnalysis(caseId) {
  const result = await db.query(
    `SELECT ra.* FROM response_analysis ra
     JOIN messages m ON ra.message_id = m.id
     WHERE m.case_id = $1
     ORDER BY ra.created_at DESC LIMIT 1`,
    [caseId]
  );
  return result.rows[0];
}

async function getLatestProposal(caseId) {
  const result = await db.query(
    `SELECT * FROM proposals WHERE case_id = $1 ORDER BY created_at DESC LIMIT 1`,
    [caseId]
  );
  return result.rows[0];
}

async function getPendingProposals(caseId) {
  const result = await db.query(
    `SELECT * FROM proposals
     WHERE case_id = $1 AND status IN ('PENDING_APPROVAL', 'DRAFT')
     ORDER BY created_at DESC`,
    [caseId]
  );
  return result.rows;
}

async function supersedePendingProposals(caseId) {
  const result = await db.query(
    `UPDATE proposals SET status = 'SUPERSEDED', updated_at = NOW()
     WHERE case_id = $1 AND status IN ('PENDING_APPROVAL', 'DRAFT')
     RETURNING id, action_type`,
    [caseId]
  );
  return result.rows;
}

async function reprocessCase(caseData, analysis) {
  const fullJson = analysis.full_analysis_json || {};

  // Build stubbed classify state from existing analysis
  const classifyState = {
    caseId: caseData.id,
    latestInboundMessageId: analysis.message_id,
    triggerType: 'agency_reply',
    llmStubs: {
      classify: {
        classification: analysis.intent,
        confidence: analysis.confidence_score || 0.85,
        sentiment: analysis.sentiment || 'neutral',
        denial_subtype: fullJson.denial_subtype || null,
        key_points: analysis.key_points || [],
        fee_amount: analysis.extracted_fee_amount,
        deadline: analysis.extracted_deadline,
        requires_response: analysis.requires_action !== false,
        suggested_action: analysis.suggested_action || fullJson.suggested_action || null,
        portal_url: fullJson.portal_url || null,
        reason_no_response: fullJson.reason_no_response || null
      }
    }
  };

  // Mock saveResponseAnalysis to not clobber existing data
  const origSave = db.saveResponseAnalysis;
  db.saveResponseAnalysis = async () => ({ id: analysis.id });

  // Step 1: Classify (from existing analysis, no API call)
  const classifyResult = await classifyInboundNode(classifyState);

  db.saveResponseAnalysis = origSave;

  // Step 2: Decide next action (deterministic routing)
  const decideState = {
    caseId: caseData.id,
    classification: classifyResult.classification,
    classificationConfidence: classifyResult.classificationConfidence,
    sentiment: classifyResult.sentiment,
    extractedFeeAmount: classifyResult.extractedFeeAmount,
    extractedDeadline: classifyResult.extractedDeadline,
    denialSubtype: classifyResult.denialSubtype,
    requiresResponse: classifyResult.requiresResponse,
    portalUrl: classifyResult.portalUrl,
    suggestedAction: classifyResult.suggestedAction,
    reasonNoResponse: classifyResult.reasonNoResponse,
    constraints: [],
    triggerType: 'agency_reply',
    autopilotMode: 'SUPERVISED',
    humanDecision: null,
    reviewAction: null,
    reviewInstruction: null,
    proposalReasoning: []
  };

  const decideResult = await decideNextActionNode(decideState);

  return {
    classifyResult,
    decideResult,
    denialSubtype: classifyResult.denialSubtype
  };
}

async function runDraftForNewAction(caseId, actionType, latestInboundId) {
  // Only run draft for action types that produce output
  if (!ACTIONS_NEEDING_DRAFT.includes(actionType)) {
    return null;
  }

  console.log(`    Running live AI draft for ${actionType}...`);
  const draftState = {
    caseId,
    proposalActionType: actionType,
    constraints: [],
    scopeItems: [],
    extractedFeeAmount: null,
    adjustmentInstruction: null,
    llmStubs: null,
    latestInboundMessageId: latestInboundId,
    proposalReasoning: []
  };

  const draftResult = await draftResponseNode(draftState);
  return draftResult;
}

async function main() {
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║   Reprocess All Cases — Denial Subtype Routing v2          ║');
  console.log('╚══════════════════════════════════════════════════════════════╝');
  console.log(`  Mode: ${EXECUTE ? '🔴 EXECUTE (will write to DB)' : '🟡 DRY RUN (preview only)'}`);
  console.log();

  const cases = await getAllCasesWithInbound();
  console.log(`Found ${cases.length} cases with inbound messages\n`);

  const results = {
    unchanged: [],
    changed: [],
    errors: [],
    skipped: []
  };

  for (const caseRow of cases) {
    const caseId = caseRow.id;
    console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    console.log(`Case #${caseId}: ${(caseRow.case_name || '').substring(0, 55)}`);
    console.log(`  Agency: ${caseRow.agency_name} | Status: ${caseRow.status}`);

    try {
      // Get existing analysis
      const analysis = await getLatestAnalysis(caseId);
      if (!analysis) {
        console.log(`  ⏭️  SKIP: No response analysis found`);
        results.skipped.push({ caseId, reason: 'no analysis' });
        continue;
      }

      const fullJson = analysis.full_analysis_json || {};
      console.log(`  Analysis: intent=${analysis.intent} | subtype=${fullJson.denial_subtype || 'none'}`);

      // Get existing proposal
      const oldProposal = await getLatestProposal(caseId);
      const oldAction = oldProposal?.action_type || 'NONE';
      const oldStatus = oldProposal?.status || 'none';
      console.log(`  Old proposal: ${oldAction} (${oldStatus})`);

      // Don't reprocess EXECUTED proposals — those are done
      if (oldStatus === 'EXECUTED' && !['SUBMIT_PORTAL'].includes(oldAction)) {
        console.log(`  ⏭️  SKIP: Latest proposal already EXECUTED (${oldAction})`);
        results.skipped.push({ caseId, reason: `already executed: ${oldAction}` });
        continue;
      }

      // Reprocess through new routing
      const { classifyResult, decideResult, denialSubtype } = await reprocessCase(caseRow, analysis);

      const newAction = decideResult.proposalActionType || 'NONE';
      const isComplete = decideResult.isComplete || false;

      console.log(`  New routing: ${newAction}${isComplete ? ' (complete)' : ''}`);
      console.log(`  Denial subtype: ${denialSubtype || 'none'}`);
      console.log(`  Reasoning: ${(decideResult.proposalReasoning || []).join(' | ')}`);

      // Compare
      if (newAction === oldAction) {
        console.log(`  ✅ UNCHANGED: ${oldAction} → ${newAction}`);
        results.unchanged.push({ caseId, action: newAction });
        continue;
      }

      // Action changed!
      console.log(`  🔄 CHANGED: ${oldAction} → ${newAction}`);

      let draftResult = null;
      if (ACTIONS_NEEDING_DRAFT.includes(newAction) && EXECUTE) {
        draftResult = await runDraftForNewAction(caseId, newAction, caseRow.latest_inbound_id);
        if (draftResult) {
          if (draftResult.proposalReasoning) {
            console.log(`    Draft reasoning: ${draftResult.proposalReasoning.join(' | ')}`);
          }
          if (draftResult.draftSubject) {
            console.log(`    Draft subject: ${draftResult.draftSubject}`);
          }
          if (draftResult.draftBodyText) {
            console.log(`    Draft body: ${draftResult.draftBodyText.substring(0, 150)}...`);
          }
        }
      }

      if (EXECUTE) {
        // Supersede old pending proposals
        const superseded = await supersedePendingProposals(caseId);
        if (superseded.length > 0) {
          console.log(`    Superseded ${superseded.length} old proposals: ${superseded.map(p => `#${p.id} (${p.action_type})`).join(', ')}`);
        }

        // Create new proposal
        const proposalKey = `${caseId}:${caseRow.latest_inbound_id || 'reprocess'}:${newAction}:0`;

        const reasoning = [
          ...(decideResult.proposalReasoning || []),
          `[REPROCESSED] Old action: ${oldAction} → New action: ${newAction}`,
          ...(draftResult?.proposalReasoning || [])
        ];

        if (!isComplete && newAction !== 'NONE') {
          const newProposal = await db.upsertProposal({
            proposalKey,
            caseId,
            runId: null,
            triggerMessageId: caseRow.latest_inbound_id,
            actionType: newAction,
            draftSubject: draftResult?.draftSubject || null,
            draftBodyText: draftResult?.draftBodyText || null,
            draftBodyHtml: draftResult?.draftBodyHtml || null,
            reasoning,
            confidence: 0.85,
            riskFlags: [],
            warnings: [],
            canAutoExecute: false,
            requiresHuman: true,
            status: 'PENDING_APPROVAL',
            langgraphThreadId: `case:${caseId}`,
            adjustmentCount: 0
          });
          console.log(`    ✅ Created proposal #${newProposal.id}: ${newAction} (PENDING_APPROVAL)`);

          // Update case status (pause_reason must be a valid enum)
          const pauseReasonMap = {
            'RESEARCH_AGENCY': 'DENIAL',
            'REFORMULATE_REQUEST': 'DENIAL',
            'SEND_REBUTTAL': 'DENIAL',
            'NEGOTIATE_FEE': 'FEE_QUOTE',
            'ACCEPT_FEE': 'FEE_QUOTE',
            'ESCALATE': 'SENSITIVE'
          };
          await db.updateCaseStatus(caseId, 'needs_human_review', {
            requires_human: true,
            pause_reason: pauseReasonMap[newAction] || 'DENIAL'
          });
        } else {
          console.log(`    ℹ️  Action is NONE/complete — no proposal needed`);
        }
      } else {
        console.log(`    [DRY RUN] Would supersede old proposals and create: ${newAction}`);
      }

      results.changed.push({
        caseId,
        caseName: (caseRow.case_name || '').substring(0, 50),
        oldAction,
        newAction,
        denialSubtype,
        reasoning: (decideResult.proposalReasoning || []).join(' | ')
      });

    } catch (err) {
      console.log(`  ❌ ERROR: ${err.message}`);
      results.errors.push({ caseId, error: err.message });
    }

    console.log();
  }

  // Summary
  console.log('\n' + '═'.repeat(62));
  console.log('  REPROCESSING SUMMARY');
  console.log('═'.repeat(62));
  console.log(`  Mode: ${EXECUTE ? 'EXECUTED' : 'DRY RUN'}`);
  console.log(`  Total cases: ${cases.length}`);
  console.log(`  Unchanged: ${results.unchanged.length}`);
  console.log(`  Changed: ${results.changed.length}`);
  console.log(`  Skipped: ${results.skipped.length}`);
  console.log(`  Errors: ${results.errors.length}`);

  if (results.changed.length > 0) {
    console.log('\n  CHANGES:');
    for (const c of results.changed) {
      console.log(`    Case #${c.caseId}: ${c.oldAction} → ${c.newAction} (subtype: ${c.denialSubtype || 'none'})`);
      console.log(`      ${c.caseName}`);
    }
  }

  if (results.skipped.length > 0) {
    console.log('\n  SKIPPED:');
    for (const s of results.skipped) {
      console.log(`    Case #${s.caseId}: ${s.reason}`);
    }
  }

  if (results.errors.length > 0) {
    console.log('\n  ERRORS:');
    for (const e of results.errors) {
      console.log(`    Case #${e.caseId}: ${e.error}`);
    }
  }

  await db.pool.end();
}

main().catch(e => {
  console.error('Fatal error:', e);
  process.exit(1);
});
