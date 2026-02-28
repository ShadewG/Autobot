/**
 * Process Follow-up Trigger Task
 *
 * Replaces: followup trigger handler in agent-worker
 *
 * Triggered by scheduled follow-up. Routes through the same inbound pipeline
 * but with NO_RESPONSE classification (since there's no new message).
 */

import { task, wait } from "@trigger.dev/sdk";
import { loadContext } from "../steps/load-context";
import { decideNextAction } from "../steps/decide-next-action";
import { draftResponse } from "../steps/draft-response";
import { safetyCheck } from "../steps/safety-check";
import { createProposalAndGate } from "../steps/gate-or-execute";
import { executeAction } from "../steps/execute-action";
import { commitState } from "../steps/commit-state";
import { researchContext, determineResearchLevel, emptyResearchContext } from "../steps/research-context";
import db, { logger, caseRuntime, completeRun, waitRun } from "../lib/db";
import { reconcileCaseAfterDismiss } from "../lib/reconcile-case";
import type { FollowupPayload, HumanDecision, ResearchContext } from "../lib/types";

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

export const processFollowup = task({
  id: "process-followup",
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
      await db.logActivity("agent_run_failed", `Process-followup failed for case ${caseId}: ${String(error).substring(0, 300)}`, {
        case_id: caseId,
      });
    } catch {}
  },

  run: async (payload: FollowupPayload) => {
    const { caseId, followupScheduleId } = payload;

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
          const agentRun = await db.createAgentRun(caseId, "SCHEDULED_FOLLOWUP", {
            followupScheduleId, source: "trigger.dev",
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
      const agentRun = await db.createAgentRun(caseId, "SCHEDULED_FOLLOWUP", {
        followupScheduleId, source: "trigger.dev",
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
        // non-fatal
      }
    };

    logger.info("process-followup started", { runId, caseId, followupScheduleId });
    await markStep("start", `Run #${runId}: started scheduled follow-up`);

    // Step 1: Load context
    await markStep("load_context", `Run #${runId}: loading follow-up context`);
    const context = await loadContext(caseId, null);

    // Step 2: Decide (classification = NO_RESPONSE for scheduled followups)
    await markStep("decide_next_action", `Run #${runId}: deciding follow-up action`);
    const decision = await decideNextAction(
      caseId, "NO_RESPONSE", context.constraints,
      null, "neutral", context.autopilotMode,
      "SCHEDULED_FOLLOWUP", false, null, null, null, null
    );

    if (decision.isComplete || decision.actionType === "NONE") {
      await commitState(
        caseId, runId, decision.actionType, decision.reasoning,
        1.0, "SCHEDULED_FOLLOWUP", false, null
      );
      await completeRun(caseId, runId);
      return { status: "completed", action: "none" };
    }

    // Step 2b: Research context (lightweight for followups)
    let research: ResearchContext = emptyResearchContext();
    const followupResearchLevel = determineResearchLevel(
      decision.actionType, "NO_RESPONSE", null,
      decision.researchLevel, !!(context.caseData.contact_research_notes)
    );
    if (followupResearchLevel !== "none") {
      await markStep("research_context", `Run #${runId}: running follow-up research`, { level: followupResearchLevel });
      research = await researchContext(caseId, decision.actionType, "NO_RESPONSE", null, followupResearchLevel);
    }

    // Step 3: Draft follow-up
    await markStep("draft_response", `Run #${runId}: drafting follow-up`, { action_type: decision.actionType });
    const draft = await draftResponse(
      caseId, decision.actionType, context.constraints, context.scopeItems,
      null, decision.adjustmentInstruction, null,
      research
    );

    // Step 4: Safety check
    await markStep("safety_check", `Run #${runId}: safety checking follow-up draft`);
    const safety = await safetyCheck(
      draft.bodyText, draft.subject, decision.actionType,
      context.constraints, context.scopeItems,
      null, null
    );

    // Step 5: Gate
    await markStep("gate", `Run #${runId}: creating proposal/gate for follow-up`);
    const gate = await createProposalAndGate(
      caseId, runId, decision.actionType,
      null, draft, safety,
      decision.canAutoExecute, decision.requiresHuman,
      decision.pauseReason, decision.reasoning,
      1.0, 0, null, draft.lessonsApplied
    );

    // Step 6: Wait if needed
    if (gate.shouldWait && gate.waitpointTokenId) {
      await markStep("wait_human_decision", `Run #${runId}: waiting for human decision`, { proposal_id: gate.proposalId });
      await waitRun(caseId, runId);
      const result = await waitForHumanDecision(gate.waitpointTokenId, gate.proposalId);

      if (!result.ok) {
        await db.updateProposal(gate.proposalId, { status: "EXPIRED" });
        await completeRun(caseId, runId);
        return { status: "timed_out", proposalId: gate.proposalId };
      }

      // Validate proposal is still actionable.
      // If proposal was DISMISSED externally (e.g. resolve-review), exit cleanly.
      const currentProposal = await db.getProposalById(gate.proposalId);
      if (currentProposal?.status === "DISMISSED") {
        logger.info("Proposal was dismissed externally, exiting cleanly", { caseId, proposalId: gate.proposalId });
        await completeRun(caseId, runId);
        return { status: "dismissed_externally", proposalId: gate.proposalId };
      }
      if (!["PENDING_APPROVAL", "DECISION_RECEIVED"].includes(currentProposal?.status)) {
        throw new Error(
          `Proposal ${gate.proposalId} is ${currentProposal?.status}, expected PENDING_APPROVAL or DECISION_RECEIVED`
        );
      }

      const humanDecision = result.output;
      if (!humanDecision || !humanDecision.action) {
        logger.error("Invalid human decision output", { caseId, proposalId: gate.proposalId, output: result.output });
        throw new Error(`Invalid human decision for proposal ${gate.proposalId}: missing action`);
      }

      if (humanDecision.action === "WITHDRAW") {
        await db.updateProposal(gate.proposalId, { status: "WITHDRAWN" });
        await db.updateCaseStatus(caseId, "cancelled", { substatus: "withdrawn_by_user" });
        await db.updateCase(caseId, { outcome_type: "withdrawn", outcome_recorded: true });
        await completeRun(caseId, runId);
        return { status: "withdrawn", proposalId: gate.proposalId };
      }

      if (humanDecision.action !== "APPROVE") {
        await db.updateProposal(gate.proposalId, { status: "DISMISSED" });
        await reconcileCaseAfterDismiss(caseId);
        await completeRun(caseId, runId);
        return { status: "dismissed", proposalId: gate.proposalId };
      }
    }

    // Step 7: Execute
    await markStep("execute_action", `Run #${runId}: executing follow-up action`, { action_type: decision.actionType });
    const execution = await executeAction(
      caseId, gate.proposalId, decision.actionType, runId,
      draft, null, decision.reasoning
    );

    // Step 8: Commit
    await markStep("commit_state", `Run #${runId}: committing follow-up state`);
    await commitState(
      caseId, runId, decision.actionType, decision.reasoning,
      1.0, "SCHEDULED_FOLLOWUP", execution.actionExecuted, execution.executionResult
    );

    await completeRun(caseId, runId);
    return {
      status: "completed",
      proposalId: gate.proposalId,
      actionType: decision.actionType,
      executed: execution.actionExecuted,
    };
  },
});
