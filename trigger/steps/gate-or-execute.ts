/**
 * Gate or Execute Step
 *
 * REWRITTEN: Uses Trigger.dev waitpoint tokens instead of LangGraph interrupt().
 *
 * Creates proposal, then either:
 * - Auto-execute path: returns immediately for execution
 * - Human gate path: returns waitpoint token ID for pause
 */

import db, { logger } from "../lib/db";
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

  // Merge safety into auto-execute decision
  const canAutoExecute = decisionCanAutoExecute && safety.canAutoExecute;
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
    confidence: confidence || 0.8,
    riskFlags: safety.riskFlags || [],
    warnings: safety.warnings || [],
    canAutoExecute,
    requiresHuman,
    status: canAutoExecute ? "APPROVED" : "PENDING_APPROVAL",
    adjustmentCount: adjustmentCount || 0,
    lessonsApplied: lessonsApplied || null,
    gateOptions: gateOptions || ["APPROVE", "ADJUST", "DISMISS", "WITHDRAW"],
  });

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

  // Store token ID on proposal and reset status for the new gate
  // (upsert ON CONFLICT preserves EXECUTED status; we need PENDING_APPROVAL for the compare-and-swap)
  // Also clear execution_key so claimProposalExecution can re-claim it
  await db.updateProposal(proposal.id, {
    waitpoint_token: tokenId,
    status: "PENDING_APPROVAL",
    executionKey: null,
    executed_at: null,
  });

  // Update case status to needs_human_review
  await db.updateCaseStatus(caseId, "needs_human_review", {
    requires_human: true,
    pause_reason: pauseReason || "PENDING_APPROVAL",
  });

  return {
    proposalId: proposal.id,
    proposalKey,
    shouldWait: true,
    waitpointTokenId: tokenId,
  };
}
