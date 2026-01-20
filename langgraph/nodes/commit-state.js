/**
 * Commit State Node
 *
 * Finalizes state after action execution.
 * - Recomputes due_info
 * - Updates next_due_at
 * - Clears gates if resolved
 * - Logs decision for learning
 */

const db = require('../../services/database');
const logger = require('../../services/logger');

/**
 * Get statutory response days by state
 */
function getStatutoryDays(state) {
  const stateDays = {
    'CA': 10,
    'TX': 10,
    'NY': 5,
    'FL': 14,
    'IL': 7,
    'PA': 5,
    'OH': 10,
    'GA': 3,
    'NC': 14,
    'MI': 5,
    'NJ': 7,
    'VA': 5,
    'WA': 5,
    'AZ': 5,
    'MA': 10,
    'TN': 7,
    'IN': 7,
    'MO': 3,
    'MD': 30,
    'WI': 10,
    'CO': 3,
    'MN': 10,
    'SC': 15,
    'AL': 10,
    'LA': 3,
    'KY': 3,
    'OR': 5,
    'OK': 3,
    'CT': 4,
    'UT': 10,
    'IA': 10,
    'NV': 5,
    'AR': 3,
    'MS': 7,
    'KS': 3,
    'NM': 15,
    'NE': 4,
    'ID': 3,
    'WV': 5,
    'HI': 10,
    'NH': 5,
    'ME': 5,
    'MT': 5,
    'RI': 10,
    'DE': 15,
    'SD': 5,
    'ND': 5,
    'AK': 10,
    'DC': 15,
    'VT': 3,
    'WY': 5,
    'DEFAULT': 10
  };
  return stateDays[state] || stateDays['DEFAULT'];
}

/**
 * Compute next due date based on case state
 */
async function computeDueInfo(caseData) {
  const { id, status, send_date, state: caseState } = caseData;

  // Get statutory deadline (varies by state)
  const statutoryDays = getStatutoryDays(caseState);

  // Check for scheduled follow-up
  const followup = await db.getFollowUpScheduleByCaseId(id);

  let next_due_at = null;
  let due_type = null;

  if (followup?.next_followup_date) {
    next_due_at = new Date(followup.next_followup_date);
    due_type = 'FOLLOWUP';
  } else if (send_date && statutoryDays) {
    // Calculate statutory deadline
    const deadline = new Date(send_date);
    deadline.setDate(deadline.getDate() + statutoryDays);
    next_due_at = deadline;
    due_type = 'STATUTORY';
  }

  return {
    next_due_at,
    due_type,
    statutory_days: statutoryDays
  };
}

/**
 * Finalize state after action execution
 */
async function commitStateNode(state) {
  const {
    caseId, proposalActionType, proposalReasoning, proposalConfidence,
    actionExecuted, executionResult, triggerType
  } = state;

  const logs = [];

  try {
    const caseData = await db.getCaseById(caseId);

    // === Recompute due_info ===
    const dueInfo = await computeDueInfo(caseData);

    if (dueInfo.next_due_at) {
      await db.updateCase(caseId, {
        next_due_at: dueInfo.next_due_at,
        updated_at: new Date()
      });
      logs.push(`Updated next_due_at: ${dueInfo.next_due_at.toISOString()}`);
    } else {
      logs.push('No next_due_at to update');
    }

    // === Log decision for adaptive learning ===
    await db.createAgentDecision({
      caseId,
      reasoning: (proposalReasoning || []).join('\n') || 'No reasoning recorded',
      actionTaken: proposalActionType || 'NONE',
      confidence: proposalConfidence || 0.8,
      triggerType: triggerType,
      outcome: actionExecuted ? 'executed' : 'gated'
    });

    logs.push('Decision logged for learning');

    // === Log timeline event ===
    await db.logActivity('agent_decision',
      `Agent decided: ${proposalActionType || 'NONE'}`, {
        caseId,
        reasoning: proposalReasoning,
        executed: actionExecuted,
        result: executionResult
      }
    );

    return {
      isComplete: true,
      logs
    };

  } catch (error) {
    logger.error('commit_state_node error', { caseId, error: error.message });
    return {
      errors: [`Commit failed: ${error.message}`],
      isComplete: true,  // Still mark complete to exit
      logs
    };
  }
}

module.exports = { commitStateNode };
