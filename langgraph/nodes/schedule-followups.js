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

// Default response days for unknown states
const DEFAULT_RESPONSE_DAYS = parseInt(process.env.DEFAULT_RESPONSE_DAYS) || 10;

/**
 * Get the statutory response days for a state
 *
 * @param {string} state - State code (e.g., 'CA', 'NY')
 * @returns {number} - Response days for that state
 */
async function getStateResponseDays(state) {
  let responseDays = DEFAULT_RESPONSE_DAYS;

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

  return responseDays;
}

/**
 * Calculate next follow-up date based on state deadlines
 *
 * @param {string} state - State code (e.g., 'CA', 'NY')
 * @param {Date} sendDate - When the request was sent
 * @returns {Date} - Next follow-up date
 */
async function calculateNextFollowupDate(state, sendDate = new Date()) {
  const responseDays = await getStateResponseDays(state);

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

    // Calculate next follow-up date and statutory deadline
    const sendDate = executionResult?.sentAt ? new Date(executionResult.sentAt) : new Date();
    const responseDays = await getStateResponseDays(caseData.state);
    const nextFollowupDate = await calculateNextFollowupDate(caseData.state, sendDate);

    // Calculate the statutory deadline (no buffer — the actual legal deadline)
    const deadlineDate = new Date(sendDate);
    deadlineDate.setDate(deadlineDate.getDate() + responseDays);

    // Create or update follow-up schedule (auto_send disabled — deadline escalation handles it)
    const schedule = await db.upsertFollowUpSchedule(caseId, {
      threadId: thread?.id || null,
      nextFollowupDate: nextFollowupDate,
      followupCount: 0,
      autoSend: false,
      status: 'scheduled',
      lastFollowupSentAt: null
    });

    logs.push(`Follow-up scheduled for ${nextFollowupDate.toISOString().split('T')[0]}`);
    logs.push(`Statutory deadline: ${deadlineDate.toISOString().split('T')[0]} (${responseDays} days)`);
    logs.push(`Auto-send: ${schedule.auto_send}`);

    // Update case status to awaiting_response with deadline
    await db.updateCase(caseId, {
      status: 'awaiting_response',
      send_date: sendDate,
      deadline_date: deadlineDate
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

module.exports = { scheduleFollowupsNode, calculateNextFollowupDate, getStateResponseDays };
