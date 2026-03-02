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
import type { ActionType, ProposalRecord, ChainAction } from "../lib/types";

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
  chainId: string | null;
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
  gateOptions?: string[],
  chainActions?: ChainAction[]
): Promise<GateResult> {
  // NONE actions skip proposal creation
  if (actionType === "NONE") {
    return { proposalId: 0, proposalKey: "", shouldWait: false, waitpointTokenId: null, chainId: null };
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

  // Determine chain metadata
  const hasChain = chainActions && chainActions.length > 1;
  const chainId = hasChain ? crypto.randomUUID() : null;

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
    actionChain: hasChain ? chainActions : null,
    chainId,
    chainStep: hasChain ? 0 : null,
  });
  if (caseAgencyId && proposal?.id) {
    await db.updateProposal(proposal.id, { case_agency_id: caseAgencyId });
  }

  // Create follow-up chain proposals (CHAIN_PENDING status — wait for primary approval)
  if (hasChain && chainId) {
    for (let step = 1; step < chainActions.length; step++) {
      const chainAction = chainActions[step];
      const chainProposalKey = generateProposalKey(
        caseId, messageId, chainAction.actionType, adjustmentCount, caseAgencyId, runId
      ) + `:chain-${step}`;

      const chainProposal = await db.upsertProposal({
        proposalKey: chainProposalKey,
        caseId,
        runId,
        triggerMessageId: messageId,
        actionType: chainAction.actionType,
        draftSubject: chainAction.draftSubject,
        draftBodyText: chainAction.draftBodyText,
        draftBodyHtml: chainAction.draftBodyHtml,
        reasoning: [`Chain step ${step + 1}: follows ${actionType}`],
        confidence: confidence ?? 0.8,
        riskFlags: [],
        warnings: [],
        canAutoExecute: false,
        requiresHuman: true,
        status: "CHAIN_PENDING",
        adjustmentCount: adjustmentCount || 0,
        lessonsApplied: null,
        gateOptions: null,
        chainId,
        chainStep: step,
      });
      if (caseAgencyId && chainProposal?.id) {
        await db.updateProposal(chainProposal.id, { case_agency_id: caseAgencyId });
      }
    }

    logger.info("Created action chain proposals", {
      caseId, chainId, steps: chainActions.length,
      actions: chainActions.map(a => a.actionType),
    });
  }

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

  // Same-run retry guard: if proposal was already EXECUTED by THIS run,
  // the action completed in a prior attempt — don't re-gate.
  if (proposal.status === 'EXECUTED' && proposal.run_id === runId) {
    logger.info("Proposal already executed by this run, skipping re-gate", {
      caseId, proposalId: proposal.id, runId,
    });
    return {
      proposalId: proposal.id,
      proposalKey,
      shouldWait: false,
      waitpointTokenId: null,
      chainId,
    };
  }

  // AUTO EXECUTE PATH
  if (canAutoExecute && !requiresHuman) {
    return {
      proposalId: proposal.id,
      proposalKey,
      shouldWait: false,
      waitpointTokenId: null,
      chainId,
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
    chainId,
  };
}
