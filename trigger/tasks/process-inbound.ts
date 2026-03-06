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
import db, { logger, attachmentProcessor, caseRuntime, completeRun, waitRun } from "../lib/db";
import { reconcileCaseAfterDismiss } from "../lib/reconcile-case";
import type { HumanDecision, InboundPayload, ResearchContext, ChainAction, ActionType } from "../lib/types";

const DRAFT_REQUIRED_ACTIONS = [
  "SEND_INITIAL_REQUEST", "SUBMIT_PORTAL", "SEND_FOLLOWUP", "SEND_REBUTTAL", "SEND_CLARIFICATION",
  "SEND_PDF_EMAIL",
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
      await caseRuntime.transitionCaseRuntime(caseId, "RUN_FAILED", {
        runId: Number.isFinite(Number((payload as any).runId)) ? Number((payload as any).runId) : undefined,
        error: String(error).substring(0, 500),
        substatus: `Agent run failed: ${String(error).substring(0, 200)}`,
      });
      await db.logActivity("agent_run_failed", `Process-inbound failed for case ${caseId}: ${String(error).substring(0, 300)}`, {
        case_id: caseId,
      });
    } catch {}
  },

  run: async (payload: InboundPayload) => {
    const { caseId, messageId, autopilotMode, triggerType, reviewAction, reviewInstruction, originalActionType, originalProposalId } = payload;

    // Claim pre-flight agent_run row (preserves triggerRunId in metadata) or create new
    const ACTIVE_STATUSES = "('created', 'queued', 'running', 'processing', 'waiting')";
    let runId: number;

    if (payload.runId) {
      // Try to claim the pre-flight row (keeps triggerRunId in metadata)
      const claimed = await db.query(
        `UPDATE agent_runs SET status = 'running', started_at = NOW()
         WHERE id = $1 AND case_id = $2 AND status IN ('created', 'queued')
         RETURNING id`,
        [payload.runId, caseId]
      );
      if (claimed.rowCount > 0) {
        runId = payload.runId;
        // Cancel any OTHER active runs
        await db.query(
          `UPDATE agent_runs SET status = 'cancelled', ended_at = NOW(), error = 'superseded'
           WHERE case_id = $1 AND id != $2 AND status IN ${ACTIVE_STATUSES}`,
          [caseId, runId]
        );
      } else {
        // Pre-flight row already claimed — check if it's still active (retry scenario)
        const existing = await db.query(
          `SELECT id FROM agent_runs WHERE id = $1 AND case_id = $2
           AND status IN ('running', 'processing', 'waiting')`,
          [payload.runId, caseId]
        );
        if (existing.rowCount > 0) {
          // Row is already active from a previous attempt — reuse it
          runId = payload.runId;
          await db.query(
            `UPDATE agent_runs SET status = 'cancelled', ended_at = NOW(), error = 'superseded'
             WHERE case_id = $1 AND id != $2 AND status IN ${ACTIVE_STATUSES}`,
            [caseId, runId]
          );
        } else {
          // Row was completed/failed/cancelled — create a new one
          await db.query(
            `UPDATE agent_runs SET status = 'cancelled', ended_at = NOW(), error = 'superseded'
             WHERE case_id = $1 AND status IN ${ACTIVE_STATUSES}`,
            [caseId]
          );
          const agentRun = await db.createAgentRun(caseId, "INBOUND_MESSAGE", {
            messageId, autopilotMode, source: "trigger.dev",
          });
          runId = agentRun.id;
        }
      }
    } else {
      // No pre-flight row (legacy/orphan path)
      await db.query(
        `UPDATE agent_runs SET status = 'cancelled', ended_at = NOW(), error = 'superseded'
         WHERE case_id = $1 AND status IN ${ACTIVE_STATUSES}`,
        [caseId]
      );
      const agentRun = await db.createAgentRun(caseId, "INBOUND_MESSAGE", {
        messageId, autopilotMode, source: "trigger.dev",
      });
      runId = agentRun.id;
    }
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

    const runAdjustedDraftLoop = async ({
      actionType,
      constraints,
      scopeItems,
      feeAmount,
      baseInstruction,
      messageIdForDraft,
      baseResearch,
      baseReasoning,
      basePauseReason,
      confidence,
      triggerSource,
      classificationForExecution,
      jurisdictionLevel,
      state,
      startingAdjustmentCount = 1,
    }: {
      actionType: ActionType;
      constraints: any[];
      scopeItems: any[];
      feeAmount: number | null;
      baseInstruction: string | null | undefined;
      messageIdForDraft: number | null;
      baseResearch: ResearchContext;
      baseReasoning: string[];
      basePauseReason: string | null;
      confidence: number;
      triggerSource: "ADJUSTMENT" | "INBOUND_MESSAGE";
      classificationForExecution: any;
      jurisdictionLevel: any;
      state: string | null | undefined;
      startingAdjustmentCount?: number;
    }): Promise<
      | { status: "timed_out" | "dismissed" | "withdrawn"; proposalId: number }
      | {
          status: "approved";
          proposalId: number;
          draft: any;
          reasoning: string[];
          actionType: ActionType;
        }
    > => {
      let instruction = baseInstruction || null;
      let researchForLoop = baseResearch;
      let adjustmentCount = startingAdjustmentCount;

      while (true) {
        const loopReasoning = instruction
          ? [...baseReasoning, `Adjusted per human: ${instruction}`]
          : [...baseReasoning];

        await markStep("draft_response", `Run #${runId}: drafting adjusted response`, {
          action_type: actionType,
          adjustment_count: adjustmentCount,
        });
        const adjustedDraft = await draftResponse(
          caseId,
          actionType,
          constraints,
          scopeItems,
          feeAmount,
          instruction,
          messageIdForDraft,
          researchForLoop
        );

        await markStep("safety_check", `Run #${runId}: safety checking adjusted draft`, {
          action_type: actionType,
          adjustment_count: adjustmentCount,
        });
        const adjustedSafety = await safetyCheck(
          adjustedDraft.bodyText,
          adjustedDraft.subject,
          actionType,
          constraints,
          scopeItems,
          jurisdictionLevel,
          state
        );

        await markStep("gate", `Run #${runId}: creating adjusted proposal for approval`, {
          action_type: actionType,
          adjustment_count: adjustmentCount,
        });
        const adjustedGate = await createProposalAndGate(
          caseId,
          runId,
          actionType,
          messageIdForDraft,
          adjustedDraft,
          adjustedSafety,
          false,
          true,
          basePauseReason,
          loopReasoning,
          confidence,
          adjustmentCount,
          null,
          adjustedDraft.lessonsApplied
        );

        if (!adjustedGate.shouldWait || !adjustedGate.waitpointTokenId) {
          return {
            status: "approved",
            proposalId: adjustedGate.proposalId,
            draft: adjustedDraft,
            reasoning: loopReasoning,
            actionType,
          };
        }

        await markStep("wait_human_decision", `Run #${runId}: waiting for adjusted draft approval`, {
          proposal_id: adjustedGate.proposalId,
          adjustment_count: adjustmentCount,
        });
        await waitRun(caseId, runId);
        const adjustResult = await waitForHumanDecision(adjustedGate.waitpointTokenId, adjustedGate.proposalId);

        if (!adjustResult.ok) {
          await db.updateProposal(adjustedGate.proposalId, { status: "EXPIRED" });
          return { status: "timed_out", proposalId: adjustedGate.proposalId };
        }

        const humanDecision = adjustResult.output;

        if (humanDecision.action === "DISMISS") {
          await db.updateProposal(adjustedGate.proposalId, { status: "DISMISSED" });
          await reconcileCaseAfterDismiss(caseId);
          return { status: "dismissed", proposalId: adjustedGate.proposalId };
        }

        if (humanDecision.action === "WITHDRAW") {
          await caseRuntime.transitionCaseRuntime(caseId, "PROPOSAL_WITHDRAWN", {
            proposalId: adjustedGate.proposalId,
          });
          await caseRuntime.transitionCaseRuntime(caseId, "CASE_CANCELLED", {
            substatus: "withdrawn_by_user",
          });
          await db.updateCase(caseId, { outcome_type: "withdrawn", outcome_recorded: true });
          return { status: "withdrawn", proposalId: adjustedGate.proposalId };
        }

        if (humanDecision.action === "ADJUST") {
          await db.updateProposal(adjustedGate.proposalId, {
            status: "DISMISSED",
            human_decision: {
              action: "ADJUST",
              instruction: humanDecision.instruction,
              decidedAt: new Date().toISOString(),
            },
          });

          const ADJUST_RESEARCH_RE = /\bresearch\b|\bfind\s+(the|a|correct|right)\b|\blook\s*up\b|\bredirect\b|\bchange\s+agency\b|\bdifferent\s+agency\b/i;
          if (ADJUST_RESEARCH_RE.test(humanDecision.instruction || "") && researchForLoop.level === "none") {
            researchForLoop = await researchContext(
              caseId,
              actionType,
              classificationForExecution,
              null,
              "medium",
              undefined,
              messageIdForDraft
            );
          }

          instruction = humanDecision.instruction || instruction;
          adjustmentCount += 1;
          continue;
        }

        await db.updateProposal(adjustedGate.proposalId, { status: "APPROVED" });
        return {
          status: "approved",
          proposalId: adjustedGate.proposalId,
          draft: adjustedDraft,
          reasoning: loopReasoning,
          actionType,
        };
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
        const adjustedOutcome = await runAdjustedDraftLoop({
          actionType: originalActionType as ActionType,
          constraints: currentConstraints,
          scopeItems: currentScopeItems,
          feeAmount: context.caseData.fee_amount ?? null,
          baseInstruction: reviewInstruction,
          messageIdForDraft: messageId,
          baseResearch: adjustResearch,
          baseReasoning: adjustmentReasoning,
          basePauseReason: null,
          confidence: 0.9,
          triggerSource: "ADJUSTMENT",
          classificationForExecution: null,
          jurisdictionLevel: null,
          state: context.caseData.state,
          startingAdjustmentCount: 1,
        });

        if (adjustedOutcome.status !== "approved") {
          await completeRun(caseId, runId);
          return adjustedOutcome;
        }

        const adjustedProposalRow = await db.getProposalById(adjustedOutcome.proposalId);
        const adjustedExecutionActionType = (adjustedProposalRow?.action_type || originalActionType) as ActionType;
        await markStep("execute_action", `Run #${runId}: executing approved adjusted action`, { action_type: adjustedExecutionActionType });
        const execution = await executeAction(
          caseId, adjustedOutcome.proposalId, adjustedExecutionActionType, runId,
          adjustedOutcome.draft, null, adjustedOutcome.reasoning,
          undefined, undefined,
          null // classification: fast-path skips classify; side effects ran in original run
        );

        // Only mark EXECUTED if executeAction didn't set a different status (e.g. PENDING_PORTAL)
        if (execution.actionExecuted) {
          await db.updateProposal(adjustedOutcome.proposalId, { status: "EXECUTED", executedAt: new Date() });
        }

        await markStep("commit_state", `Run #${runId}: committing adjusted decision state`);
        await commitState(
          caseId, runId, adjustedExecutionActionType,
          adjustedOutcome.reasoning,
          0.9, "ADJUSTMENT", execution.actionExecuted, execution.executionResult
        );

        try {
          await completeRun(caseId, runId);
        } catch (err: any) {
          logger.warn("completeRun failed (non-fatal)", { caseId, runId, error: err.message });
        }
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
      const noActionContext = `${classification.reasonNoResponse || ""} ${(decision.reasoning || []).join(" ")}`;
      const isAutomatedNoReplyNotice = /automated|auto-generated|unmonitored|welcome to the records center|portal welcome email|password assistance|do not reply|noreply|no-reply/i.test(
        noActionContext.toLowerCase()
      );
      // Decision spin detection: if 3+ consecutive NONE decisions for this case, escalate
      if (!isAutomatedNoReplyNotice) {
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
          await caseRuntime.transitionCaseRuntime(caseId, "CASE_ESCALATED", {
            substatus: `Decision spin: ${noneDecisions} NONE decisions in 24h`,
            pauseReason: "LOOP_DETECTED",
          });
          await db.logActivity("decision_spin_detected",
            `${noneDecisions} consecutive NONE decisions in 24h — escalated to human review`,
            { case_id: caseId }
          );
          await completeRun(caseId, runId);
          return { status: "escalated", action: "none", reasoning: [...decision.reasoning, "Decision spin detected — escalated to human review"] };
        }
      }

      await markStep("commit_state", `Run #${runId}: no-action path, committing state`);
      await commitState(
        caseId, runId, decision.actionType, decision.reasoning,
        classification.confidence, "INBOUND_MESSAGE", false, null
      );
      await completeRun(caseId, runId);
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

    // Step 5b: Draft chain follow-up (if decision includes a chain)
    const chainDrafts = new Map<string, any>();
    if (decision.followUpAction) {
      const followUpNeedsDraft = DRAFT_REQUIRED_ACTIONS.includes(decision.followUpAction) ||
        ["RESEARCH_AGENCY", "REFORMULATE_REQUEST"].includes(decision.followUpAction);
      if (followUpNeedsDraft) {
        await markStep("draft_chain_followup", `Run #${runId}: drafting chain follow-up`, { action_type: decision.followUpAction });
        const followUpDraft = await draftResponse(
          caseId, decision.followUpAction, constraints, scopeItems,
          classification.extractedFeeAmount,
          `This is a follow-up action after ${decision.actionType}. ${decision.adjustmentInstruction || ""}`.trim(),
          decision.overrideMessageId || messageId,
          research
        );
        chainDrafts.set(decision.followUpAction, followUpDraft);
      }
    }

    // Step 6: Safety check (primary)
    await markStep("safety_check", `Run #${runId}: safety checking draft`);
    const safety = await safetyCheck(
      draft.bodyText, draft.subject, decision.actionType, constraints, scopeItems,
      classification.jurisdiction_level, context.caseData.state
    );

    // Step 6b: Safety check chain follow-ups and merge results
    let combinedSafety = { ...safety };
    for (const [followUpAction, followUpDraft] of chainDrafts) {
      const stepSafety = await safetyCheck(
        followUpDraft.bodyText, followUpDraft.subject, followUpAction as ActionType,
        constraints, scopeItems, classification.jurisdiction_level, context.caseData.state
      );
      combinedSafety = {
        riskFlags: [...combinedSafety.riskFlags, ...stepSafety.riskFlags],
        warnings: [...combinedSafety.warnings, ...stepSafety.warnings],
        canAutoExecute: combinedSafety.canAutoExecute && stepSafety.canAutoExecute,
        requiresHuman: combinedSafety.requiresHuman || stepSafety.requiresHuman,
        pauseReason: combinedSafety.pauseReason || stepSafety.pauseReason,
      };
    }

    // Build chain actions array for gate
    let chainActions: ChainAction[] | undefined;
    if (decision.followUpAction && chainDrafts.size > 0) {
      chainActions = [
        { actionType: decision.actionType, draftSubject: draft.subject, draftBodyText: draft.bodyText, draftBodyHtml: draft.bodyHtml },
        ...Array.from(chainDrafts.entries()).map(([actionType, d]) => ({
          actionType: actionType as ActionType,
          draftSubject: d.subject,
          draftBodyText: d.bodyText,
          draftBodyHtml: d.bodyHtml,
        })),
      ];
      logger.info("Action chain built", { caseId, actions: chainActions.map(a => a.actionType) });
    }

    // Step 7: Create proposal + determine gate
    await markStep("gate", `Run #${runId}: creating proposal and evaluating gate`, { action_type: decision.actionType });
    const gate = await createProposalAndGate(
      caseId, runId, decision.actionType,
      messageId, draft, combinedSafety,
      decision.canAutoExecute, decision.requiresHuman,
      decision.pauseReason, decision.reasoning,
      classification.confidence, 0, null,
      draft.lessonsApplied, decision.gateOptions,
      chainActions
    );

    // Step 8: If human gate, wait for approval
    if (gate.shouldWait && gate.waitpointTokenId) {
      await markStep("wait_human_decision", `Run #${runId}: waiting for human decision`, { proposal_id: gate.proposalId });
      await waitRun(caseId, runId);
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
        await caseRuntime.transitionCaseRuntime(caseId, "CASE_ESCALATED", {
          pauseReason: "TIMED_OUT",
        });
        await completeRun(caseId, runId);
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
      if (!currentProposal) {
        // Distinguish reset-driven deletion from unexpected missing row for cleaner telemetry.
        const recentReset = await db.query(
          `SELECT id, created_at
           FROM activity_log
           WHERE case_id = $1
             AND event_type = 'case_reset_to_last_inbound'
             AND created_at > NOW() - INTERVAL '20 minutes'
           ORDER BY created_at DESC
           LIMIT 1`,
          [caseId]
        );
        const missingReason = recentReset.rows.length > 0
          ? "proposal_missing_after_reset"
          : "proposal_missing_unexpected";
        logger.warn("Proposal row missing at gate compare-and-swap, exiting cleanly", {
          caseId,
          proposalId: gate.proposalId,
          missingReason,
          resetEventId: recentReset.rows[0]?.id || null,
        });
        await completeRun(caseId, runId);
        return { status: missingReason, proposalId: gate.proposalId };
      }
      if (currentProposal.status === "DISMISSED") {
        logger.info("Proposal was dismissed externally, exiting cleanly", { caseId, proposalId: gate.proposalId });
        await completeRun(caseId, runId);
        return { status: "dismissed_externally", proposalId: gate.proposalId };
      }
      const nonActionableStatuses = new Set([
        "WITHDRAWN",
        "EXPIRED",
        "EXECUTED",
        "CANCELLED",
        "CANCELED",
      ]);
      if (nonActionableStatuses.has(currentProposal.status)) {
        logger.info("Proposal is no longer actionable, exiting cleanly", {
          caseId,
          proposalId: gate.proposalId,
          proposalStatus: currentProposal.status,
        });
        await completeRun(caseId, runId);
        return {
          status: `proposal_not_actionable_${String(currentProposal.status || "").toLowerCase()}`,
          proposalId: gate.proposalId,
        };
      }
      if (!["PENDING_APPROVAL", "DECISION_RECEIVED"].includes(currentProposal.status)) {
        throw new Error(
          `Proposal ${gate.proposalId} is ${currentProposal.status}, expected PENDING_APPROVAL or DECISION_RECEIVED`
        );
      }

      if (humanDecision.action === "DISMISS") {
        await db.updateProposal(gate.proposalId, { status: "DISMISSED" });
        // Also dismiss chain siblings if this was a chain primary
        if (gate.chainId) {
          const chainSiblings = await db.getChainProposals(gate.chainId);
          for (const sibling of chainSiblings.filter((p: any) => p.id !== gate.proposalId)) {
            await db.updateProposal(sibling.id, { status: "DISMISSED" });
          }
        }
        await reconcileCaseAfterDismiss(caseId);
        await completeRun(caseId, runId);
        return { status: "dismissed", proposalId: gate.proposalId };
      }

      if (humanDecision.action === "WITHDRAW") {
        await caseRuntime.transitionCaseRuntime(caseId, "PROPOSAL_WITHDRAWN", { proposalId: gate.proposalId });
        await caseRuntime.transitionCaseRuntime(caseId, "CASE_CANCELLED", { substatus: "withdrawn_by_user" });
        await db.updateCase(caseId, { outcome_type: "withdrawn", outcome_recorded: true });
        await completeRun(caseId, runId);
        return { status: "withdrawn", proposalId: gate.proposalId };
      }

      if (humanDecision.action === "ADJUST") {
        await markStep("adjust_draft", `Run #${runId}: applying human adjustment`, { proposal_id: gate.proposalId });
        await db.updateProposal(gate.proposalId, {
          status: "DISMISSED",
          human_decision: {
            action: "ADJUST",
            instruction: humanDecision.instruction,
            decidedAt: new Date().toISOString(),
          },
        });

        const adjustedOutcome = await runAdjustedDraftLoop({
          actionType: decision.actionType,
          constraints,
          scopeItems,
          feeAmount: classification.extractedFeeAmount,
          baseInstruction: humanDecision.instruction || null,
          messageIdForDraft: decision.overrideMessageId || messageId,
          baseResearch: research,
          baseReasoning: decision.reasoning,
          basePauseReason: decision.pauseReason,
          confidence: classification.confidence,
          triggerSource: "INBOUND_MESSAGE",
          classificationForExecution: classification.classification,
          jurisdictionLevel: classification.jurisdiction_level,
          state: context.caseData.state,
          startingAdjustmentCount: 1,
        });

        if (adjustedOutcome.status !== "approved") {
          await completeRun(caseId, runId);
          return adjustedOutcome;
        }

        const adjustedProposalRow = await db.getProposalById(adjustedOutcome.proposalId);
        const adjustedExecutionActionType = (adjustedProposalRow?.action_type || decision.actionType) as ActionType;
        await markStep("execute_action", `Run #${runId}: executing adjusted approved action`, { action_type: adjustedExecutionActionType });
        const adjustedExecution = await executeAction(
          caseId, adjustedOutcome.proposalId, adjustedExecutionActionType, runId,
          adjustedOutcome.draft, null, adjustedOutcome.reasoning,
          undefined, undefined,
          classification.classification
        );
        await markStep("commit_state", `Run #${runId}: committing adjusted approved action state`);
        await commitState(
          caseId, runId, adjustedExecutionActionType, adjustedOutcome.reasoning,
          classification.confidence, "INBOUND_MESSAGE",
          adjustedExecution.actionExecuted, adjustedExecution.executionResult
        );
        try {
          await completeRun(caseId, runId);
        } catch (err: any) {
          logger.warn("completeRun failed (non-fatal)", { caseId, runId, error: err.message });
        }
        return { status: "completed", proposalId: adjustedOutcome.proposalId };
      }
      // APPROVE falls through to execute
    }

    // Step 9: Execute primary action
    const currentProposal = await db.getProposalById(gate.proposalId);
    const executionActionType = (currentProposal?.action_type || decision.actionType) as ActionType;
    if (executionActionType !== decision.actionType) {
      logger.warn("Execution action diverged from decision action; using proposal action", {
        caseId,
        proposalId: gate.proposalId,
        decisionAction: decision.actionType,
        proposalAction: executionActionType,
      });
    }
    await markStep("execute_action", `Run #${runId}: executing action`, { action_type: executionActionType });
    const execution = await executeAction(
      caseId, gate.proposalId, executionActionType, runId,
      draft, null, decision.reasoning,
      draft.researchContactResult, draft.researchBrief,
      classification.classification
    );

    // Step 9b: Execute chain follow-ups sequentially
    // NOTE: chainDrafts (a Map) may be empty after a Trigger.dev checkpoint restore.
    // Always check DB for chain proposals and fall back to DB-stored drafts.
    if (execution.actionExecuted && gate.chainId) {
      const chainProposals = await db.getChainProposals(gate.chainId);
      const unprocessedChainSteps = chainProposals.filter(
        (p: any) => p.chain_step > 0 && p.status !== "EXECUTED"
      );

      if (unprocessedChainSteps.length > 0) {
        await markStep("execute_chain", `Run #${runId}: executing chain follow-ups`, { chain_id: gate.chainId });
      }

      // Chain steps that represent new independent requests get promoted
      // to standalone proposals instead of auto-executing
      const INDEPENDENT_CHAIN_ACTIONS = ["REFORMULATE_REQUEST", "SEND_INITIAL_REQUEST"];

      for (const stepProposal of unprocessedChainSteps) {
        // New-request chain steps → promote to independent proposal
        if (INDEPENDENT_CHAIN_ACTIONS.includes(stepProposal.action_type)) {
          const updated = await db.query(
            `UPDATE proposals
             SET status = 'PENDING_APPROVAL', chain_id = NULL, chain_step = NULL,
                 gate_options = $3, updated_at = NOW()
             WHERE id = $1 AND case_id = $2 AND status IN ('CHAIN_PENDING', 'DISMISSED')
             RETURNING id`,
            [stepProposal.id, caseId, JSON.stringify(["APPROVE", "ADJUST", "DISMISS"])]
          );
          if (updated.rowCount > 0) {
            await db.query('UPDATE cases SET requires_human = true WHERE id = $1', [caseId]);
            logger.info("Chain step promoted to independent proposal", {
              caseId, proposalId: stepProposal.id, actionType: stepProposal.action_type,
            });
          }
          continue;
        }
        const inMemoryDraft = chainDrafts.get(stepProposal.action_type);

        // Prefer DB-stored drafts (may have been edited by user), fall back to in-memory
        const finalSubject = stepProposal.draft_subject || inMemoryDraft?.subject;
        const finalBodyText = stepProposal.draft_body_text || inMemoryDraft?.bodyText;
        const finalBodyHtml = inMemoryDraft?.bodyHtml || null;

        if (!finalSubject && !finalBodyText) {
          logger.warn("Chain step has no draft content, skipping", {
            caseId, chainId: gate.chainId, step: stepProposal.chain_step,
            actionType: stepProposal.action_type,
          });
          continue;
        }

        try {
          // Transition chain sibling from CHAIN_PENDING → APPROVED
          await db.updateProposal(stepProposal.id, { status: "APPROVED" });

          const stepExecution = await executeAction(
            caseId, stepProposal.id, stepProposal.action_type, runId,
            { subject: finalSubject, bodyText: finalBodyText, bodyHtml: finalBodyHtml },
            null, [`Chain step ${stepProposal.chain_step + 1}: ${stepProposal.action_type}`],
            inMemoryDraft?.researchContactResult, inMemoryDraft?.researchBrief,
            classification.classification,
            { chainId: gate.chainId }
          );

          if (!stepExecution.actionExecuted) {
            logger.warn("Chain step failed to execute", {
              caseId, chainId: gate.chainId, step: stepProposal.chain_step,
              actionType: stepProposal.action_type,
            });
            // Mark case for human review — partial chain execution
            await caseRuntime.transitionCaseRuntime(caseId, "CASE_ESCALATED", {
              targetStatus: "needs_human_review",
              pauseReason: "EXECUTION_BLOCKED",
              substatus: `Partial chain: ${executionActionType} executed, ${stepProposal.action_type} failed`,
            });
            break;
          }

          logger.info("Chain step executed", {
            caseId, chainId: gate.chainId, step: stepProposal.chain_step,
            actionType: stepProposal.action_type,
          });
        } catch (err: any) {
          logger.error("Chain step execution error", {
            caseId, chainId: gate.chainId, step: stepProposal.chain_step, error: err.message,
          });
          await caseRuntime.transitionCaseRuntime(caseId, "CASE_ESCALATED", {
            targetStatus: "needs_human_review",
            pauseReason: "EXECUTION_BLOCKED",
            substatus: `Chain error: ${executionActionType} executed, ${stepProposal.action_type} failed: ${err.message}`,
          });
          break;
        }
      }
    }

    // Step 10: Commit
    await markStep("commit_state", `Run #${runId}: committing state`);
    await commitState(
      caseId, runId, executionActionType, decision.reasoning,
      classification.confidence, "INBOUND_MESSAGE",
      execution.actionExecuted, execution.executionResult
    );

    try {
      await completeRun(caseId, runId);
    } catch (err: any) {
      logger.warn("completeRun failed (non-fatal)", { caseId, runId, error: err.message });
    }
    return {
      status: "completed",
      proposalId: gate.proposalId,
      actionType: executionActionType,
      executed: execution.actionExecuted,
      chainId: gate.chainId || undefined,
    };
  },
});
