/**
 * Commit State Step
 *
 * Port of langgraph/nodes/commit-state.js
 * Finalizes state: recomputes due dates, logs decision for adaptive learning.
 */

import db, { logger } from "../lib/db";
import type { ActionType } from "../lib/types";

const COMMIT_STEP_TIMEOUT_MS = parseInt(process.env.COMMIT_STEP_TIMEOUT_MS || "5000", 10);

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeoutPromise = new Promise<T>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
  });
  try {
    const result = await Promise.race([promise, timeoutPromise]);
    clearTimeout(timer!);
    return result;
  } catch (error) {
    clearTimeout(timer!);
    throw error;
  }
}

const STATE_DAYS: Record<string, number> = {
  CA: 10, TX: 10, NY: 5, FL: 14, IL: 7, PA: 5, OH: 10, GA: 3, NC: 14, MI: 5,
  NJ: 7, VA: 5, WA: 5, AZ: 5, MA: 10, TN: 7, IN: 7, MO: 3, MD: 30, WI: 10,
  CO: 3, MN: 10, SC: 15, AL: 10, LA: 3, KY: 3, OR: 5, OK: 3, CT: 4, UT: 10,
  IA: 10, NV: 5, AR: 3, MS: 7, KS: 3, NM: 15, NE: 4, ID: 3, WV: 5, HI: 10,
  NH: 5, ME: 5, MT: 5, RI: 10, DE: 15, SD: 5, ND: 5, AK: 10, DC: 15, VT: 3,
  WY: 5, DEFAULT: 10,
};

function getStatutoryDays(state: string): number {
  return STATE_DAYS[state] || STATE_DAYS["DEFAULT"];
}

async function computeDueInfo(caseData: any) {
  const { id, send_date, state: caseState } = caseData;
  const statutoryDays = getStatutoryDays(caseState);
  const followup = await db.getFollowUpScheduleByCaseId(id);

  let next_due_at: Date | null = null;
  let due_type: string | null = null;

  if (followup?.next_followup_date) {
    next_due_at = new Date(followup.next_followup_date);
    due_type = "FOLLOWUP";
  } else if (send_date && statutoryDays) {
    const deadline = new Date(send_date);
    deadline.setDate(deadline.getDate() + statutoryDays);
    next_due_at = deadline;
    due_type = "STATUTORY";
  }

  return { next_due_at, due_type, statutory_days: statutoryDays };
}

export async function commitState(
  caseId: number,
  runId: number,
  actionType: ActionType | string,
  reasoning: string[],
  confidence: number,
  triggerType: string,
  actionExecuted: boolean,
  executionResult: any
): Promise<void> {
  try {
    const caseData = await withTimeout(
      db.getCaseById(caseId),
      COMMIT_STEP_TIMEOUT_MS,
      "getCaseById"
    );

    // Recompute due_info
    const dueInfo = await withTimeout(
      computeDueInfo(caseData),
      COMMIT_STEP_TIMEOUT_MS,
      "computeDueInfo"
    );

    if (dueInfo.next_due_at) {
      await withTimeout(
        db.updateCase(caseId, {
          next_due_at: dueInfo.next_due_at,
        }),
        COMMIT_STEP_TIMEOUT_MS,
        "updateCase(next_due_at)"
      );
    }

    // Log decision for adaptive learning
    await withTimeout(
      db.createAgentDecision({
        caseId,
        reasoning: (reasoning || []).join("\n") || "No reasoning recorded",
        actionTaken: actionType || "NONE",
        confidence: confidence || 0.8,
        triggerType,
        outcome: actionExecuted ? "executed" : "gated",
      }),
      COMMIT_STEP_TIMEOUT_MS,
      "createAgentDecision"
    );

    // Log timeline event
    await withTimeout(
      db.logActivity("agent_decision", `Agent decided: ${actionType || "NONE"}`, {
        caseId,
        reasoning,
        executed: actionExecuted,
        result: executionResult,
      }),
      COMMIT_STEP_TIMEOUT_MS,
      "logActivity(agent_decision)"
    );
  } catch (error: any) {
    logger.error("commit_state step error", { caseId, error: error.message });
    // Don't throw — commit is best-effort, we don't want to fail the whole run
  }
}
