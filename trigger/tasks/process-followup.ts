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
import db, { logger } from "../lib/db";
import type { FollowupPayload, HumanDecision } from "../lib/types";

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
  maxDuration: 300,
  retry: { maxAttempts: 2 },

  run: async (payload: FollowupPayload) => {
    const { runId, caseId, followupScheduleId } = payload;

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
      return { status: "completed", action: "none" };
    }

    // Step 3: Draft follow-up
    const draft = await draftResponse(
      caseId, decision.actionType, context.constraints, context.scopeItems,
      null, decision.adjustmentInstruction, null
    );

    // Step 4: Safety check
    const safety = await safetyCheck(
      draft.bodyText, draft.subject, decision.actionType,
      context.constraints, context.scopeItems
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
      const result = await waitForHumanDecision(gate.waitpointTokenId, gate.proposalId);

      if (!result.ok) {
        await db.updateProposal(gate.proposalId, { status: "EXPIRED" });
        return { status: "timed_out", proposalId: gate.proposalId };
      }

      // Validate proposal still PENDING_APPROVAL
      const currentProposal = await db.getProposalById(gate.proposalId);
      if (currentProposal?.status !== "PENDING_APPROVAL") {
        throw new Error(
          `Proposal ${gate.proposalId} is ${currentProposal?.status}, not PENDING_APPROVAL`
        );
      }

      if (result.output.action === "WITHDRAW") {
        await db.updateProposal(gate.proposalId, { status: "WITHDRAWN" });
        await db.updateCaseStatus(caseId, "cancelled", { substatus: "withdrawn_by_user" });
        await db.updateCase(caseId, { outcome_type: "withdrawn", outcome_recorded: true });
        return { status: "withdrawn", proposalId: gate.proposalId };
      }

      if (result.output.action !== "APPROVE") {
        await db.updateProposal(gate.proposalId, { status: "DISMISSED" });
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

    return {
      status: "completed",
      proposalId: gate.proposalId,
      actionType: decision.actionType,
      executed: execution.actionExecuted,
    };
  },
});
