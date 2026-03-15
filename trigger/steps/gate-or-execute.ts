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
import type { ActionType, ProposalRecord, ChainAction, AIModelMetadata } from "../lib/types";

const ACTIONS_REQUIRING_REVIEWABLE_DRAFT = new Set<ActionType>([
  "SEND_INITIAL_REQUEST",
  "SUBMIT_PORTAL",
  "SEND_FOLLOWUP",
  "SEND_REBUTTAL",
  "SEND_CLARIFICATION",
  "SEND_PDF_EMAIL",
  "SEND_APPEAL",
  "SEND_FEE_WAIVER_REQUEST",
  "SEND_STATUS_UPDATE",
  "RESPOND_PARTIAL_APPROVAL",
  "ACCEPT_FEE",
  "NEGOTIATE_FEE",
  "DECLINE_FEE",
  "REFORMULATE_REQUEST",
]);

const DRAFT_ALIGNMENT_FALLBACK_FLAGS = new Set([
  "INVALID_ACTION_DRAFT",
]);

function hasDraftContent(draft: { subject: string | null; bodyText: string | null; bodyHtml: string | null }): boolean {
  const subject = (draft.subject || "").trim();
  const bodyText = (draft.bodyText || "").trim();
  const bodyHtml = (draft.bodyHtml || "").trim();
  return subject.length > 0 || bodyText.length > 0 || bodyHtml.length > 0;
}

function buildFallbackDraft(
  actionType: ActionType,
  reasoning: string[]
): { subject: string | null; bodyText: string | null; bodyHtml: string | null } {
  const reason = reasoning?.[0] || "System generated this fallback after draft generation failed.";
  const bodyText = [
    "System fallback draft generated.",
    "",
    `Requested action: ${actionType}`,
    `Reason: ${reason}`,
    "",
    "Please review and adjust before sending.",
  ].join("\n");
  return {
    subject: `Review required: ${actionType.replaceAll("_", " ")}`,
    bodyText,
    bodyHtml: null,
  };
}

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
  chainActions?: ChainAction[],
  decisionModelMetadata?: AIModelMetadata | null,
  draftModelMetadata?: AIModelMetadata | null
): Promise<GateResult> {
  // NONE actions skip proposal creation
  if (actionType === "NONE") {
    return { proposalId: 0, proposalKey: "", shouldWait: false, waitpointTokenId: null, chainId: null };
  }

  let effectiveDraft = { ...draft };
  let effectiveDecisionCanAutoExecute = decisionCanAutoExecute;
  let effectiveDecisionRequiresHuman = decisionRequiresHuman;
  let effectivePauseReason = pauseReason;
  let effectiveSafety = { ...safety };
  let effectiveCaseAgencyId = Number.isInteger(caseAgencyId) && Number(caseAgencyId) > 0
    ? Number(caseAgencyId)
    : null;

  if (caseId) {
    const resolvedCaseAgency = await db.resolveProposalCaseAgency(caseId, {
      caseAgencyId: effectiveCaseAgencyId,
    }).catch(() => null);
    if (resolvedCaseAgency?.id) {
      effectiveCaseAgencyId = Number(resolvedCaseAgency.id);
    }
  }

  // Research-only steps are safe operational actions and should not block
  // human queues. Any true ambiguity/failure is handled inside execute-action
  // via explicit research handoff proposals.
  if (
    actionType === "RESEARCH_AGENCY" &&
    effectiveSafety.canAutoExecute &&
    !effectiveSafety.requiresHuman
  ) {
    effectiveDecisionCanAutoExecute = true;
    effectiveDecisionRequiresHuman = false;
    effectivePauseReason = null;
    effectiveSafety = {
      ...effectiveSafety,
      canAutoExecute: true,
      requiresHuman: false,
    };
  }

  // Never allow reviewable actions to gate as empty proposals.
  if (ACTIONS_REQUIRING_REVIEWABLE_DRAFT.has(actionType) && !hasDraftContent(effectiveDraft)) {
    effectiveDraft = buildFallbackDraft(actionType, reasoning);
    effectiveDecisionCanAutoExecute = false;
    effectiveDecisionRequiresHuman = true;
    effectivePauseReason = effectivePauseReason || "MISSING_DRAFT_AUTOFALLBACK";
    effectiveSafety = {
      ...effectiveSafety,
      canAutoExecute: false,
      requiresHuman: true,
      warnings: [...(effectiveSafety.warnings || []), "Draft content was missing; fallback draft generated automatically."],
    };
    logger.error("Missing draft content for reviewable action; generated fallback draft", {
      caseId,
      runId,
      actionType,
    });
  }

  if (
    ACTIONS_REQUIRING_REVIEWABLE_DRAFT.has(actionType)
    && effectiveSafety.riskFlags?.some((flag) => DRAFT_ALIGNMENT_FALLBACK_FLAGS.has(flag))
  ) {
    effectiveDraft = buildFallbackDraft(actionType, [
      ...reasoning,
      `Generated ${actionType} draft failed semantic validation and needs manual rewrite before sending.`,
    ]);
    effectiveDecisionCanAutoExecute = false;
    effectiveDecisionRequiresHuman = true;
    effectivePauseReason = effectivePauseReason || "INVALID_DRAFT_AUTOFALLBACK";
    effectiveSafety = {
      ...effectiveSafety,
      canAutoExecute: false,
      requiresHuman: true,
      warnings: [
        ...(effectiveSafety.warnings || []),
        `Generated ${actionType} draft failed semantic validation; fallback draft generated automatically.`,
      ],
    };
    logger.error("Generated draft failed semantic validation; replaced with fallback draft", {
      caseId,
      runId,
      actionType,
      riskFlags: effectiveSafety.riskFlags,
    });
  }

  // Confidence-based auto-execution tiers (even in SUPERVISED mode)
  // Safe actions with high confidence can auto-execute without human review
  const SAFE_AUTO_ACTIONS: string[] = ["CLOSE_CASE", "RESEARCH_AGENCY"];
  const MEDIUM_AUTO_ACTIONS: string[] = ["SEND_FOLLOWUP", "SEND_CLARIFICATION"];
  const effectiveConfidence = confidence ?? 0.8;

  let confidenceAutoExecute = false;
  if (!effectiveDecisionRequiresHuman && effectiveSafety.canAutoExecute) {
    if (SAFE_AUTO_ACTIONS.includes(actionType) && effectiveConfidence >= 0.90) {
      confidenceAutoExecute = true;
    } else if (MEDIUM_AUTO_ACTIONS.includes(actionType) && effectiveConfidence >= 0.85) {
      confidenceAutoExecute = true;
    }
  }

  // Merge safety into auto-execute decision
  const canAutoExecute = (effectiveDecisionCanAutoExecute || confidenceAutoExecute) && effectiveSafety.canAutoExecute;
  const requiresHuman = effectiveDecisionRequiresHuman || effectiveSafety.requiresHuman;

  const proposalKey = generateProposalKey(
    caseId,
    messageId,
    actionType,
    adjustmentCount,
    effectiveCaseAgencyId,
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
    draftSubject: effectiveDraft.subject,
    draftBodyText: effectiveDraft.bodyText,
    draftBodyHtml: effectiveDraft.bodyHtml,
    decisionModelId: decisionModelMetadata?.modelId || null,
    decisionPromptTokens: decisionModelMetadata?.promptTokens ?? null,
    decisionCompletionTokens: decisionModelMetadata?.completionTokens ?? null,
    decisionLatencyMs: decisionModelMetadata?.latencyMs ?? null,
    draftModelId: draftModelMetadata?.modelId || null,
    draftPromptTokens: draftModelMetadata?.promptTokens ?? null,
    draftCompletionTokens: draftModelMetadata?.completionTokens ?? null,
    draftLatencyMs: draftModelMetadata?.latencyMs ?? null,
    reasoning,
    confidence: confidence ?? 0.8,
    riskFlags: effectiveSafety.riskFlags || [],
    warnings: effectiveSafety.warnings || [],
    canAutoExecute,
    requiresHuman,
    status: canAutoExecute ? "APPROVED" : "PENDING_APPROVAL",
    caseAgencyId: effectiveCaseAgencyId || null,
    adjustmentCount: adjustmentCount || 0,
    lessonsApplied: lessonsApplied || null,
    gateOptions: gateOptions || (actionType === "ACCEPT_FEE"
      ? ["APPROVE", "ADD_TO_INVOICING", "WAIT_FOR_GOOD_TO_PAY", "ADJUST", "DISMISS", "WITHDRAW"]
      : ["APPROVE", "ADJUST", "DISMISS", "WITHDRAW"]),
    actionChain: hasChain ? chainActions : null,
    chainId,
    chainStep: hasChain ? 0 : null,
  });
  if (effectiveCaseAgencyId && proposal?.id) {
    await db.updateProposal(proposal.id, { case_agency_id: effectiveCaseAgencyId });
  }

  // Create follow-up chain proposals (CHAIN_PENDING status — wait for primary approval)
  if (hasChain && chainId) {
    for (let step = 1; step < chainActions.length; step++) {
      const chainAction = chainActions[step];
      const chainProposalKey = generateProposalKey(
        caseId, messageId, chainAction.actionType, adjustmentCount, effectiveCaseAgencyId, runId
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
        decisionModelId: decisionModelMetadata?.modelId || null,
        decisionPromptTokens: decisionModelMetadata?.promptTokens ?? null,
        decisionCompletionTokens: decisionModelMetadata?.completionTokens ?? null,
        decisionLatencyMs: decisionModelMetadata?.latencyMs ?? null,
        reasoning: [`Chain step ${step + 1}: follows ${actionType}`],
        confidence: confidence ?? 0.8,
        riskFlags: [],
        warnings: [],
        canAutoExecute: false,
        requiresHuman: true,
        status: "CHAIN_PENDING",
        caseAgencyId: effectiveCaseAgencyId || null,
        adjustmentCount: adjustmentCount || 0,
        lessonsApplied: null,
        gateOptions: null,
        chainId,
        chainStep: step,
      });
      if (effectiveCaseAgencyId && chainProposal?.id) {
        await db.updateProposal(chainProposal.id, { case_agency_id: effectiveCaseAgencyId });
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
    pauseReason: effectivePauseReason || "PENDING_APPROVAL",
  });

  return {
    proposalId: proposal.id,
    proposalKey,
    shouldWait: true,
    waitpointTokenId: tokenId,
    chainId,
  };
}
