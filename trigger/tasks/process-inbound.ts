/**
 * Process Inbound Message Task
 *
 * Replaces: foia-case-graph + agent-worker inbound handler
 *
 * Flow: load-context -> classify -> update-constraints -> decide ->
 *       [draft -> safety-check -> gate] -> [wait for human?] -> execute -> commit
 */

import { task, wait } from "@trigger.dev/sdk/v3";
import { loadContext } from "../steps/load-context";
import { classifyInbound } from "../steps/classify-inbound";
import { updateConstraints } from "../steps/update-constraints";
import { decideNextAction } from "../steps/decide-next-action";
import { draftResponse } from "../steps/draft-response";
import { safetyCheck } from "../steps/safety-check";
import { createProposalAndGate } from "../steps/gate-or-execute";
import { executeAction } from "../steps/execute-action";
import { commitState } from "../steps/commit-state";
import { researchContext, determineResearchLevel, emptyResearchContext } from "../steps/research-context";
import db, { logger } from "../lib/db";
import type { HumanDecision, InboundPayload, ResearchContext } from "../lib/types";

const DRAFT_REQUIRED_ACTIONS = [
  "SEND_INITIAL_REQUEST", "SEND_FOLLOWUP", "SEND_REBUTTAL", "SEND_CLARIFICATION",
  "SEND_APPEAL", "SEND_FEE_WAIVER_REQUEST", "SEND_STATUS_UPDATE",
  "RESPOND_PARTIAL_APPROVAL", "ACCEPT_FEE", "NEGOTIATE_FEE", "DECLINE_FEE",
];

async function waitForHumanDecision(
  idempotencyKey: string,
  proposalId: number
): Promise<{ ok: true; output: HumanDecision } | { ok: false }> {
  // Create a Trigger.dev waitpoint token with 30-day timeout
  // Use our UUID as idempotencyKey for dedup, but store the real Trigger.dev token ID
  const token = await wait.createToken({
    idempotencyKey,
    timeout: "30d",
  });

  // Update proposal with the real Trigger.dev token ID (needed for wait.completeToken from dashboard)
  await db.updateProposal(proposalId, { waitpoint_token: token.id });
  logger.info("Waitpoint token created", { proposalId, idempotencyKey, triggerTokenId: token.id });

  // Wait for it to be completed
  const result = await wait.forToken<HumanDecision>(token);
  if (!result.ok) return { ok: false };
  return { ok: true, output: result.output };
}

export const processInbound = task({
  id: "process-inbound",
  maxDuration: 600,
  retry: { maxAttempts: 2 },

  run: async (payload: InboundPayload) => {
    const { runId, caseId, messageId, autopilotMode } = payload;

    logger.info("process-inbound started", { runId, caseId, messageId, autopilotMode });

    // Step 1: Load context
    const context = await loadContext(caseId, messageId);

    // Step 2: Classify inbound (Vercel AI SDK + Zod)
    const classification = await classifyInbound(context, messageId, "INBOUND_MESSAGE");

    // Step 3: Update constraints
    const { constraints, scopeItems } = await updateConstraints(
      caseId, classification.classification, classification.extractedFeeAmount,
      messageId, context.constraints, context.scopeItems
    );

    // Step 4: Decide next action
    const decision = await decideNextAction(
      caseId, classification.classification, constraints,
      classification.extractedFeeAmount, classification.sentiment,
      autopilotMode, "INBOUND_MESSAGE",
      classification.requiresResponse, classification.portalUrl,
      classification.suggestedAction, classification.reasonNoResponse,
      classification.denialSubtype,
      undefined, undefined, undefined,
      classification.jurisdiction_level
    );

    // If no action needed, commit and return
    if (decision.isComplete || decision.actionType === "NONE") {
      await commitState(
        caseId, runId, decision.actionType, decision.reasoning,
        classification.confidence, "INBOUND_MESSAGE", false, null
      );
      return { status: "completed", action: "none", reasoning: decision.reasoning };
    }

    // Step 4b: Research context (between decide and draft)
    let research: ResearchContext = emptyResearchContext();
    const researchLevel = determineResearchLevel(
      decision.actionType,
      classification.classification,
      classification.denialSubtype,
      decision.researchLevel,
      !!(context.caseData.contact_research_notes)
    );
    if (researchLevel !== "none") {
      research = await researchContext(
        caseId, decision.actionType, classification.classification,
        classification.denialSubtype, researchLevel
      );
    }

    // Step 5: Draft response (if action requires it)
    let draft: any = { subject: null, bodyText: null, bodyHtml: null, lessonsApplied: [] };
    const needsDraft = DRAFT_REQUIRED_ACTIONS.includes(decision.actionType) ||
      ["RESEARCH_AGENCY", "REFORMULATE_REQUEST"].includes(decision.actionType);

    if (needsDraft) {
      draft = await draftResponse(
        caseId, decision.actionType, constraints, scopeItems,
        classification.extractedFeeAmount, decision.adjustmentInstruction,
        decision.overrideMessageId || messageId,
        research
      );
    }

    // Step 6: Safety check
    const safety = await safetyCheck(
      draft.bodyText, draft.subject, decision.actionType, constraints, scopeItems,
      classification.jurisdiction_level, context.caseData.state
    );

    // Step 7: Create proposal + determine gate
    const gate = await createProposalAndGate(
      caseId, runId, decision.actionType,
      messageId, draft, safety,
      decision.canAutoExecute, decision.requiresHuman,
      decision.pauseReason, decision.reasoning,
      classification.confidence, 0, null,
      draft.lessonsApplied, decision.gateOptions
    );

    // Step 8: If human gate, wait for approval
    if (gate.shouldWait && gate.waitpointTokenId) {
      logger.info("Waiting for human decision", {
        caseId, proposalId: gate.proposalId, tokenId: gate.waitpointTokenId,
      });

      const result = await waitForHumanDecision(gate.waitpointTokenId, gate.proposalId);

      // Timeout: auto-escalate
      if (!result.ok) {
        await db.upsertEscalation({
          caseId,
          reason: "Proposal timed out after 30 days without human action",
          urgency: "high",
          suggestedAction: "Review stale proposal and decide",
        });
        await db.updateProposal(gate.proposalId, { status: "EXPIRED" });
        await db.updateCaseStatus(caseId, "needs_human_review", {
          requires_human: true, pause_reason: "TIMED_OUT",
        });
        return { status: "timed_out", proposalId: gate.proposalId };
      }

      const humanDecision = result.output;
      if (!humanDecision || !humanDecision.action) {
        logger.error("Invalid human decision output", { caseId, proposalId: gate.proposalId, output: result.output });
        throw new Error(`Invalid human decision for proposal ${gate.proposalId}: missing action`);
      }
      logger.info("Human decision received", { caseId, action: humanDecision.action });

      // Compare-and-swap: validate proposal is still actionable
      const currentProposal = await db.getProposalById(gate.proposalId);
      if (!["PENDING_APPROVAL", "DECISION_RECEIVED"].includes(currentProposal?.status)) {
        throw new Error(
          `Proposal ${gate.proposalId} is ${currentProposal?.status}, expected PENDING_APPROVAL or DECISION_RECEIVED`
        );
      }

      if (humanDecision.action === "DISMISS") {
        await db.updateProposal(gate.proposalId, { status: "DISMISSED" });
        return { status: "dismissed", proposalId: gate.proposalId };
      }

      if (humanDecision.action === "WITHDRAW") {
        await db.updateProposal(gate.proposalId, { status: "WITHDRAWN" });
        await db.updateCaseStatus(caseId, "cancelled", { substatus: "withdrawn_by_user" });
        await db.updateCase(caseId, { outcome_type: "withdrawn", outcome_recorded: true });
        return { status: "withdrawn", proposalId: gate.proposalId };
      }

      if (humanDecision.action === "ADJUST") {
        const adjustedDraft = await draftResponse(
          caseId, decision.actionType, constraints, scopeItems,
          classification.extractedFeeAmount,
          humanDecision.instruction || null,
          decision.overrideMessageId || messageId,
          research
        );

        const adjustedSafety = await safetyCheck(
          adjustedDraft.bodyText, adjustedDraft.subject,
          decision.actionType, constraints, scopeItems,
          classification.jurisdiction_level, context.caseData.state
        );

        const adjustedGate = await createProposalAndGate(
          caseId, runId, decision.actionType,
          messageId, adjustedDraft, adjustedSafety,
          false, true, decision.pauseReason,
          [...decision.reasoning, `Adjusted per human: ${humanDecision.instruction}`],
          classification.confidence, 1, null, adjustedDraft.lessonsApplied
        );

        if (adjustedGate.shouldWait && adjustedGate.waitpointTokenId) {
          const adjustResult = await waitForHumanDecision(adjustedGate.waitpointTokenId, adjustedGate.proposalId);

          if (!adjustResult.ok) {
            await db.updateProposal(adjustedGate.proposalId, { status: "EXPIRED" });
            return { status: "timed_out", proposalId: adjustedGate.proposalId };
          }

          if (adjustResult.output.action !== "APPROVE") {
            await db.updateProposal(adjustedGate.proposalId, {
              status: adjustResult.output.action === "DISMISS" ? "DISMISSED" : "WITHDRAWN",
            });
            return { status: adjustResult.output.action.toLowerCase(), proposalId: adjustedGate.proposalId };
          }

          const adjustedExecution = await executeAction(
            caseId, adjustedGate.proposalId, decision.actionType, runId,
            adjustedDraft, null, decision.reasoning
          );
          await commitState(
            caseId, runId, decision.actionType, decision.reasoning,
            classification.confidence, "INBOUND_MESSAGE",
            adjustedExecution.actionExecuted, adjustedExecution.executionResult
          );
          return { status: "completed", proposalId: adjustedGate.proposalId };
        }
      }
      // APPROVE falls through to execute
    }

    // Step 9: Execute
    const execution = await executeAction(
      caseId, gate.proposalId, decision.actionType, runId,
      draft, null, decision.reasoning,
      draft.researchContactResult, draft.researchBrief
    );

    // Step 10: Commit
    await commitState(
      caseId, runId, decision.actionType, decision.reasoning,
      classification.confidence, "INBOUND_MESSAGE",
      execution.actionExecuted, execution.executionResult
    );

    return {
      status: "completed",
      proposalId: gate.proposalId,
      actionType: decision.actionType,
      executed: execution.actionExecuted,
    };
  },
});
