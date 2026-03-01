/**
 * Gate or Execute Step
 *
 * REWRITTEN: Uses Trigger.dev waitpoint tokens instead of LangGraph interrupt().
 *
 * Creates proposal, then either:
 * - Auto-execute path: returns immediately for execution
 * - Human gate path: returns waitpoint token ID for pause
 */

import db, { logger, caseRuntime } from "../lib/db";
import type { ActionType, ProposalRecord } from "../lib/types";

function generateProposalKey(
  caseId: number,
  messageId: number | null,
  actionType: string,
  adjustmentCount: number,
  caseAgencyId: number | null,
  runId: number | null
): string {
  const agencyPart = caseAgencyId ? `:ca${caseAgencyId}` : "";
  const messagePart = messageId || (runId ? `run-${runId}` : "scheduled");
  return `${caseId}:${messagePart}${agencyPart}:${actionType}:${adjustmentCount || 0}`;
}

export interface GateResult {
  proposalId: number;
  proposalKey: string;
  shouldWait: boolean;
  waitpointTokenId: string | null;
}

export async function createProposalAndGate(
  caseId: number,
  runId: number,
  actionType: ActionType,
  messageId: number | null,
  draft: { subject: string | null; bodyText: string | null; bodyHtml: string | null },
  safety: { riskFlags: string[]; warnings: string[]; canAutoExecute: boolean; requiresHuman: boolean; pauseReason: string | null },
  decisionCanAutoExecute: boolean,
  decisionRequiresHuman: boolean,
  pauseReason: string | null,
  reasoning: string[],
  confidence: number,
  adjustmentCount: number,
  caseAgencyId: number | null,
  lessonsApplied: any[] | null,
  gateOptions?: string[]
): Promise<GateResult> {
  // NONE actions skip proposal creation
  if (actionType === "NONE") {
    return { proposalId: 0, proposalKey: "", shouldWait: false, waitpointTokenId: null };
  }

  // Confidence-based auto-execution tiers (even in SUPERVISED mode)
  // Safe actions with high confidence can auto-execute without human review
  const SAFE_AUTO_ACTIONS: string[] = ["CLOSE_CASE", "RESEARCH_AGENCY"];
  const MEDIUM_AUTO_ACTIONS: string[] = ["SEND_FOLLOWUP", "SEND_CLARIFICATION"];
  const effectiveConfidence = confidence ?? 0.8;

  let confidenceAutoExecute = false;
  if (!decisionRequiresHuman && safety.canAutoExecute) {
    if (SAFE_AUTO_ACTIONS.includes(actionType) && effectiveConfidence >= 0.90) {
      confidenceAutoExecute = true;
    } else if (MEDIUM_AUTO_ACTIONS.includes(actionType) && effectiveConfidence >= 0.85) {
      confidenceAutoExecute = true;
    }
  }

  // Merge safety into auto-execute decision
  const canAutoExecute = (decisionCanAutoExecute || confidenceAutoExecute) && safety.canAutoExecute;
  const requiresHuman = decisionRequiresHuman || safety.requiresHuman;

  const proposalKey = generateProposalKey(
    caseId,
    messageId,
    actionType,
    adjustmentCount,
    caseAgencyId,
    runId
  );

  // Idempotent upsert
  const proposal = await db.upsertProposal({
    proposalKey,
    caseId,
    runId,
    triggerMessageId: messageId,
    actionType,
    draftSubject: draft.subject,
    draftBodyText: draft.bodyText,
    draftBodyHtml: draft.bodyHtml,
    reasoning,
    confidence: confidence ?? 0.8,
    riskFlags: safety.riskFlags || [],
    warnings: safety.warnings || [],
    canAutoExecute,
    requiresHuman,
    status: canAutoExecute ? "APPROVED" : "PENDING_APPROVAL",
    adjustmentCount: adjustmentCount || 0,
    lessonsApplied: lessonsApplied || null,
    gateOptions: gateOptions || ["APPROVE", "ADJUST", "DISMISS", "WITHDRAW"],
  });

  // Reclaim proposal from a prior run whose execution is stale.
  // The upsert ON CONFLICT preserves EXECUTED status (correct for same-run retries),
  // but a NEW run processing the same message needs a fresh proposal.
  if (proposal.status === 'EXECUTED' && proposal.run_id !== runId) {
    const reclaimStatus = canAutoExecute ? 'APPROVED' : 'PENDING_APPROVAL';
    await db.updateProposal(proposal.id, {
      status: reclaimStatus,
      run_id: runId,
      executionKey: null,
      executed_at: null,
      emailJobId: null,
      humanDecision: null,
      humanDecidedAt: null,
      humanDecidedBy: null,
      waitpoint_token: null,
    });
    proposal.status = reclaimStatus;
    proposal.run_id = runId;
    proposal.execution_key = null;
    proposal.executed_at = null;
  }

  // AUTO EXECUTE PATH
  if (canAutoExecute && !requiresHuman) {
    return {
      proposalId: proposal.id,
      proposalKey,
      shouldWait: false,
      waitpointTokenId: null,
    };
  }

  // HUMAN GATE PATH — generate opaque token ID
  const tokenId = crypto.randomUUID();

  // Store token ID on proposal and clear execution fields for the new gate
  // (upsert ON CONFLICT preserves EXECUTED status; we need to re-claim it)
  // Status is set to PENDING_APPROVAL by the runtime via PROPOSAL_GATED
  await db.updateProposal(proposal.id, {
    waitpoint_token: tokenId,
    executionKey: null,
    executed_at: null,
  });

  // Atomically update case + proposal status via the runtime
  await caseRuntime.transitionCaseRuntime(caseId, "PROPOSAL_GATED", {
    proposalId: proposal.id,
    runId,
    pauseReason: pauseReason || "PENDING_APPROVAL",
  });

  return {
    proposalId: proposal.id,
    proposalKey,
    shouldWait: true,
    waitpointTokenId: tokenId,
  };
}
