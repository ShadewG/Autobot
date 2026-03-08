#!/usr/bin/env node
/**
 * Reset + reprocess cases that were mis-labeled as agency_research_failed
 * even though research had usable channels.
 *
 * Usage:
 *   node scripts/_reset_and_reprocess_mislabeled_research_cases.js --dry-run
 *   node scripts/_reset_and_reprocess_mislabeled_research_cases.js
 */

require('dotenv').config();

const db = require('../services/database');
const { transitionCaseRuntime } = require('../services/case-runtime');
const triggerDispatch = require('../services/trigger-dispatch-service');

const DRY_RUN = process.argv.includes('--dry-run');
const CASE_IDS = [25109, 25140, 25148, 25150, 25152, 25155, 25165, 25166];

async function resetCase(caseId) {
  const caseRow = await db.getCaseById(caseId);
  if (!caseRow) {
    console.log(`Case ${caseId}: not found`);
    return null;
  }

  const latestInbound = await db.query(
    `SELECT id
     FROM messages
     WHERE case_id = $1 AND direction = 'inbound'
     ORDER BY COALESCE(received_at, created_at) DESC
     LIMIT 1`,
    [caseId]
  );

  const latestInboundId = latestInbound.rows[0]?.id || null;
  const targetStatus = latestInboundId ? 'responded' : 'awaiting_response';

  console.log(`Case ${caseId}: ${caseRow.status}/${caseRow.substatus || '-'} -> ${targetStatus}`);

  if (DRY_RUN) {
    return { caseRow, latestInboundId };
  }

  await db.query(
    `UPDATE proposals
     SET status = 'DISMISSED', updated_at = NOW()
     WHERE case_id = $1 AND status IN ('PENDING_APPROVAL', 'BLOCKED')`,
    [caseId]
  );

  await transitionCaseRuntime(caseId, 'CASE_RECONCILED', { targetStatus });

  return { caseRow, latestInboundId };
}

async function reprocessCase(caseId, latestInboundId) {
  if (DRY_RUN) {
    console.log(`Case ${caseId}: would trigger process-inbound (messageId=${latestInboundId || 'null'})`);
    return;
  }

  const run = await db.createAgentRunFull({
    case_id: caseId,
    trigger_type: 'inbound_message',
    status: 'queued',
    message_id: latestInboundId,
    autopilot_mode: 'SUPERVISED',
    langgraph_thread_id: `case:${caseId}:msg-${latestInboundId}`,
  });

  const { handle } = await triggerDispatch.triggerTask(
    'process-inbound',
    {
      runId: run.id,
      caseId,
      messageId: latestInboundId,
      autopilotMode: 'SUPERVISED',
      triggerType: 'RESEARCH_MISLABEL_RESET',
    },
    {
      queue: `case-${caseId}`,
      concurrencyKey: `case-${caseId}`,
    }
  );

  console.log(`Case ${caseId}: triggered run ${run.id} (${handle.id}) with messageId=${latestInboundId || 'null'}`);
}

(async () => {
  console.log(`${DRY_RUN ? '[DRY RUN] ' : ''}Resetting/reprocessing cases: ${CASE_IDS.join(', ')}`);

  for (const caseId of CASE_IDS) {
    try {
      const resetInfo = await resetCase(caseId);
      if (!resetInfo) continue;
      await reprocessCase(caseId, resetInfo.latestInboundId);
    } catch (e) {
      console.error(`Case ${caseId}: failed - ${e.message}`);
    }
  }

  console.log('Done.');
  process.exit(0);
})();
