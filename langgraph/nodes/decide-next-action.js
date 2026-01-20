/**
 * Decide Next Action Node (Router)
 *
 * Determines what action to take based on classification and constraints.
 * Uses DETERMINISTIC rules first, then can fall back to LLM for complex cases.
 */

const db = require('../../services/database');
const logger = require('../../utils/logger');

// Fee threshold from env
const FEE_AUTO_APPROVE_MAX = parseFloat(process.env.FEE_AUTO_APPROVE_MAX) || 100;
const MAX_FOLLOWUPS = parseInt(process.env.MAX_FOLLOWUPS) || 2;

/**
 * Assess how strong a denial is
 */
async function assessDenialStrength(caseData) {
  const latestAnalysis = await db.getLatestResponseAnalysis(caseData.id);
  const keyPoints = latestAnalysis?.key_points || [];

  const strongIndicators = [
    'exemption', 'statute', 'law enforcement', 'ongoing investigation',
    'privacy', 'confidential', 'sealed'
  ];

  const strongCount = keyPoints.filter(p =>
    strongIndicators.some(ind => p.toLowerCase().includes(ind))
  ).length;

  if (strongCount >= 2) return 'strong';
  if (strongCount === 1) return 'medium';
  return 'weak';
}

/**
 * Decide what action to take next
 */
async function decideNextActionNode(state) {
  const {
    caseId, classification, extractedFeeAmount, sentiment,
    constraints, triggerType, autopilotMode,
    humanDecision
  } = state;

  const logs = [];
  const reasoning = [];

  try {
    // === Handle human resume first ===
    if (humanDecision) {
      logs.push(`Processing human decision: ${humanDecision.action}`);

      switch (humanDecision.action) {
        case 'APPROVE':
          reasoning.push('Human approved the proposal');
          return {
            proposalActionType: state.proposalActionType,  // Keep existing
            canAutoExecute: true,  // Now approved for execution
            requiresHuman: false,
            logs,
            proposalReasoning: reasoning,
            nextNode: 'execute_action'
          };

        case 'ADJUST':
          reasoning.push(`Human requested adjustment: ${humanDecision.instruction}`);
          return {
            proposalReasoning: reasoning,
            logs: [...logs, 'Re-drafting with adjustment instruction'],
            nextNode: 'draft_response'
          };

        case 'DISMISS':
          reasoning.push('Human dismissed proposal, will generate new one');
          return {
            proposalId: null,
            proposalKey: null,
            draftSubject: null,
            draftBodyText: null,
            draftBodyHtml: null,
            proposalReasoning: [],
            humanDecision: null,  // Clear the decision
            logs: [...logs, 'Proposal dismissed, generating new action'],
            // Continue to re-evaluate - don't set nextNode
          };

        case 'WITHDRAW':
          reasoning.push('Human chose to withdraw/close the request');
          await db.updateCaseStatus(caseId, 'cancelled', {
            substatus: 'withdrawn_by_user'
          });
          return {
            isComplete: true,
            logs: [...logs, 'Request withdrawn by user'],
            proposalReasoning: reasoning
          };
      }
    }

    // === Deterministic routing based on classification ===

    // 1. FEE QUOTE handling
    if (classification === 'FEE_QUOTE' && extractedFeeAmount) {
      reasoning.push(`Fee quote received: $${extractedFeeAmount}`);

      if (extractedFeeAmount <= FEE_AUTO_APPROVE_MAX && autopilotMode === 'AUTO') {
        reasoning.push(`Fee under threshold ($${FEE_AUTO_APPROVE_MAX}), auto-approving`);
        return {
          proposalActionType: 'APPROVE_FEE',
          canAutoExecute: true,
          requiresHuman: false,
          pauseReason: null,
          proposalReasoning: reasoning,
          logs: [...logs, `Auto-approving fee: $${extractedFeeAmount}`],
          nextNode: 'draft_response'
        };
      } else {
        reasoning.push(`Fee exceeds threshold or requires supervision, gating for human approval`);
        return {
          proposalActionType: 'APPROVE_FEE',
          canAutoExecute: false,
          requiresHuman: true,
          pauseReason: 'FEE_QUOTE',
          proposalReasoning: reasoning,
          logs: [...logs, `Gating fee approval: $${extractedFeeAmount}`],
          nextNode: 'draft_response'
        };
      }
    }

    // 2. DENIAL handling
    if (classification === 'DENIAL') {
      reasoning.push('Denial received from agency');

      // Check if denial is challengeable
      const caseData = await db.getCaseById(caseId);
      const denialStrength = await assessDenialStrength(caseData);
      reasoning.push(`Denial strength assessed as: ${denialStrength}`);

      if (denialStrength === 'weak' && autopilotMode === 'AUTO') {
        reasoning.push('Weak denial, preparing rebuttal');
        return {
          proposalActionType: 'SEND_REBUTTAL',
          canAutoExecute: true,
          requiresHuman: false,
          proposalReasoning: reasoning,
          logs: [...logs, 'Drafting rebuttal for weak denial'],
          nextNode: 'draft_response'
        };
      } else {
        reasoning.push('Strong/medium denial or supervised mode, gating for human review');
        return {
          proposalActionType: 'SEND_REBUTTAL',
          canAutoExecute: false,
          requiresHuman: true,
          pauseReason: 'DENIAL',
          proposalReasoning: reasoning,
          logs: [...logs, 'Gating denial response for human review'],
          nextNode: 'draft_response'
        };
      }
    }

    // 3. CLARIFICATION REQUEST handling
    if (classification === 'CLARIFICATION_REQUEST') {
      reasoning.push('Agency requested clarification/more info');

      const canAuto = autopilotMode === 'AUTO' && sentiment !== 'hostile';
      return {
        proposalActionType: 'SEND_CLARIFICATION',
        canAutoExecute: canAuto,
        requiresHuman: !canAuto,
        pauseReason: canAuto ? null : 'SCOPE',
        proposalReasoning: reasoning,
        logs: [...logs, `Preparing clarification response (auto=${canAuto})`],
        nextNode: 'draft_response'
      };
    }

    // 4. RECORDS_READY / ACKNOWLEDGMENT - positive outcomes
    if (classification === 'RECORDS_READY') {
      reasoning.push('Records are ready for pickup/download');
      await db.updateCaseStatus(caseId, 'completed', { substatus: 'records_received' });
      return {
        isComplete: true,
        proposalReasoning: reasoning,
        logs: [...logs, 'Case completed: records ready']
      };
    }

    if (classification === 'ACKNOWLEDGMENT') {
      reasoning.push('Acknowledgment received, no action needed');
      return {
        isComplete: true,
        proposalReasoning: reasoning,
        logs: [...logs, 'Acknowledgment received, waiting for next response']
      };
    }

    // 5. NO_RESPONSE - time-based follow-up
    if (classification === 'NO_RESPONSE' || triggerType === 'time_based_followup') {
      reasoning.push('No response from agency, preparing follow-up');

      const followupSchedule = await db.getFollowUpScheduleByCaseId(caseId);
      const followupCount = followupSchedule?.followup_count || 0;

      if (followupCount >= MAX_FOLLOWUPS) {
        reasoning.push(`Max follow-ups reached (${followupCount}/${MAX_FOLLOWUPS}), escalating`);
        return {
          proposalActionType: 'ESCALATE',
          canAutoExecute: true,
          requiresHuman: true,
          pauseReason: 'CLOSE_ACTION',
          proposalReasoning: reasoning,
          logs: [...logs, 'Max follow-ups reached, escalating'],
          nextNode: 'gate_or_execute'
        };
      }

      const canAuto = autopilotMode === 'AUTO';
      return {
        proposalActionType: 'SEND_FOLLOWUP',
        canAutoExecute: canAuto,
        requiresHuman: !canAuto,
        proposalReasoning: reasoning,
        logs: [...logs, `Preparing follow-up #${followupCount + 1}`],
        nextNode: 'draft_response'
      };
    }

    // 6. UNKNOWN or hostile sentiment - always gate
    if (classification === 'UNKNOWN' || sentiment === 'hostile') {
      reasoning.push('Uncertain classification or hostile sentiment, escalating to human');
      return {
        proposalActionType: 'ESCALATE',
        canAutoExecute: false,
        requiresHuman: true,
        pauseReason: 'SENSITIVE',
        proposalReasoning: reasoning,
        logs: [...logs, 'Escalating uncertain/hostile case'],
        nextNode: 'gate_or_execute'
      };
    }

    // Default: No action needed
    reasoning.push('No action required at this time');
    return {
      proposalActionType: 'NONE',
      isComplete: true,
      proposalReasoning: reasoning,
      logs: [...logs, 'No action needed']
    };

  } catch (error) {
    logger.error('decide_next_action_node error', { caseId, error: error.message });
    return {
      errors: [`Decision failed: ${error.message}`],
      proposalActionType: 'ESCALATE',
      requiresHuman: true,
      pauseReason: 'SENSITIVE'
    };
  }
}

module.exports = { decideNextActionNode };
