#!/usr/bin/env node
/**
 * One-time script to fix 6 orphaned cases stuck in needs_human_review.
 *
 * Root cause: dismissing proposals via the legacy/API path didn't reconcile
 * case state, leaving cases with requires_human=true and no active proposal.
 *
 * Cases 25140 & 25206: just reset state (no reprocess needed)
 * Cases 25147, 25151, 25169, 25202: reset state + trigger process-inbound
 */

require('dotenv').config();
const db = require('../services/database');
const { transitionCaseRuntime } = require('../services/case-runtime');
const triggerDispatch = require('../services/trigger-dispatch-service');

const CASES_RESET_ONLY = [25140, 25206];
const CASES_REPROCESS = [25147, 25151, 25169, 25202];
const ALL_CASES = [...CASES_RESET_ONLY, ...CASES_REPROCESS];

async function resetCase(caseId) {
  // 1. Dismiss all active proposals
  const dismissed = await db.query(
    `UPDATE proposals SET status = 'DISMISSED', updated_at = NOW()
     WHERE case_id = $1 AND status IN ('PENDING_APPROVAL', 'BLOCKED')
     RETURNING id, action_type, status`,
    [caseId]
  );
  console.log(`  Case ${caseId}: dismissed ${dismissed.rows.length} proposals`, dismissed.rows.map(r => `#${r.id} (${r.action_type})`));

  // 2. Determine target status based on inbound messages
  const hasInbound = await db.query(
    `SELECT 1 FROM messages WHERE case_id = $1 AND direction = 'inbound' LIMIT 1`,
    [caseId]
  );
  const targetStatus = hasInbound.rows.length > 0 ? 'responded' : 'awaiting_response';

  // 3. Clear requires_human and pause_reason, set correct status
  await transitionCaseRuntime(caseId, 'CASE_RECONCILED', { targetStatus });
  console.log(`  Case ${caseId}: status → ${targetStatus}, requires_human → false`);
}

async function reprocessCase(caseId) {
  // Get the latest inbound message to use as trigger
  const latestInbound = await db.query(
    `SELECT id FROM messages WHERE case_id = $1 AND direction = 'inbound' ORDER BY created_at DESC LIMIT 1`,
    [caseId]
  );
  const messageId = latestInbound.rows[0]?.id || null;

  const { handle } = await triggerDispatch.triggerTask('process-inbound', {
    runId: 0,
    caseId,
    messageId,
    autopilotMode: 'SUPERVISED',
    triggerType: 'ORPHAN_CASE_RESET',
  }, {
    queue: `case-${caseId}`,
    concurrencyKey: `case-${caseId}`,
  });

  console.log(`  Case ${caseId}: triggered process-inbound (run: ${handle.id})`);
}

async function main() {
  console.log('=== Resetting broken orphaned cases ===\n');

  // Phase 1: Reset all cases
  for (const caseId of ALL_CASES) {
    try {
      await resetCase(caseId);
    } catch (err) {
      console.error(`  Case ${caseId}: RESET FAILED — ${err.message}`);
    }
  }

  console.log('\n--- Phase 2: Reprocessing cases that need it ---\n');

  // Phase 2: Trigger reprocessing for cases that need it
  for (const caseId of CASES_REPROCESS) {
    try {
      await reprocessCase(caseId);
    } catch (err) {
      console.error(`  Case ${caseId}: REPROCESS FAILED — ${err.message}`);
    }
  }

  console.log('\n=== Done. Verify cases on dashboard. ===');
}

main()
  .catch(err => { console.error('Fatal:', err); process.exit(1); })
  .finally(() => setTimeout(() => process.exit(0), 2000));
