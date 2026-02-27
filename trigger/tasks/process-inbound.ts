/**
 * Process Inbound Message Task
 *
 * Replaces: foia-case-graph + agent-worker inbound handler
 *
 * Flow: load-context -> classify -> update-constraints -> decide ->
 *       [draft -> safety-check -> gate] -> [wait for human?] -> execute -> commit
 */

import { task, wait } from "@trigger.dev/sdk";
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
import { reconcileCaseAfterDismiss } from "../lib/reconcile-case";
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

  onFailure: async ({ payload, error }) => {
    // Flag case for human review when the task fails after all retries.
    // We do NOT dismiss proposals here to avoid clobbering a concurrent run's proposals.
    // Orphaned proposals are handled by the resolve-review token completion and dedup guard.
    if (!payload || typeof payload !== "object") return;
    const { caseId } = payload as any;
    if (!caseId) return;
    try {
      await db.updateCaseStatus(caseId, "needs_human_review", {
        requires_human: true,
        substatus: `Agent run failed: ${String(error).substring(0, 200)}`,
      });
      await db.logActivity("agent_run_failed", `Process-inbound failed for case ${caseId}: ${String(error).substring(0, 300)}`, {
        case_id: caseId,
      });
    } catch {}
  },

  run: async (payload: InboundPayload) => {
    const { caseId, messageId, autopilotMode, triggerType, reviewAction, reviewInstruction, originalActionType, originalProposalId } = payload;

    // Clear any stale agent_runs that would block the unique constraint
    await db.query(
      `UPDATE agent_runs
       SET status = 'cancelled',
           ended_at = NOW(),
           error = 'superseded by new trigger.dev run'
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
    const markStep = async (step: string, detail?: string, extra: Record<string, any> = {}) => {
      try {
        await db.updateAgentRunNodeProgress(runId, step);
        await db.logActivity("agent_run_step", detail || `Run #${runId}: ${step}`, {
          case_id: caseId,
          run_id: runId,
          step,
          category: "AGENT",
          ...extra,
        });
      } catch {
        // non-fatal: live step telemetry should not break the run
      }
    };

    logger.info("process-inbound started", { runId, caseId, messageId, autopilotMode, triggerType });
    await markStep("start", `Run #${runId}: started process-inbound`, { trigger_type: triggerType || "INBOUND_MESSAGE" });

    // ── ADJUSTMENT FAST-PATH ──
    // When human clicks ADJUST on a proposal, skip classify/decide entirely.
    // Re-draft with the original action type + human's instruction, then re-gate.
    if (triggerType === "ADJUSTMENT" && originalActionType && reviewInstruction) {
      logger.info("Adjustment fast-path", { caseId, originalActionType, instruction: reviewInstruction });

      // Dismiss the original proposal (it's already DECISION_RECEIVED, move to DISMISSED)
      if (originalProposalId) {
        await db.updateProposal(originalProposalId, { status: "DISMISSED" });
      }

      try {
        await markStep("load_context", `Run #${runId}: loading context for adjusted re-draft`);
        const context = await loadContext(caseId, messageId);
        const currentConstraints = context.constraints || [];
        const currentScopeItems = context.scopeItems || [];
        const adjustmentReasoning = [`Re-drafted per human instruction: ${reviewInstruction}`];

        // Do research if instruction mentions research keywords
        const RESEARCH_RE = /\bresearch\b|\bfind\s+(the|a|correct|right)\b|\blook\s*up\b|\bredirect\b|\bchange\s+agency\b|\bdifferent\s+agency\b/i;
        let adjustResearch: ResearchContext = emptyResearchContext();
        if (RESEARCH_RE.test(reviewInstruction)) {
          adjustResearch = await researchContext(caseId, originalActionType as any, "UNKNOWN" as any, null, "medium", undefined, messageId);
        }

        // Re-draft with the user's adjustment instruction
        await markStep("draft_response", `Run #${runId}: drafting adjusted response`, { action_type: originalActionType });
        const adjustedDraft = await draftResponse(
          caseId, originalActionType as any, currentConstraints, currentScopeItems,
          context.caseData.fee_amount ?? null,
          reviewInstruction,
          messageId,
          adjustResearch
        );

        // Safety check the adjusted draft
        await markStep("safety_check", `Run #${runId}: safety checking adjusted draft`);
        const adjustedSafety = await safetyCheck(
          adjustedDraft.bodyText, adjustedDraft.subject,
          originalActionType, currentConstraints, currentScopeItems,
          null, context.caseData.state
        );

        // Create new proposal for human review (always requires human approval)
        await markStep("gate", `Run #${runId}: creating adjusted proposal for approval`);
        const adjustedGate = await createProposalAndGate(
          caseId, runId, originalActionType as any,
          messageId, adjustedDraft, adjustedSafety,
          false, true, null,
          adjustmentReasoning,
          0.9, 1, null, adjustedDraft.lessonsApplied
        );

        // Wait for human to approve the adjusted draft
        if (adjustedGate.shouldWait && adjustedGate.waitpointTokenId) {
          await markStep("wait_human_decision", `Run #${runId}: waiting for human decision`, { proposal_id: adjustedGate.proposalId });
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
            await reconcileCaseAfterDismiss(caseId);
            await db.query("UPDATE agent_runs SET status = 'completed', ended_at = NOW() WHERE id = $1", [runId]);
            return { status: "dismissed", proposalId: adjustedGate.proposalId };
          }

          if (humanDecision.action === "WITHDRAW") {
            await db.updateProposal(adjustedGate.proposalId, { status: "WITHDRAWN" });
            await db.updateCaseStatus(caseId, "cancelled", { substatus: "withdrawn_by_user" });
            await db.updateCase(caseId, { outcome_type: "withdrawn", outcome_recorded: true });
            await db.query("UPDATE agent_runs SET status = 'completed', ended_at = NOW() WHERE id = $1", [runId]);
            return { status: "withdrawn", proposalId: adjustedGate.proposalId };
          }

          if (humanDecision.action === "ADJUST") {
            // Recursive adjustment — dismiss this proposal, complete this run.
            // The waitpoint completion from the dashboard already records the instruction.
            // The monitor processProposalDecision will see no waitpoint_token on this new
            // proposal (it was consumed), so it will re-trigger a new process-inbound run
            // with the updated instruction via the legacy path.
            await db.updateProposal(adjustedGate.proposalId, {
              status: "DISMISSED",
              human_decision: { action: "ADJUST", instruction: humanDecision.instruction, decidedAt: new Date().toISOString() },
            });
            await db.query("UPDATE agent_runs SET status = 'completed', ended_at = NOW() WHERE id = $1", [runId]);
            return { status: "adjustment_requested_again", proposalId: adjustedGate.proposalId };
          }

          // APPROVE: execute the adjusted action
          await db.updateProposal(adjustedGate.proposalId, { status: "APPROVED" });
          await markStep("execute_action", `Run #${runId}: executing approved adjusted action`, { action_type: originalActionType });
          const execution = await executeAction(
            caseId, adjustedGate.proposalId, originalActionType as any, runId,
            adjustedDraft, null, adjustmentReasoning
          );

          // Only mark EXECUTED if executeAction didn't set a different status (e.g. PENDING_PORTAL)
          if (execution.actionExecuted) {
            await db.updateProposal(adjustedGate.proposalId, { status: "EXECUTED", executedAt: new Date() });
          }

          await markStep("commit_state", `Run #${runId}: committing adjusted decision state`);
          await commitState(
            caseId, runId, originalActionType,
            adjustmentReasoning,
            0.9, "ADJUSTMENT", execution.actionExecuted, execution.executionResult
          );
        }

        await db.query("UPDATE agent_runs SET status = 'completed', ended_at = NOW() WHERE id = $1", [runId]);
        return { status: "completed", action: originalActionType, adjusted: true };
      } catch (err: any) {
        logger.error("Adjustment fast-path failed", { caseId, error: err.message });
        await db.query(
          "UPDATE agent_runs SET status = 'failed', error = $2, ended_at = NOW() WHERE id = $1",
          [runId, `Adjustment failed: ${err.message}`.substring(0, 500)]
        );
        throw err;
      }
    }

    // Step 1: Load context
    await markStep("load_context", `Run #${runId}: loading inbound context`);
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
    await markStep("classify_inbound", `Run #${runId}: classifying inbound message`, { message_id: messageId });
    const classification = await classifyInbound(context, messageId, "INBOUND_MESSAGE");

    // Step 2b: Classification safety gates (before constraint mutation)
    let effectiveClassification = classification.classification;

    // Gate 1: Low confidence → force human review (before constraints get mutated)
    const LOW_CONFIDENCE_THRESHOLD = 0.7;
    if (
      classification.confidence < LOW_CONFIDENCE_THRESHOLD &&
      effectiveClassification !== "NO_RESPONSE" &&
      effectiveClassification !== "HUMAN_REVIEW_RESOLUTION"
    ) {
      logger.warn("Low classification confidence — escalating to human review", {
        caseId, confidence: classification.confidence,
        originalClassification: effectiveClassification,
      });
      effectiveClassification = "UNKNOWN" as any;
    }

    // Gate 2: Cross-check — catch obvious misclassifications
    // Only check direct message body (not subject/quoted thread) to avoid false positives
    const clf = effectiveClassification as string;
    if (clf === "PARTIAL_DELIVERY" || clf === "ACKNOWLEDGMENT") {
      const msg = await db.getMessageById(messageId);
      const bodyText = (msg?.body_text || "").substring(0, 1000);
      // Only match strong denial phrases, not generic words
      const hasDenialLanguage = /\bexempt from disclosure\b|\bdenied your request\b|\bunable to release\b|\bwithheld pursuant to\b|\bnot subject to disclosure\b/i.test(bodyText);
      const hasFeeLanguage = /\bprocessing fee\b|\bestimated cost\b|\bfee of \$\d|\binvoice attached\b|\bpayment of \$\d/i.test(bodyText);
      if (hasDenialLanguage) {
        logger.warn("Classification cross-check: denial language in non-denial classification", {
          caseId, original: clf,
        });
        effectiveClassification = "DENIAL" as any;
        classification.requiresResponse = true;
      } else if (hasFeeLanguage) {
        logger.warn("Classification cross-check: fee language in non-fee classification", {
          caseId, original: clf,
        });
        effectiveClassification = "FEE_QUOTE" as any;
        classification.requiresResponse = true;
      }
    }

    // Step 3: Update constraints (uses effective classification, not raw)
    await markStep("update_constraints", `Run #${runId}: updating constraints/scope from classification`);
    const { constraints, scopeItems } = await updateConstraints(
      caseId, effectiveClassification, classification.extractedFeeAmount,
      messageId, context.constraints, context.scopeItems
    );

    // Step 4: Decide next action
    const effectiveTriggerType = triggerType || "INBOUND_MESSAGE";
    await markStep("decide_next_action", `Run #${runId}: deciding next action`, { classification: effectiveClassification });
    const decision = await decideNextAction(
      caseId, effectiveClassification, constraints,
      classification.extractedFeeAmount, classification.sentiment,
      autopilotMode, effectiveTriggerType,
      classification.requiresResponse, classification.portalUrl,
      classification.suggestedAction, classification.reasonNoResponse,
      classification.denialSubtype,
      reviewAction || undefined, reviewInstruction || undefined, undefined,
      classification.jurisdiction_level
    );

    // If no action needed, commit and return — but detect decision spin
    if (decision.isComplete || decision.actionType === "NONE") {
      // Decision spin detection: if 3+ consecutive NONE decisions for this case, escalate
      const noneCount = await db.query(
        `SELECT COUNT(*) as cnt FROM agent_decisions
         WHERE case_id = $1 AND action_taken = 'NONE'
           AND created_at > NOW() - INTERVAL '24 hours'`,
        [caseId]
      );
      const noneDecisions = parseInt(noneCount.rows[0]?.cnt || "0", 10);
      if (noneDecisions >= 3) {
        logger.warn("Decision spin detected: 3+ NONE decisions in 24h — escalating to human review", {
          caseId, noneDecisions,
        });
        await db.updateCaseStatus(caseId, "needs_human_review", {
          substatus: `Decision spin: ${noneDecisions} NONE decisions in 24h`,
          pause_reason: "LOOP_DETECTED",
        });
        await db.logActivity("decision_spin_detected",
          `${noneDecisions} consecutive NONE decisions in 24h — escalated to human review`,
          { case_id: caseId }
        );
        await db.query("UPDATE agent_runs SET status = 'completed', ended_at = NOW() WHERE id = $1", [runId]);
        return { status: "escalated", action: "none", reasoning: [...decision.reasoning, "Decision spin detected — escalated to human review"] };
      }

      await markStep("commit_state", `Run #${runId}: no-action path, committing state`);
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
      await markStep("research_context", `Run #${runId}: running research context`, { level: researchLevel });
      research = await researchContext(
        caseId, decision.actionType, classification.classification,
        classification.denialSubtype, researchLevel,
        classification.referralContact, messageId
      );
    }

    // Step 5: Draft response (if action requires it)
    let draft: any = { subject: null, bodyText: null, bodyHtml: null, lessonsApplied: [] };
    const needsDraft = DRAFT_REQUIRED_ACTIONS.includes(decision.actionType) ||
      ["RESEARCH_AGENCY", "REFORMULATE_REQUEST"].includes(decision.actionType);

    if (needsDraft) {
      await markStep("draft_response", `Run #${runId}: generating draft`, { action_type: decision.actionType });
      draft = await draftResponse(
        caseId, decision.actionType, constraints, scopeItems,
        classification.extractedFeeAmount, decision.adjustmentInstruction,
        decision.overrideMessageId || messageId,
        research
      );
    }

    // Step 6: Safety check
    await markStep("safety_check", `Run #${runId}: safety checking draft`);
    const safety = await safetyCheck(
      draft.bodyText, draft.subject, decision.actionType, constraints, scopeItems,
      classification.jurisdiction_level, context.caseData.state
    );

    // Step 7: Create proposal + determine gate
    await markStep("gate", `Run #${runId}: creating proposal and evaluating gate`, { action_type: decision.actionType });
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
      await markStep("wait_human_decision", `Run #${runId}: waiting for human decision`, { proposal_id: gate.proposalId });
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

      // Compare-and-swap: validate proposal is still actionable.
      // If proposal was DISMISSED (e.g. by resolve-review completing our token with DISMISS),
      // exit cleanly — the human chose a different path.
      const currentProposal = await db.getProposalById(gate.proposalId);
      if (currentProposal?.status === "DISMISSED") {
        logger.info("Proposal was dismissed externally, exiting cleanly", { caseId, proposalId: gate.proposalId });
        await db.query("UPDATE agent_runs SET status = 'completed', ended_at = NOW() WHERE id = $1", [runId]);
        return { status: "dismissed_externally", proposalId: gate.proposalId };
      }
      if (!["PENDING_APPROVAL", "DECISION_RECEIVED"].includes(currentProposal?.status)) {
        throw new Error(
          `Proposal ${gate.proposalId} is ${currentProposal?.status}, expected PENDING_APPROVAL or DECISION_RECEIVED`
        );
      }

      if (humanDecision.action === "DISMISS") {
        await db.updateProposal(gate.proposalId, { status: "DISMISSED" });
        await reconcileCaseAfterDismiss(caseId);
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
        await markStep("adjust_draft", `Run #${runId}: applying human adjustment`, { proposal_id: gate.proposalId });
        // Upgrade research if instruction mentions research keywords and original research was empty
        const ADJUST_RESEARCH_RE = /\bresearch\b|\bfind\s+(the|a|correct|right)\b|\blook\s*up\b|\bredirect\b|\bchange\s+agency\b|\bdifferent\s+agency\b/i;
        let adjustResearch = research;
        if (ADJUST_RESEARCH_RE.test(humanDecision.instruction || "") && research.level === "none") {
          adjustResearch = await researchContext(caseId, decision.actionType, classification.classification, classification.denialSubtype, "medium", undefined, messageId);
        }

        const adjustedDraft = await draftResponse(
          caseId, decision.actionType, constraints, scopeItems,
          classification.extractedFeeAmount,
          humanDecision.instruction || null,
          decision.overrideMessageId || messageId,
          adjustResearch
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
          await markStep("wait_human_decision", `Run #${runId}: waiting for adjusted draft approval`, { proposal_id: adjustedGate.proposalId });
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
            if (adjustResult.output.action === "DISMISS") {
              await reconcileCaseAfterDismiss(caseId);
            }
            await db.query("UPDATE agent_runs SET status = 'completed', ended_at = NOW() WHERE id = $1", [runId]);
            return { status: adjustResult.output.action.toLowerCase(), proposalId: adjustedGate.proposalId };
          }

          await markStep("execute_action", `Run #${runId}: executing adjusted approved action`, { action_type: decision.actionType });
          const adjustedExecution = await executeAction(
            caseId, adjustedGate.proposalId, decision.actionType, runId,
            adjustedDraft, null, decision.reasoning
          );
          await markStep("commit_state", `Run #${runId}: committing adjusted approved action state`);
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
    await markStep("execute_action", `Run #${runId}: executing action`, { action_type: decision.actionType });
    const execution = await executeAction(
      caseId, gate.proposalId, decision.actionType, runId,
      draft, null, decision.reasoning,
      draft.researchContactResult, draft.researchBrief
    );

    // Step 10: Commit
    await markStep("commit_state", `Run #${runId}: committing state`);
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
