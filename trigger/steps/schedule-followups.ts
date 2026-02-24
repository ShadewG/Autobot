/**
 * Schedule Follow-ups Step
 *
 * Port of langgraph/nodes/schedule-followups.js
 * Creates follow-up schedule after initial request is sent.
 */

import db, { logger } from "../lib/db";

const DEFAULT_RESPONSE_DAYS = parseInt(process.env.DEFAULT_RESPONSE_DAYS || "10", 10);

async function getStateResponseDays(state: string): Promise<number> {
  let responseDays = DEFAULT_RESPONSE_DAYS;
  if (state) {
    try {
      const result = await db.query(
        "SELECT response_days FROM state_deadlines WHERE state_code = $1",
        [state.toUpperCase()]
      );
      if (result.rows[0]) {
        responseDays = result.rows[0].response_days;
      }
    } catch (err: any) {
      logger.warn("Could not fetch state deadline", { state, error: err.message });
    }
  }
  return responseDays;
}

export async function scheduleFollowups(
  caseId: number,
  actionExecuted: boolean,
  executionResult: any
): Promise<{ followupScheduleId?: number; nextFollowupDate?: string }> {
  if (!actionExecuted) {
    return {};
  }

  const caseData = await db.getCaseById(caseId);
  if (!caseData) {
    throw new Error(`Case ${caseId} not found`);
  }

  const thread = await db.getThreadByCaseId(caseId);
  const sendDate = executionResult?.sentAt ? new Date(executionResult.sentAt) : new Date();
  const responseDays = await getStateResponseDays(caseData.state);

  // Follow-up = statutory deadline + 2 day buffer
  const bufferDays = 2;
  const nextFollowupDate = new Date(sendDate);
  nextFollowupDate.setDate(nextFollowupDate.getDate() + responseDays + bufferDays);

  // Statutory deadline (no buffer)
  const deadlineDate = new Date(sendDate);
  deadlineDate.setDate(deadlineDate.getDate() + responseDays);

  const schedule = await db.upsertFollowUpSchedule(caseId, {
    threadId: thread?.id || null,
    nextFollowupDate,
    followupCount: 0,
    autoSend: false,
    status: "scheduled",
    lastFollowupSentAt: null,
  });

  // Update case status
  await db.updateCase(caseId, {
    status: "awaiting_response",
    send_date: sendDate,
    deadline_date: deadlineDate,
  });

  return {
    followupScheduleId: schedule.id,
    nextFollowupDate: nextFollowupDate.toISOString(),
  };
}
