/**
 * Gate or Execute Node (with Interrupt)
 *
 * Gates for human approval OR executes automatically.
 *
 * P0 FIX #2: CRITICAL RULES FOR INTERRUPTS
 * 1. NO try/catch around interrupt()
 * 2. All side effects before interrupt() MUST be idempotent
 * 3. Use upsert with proposal_key for proposal creation
 *
 * Uses LangGraph interrupt() for human-in-the-loop.
 */

const { interrupt } = require("@langchain/langgraph");
const db = require('../../services/database');
const logger = require('../../utils/logger');

/**
 * Generate deterministic proposal key for idempotency
 * P0 FIX #2: Allows safe re-runs without duplicate proposals
 */
function generateProposalKey(state) {
  const {
    caseId, latestInboundMessageId, proposalActionType,
    adjustmentCount
  } = state;

  // Format: {case}:{message}:{action}:{attempt}
  return `${caseId}:${latestInboundMessageId || 'scheduled'}:${proposalActionType}:${adjustmentCount || 0}`;
}

/**
 * Gate for human approval OR execute automatically
 */
async function gateOrExecuteNode(state) {
  const {
    caseId, proposalActionType, canAutoExecute, requiresHuman,
    pauseReason, draftSubject, draftBodyText, draftBodyHtml,
    proposalReasoning, proposalConfidence, riskFlags, warnings,
    gateOptions, adjustmentCount
  } = state;

  const logs = [];

  // P0 FIX #2: Generate deterministic key for idempotent upsert
  const proposalKey = generateProposalKey(state);

  // P0 FIX #2: IDEMPOTENT proposal creation (upsert, not insert)
  // This is SAFE to re-run on resume because of ON CONFLICT
  const proposal = await db.upsertProposal({
    proposalKey,  // Unique key for idempotency
    caseId,
    triggerMessageId: state.latestInboundMessageId,
    actionType: proposalActionType,
    draftSubject,
    draftBodyText,
    draftBodyHtml,
    reasoning: proposalReasoning,
    confidence: proposalConfidence || 0.8,
    riskFlags: riskFlags || [],
    warnings: warnings || [],
    canAutoExecute,
    requiresHuman,
    status: canAutoExecute ? 'APPROVED' : 'PENDING_APPROVAL',
    langgraphThreadId: state.threadId,
    adjustmentCount: adjustmentCount || 0
  });

  logs.push(`Upserted proposal ${proposal.id} (key: ${proposalKey})`);

  // === AUTO EXECUTE PATH ===
  if (canAutoExecute && !requiresHuman) {
    logs.push('Auto-executing approved action');
    return {
      proposalId: proposal.id,
      proposalKey,
      logs,
      nextNode: 'execute_action'
    };
  }

  // === HUMAN GATE PATH ===
  logs.push(`Gating for human approval (reason: ${pauseReason})`);

  // P0 FIX #2: IDEMPOTENT status update (safe to re-run)
  await db.updateCaseStatus(caseId, 'needs_human_review', {
    requires_human: true,
    pause_reason: pauseReason
  });

  // P0 FIX #2: CRITICAL - NO try/catch around interrupt()
  // When resumed, this entire node function reruns from the TOP
  // That's why all operations above MUST be idempotent

  const decision = interrupt({
    type: 'HUMAN_APPROVAL',
    requestId: caseId,
    proposalId: proposal.id,
    proposalKey,
    proposalActionType,
    pauseReason,
    options: gateOptions || ['APPROVE', 'ADJUST', 'DISMISS', 'WITHDRAW'],
    summary: {
      subject: draftSubject,
      reasoning: proposalReasoning,
      riskFlags: riskFlags || [],
      warnings: warnings || []
    }
  });

  // This code runs AFTER resume - decision contains the human's choice
  // The node re-ran from the top, so proposal was re-upserted (idempotent)
  return {
    proposalId: proposal.id,
    proposalKey,
    humanDecision: decision,
    adjustmentCount: decision?.action === 'ADJUST'
      ? (adjustmentCount || 0) + 1
      : adjustmentCount,
    logs: [...logs, `Human decision received: ${decision?.action}`],
    nextNode: 'decide_next_action'  // Re-route based on decision
  };

  // P0 FIX #2: NO catch block - errors should propagate up
}

module.exports = { gateOrExecuteNode };
