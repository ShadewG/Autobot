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
import db, { logger, attachmentProcessor } from "../lib/db";
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
    const { caseId, messageId, autopilotMode, triggerType, reviewAction, reviewInstruction, originalActionType, originalProposalId } = payload;

    // Clear any stale agent_runs that would block the unique constraint
    await db.query(
      `UPDATE agent_runs SET status = 'failed', error = 'superseded by new trigger.dev run'
       WHERE case_id = $1 AND status IN ('created', 'queued', 'running')`,
      [caseId]
    );

    // Create agent_run record in DB (provides FK for proposals)
    const agentRun = await db.createAgentRun(caseId, "INBOUND_MESSAGE", {
      messageId,
      autopilotMode,
      source: "trigger.dev",
    });
    const runId = agentRun.id;

    logger.info("process-inbound started", { runId, caseId, messageId, autopilotMode, triggerType });

    // ── ADJUSTMENT FAST-PATH ──
    // When human clicks ADJUST on a proposal, skip classify/decide entirely.
    // Re-draft with the original action type + human's instruction, then re-gate.
    if (triggerType === "ADJUSTMENT" && originalActionType && reviewInstruction) {
      logger.info("Adjustment fast-path", { caseId, originalActionType, instruction: reviewInstruction });

      // Dismiss the original proposal (it's already DECISION_RECEIVED, move to DISMISSED)
      if (originalProposalId) {
        await db.updateProposal(originalProposalId, { status: "DISMISSED" });
      }

      const context = await loadContext(caseId, messageId);
      const currentConstraints = context.constraints || [];
      const currentScopeItems = context.scopeItems || [];

      // Re-draft with the user's adjustment instruction
      const adjustedDraft = await draftResponse(
        caseId, originalActionType, currentConstraints, currentScopeItems,
        context.caseData.fee_amount || null,
        reviewInstruction,
        messageId,
        emptyResearchContext()
      );

      // Safety check the adjusted draft
      const adjustedSafety = await safetyCheck(
        adjustedDraft.bodyText, adjustedDraft.subject,
        originalActionType, currentConstraints, currentScopeItems,
        null, context.caseData.state
      );

      // Create new proposal for human review
      const adjustedGate = await createProposalAndGate(
        caseId, runId, originalActionType,
        messageId, adjustedDraft, adjustedSafety,
        false, true, null,
        [{ step: "Adjustment", detail: `Re-drafted per human instruction: ${reviewInstruction}` }],
        0.9, 1, null, adjustedDraft.lessonsApplied
      );

      // Wait for human to approve the adjusted draft
      if (adjustedGate.shouldWait && adjustedGate.waitpointTokenId) {
        await db.query("UPDATE agent_runs SET status = 'waiting' WHERE id = $1", [runId]);
        const result = await waitForHumanDecision(adjustedGate.waitpointTokenId, adjustedGate.proposalId);

        if (!result.ok) {
          await db.updateProposal(adjustedGate.proposalId, { status: "EXPIRED" });
          await db.query("UPDATE agent_runs SET status = 'completed', ended_at = NOW() WHERE id = $1", [runId]);
          return { status: "timed_out", proposalId: adjustedGate.proposalId };
        }

        const humanDecision = result.output;
        if (humanDecision.action === "DISMISS") {
          await db.updateProposal(adjustedGate.proposalId, { status: "DISMISSED" });
          await db.query("UPDATE agent_runs SET status = 'completed', ended_at = NOW() WHERE id = $1", [runId]);
          return { status: "dismissed", proposalId: adjustedGate.proposalId };
        }

        if (humanDecision.action === "ADJUST") {
          // Recursive adjustment — dismiss this and re-trigger
          await db.updateProposal(adjustedGate.proposalId, {
            status: "DISMISSED",
            human_decision: { action: "ADJUST", instruction: humanDecision.instruction, decidedAt: new Date().toISOString() },
          });
          // The monitor will re-trigger with the new instruction
          await db.query("UPDATE agent_runs SET status = 'completed', ended_at = NOW() WHERE id = $1", [runId]);
          return { status: "adjustment_requested_again", proposalId: adjustedGate.proposalId };
        }

        // APPROVE: execute the adjusted action
        await db.updateProposal(adjustedGate.proposalId, { status: "APPROVED" });
        await executeAction(
          caseId, adjustedGate.proposalId, originalActionType,
          adjustedDraft.subject, adjustedDraft.bodyText, adjustedDraft.bodyHtml,
          context.caseData, runId, adjustedDraft.lessonsApplied
        );
        await db.updateProposal(adjustedGate.proposalId, { status: "EXECUTED", executedAt: new Date() });
      }

      await commitState(
        caseId, runId, originalActionType,
        [{ step: "Adjustment", detail: `Adjusted per human: ${reviewInstruction}` }],
        0.9, "ADJUSTMENT", false, null
      );
      await db.query("UPDATE agent_runs SET status = 'completed', ended_at = NOW() WHERE id = $1", [runId]);
      return { status: "completed", action: originalActionType, adjusted: true };
    }

    // Step 1: Load context
    const context = await loadContext(caseId, messageId);

    // Step 1b: Extract text from any unprocessed PDF attachments
    const inboundAttachments = context.attachments.filter(
      (a: any) => a.message_id === messageId && !a.extracted_text
    );
    if (inboundAttachments.length > 0) {
      try {
        const processed = await attachmentProcessor.processAttachmentsForCase(caseId);
        // Refresh attachments in context with extracted text
        for (const p of processed) {
          const existing = context.attachments.find((a: any) => a.id === p.id);
          if (existing) existing.extracted_text = p.extracted_text;
        }
        logger.info("Extracted text from attachments", {
          caseId, processed: processed.length,
        });
      } catch (err: any) {
        logger.warn("Attachment text extraction failed", { caseId, error: err.message });
      }
    }

    // Step 2: Classify inbound (Vercel AI SDK + Zod)
    const classification = await classifyInbound(context, messageId, "INBOUND_MESSAGE");

    // Step 3: Update constraints
    const { constraints, scopeItems } = await updateConstraints(
      caseId, classification.classification, classification.extractedFeeAmount,
      messageId, context.constraints, context.scopeItems
    );

    // Step 4: Decide next action
    const effectiveTriggerType = triggerType || "INBOUND_MESSAGE";
    const decision = await decideNextAction(
      caseId, classification.classification, constraints,
      classification.extractedFeeAmount, classification.sentiment,
      autopilotMode, effectiveTriggerType,
      classification.requiresResponse, classification.portalUrl,
      classification.suggestedAction, classification.reasonNoResponse,
      classification.denialSubtype,
      reviewAction || undefined, reviewInstruction || undefined, undefined,
      classification.jurisdiction_level
    );

    // If no action needed, commit and return
    if (decision.isComplete || decision.actionType === "NONE") {
      await commitState(
        caseId, runId, decision.actionType, decision.reasoning,
        classification.confidence, "INBOUND_MESSAGE", false, null
      );
      await db.query("UPDATE agent_runs SET status = 'completed', ended_at = NOW() WHERE id = $1", [runId]);
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
      await db.query("UPDATE agent_runs SET status = 'waiting' WHERE id = $1", [runId]);
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
        await db.query("UPDATE agent_runs SET status = 'completed', ended_at = NOW() WHERE id = $1", [runId]);
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
        await db.query("UPDATE agent_runs SET status = 'completed', ended_at = NOW() WHERE id = $1", [runId]);
        return { status: "dismissed", proposalId: gate.proposalId };
      }

      if (humanDecision.action === "WITHDRAW") {
        await db.updateProposal(gate.proposalId, { status: "WITHDRAWN" });
        await db.updateCaseStatus(caseId, "cancelled", { substatus: "withdrawn_by_user" });
        await db.updateCase(caseId, { outcome_type: "withdrawn", outcome_recorded: true });
        await db.query("UPDATE agent_runs SET status = 'completed', ended_at = NOW() WHERE id = $1", [runId]);
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
            await db.query("UPDATE agent_runs SET status = 'completed', ended_at = NOW() WHERE id = $1", [runId]);
            return { status: "timed_out", proposalId: adjustedGate.proposalId };
          }

          if (adjustResult.output.action !== "APPROVE") {
            await db.updateProposal(adjustedGate.proposalId, {
              status: adjustResult.output.action === "DISMISS" ? "DISMISSED" : "WITHDRAWN",
            });
            await db.query("UPDATE agent_runs SET status = 'completed', ended_at = NOW() WHERE id = $1", [runId]);
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
          await db.query("UPDATE agent_runs SET status = 'completed', ended_at = NOW() WHERE id = $1", [runId]);
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

    await db.query("UPDATE agent_runs SET status = 'completed', ended_at = NOW() WHERE id = $1", [runId]);
    return {
      status: "completed",
      proposalId: gate.proposalId,
      actionType: decision.actionType,
      executed: execution.actionExecuted,
    };
  },
});
