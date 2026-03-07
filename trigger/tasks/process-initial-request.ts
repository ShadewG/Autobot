/**
 * Process Initial Request Task
 *
 * Replaces: initial-request-graph + agent-worker initial handler
 *
 * Flow: load-context -> draft-initial-request -> safety-check ->
 *       gate -> [wait for human?] -> execute -> schedule-followups -> commit
 */

import { task, wait } from "@trigger.dev/sdk";
import { loadContext } from "../steps/load-context";
import { draftInitialRequest } from "../steps/draft-initial-request";
import { draftResponse } from "../steps/draft-response";
import { safetyCheck } from "../steps/safety-check";
import { createProposalAndGate } from "../steps/gate-or-execute";
import { executeAction } from "../steps/execute-action";
import { scheduleFollowups } from "../steps/schedule-followups";
import { commitState } from "../steps/commit-state";
import { researchContext, emptyResearchContext } from "../steps/research-context";
import db, { logger, caseRuntime, completeRun, waitRun } from "../lib/db";
import { reconcileCaseAfterDismiss } from "../lib/reconcile-case";
import type { ActionType, HumanDecision, InitialRequestPayload, ResearchContext } from "../lib/types";
const proposalLifecycle = require("../../services/proposal-lifecycle");
const { createDecisionTraceTracker, summarizeExecutionResult } = require("../../services/decision-trace-service");

const RESEARCH_INSTRUCTION_RE = /\bresearch\b|\bfind\s+(the|a|correct|right)\b|\blook\s*up\b|\bredirect\b|\bchange\s+agency\b|\bdifferent\s+agency\b/i;

async function waitForHumanDecision(
  idempotencyKey: string,
  proposalId: number
): Promise<{ ok: true; output: HumanDecision } | { ok: false }> {
  const token = await wait.createToken({ idempotencyKey, timeout: "30d" });

  // Update proposal with real Trigger.dev token ID (needed for wait.completeToken from dashboard)
  await db.updateProposal(proposalId, { waitpoint_token: token.id });
  logger.info("Waitpoint token created", { proposalId, idempotencyKey, triggerTokenId: token.id });

  const result = await wait.forToken<HumanDecision>(token);
  if (!result.ok) return { ok: false };
  return { ok: true, output: result.output };
}

export const processInitialRequest = task({
  id: "process-initial-request",
  maxDuration: 600,
  retry: { maxAttempts: 2 },

  onFailure: async ({ payload, error }) => {
    if (!payload || typeof payload !== "object") return;
    const { caseId } = payload as any;
    if (!caseId) return;
    try {
      await caseRuntime.transitionCaseRuntime(caseId, "RUN_FAILED", {
        runId: Number.isFinite(Number((payload as any).runId)) ? Number((payload as any).runId) : undefined,
        error: String(error).substring(0, 500),
        substatus: `Agent run failed: ${String(error).substring(0, 200)}`,
      });
      await db.logActivity("agent_run_failed", `Process-initial-request failed for case ${caseId}: ${String(error).substring(0, 300)}`, {
        case_id: caseId,
      });
    } catch {}
  },

  run: async (payload: InitialRequestPayload) => {
    const { caseId, autopilotMode, triggerType, reviewInstruction, originalActionType, originalProposalId } = payload;

    // Claim pre-flight agent_run row (preserves triggerRunId in metadata) or create new
    const ACTIVE_STATUSES = "('created', 'queued', 'running', 'processing', 'waiting')";
    let runId: number;

    if (payload.runId) {
      const claimed = await db.query(
        `UPDATE agent_runs SET status = 'running', started_at = NOW()
         WHERE id = $1 AND case_id = $2 AND status IN ('created', 'queued')
         RETURNING id`,
        [payload.runId, caseId]
      );
      if (claimed.rowCount > 0) {
        runId = payload.runId;
        await db.query(
          `UPDATE agent_runs SET status = 'cancelled', ended_at = NOW(), error = 'superseded'
           WHERE case_id = $1 AND id != $2 AND status IN ${ACTIVE_STATUSES}`,
          [caseId, runId]
        );
      } else {
        const existing = await db.query(
          `SELECT id FROM agent_runs WHERE id = $1 AND case_id = $2
           AND status IN ('running', 'processing', 'waiting')`,
          [payload.runId, caseId]
        );
        if (existing.rowCount > 0) {
          runId = payload.runId;
          await db.query(
            `UPDATE agent_runs SET status = 'cancelled', ended_at = NOW(), error = 'superseded'
             WHERE case_id = $1 AND id != $2 AND status IN ${ACTIVE_STATUSES}`,
            [caseId, runId]
          );
        } else {
          await db.query(
            `UPDATE agent_runs SET status = 'cancelled', ended_at = NOW(), error = 'superseded'
             WHERE case_id = $1 AND status IN ${ACTIVE_STATUSES}`,
            [caseId]
          );
          const agentRun = await db.createAgentRun(caseId, "INITIAL_REQUEST", {
            autopilotMode, source: "trigger.dev",
          });
          runId = agentRun.id;
        }
      }
    } else {
      await db.query(
        `UPDATE agent_runs SET status = 'cancelled', ended_at = NOW(), error = 'superseded'
         WHERE case_id = $1 AND status IN ${ACTIVE_STATUSES}`,
        [caseId]
      );
      const agentRun = await db.createAgentRun(caseId, "INITIAL_REQUEST", {
        autopilotMode, source: "trigger.dev",
      });
      runId = agentRun.id;
    }
    let trace: any = null;
    const markStep = async (step: string, detail?: string, extra: Record<string, any> = {}) => {
      try {
        trace?.recordNode(step, { detail, ...extra });
        await db.updateAgentRunNodeProgress(runId, step);
        await db.logActivity("agent_run_step", detail || `Run #${runId}: ${step}`, {
          case_id: caseId,
          run_id: runId,
          step,
          category: "AGENT",
          ...extra,
        });
      } catch {
        // non-fatal
      }
    };
    trace = await createDecisionTraceTracker(db, {
      taskType: "process-initial-request",
      runId,
      caseId,
      triggerType: triggerType || "INITIAL_REQUEST",
      classification: {
        classification: "INITIAL_REQUEST",
        source: triggerType || "INITIAL_REQUEST",
      },
      context: {
        autopilotMode,
        originalActionType: originalActionType || null,
        originalProposalId: originalProposalId || null,
      },
    });

    try {
      logger.info("process-initial-request started", { runId, caseId, autopilotMode, triggerType });
      await markStep("start", `Run #${runId}: started process-initial-request`);

      // ── ADJUSTMENT FAST-PATH ──
      // When human clicks ADJUST on a proposal, skip the normal flow.
      // Re-draft with the original action type + human's instruction, then re-gate.
      if (triggerType === "ADJUSTMENT" && originalActionType && reviewInstruction) {
        trace.setRouterOutput({
          adjustmentFlow: true,
          actionType: originalActionType,
          instruction: reviewInstruction,
        });
        logger.info("Adjustment fast-path (initial request)", { caseId, originalActionType, instruction: reviewInstruction });

        if (originalProposalId) {
          await proposalLifecycle.applyHumanReviewDecision(originalProposalId, {
            status: "DISMISSED",
            humanDecision: {
              action: "ADJUST",
              instruction: reviewInstruction,
              decidedAt: new Date().toISOString(),
            },
          });
        }

        try {
          await markStep("load_context", `Run #${runId}: loading context for adjusted initial request`);
          const context = await loadContext(caseId, null);
          const currentConstraints = context.constraints || [];
          const currentScopeItems = context.scopeItems || [];
          const adjustmentReasoning = [`Re-drafted per human instruction: ${reviewInstruction}`];

          let research: ResearchContext = emptyResearchContext();
          if (RESEARCH_INSTRUCTION_RE.test(reviewInstruction)) {
            await markStep("research_context", `Run #${runId}: running adjustment research`);
            research = await researchContext(caseId, originalActionType as any, "UNKNOWN" as any, null, "medium");
          }

          await markStep("draft_response", `Run #${runId}: drafting adjusted initial request`, { action_type: originalActionType });
          const adjustedDraft = await draftResponse(
            caseId, originalActionType as any, currentConstraints, currentScopeItems,
            context.caseData.fee_amount ?? null,
            reviewInstruction,
            null,
            research
          );

          await markStep("safety_check", `Run #${runId}: safety checking adjusted initial draft`);
          const adjustedSafety = await safetyCheck(
            adjustedDraft.bodyText, adjustedDraft.subject,
            originalActionType, currentConstraints, currentScopeItems
          );

          await markStep("gate", `Run #${runId}: creating adjusted initial proposal`);
          const adjustedGate = await createProposalAndGate(
            caseId, runId, originalActionType as any,
            null, adjustedDraft, adjustedSafety,
            false, true, null,
            adjustmentReasoning,
            0.9, 1, null, adjustedDraft.lessonsApplied
          );
          trace.setGateDecision({
            proposalId: adjustedGate.proposalId,
            actionType: originalActionType,
            shouldWait: adjustedGate.shouldWait,
            hasWaitpointToken: !!adjustedGate.waitpointTokenId,
            adjustmentFlow: true,
          });

          if (adjustedGate.shouldWait && adjustedGate.waitpointTokenId) {
            await markStep("wait_human_decision", `Run #${runId}: waiting for adjusted initial approval`, { proposal_id: adjustedGate.proposalId });
            await waitRun(caseId, runId);
            const result = await waitForHumanDecision(adjustedGate.waitpointTokenId, adjustedGate.proposalId);

            if (!result.ok) {
              trace.setGateDecision({ proposalId: adjustedGate.proposalId, humanDecision: { action: "EXPIRED" } });
              trace.markOutcome("timed_out", { proposalId: adjustedGate.proposalId });
              await proposalLifecycle.applyHumanReviewDecision(adjustedGate.proposalId, { status: "EXPIRED" });
              await completeRun(caseId, runId);
              return { status: "timed_out", proposalId: adjustedGate.proposalId };
            }

            const humanDecision = result.output;
            trace.setGateDecision({
              proposalId: adjustedGate.proposalId,
              humanDecision: {
                action: humanDecision.action,
                instruction: humanDecision.instruction || null,
              },
            });

            if (humanDecision.action === "DISMISS") {
              trace.markOutcome("dismissed", { proposalId: adjustedGate.proposalId });
              await proposalLifecycle.applyHumanReviewDecision(adjustedGate.proposalId, {
                status: "DISMISSED",
                humanDecision,
              });
              await reconcileCaseAfterDismiss(caseId);
              await completeRun(caseId, runId);
              return { status: "dismissed", proposalId: adjustedGate.proposalId };
            }

            if (humanDecision.action === "ADJUST") {
              trace.markOutcome("adjustment_requested_again", { proposalId: adjustedGate.proposalId });
              await proposalLifecycle.applyHumanReviewDecision(adjustedGate.proposalId, {
                status: "DISMISSED",
                humanDecision,
              });
              await completeRun(caseId, runId);
              return { status: "adjustment_requested_again", proposalId: adjustedGate.proposalId };
            }

            if (humanDecision.action === "WITHDRAW") {
              trace.markOutcome("withdrawn", { proposalId: adjustedGate.proposalId });
              await caseRuntime.transitionCaseRuntime(caseId, "PROPOSAL_WITHDRAWN", { proposalId: adjustedGate.proposalId });
              await caseRuntime.transitionCaseRuntime(caseId, "CASE_CANCELLED", { substatus: "withdrawn_by_user" });
              await db.updateCase(caseId, { outcome_type: "withdrawn", outcome_recorded: true });
              await completeRun(caseId, runId);
              return { status: "withdrawn", proposalId: adjustedGate.proposalId };
            }

            // APPROVE: execute
            await proposalLifecycle.applyHumanReviewDecision(adjustedGate.proposalId, {
              status: "APPROVED",
              humanDecision,
            });
            const adjustedProposalRow = await db.getProposalById(adjustedGate.proposalId);
            const adjustedExecutionActionType = (adjustedProposalRow?.action_type || originalActionType) as ActionType;
            const adjustedExecutionDraft = {
              subject: adjustedProposalRow?.draft_subject ?? adjustedDraft.subject,
              bodyText: adjustedProposalRow?.draft_body_text ?? adjustedDraft.bodyText,
              bodyHtml: adjustedProposalRow?.draft_body_html ?? adjustedDraft.bodyHtml,
            };
            await markStep("execute_action", `Run #${runId}: executing adjusted initial action`, { action_type: adjustedExecutionActionType });
            const execution = await executeAction(
              caseId, adjustedGate.proposalId, adjustedExecutionActionType, runId,
              adjustedExecutionDraft, null, adjustmentReasoning,
              undefined, undefined, undefined,
              { attachments: humanDecision?.attachments }
            );
            trace.setGateDecision({
              proposalId: adjustedGate.proposalId,
              execution: {
                actionExecuted: execution.actionExecuted,
                result: summarizeExecutionResult(execution.executionResult),
              },
            });

            if (execution.actionExecuted) {
              await proposalLifecycle.markProposalExecuted(adjustedGate.proposalId, {
                executedAt: new Date(),
              });
              await scheduleFollowups(caseId, execution.actionExecuted, execution.executionResult);
            }

            await markStep("commit_state", `Run #${runId}: committing adjusted initial state`);
            await commitState(
              caseId, runId, adjustedExecutionActionType,
              adjustmentReasoning,
              0.9, "ADJUSTMENT", execution.actionExecuted, execution.executionResult
            );
          }

          trace.markOutcome("completed", { actionType: originalActionType, adjusted: true });
          await completeRun(caseId, runId);
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

      // Pre-check: abort if case already has denial correspondence
      // (don't blindly send a new FOIA when the agency already said no)
      const denialCheck = await db.query(
        `SELECT ra.intent, ra.full_analysis_json->>'denial_subtype' AS denial_subtype,
                LEFT(m.body_text, 200) AS body_preview
         FROM response_analysis ra
         JOIN messages m ON m.id = ra.message_id
         WHERE ra.case_id = $1 AND m.case_id = $1 AND m.direction = 'inbound'
           AND ra.intent = 'denial'
         ORDER BY ra.created_at DESC LIMIT 1`,
        [caseId]
      );
      if (denialCheck.rows.length > 0) {
        const denial = denialCheck.rows[0];
        trace.setRouterOutput({
          aborted: true,
          reason: "existing_denial",
          denialSubtype: denial.denial_subtype || null,
        });
        trace.markOutcome("aborted", { reason: "existing_denial", denialSubtype: denial.denial_subtype || null });
        logger.warn("process-initial-request aborted: case has existing denial", {
          caseId, denialSubtype: denial.denial_subtype, bodyPreview: denial.body_preview,
        });
        await caseRuntime.transitionCaseRuntime(caseId, "CASE_ESCALATED", {
          substatus: `Cannot send new initial request: agency already denied (${denial.denial_subtype || "general denial"}). Review correspondence and decide next step.`,
          pauseReason: "DENIAL",
        });
        await completeRun(caseId, runId);
        return { status: "aborted", reason: "existing_denial", denialSubtype: denial.denial_subtype };
      }

      // Step 1: Load context
      await markStep("load_context", `Run #${runId}: loading initial-request context`);
      const context = await loadContext(caseId, null);

      // Step 2: Draft initial FOIA request
      await markStep("draft_initial_request", `Run #${runId}: drafting initial request`);
      const draft = await draftInitialRequest(caseId, runId, autopilotMode);
      trace.setRouterOutput({
        actionType: draft.actionType,
        requiresHuman: draft.requiresHuman,
        proposalId: draft.proposalId,
        reasoning: draft.reasoning,
      });
      trace.setGateDecision({
        proposalId: draft.proposalId,
        actionType: draft.actionType,
        shouldWait: !!draft.requiresHuman,
      });

      // If proposal was auto-dismissed by status guard (e.g. case already awaiting
      // response), do not continue to gate/execute. Exit cleanly and reconcile flags.
      if (draft.proposalStatus === "DISMISSED") {
        trace.markOutcome("dismissed_externally", { proposalId: draft.proposalId });
        await markStep(
          "proposal_dismissed",
          `Run #${runId}: initial request proposal was auto-dismissed`
        );
        await reconcileCaseAfterDismiss(caseId);
        await completeRun(caseId, runId);
        return { status: "dismissed_externally", proposalId: draft.proposalId };
      }

      // Step 3: Safety check
      await markStep("safety_check", `Run #${runId}: safety checking initial request`);
      const safety = await safetyCheck(
        draft.bodyText, draft.subject,
        draft.actionType, context.constraints, context.scopeItems
      );

      // If requires human review, wait for approval
      if (draft.requiresHuman) {
        await markStep("wait_human_decision", `Run #${runId}: waiting for initial request approval`, { proposal_id: draft.proposalId });
        await waitRun(caseId, runId);
        const tokenId = crypto.randomUUID();
        await db.updateProposal(draft.proposalId, { waitpoint_token: tokenId });
        await caseRuntime.transitionCaseRuntime(caseId, "CASE_ESCALATED", {
          pauseReason: "INITIAL_REQUEST",
        });

        logger.info("Waiting for human approval of initial request", {
          caseId, proposalId: draft.proposalId, tokenId,
        });

        const result = await waitForHumanDecision(tokenId, draft.proposalId);

        if (!result.ok) {
          trace.setGateDecision({ proposalId: draft.proposalId, humanDecision: { action: "EXPIRED" } });
          trace.markOutcome("timed_out", { proposalId: draft.proposalId });
          await proposalLifecycle.applyHumanReviewDecision(draft.proposalId, { status: "EXPIRED" });
          await db.upsertEscalation({
            caseId,
            reason: "Initial request proposal timed out after 30 days",
            urgency: "high",
            suggestedAction: "Review and decide on initial FOIA request",
          });
          await completeRun(caseId, runId);
          return { status: "timed_out", proposalId: draft.proposalId };
        }

        const humanDecision = result.output;
        if (!humanDecision || !humanDecision.action) {
          logger.error("Invalid human decision output", { caseId, proposalId: draft.proposalId, output: result.output });
          throw new Error(`Invalid human decision for proposal ${draft.proposalId}: missing action`);
        }
        trace.setGateDecision({
          proposalId: draft.proposalId,
          humanDecision: {
            action: humanDecision.action,
            instruction: humanDecision.instruction || null,
          },
        });
        logger.info("Human decision received for initial request", { caseId, action: humanDecision.action });

      // Compare-and-swap: validate proposal is still actionable.
        const currentProposal = await db.getProposalById(draft.proposalId);
        if (!currentProposal) {
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
          proposalId: draft.proposalId,
          missingReason,
          resetEventId: recentReset.rows[0]?.id || null,
          });
          trace.markOutcome(missingReason, { proposalId: draft.proposalId });
          await completeRun(caseId, runId);
          return { status: missingReason, proposalId: draft.proposalId };
        }
        if (currentProposal.status === "DISMISSED") {
          trace.markOutcome("dismissed_externally", { proposalId: draft.proposalId });
          logger.info("Proposal was dismissed externally, exiting cleanly", { caseId, proposalId: draft.proposalId });
          await completeRun(caseId, runId);
          return { status: "dismissed_externally", proposalId: draft.proposalId };
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
          proposalId: draft.proposalId,
          proposalStatus: currentProposal.status,
          });
          trace.markOutcome(`proposal_not_actionable_${String(currentProposal.status || "").toLowerCase()}`, {
            proposalId: draft.proposalId,
          });
          await completeRun(caseId, runId);
          return {
            status: `proposal_not_actionable_${String(currentProposal.status || "").toLowerCase()}`,
            proposalId: draft.proposalId,
          };
        }
        if (!["PENDING_APPROVAL", "DECISION_RECEIVED"].includes(currentProposal.status)) {
          throw new Error(
            `Proposal ${draft.proposalId} is ${currentProposal.status}, expected PENDING_APPROVAL or DECISION_RECEIVED`
          );
        }

        if (humanDecision.action === "DISMISS") {
          trace.markOutcome("dismissed", { proposalId: draft.proposalId });
          await proposalLifecycle.applyHumanReviewDecision(draft.proposalId, {
            status: "DISMISSED",
            humanDecision,
          });
          await reconcileCaseAfterDismiss(caseId);
          await completeRun(caseId, runId);
          return { status: "dismissed", proposalId: draft.proposalId };
        }

        if (humanDecision.action === "WITHDRAW") {
          trace.markOutcome("withdrawn", { proposalId: draft.proposalId });
          await caseRuntime.transitionCaseRuntime(caseId, "PROPOSAL_WITHDRAWN", { proposalId: draft.proposalId });
          await caseRuntime.transitionCaseRuntime(caseId, "CASE_CANCELLED", { substatus: "withdrawn_by_user" });
          await completeRun(caseId, runId);
          return { status: "withdrawn", proposalId: draft.proposalId };
        }

      if (humanDecision.action === "ADJUST") {
        // Dismiss old proposal and re-draft with human instruction
        await proposalLifecycle.applyHumanReviewDecision(draft.proposalId, {
          status: "DISMISSED",
          humanDecision,
        });
        const instruction = humanDecision.instruction || "";

        let adjustResearch: ResearchContext = emptyResearchContext();
        if (RESEARCH_INSTRUCTION_RE.test(instruction)) {
          adjustResearch = await researchContext(caseId, draft.actionType, "UNKNOWN" as any, null, "medium");
        }

        const adjustContext = await loadContext(caseId, null);
        const adjustedDraft = await draftResponse(
          caseId, draft.actionType, adjustContext.constraints, adjustContext.scopeItems,
          null, instruction, null, adjustResearch
        );

        const adjustedSafety = await safetyCheck(
          adjustedDraft.bodyText, adjustedDraft.subject,
          draft.actionType, adjustContext.constraints, adjustContext.scopeItems
        );

        const adjustedGate = await createProposalAndGate(
          caseId, runId, draft.actionType,
          null, adjustedDraft, adjustedSafety,
          false, true, null,
          [...draft.reasoning, `Adjusted per human: ${instruction}`],
          0.9, 1, null, adjustedDraft.lessonsApplied
        );

        if (adjustedGate.shouldWait && adjustedGate.waitpointTokenId) {
          const adjustResult = await waitForHumanDecision(adjustedGate.waitpointTokenId, adjustedGate.proposalId);

          if (!adjustResult.ok) {
            trace.setGateDecision({ proposalId: adjustedGate.proposalId, humanDecision: { action: "EXPIRED" } });
            trace.markOutcome("timed_out", { proposalId: adjustedGate.proposalId });
            await proposalLifecycle.applyHumanReviewDecision(adjustedGate.proposalId, { status: "EXPIRED" });
            await completeRun(caseId, runId);
            return { status: "timed_out", proposalId: adjustedGate.proposalId };
          }

          const adjustDecision = adjustResult.output;
          trace.setGateDecision({
            proposalId: adjustedGate.proposalId,
            humanDecision: {
              action: adjustDecision.action,
              instruction: adjustDecision.instruction || null,
            },
          });

          if (adjustDecision.action === "DISMISS") {
            trace.markOutcome("dismissed", { proposalId: adjustedGate.proposalId });
            await proposalLifecycle.applyHumanReviewDecision(adjustedGate.proposalId, {
              status: "DISMISSED",
              humanDecision: adjustDecision,
            });
            await reconcileCaseAfterDismiss(caseId);
            await completeRun(caseId, runId);
            return { status: "dismissed", proposalId: adjustedGate.proposalId };
          }

          if (adjustDecision.action === "ADJUST") {
            trace.markOutcome("adjustment_requested_again", { proposalId: adjustedGate.proposalId });
            await proposalLifecycle.applyHumanReviewDecision(adjustedGate.proposalId, {
              status: "DISMISSED",
              humanDecision: adjustDecision,
            });
            await completeRun(caseId, runId);
            return { status: "adjustment_requested_again", proposalId: adjustedGate.proposalId };
          }

          if (adjustDecision.action === "WITHDRAW") {
            trace.markOutcome("withdrawn", { proposalId: adjustedGate.proposalId });
            await caseRuntime.transitionCaseRuntime(caseId, "PROPOSAL_WITHDRAWN", { proposalId: adjustedGate.proposalId });
            await caseRuntime.transitionCaseRuntime(caseId, "CASE_CANCELLED", { substatus: "withdrawn_by_user" });
            await completeRun(caseId, runId);
            return { status: "withdrawn", proposalId: adjustedGate.proposalId };
          }

          // APPROVE: update draft variables for execution below
          await proposalLifecycle.applyHumanReviewDecision(adjustedGate.proposalId, {
            status: "APPROVED",
            humanDecision: adjustDecision,
          });
          draft.proposalId = adjustedGate.proposalId;
          draft.subject = adjustedDraft.subject || draft.subject;
          draft.bodyText = adjustedDraft.bodyText || draft.bodyText;
          draft.bodyHtml = adjustedDraft.bodyHtml || draft.bodyHtml;
        }
        // Fall through to execute with new draft
      }

      // APPROVE: update proposal status
      await proposalLifecycle.applyHumanReviewDecision(draft.proposalId, {
        status: "APPROVED",
        humanDecision,
      });
    }

    // Step 4: Execute
    const executionProposal = await db.getProposalById(draft.proposalId);
    const executionActionType = executionProposal?.action_type || draft.actionType;
    const executionDraft = {
      subject: executionProposal?.draft_subject ?? draft.subject,
      bodyText: executionProposal?.draft_body_text ?? draft.bodyText,
      bodyHtml: executionProposal?.draft_body_html ?? draft.bodyHtml,
    };
      await markStep("execute_action", `Run #${runId}: executing initial request`, { action_type: executionActionType });
      const execution = await executeAction(
        caseId, draft.proposalId, executionActionType, runId,
        executionDraft,
        null, draft.reasoning,
        undefined, undefined, undefined,
        { attachments: humanDecision?.attachments }
      );
      trace.setGateDecision({
        proposalId: draft.proposalId,
        execution: {
          actionExecuted: execution.actionExecuted,
          result: summarizeExecutionResult(execution.executionResult),
        },
      });

      // Step 5: Schedule follow-ups (only if executed)
      let followupResult = {};
      if (execution.actionExecuted) {
        followupResult = await scheduleFollowups(caseId, execution.actionExecuted, execution.executionResult);
      }

      // Step 6: Commit state
      await markStep("commit_state", `Run #${runId}: committing initial request state`);
      await commitState(
        caseId, runId, executionActionType, draft.reasoning,
        0.9, "initial_request", execution.actionExecuted, execution.executionResult
      );

      trace.markOutcome("completed", {
        proposalId: draft.proposalId,
        actionType: executionActionType,
        executed: execution.actionExecuted,
      });
      await completeRun(caseId, runId);
      return {
        status: "completed",
        proposalId: draft.proposalId,
        executed: execution.actionExecuted,
        ...followupResult,
      };
    } catch (error: any) {
      trace?.markFailed(error, { taskType: "process-initial-request" });
      throw error;
    } finally {
      await trace?.complete();
    }
  },
});
