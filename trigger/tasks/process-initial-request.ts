/**
 * Process Initial Request Task
 *
 * Replaces: initial-request-graph + agent-worker initial handler
 *
 * Flow: load-context -> draft-initial-request -> safety-check ->
 *       gate -> [wait for human?] -> execute -> schedule-followups -> commit
 */

import { task, wait } from "@trigger.dev/sdk/v3";
import { loadContext } from "../steps/load-context";
import { draftInitialRequest } from "../steps/draft-initial-request";
import { safetyCheck } from "../steps/safety-check";
import { executeAction } from "../steps/execute-action";
import { scheduleFollowups } from "../steps/schedule-followups";
import { commitState } from "../steps/commit-state";
import db, { logger } from "../lib/db";
import type { HumanDecision, InitialRequestPayload } from "../lib/types";

async function waitForHumanDecision(tokenId: string): Promise<{ ok: true; output: HumanDecision } | { ok: false }> {
  const token = await wait.createToken({ idempotencyKey: tokenId, timeout: "30d" });
  const result = await wait.forToken<HumanDecision>(token);
  if (!result.ok) return { ok: false };
  return { ok: true, output: result.output };
}

export const processInitialRequest = task({
  id: "process-initial-request",
  maxDuration: 300,
  retry: { maxAttempts: 2 },

  run: async (payload: InitialRequestPayload) => {
    const { runId, caseId, autopilotMode } = payload;

    logger.info("process-initial-request started", { runId, caseId, autopilotMode });

    // Step 1: Load context
    const context = await loadContext(caseId, null);

    // Step 2: Draft initial FOIA request
    const draft = await draftInitialRequest(caseId, runId, autopilotMode);

    // Step 3: Safety check
    const safety = await safetyCheck(
      draft.bodyText, draft.subject,
      "SEND_INITIAL_REQUEST", context.constraints, context.scopeItems
    );

    // If requires human review, wait for approval
    if (draft.requiresHuman) {
      const tokenId = crypto.randomUUID();
      await db.updateProposal(draft.proposalId, { waitpoint_token: tokenId });
      await db.updateCaseStatus(caseId, "needs_human_review", {
        requires_human: true, pause_reason: "INITIAL_REQUEST",
      });

      logger.info("Waiting for human approval of initial request", {
        caseId, proposalId: draft.proposalId, tokenId,
      });

      const result = await waitForHumanDecision(tokenId);

      if (!result.ok) {
        await db.updateProposal(draft.proposalId, { status: "EXPIRED" });
        await db.upsertEscalation({
          caseId,
          reason: "Initial request proposal timed out after 30 days",
          urgency: "high",
          suggestedAction: "Review and decide on initial FOIA request",
        });
        return { status: "timed_out", proposalId: draft.proposalId };
      }

      const humanDecision = result.output;
      logger.info("Human decision received for initial request", { caseId, action: humanDecision.action });

      // Validate proposal state AND token match
      const currentProposal = await db.getProposalById(draft.proposalId);
      if (currentProposal?.status !== "PENDING_APPROVAL") {
        throw new Error(
          `Proposal ${draft.proposalId} is ${currentProposal?.status}, not PENDING_APPROVAL`
        );
      }
      if (currentProposal?.waitpoint_token !== tokenId) {
        throw new Error(
          `Proposal ${draft.proposalId} token mismatch — stale approval rejected`
        );
      }

      if (humanDecision.action === "DISMISS") {
        await db.updateProposal(draft.proposalId, { status: "DISMISSED" });
        return { status: "dismissed", proposalId: draft.proposalId };
      }

      if (humanDecision.action === "WITHDRAW") {
        await db.updateProposal(draft.proposalId, { status: "WITHDRAWN" });
        await db.updateCaseStatus(caseId, "cancelled", { substatus: "withdrawn_by_user" });
        return { status: "withdrawn", proposalId: draft.proposalId };
      }

      if (humanDecision.action === "ADJUST") {
        // Update proposal with adjustment and wait again
        await db.updateProposal(draft.proposalId, {
          reasoning: [...draft.reasoning, `Adjusted per human: ${humanDecision.instruction}`],
        });

        const adjustTokenId = crypto.randomUUID();
        await db.updateProposal(draft.proposalId, { waitpoint_token: adjustTokenId });

        const adjustResult = await waitForHumanDecision(adjustTokenId);

        if (!adjustResult.ok || adjustResult.output.action !== "APPROVE") {
          await db.updateProposal(draft.proposalId, {
            status: !adjustResult.ok ? "EXPIRED" : "DISMISSED",
          });
          return {
            status: !adjustResult.ok ? "timed_out" : "dismissed",
            proposalId: draft.proposalId,
          };
        }
        // Fall through to execute
      }

      // APPROVE: update proposal status
      await db.updateProposal(draft.proposalId, { status: "APPROVED" });
    }

    // Step 4: Execute (send initial request)
    const execution = await executeAction(
      caseId, draft.proposalId, "SEND_INITIAL_REQUEST", runId,
      { subject: draft.subject, bodyText: draft.bodyText, bodyHtml: draft.bodyHtml },
      null, draft.reasoning
    );

    // Step 5: Schedule follow-ups (only if executed)
    let followupResult = {};
    if (execution.actionExecuted) {
      followupResult = await scheduleFollowups(caseId, execution.actionExecuted, execution.executionResult);
    }

    // Step 6: Commit state
    await commitState(
      caseId, runId, "SEND_INITIAL_REQUEST", draft.reasoning,
      0.9, "initial_request", execution.actionExecuted, execution.executionResult
    );

    return {
      status: "completed",
      proposalId: draft.proposalId,
      executed: execution.actionExecuted,
      ...followupResult,
    };
  },
});
