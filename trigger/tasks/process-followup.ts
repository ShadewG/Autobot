/**
 * Process Follow-up Trigger Task
 *
 * Replaces: followup trigger handler in agent-worker
 *
 * Triggered by scheduled follow-up. Routes through the same inbound pipeline
 * but with NO_RESPONSE classification (since there's no new message).
 */

import { task, wait } from "@trigger.dev/sdk/v3";
import { loadContext } from "../steps/load-context";
import { decideNextAction } from "../steps/decide-next-action";
import { draftResponse } from "../steps/draft-response";
import { safetyCheck } from "../steps/safety-check";
import { createProposalAndGate } from "../steps/gate-or-execute";
import { executeAction } from "../steps/execute-action";
import { commitState } from "../steps/commit-state";
import { researchContext, determineResearchLevel, emptyResearchContext } from "../steps/research-context";
import db, { logger } from "../lib/db";
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
      await db.query(
        `UPDATE proposals SET status = 'DISMISSED', updated_at = NOW()
         WHERE case_id = $1 AND status IN ('PENDING_APPROVAL', 'BLOCKED')`,
        [caseId]
      );
      await db.updateCaseStatus(caseId, "needs_human_review", {
        requires_human: true,
        substatus: `Agent run failed: ${String(error).substring(0, 200)}`,
      });
    } catch {}
  },

  run: async (payload: FollowupPayload) => {
    const { caseId, followupScheduleId } = payload;

    // Clear any stale agent_runs that would block the unique constraint
    await db.query(
      `UPDATE agent_runs SET status = 'failed', error = 'superseded by new trigger.dev run'
       WHERE case_id = $1 AND status IN ('created', 'queued', 'running')`,
      [caseId]
    );

    // Create agent_run record in DB (provides FK for proposals)
    const agentRun = await db.createAgentRun(caseId, "SCHEDULED_FOLLOWUP", {
      followupScheduleId,
      source: "trigger.dev",
    });
    const runId = agentRun.id;

    logger.info("process-followup started", { runId, caseId, followupScheduleId });

    // Step 1: Load context
    const context = await loadContext(caseId, null);

    // Step 2: Decide (classification = NO_RESPONSE for scheduled followups)
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
      await db.query("UPDATE agent_runs SET status = 'completed', ended_at = NOW() WHERE id = $1", [runId]);
      return { status: "completed", action: "none" };
    }

    // Step 2b: Research context (lightweight for followups)
    let research: ResearchContext = emptyResearchContext();
    const followupResearchLevel = determineResearchLevel(
      decision.actionType, "NO_RESPONSE", null,
      decision.researchLevel, !!(context.caseData.contact_research_notes)
    );
    if (followupResearchLevel !== "none") {
      research = await researchContext(caseId, decision.actionType, "NO_RESPONSE", null, followupResearchLevel);
    }

    // Step 3: Draft follow-up
    const draft = await draftResponse(
      caseId, decision.actionType, context.constraints, context.scopeItems,
      null, decision.adjustmentInstruction, null,
      research
    );

    // Step 4: Safety check
    const safety = await safetyCheck(
      draft.bodyText, draft.subject, decision.actionType,
      context.constraints, context.scopeItems,
      null, null
    );

    // Step 5: Gate
    const gate = await createProposalAndGate(
      caseId, runId, decision.actionType,
      null, draft, safety,
      decision.canAutoExecute, decision.requiresHuman,
      decision.pauseReason, decision.reasoning,
      1.0, 0, null, draft.lessonsApplied
    );

    // Step 6: Wait if needed
    if (gate.shouldWait && gate.waitpointTokenId) {
      await db.query("UPDATE agent_runs SET status = 'waiting' WHERE id = $1", [runId]);
      const result = await waitForHumanDecision(gate.waitpointTokenId, gate.proposalId);

      if (!result.ok) {
        await db.updateProposal(gate.proposalId, { status: "EXPIRED" });
        await db.query("UPDATE agent_runs SET status = 'completed', ended_at = NOW() WHERE id = $1", [runId]);
        return { status: "timed_out", proposalId: gate.proposalId };
      }

      // Validate proposal is still actionable
      const currentProposal = await db.getProposalById(gate.proposalId);
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
        await db.query("UPDATE agent_runs SET status = 'completed', ended_at = NOW() WHERE id = $1", [runId]);
        return { status: "withdrawn", proposalId: gate.proposalId };
      }

      if (humanDecision.action !== "APPROVE") {
        await db.updateProposal(gate.proposalId, { status: "DISMISSED" });
        await db.query("UPDATE agent_runs SET status = 'completed', ended_at = NOW() WHERE id = $1", [runId]);
        return { status: "dismissed", proposalId: gate.proposalId };
      }
    }

    // Step 7: Execute
    const execution = await executeAction(
      caseId, gate.proposalId, decision.actionType, runId,
      draft, null, decision.reasoning
    );

    // Step 8: Commit
    await commitState(
      caseId, runId, decision.actionType, decision.reasoning,
      1.0, "SCHEDULED_FOLLOWUP", execution.actionExecuted, execution.executionResult
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
