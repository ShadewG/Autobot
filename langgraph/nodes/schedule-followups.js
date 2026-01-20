/**
 * Schedule Follow-ups Node
 *
 * Creates follow-up schedule after initial request is sent.
 * Calculates next follow-up date based on state deadlines.
 *
 * Part of: Initial Request Graph
 */

const db = require('../../services/database');
const logger = require('../../services/logger');

// Default follow-up interval in business days
const DEFAULT_FOLLOWUP_DAYS = parseInt(process.env.DEFAULT_FOLLOWUP_DAYS) || 7;

/**
 * Calculate next follow-up date based on state deadlines
 *
 * @param {string} state - State code (e.g., 'CA', 'NY')
 * @param {Date} sendDate - When the request was sent
 * @returns {Date} - Next follow-up date
 */
async function calculateNextFollowupDate(state, sendDate = new Date()) {
  // Try to get state-specific deadline
  let responseDays = DEFAULT_FOLLOWUP_DAYS;

  if (state) {
    try {
      const stateDeadline = await db.query(
        'SELECT response_days FROM state_deadlines WHERE state_code = $1',
        [state.toUpperCase()]
      );
      if (stateDeadline.rows[0]) {
        responseDays = stateDeadline.rows[0].response_days;
      }
    } catch (err) {
      logger.warn('Could not fetch state deadline', { state, error: err.message });
    }
  }

  // Add buffer days (follow up after deadline + grace period)
  const bufferDays = 2;
  const totalDays = responseDays + bufferDays;

  // Calculate follow-up date (simple: add calendar days, could improve with business days)
  const followupDate = new Date(sendDate);
  followupDate.setDate(followupDate.getDate() + totalDays);

  return followupDate;
}

/**
 * Schedule follow-ups node
 *
 * Inputs from state:
 * - caseId
 * - actionExecuted (must be true to schedule)
 * - executionResult
 *
 * Outputs to state:
 * - logs
 */
async function scheduleFollowupsNode(state) {
  const { caseId, actionExecuted, executionResult } = state;
  const logs = [];

  try {
    // Only schedule if execution was successful
    if (!actionExecuted) {
      logs.push('Skipping follow-up scheduling (action not executed)');
      return { logs };
    }

    logs.push('Scheduling follow-ups');

    // Get case data for state-specific deadline calculation
    const caseData = await db.getCaseById(caseId);
    if (!caseData) {
      throw new Error(`Case ${caseId} not found`);
    }

    // Get or create email thread
    const thread = await db.getThreadByCaseId(caseId);

    // Calculate next follow-up date
    const sendDate = executionResult?.sentAt ? new Date(executionResult.sentAt) : new Date();
    const nextFollowupDate = await calculateNextFollowupDate(caseData.state, sendDate);

    // Create or update follow-up schedule
    const schedule = await db.upsertFollowUpSchedule(caseId, {
      thread_id: thread?.id || null,
      next_followup_date: nextFollowupDate,
      followup_count: 0,
      auto_send: caseData.autopilot_mode === 'AUTO',
      status: 'scheduled',
      last_followup_sent_at: null
    });

    logs.push(`Follow-up scheduled for ${nextFollowupDate.toISOString().split('T')[0]}`);
    logs.push(`Auto-send: ${schedule.auto_send}`);

    // Update case status to awaiting_response
    await db.updateCase(caseId, {
      status: 'awaiting_response',
      send_date: sendDate
    });

    logs.push('Case status updated to awaiting_response');

    return {
      logs,
      followupScheduleId: schedule.id,
      nextFollowupDate: nextFollowupDate.toISOString()
    };

  } catch (error) {
    logger.error('schedule_followups_node error', { caseId, error: error.message });
    logs.push(`Error scheduling follow-ups: ${error.message}`);
    return { logs, errors: [error.message] };
  }
}

module.exports = { scheduleFollowupsNode, calculateNextFollowupDate };
