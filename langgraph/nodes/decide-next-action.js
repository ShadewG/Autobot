/**
 * Decide Next Action Node (Router)
 *
 * Determines what action to take based on classification and constraints.
 * Uses DETERMINISTIC rules first, then can fall back to LLM for complex cases.
 *
 * IMPORTANT: All action types must be from constants/action-types.js
 */

const db = require('../../services/database');
const logger = require('../../services/logger');
const { createPortalTask } = require('../../services/executor-adapter');
const {
  SEND_FOLLOWUP,
  SEND_REBUTTAL,
  SEND_CLARIFICATION,
  RESPOND_PARTIAL_APPROVAL,
  ACCEPT_FEE,
  NEGOTIATE_FEE,
  ESCALATE,
  NONE,
  validateActionType
} = require('../../constants/action-types');

// Fee thresholds from env
const FEE_AUTO_APPROVE_MAX = parseFloat(process.env.FEE_AUTO_APPROVE_MAX) || 100;
const FEE_NEGOTIATE_THRESHOLD = parseFloat(process.env.FEE_NEGOTIATE_THRESHOLD) || 500;
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
 *
 * IMPORTANT: Respects requires_response from classification.
 * If requires_response === false, NO email is drafted.
 * Instead, we update case state and return immediately.
 */
async function decideNextActionNode(state) {
  const {
    caseId, classification, extractedFeeAmount, sentiment,
    constraints, triggerType, autopilotMode,
    humanDecision,
    // NEW: Prompt tuning fields
    requiresResponse, portalUrl, suggestedAction, reasonNoResponse,
    // Human review resolution fields
    reviewAction, reviewInstruction
  } = state;

  const logs = [];
  const reasoning = [];

  try {
    // === FIRST: Check if response is even needed (prompt tuning fix) ===
    // This is the key gate that prevents unnecessary email drafting
    if (requiresResponse === false) {
      reasoning.push(`No response needed: ${reasonNoResponse || 'Analysis determined no email required'}`);
      logs.push(`Skipping email draft: requires_response=false (${classification})`);

      // Handle based on suggested action
      if (suggestedAction === 'use_portal') {
        // CRITICAL: Portal redirect must create portal task AND update case status
        // This is enforced by production readiness tests

        // 1. Update case with portal URL and status
        await db.updateCasePortalStatus(caseId, { portal_url: portalUrl });
        await db.updateCaseStatus(caseId, 'pending', { substatus: 'portal_required' });
        reasoning.push(`Portal redirect detected, saved URL: ${portalUrl || 'unknown'}`);

        // 2. Create portal task for UI queue
        try {
          const caseData = await db.getCaseById(caseId);
          await createPortalTask({
            caseId,
            portalUrl: portalUrl || caseData?.portal_url,
            actionType: 'SUBMIT_VIA_PORTAL',
            subject: caseData?.request_summary || 'FOIA Request',
            bodyText: `Agency requires portal submission. Please submit the original request through their portal.`,
            status: 'PENDING',
            instructions: `Submit the FOIA request through the agency portal at: ${portalUrl || 'their website'}`
          });
          reasoning.push('Portal task created for manual submission');
          logs.push('Portal task created successfully');
        } catch (portalTaskError) {
          // Log but don't fail - portal task creation is important but not blocking
          logger.error('Failed to create portal task', { caseId, error: portalTaskError.message });
          logs.push(`Warning: Portal task creation failed: ${portalTaskError.message}`);
        }

        return {
          isComplete: true,
          proposalActionType: NONE,
          proposalReasoning: reasoning,
          logs: [...logs, `Case updated: portal_required. Portal URL: ${portalUrl || 'see agency website'}. No email needed.`]
        };
      }

      if (suggestedAction === 'download') {
        // Records ready - mark case as completed
        await db.updateCaseStatus(caseId, 'completed', { substatus: 'records_received' });
        reasoning.push('Records ready for download');

        return {
          isComplete: true,
          proposalActionType: NONE,
          proposalReasoning: reasoning,
          logs: [...logs, 'Case completed: records ready for download']
        };
      }

      if (suggestedAction === 'wait') {
        // Acknowledgment - just wait for next response
        reasoning.push('Acknowledgment received, waiting for substantive response');

        return {
          isComplete: true,
          proposalActionType: NONE,
          proposalReasoning: reasoning,
          logs: [...logs, 'Acknowledgment received, no action needed']
        };
      }

      if (suggestedAction === 'find_correct_agency') {
        // Wrong agency - mark for manual redirect
        await db.updateCaseStatus(caseId, 'pending', { substatus: 'wrong_agency' });
        reasoning.push('Wrong agency - needs manual redirect');

        return {
          isComplete: true,
          proposalActionType: NONE,
          proposalReasoning: reasoning,
          logs: [...logs, 'Wrong agency detected, case flagged for manual redirect']
        };
      }

      // Default no-response: just mark complete
      return {
        isComplete: true,
        proposalActionType: NONE,
        proposalReasoning: reasoning,
        logs: [...logs, 'No email response needed']
      };
    }

    // === Handle HUMAN_REVIEW_RESOLUTION trigger ===
    // Maps review actions from the resolve-review UI to graph actions
    if (triggerType === 'HUMAN_REVIEW_RESOLUTION' && reviewAction) {
      reasoning.push(`Human review resolution: action=${reviewAction}`);
      if (reviewInstruction) {
        reasoning.push(`Instruction: ${reviewInstruction}`);
      }

      // Map reviewAction to appropriate graph action
      switch (reviewAction) {
        case 'retry_portal': {
          // Re-trigger portal submission — only case that needs full case data
          const caseData = await db.getCaseById(caseId);
          reasoning.push('Retrying portal submission');
          const currentPortalUrl = caseData?.portal_url;
          if (currentPortalUrl) {
            await db.updateCaseStatus(caseId, 'portal_in_progress', {
              substatus: 'Portal retry requested by human',
              requires_human: false
            });
            try {
              await createPortalTask({
                caseId,
                portalUrl: currentPortalUrl,
                actionType: 'SUBMIT_VIA_PORTAL',
                subject: caseData?.request_summary || 'FOIA Request',
                bodyText: reviewInstruction || 'Retry portal submission per human review',
                status: 'PENDING',
                instructions: reviewInstruction || `Retry portal submission at: ${currentPortalUrl}`
              });
              reasoning.push('Portal task created for retry');
            } catch (err) {
              reasoning.push(`Portal task creation failed: ${err.message}`);
            }
          } else {
            reasoning.push('No portal URL found - cannot retry portal');
          }
          return {
            isComplete: true,
            proposalActionType: NONE,
            proposalReasoning: reasoning,
            logs: [...logs, 'Portal retry initiated via human review']
          };
        }

        case 'send_via_email': {
          // Switch to email submission - draft and send original request via email
          reasoning.push('Switching to email submission per human review');
          return {
            proposalActionType: SEND_FOLLOWUP,
            canAutoExecute: false,
            requiresHuman: true,
            pauseReason: null,
            adjustmentInstruction: reviewInstruction || 'Send the original FOIA request via email instead of portal',
            proposalReasoning: reasoning,
            logs: [...logs, 'Drafting email submission per human review'],
            nextNode: 'draft_response'
          };
        }

        case 'appeal': {
          // Draft an appeal/rebuttal
          reasoning.push('Drafting appeal per human review');
          return {
            proposalActionType: SEND_REBUTTAL,
            canAutoExecute: false,
            requiresHuman: true,
            pauseReason: null,
            adjustmentInstruction: reviewInstruction || 'Draft an appeal citing legal grounds for the records request',
            proposalReasoning: reasoning,
            logs: [...logs, 'Drafting appeal per human review'],
            nextNode: 'draft_response'
          };
        }

        case 'narrow_scope': {
          // Narrow scope and resubmit
          reasoning.push('Narrowing scope per human review');
          return {
            proposalActionType: SEND_CLARIFICATION,
            canAutoExecute: false,
            requiresHuman: true,
            pauseReason: null,
            adjustmentInstruction: reviewInstruction || 'Narrow the scope of the records request and resubmit',
            proposalReasoning: reasoning,
            logs: [...logs, 'Narrowing scope per human review'],
            nextNode: 'draft_response'
          };
        }

        case 'negotiate_fee': {
          reasoning.push('Negotiating fee per human review');
          return {
            proposalActionType: NEGOTIATE_FEE,
            canAutoExecute: false,
            requiresHuman: true,
            pauseReason: null,
            adjustmentInstruction: reviewInstruction || 'Negotiate the quoted fee amount',
            proposalReasoning: reasoning,
            logs: [...logs, 'Negotiating fee per human review'],
            nextNode: 'draft_response'
          };
        }

        case 'accept_fee': {
          reasoning.push('Accepting fee per human review');
          return {
            proposalActionType: ACCEPT_FEE,
            canAutoExecute: false,
            requiresHuman: true,
            pauseReason: null,
            adjustmentInstruction: reviewInstruction || null,
            proposalReasoning: reasoning,
            logs: [...logs, 'Accepting fee per human review'],
            nextNode: 'draft_response'
          };
        }

        case 'reprocess': {
          // Re-analyze — escalate to gate for human to review fresh
          reasoning.push('Reprocessing case per human review');
          return {
            proposalActionType: ESCALATE,
            canAutoExecute: false,
            requiresHuman: true,
            pauseReason: null,
            proposalReasoning: reasoning,
            logs: [...logs, 'Reprocessing case per human review'],
            nextNode: 'gate_or_execute'
          };
        }

        case 'custom': {
          // Use the instruction to draft a response
          reasoning.push('Custom action per human review');
          if (!reviewInstruction) {
            reasoning.push('No instruction provided for custom action');
            return {
              isComplete: true,
              proposalActionType: NONE,
              proposalReasoning: reasoning,
              logs: [...logs, 'Custom action with no instruction - skipping']
            };
          }
          return {
            proposalActionType: SEND_FOLLOWUP,
            canAutoExecute: false,
            requiresHuman: true,
            pauseReason: null,
            adjustmentInstruction: reviewInstruction,
            proposalReasoning: reasoning,
            logs: [...logs, 'Drafting custom response per human review'],
            nextNode: 'draft_response'
          };
        }

        default:
          reasoning.push(`Unknown review action: ${reviewAction}`);
          return {
            proposalActionType: ESCALATE,
            canAutoExecute: false,
            requiresHuman: true,
            proposalReasoning: reasoning,
            logs: [...logs, `Unknown review action: ${reviewAction}`]
          };
      }
    }

    // === Handle human resume ===
    if (humanDecision) {
      logs.push(`Processing human decision: ${humanDecision.action}`);

      // CRITICAL: Hydrate proposalActionType from DB if missing in state
      // This prevents null action_type errors on resume
      let proposalActionType = state.proposalActionType;
      if (!proposalActionType) {
        const pendingProposal = await db.getLatestPendingProposal(caseId);
        if (pendingProposal?.action_type) {
          proposalActionType = pendingProposal.action_type;
          logs.push(`Recovered proposalActionType from DB: ${proposalActionType}`);
        } else {
          // Last resort fallback - should not happen
          proposalActionType = 'UNKNOWN';
          logs.push(`WARNING: No proposalActionType in state or DB, using UNKNOWN`);
        }
      }

      switch (humanDecision.action) {
        case 'APPROVE':
          reasoning.push('Human approved the proposal');
          return {
            proposalActionType,  // Use hydrated value
            canAutoExecute: true,  // Now approved for execution
            requiresHuman: false,
            logs,
            proposalReasoning: reasoning,
            nextNode: 'execute_action'
          };

        case 'ADJUST':
          reasoning.push(`Human requested adjustment: ${humanDecision.instruction}`);
          return {
            proposalActionType,  // Use hydrated value
            adjustmentInstruction: humanDecision.instruction,  // Pass instruction to draft node
            proposalReasoning: reasoning,
            logs: [...logs, 'Re-drafting with adjustment instruction'],
            nextNode: 'draft_response'
          };

        case 'DISMISS':
          reasoning.push('Human dismissed proposal - ending graph run');
          // For now, DISMISS ends the graph. User can manually re-invoke later.
          // TODO: Implement proper dismissal tracking
          return {
            proposalId: null,
            proposalKey: null,
            humanDecision: null,
            isComplete: true,  // End the graph run
            logs: [...logs, 'Proposal dismissed by user'],
            proposalReasoning: reasoning
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
    if (classification === 'FEE_QUOTE' && extractedFeeAmount != null) {
      // Coerce fee amount to number for comparisons
      const fee = Number(extractedFeeAmount);
      reasoning.push(`Fee quote received: $${fee}`);

      // Determine fee action based on thresholds
      // Under FEE_AUTO_APPROVE_MAX: Accept (auto in AUTO mode)
      // FEE_AUTO_APPROVE_MAX to FEE_NEGOTIATE_THRESHOLD: Accept with review
      // Over FEE_NEGOTIATE_THRESHOLD: Negotiate

      if (fee <= FEE_AUTO_APPROVE_MAX && autopilotMode === 'AUTO') {
        reasoning.push(`Fee under threshold ($${FEE_AUTO_APPROVE_MAX}), auto-approving`);
        return {
          proposalActionType: ACCEPT_FEE,
          canAutoExecute: true,
          requiresHuman: false,
          pauseReason: null,
          proposalReasoning: reasoning,
          logs: [...logs, `Auto-accepting fee: $${fee}`],
          nextNode: 'draft_response'
        };
      } else if (fee <= FEE_NEGOTIATE_THRESHOLD) {
        // Medium fee - accept but gate for human review
        reasoning.push(`Fee within acceptable range, gating for human review`);
        return {
          proposalActionType: ACCEPT_FEE,
          canAutoExecute: false,
          requiresHuman: true,
          pauseReason: 'FEE_QUOTE',
          proposalReasoning: reasoning,
          logs: [...logs, `Gating fee acceptance: $${fee}`],
          nextNode: 'draft_response'
        };
      } else {
        // High fee - recommend negotiation
        reasoning.push(`Fee exceeds negotiate threshold ($${FEE_NEGOTIATE_THRESHOLD}), recommending negotiation`);
        return {
          proposalActionType: NEGOTIATE_FEE,
          canAutoExecute: false,
          requiresHuman: true,
          pauseReason: 'FEE_QUOTE',
          proposalReasoning: reasoning,
          logs: [...logs, `High fee - recommending negotiation: $${fee}`],
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
          proposalActionType: SEND_REBUTTAL,
          canAutoExecute: true,
          requiresHuman: false,
          proposalReasoning: reasoning,
          logs: [...logs, 'Drafting rebuttal for weak denial'],
          nextNode: 'draft_response'
        };
      } else {
        reasoning.push('Strong/medium denial or supervised mode, gating for human review');
        return {
          proposalActionType: SEND_REBUTTAL,
          canAutoExecute: false,
          requiresHuman: true,
          pauseReason: 'DENIAL',
          proposalReasoning: reasoning,
          logs: [...logs, 'Gating denial response for human review'],
          nextNode: 'draft_response'
        };
      }
    }

    // 3. PARTIAL_APPROVAL handling (some records approved, some denied/withheld)
    if (classification === 'PARTIAL_APPROVAL') {
      reasoning.push('Partial approval received - some records released, some withheld');

      // Partial approvals always need human review to decide strategy
      // Response will: 1) accept fee for released items, 2) challenge withheld items
      return {
        proposalActionType: RESPOND_PARTIAL_APPROVAL,
        canAutoExecute: false,
        requiresHuman: true,
        pauseReason: 'SCOPE',  // Scope decision needed for withheld items
        proposalReasoning: reasoning,
        logs: [...logs, 'Preparing partial approval response (accept released + challenge withheld)'],
        nextNode: 'draft_response'
      };
    }

    // 4. CLARIFICATION REQUEST handling
    if (classification === 'CLARIFICATION_REQUEST') {
      reasoning.push('Agency requested clarification/more info');

      const canAuto = autopilotMode === 'AUTO' && sentiment !== 'hostile';
      return {
        proposalActionType: SEND_CLARIFICATION,
        canAutoExecute: canAuto,
        requiresHuman: !canAuto,
        pauseReason: canAuto ? null : 'SCOPE',
        proposalReasoning: reasoning,
        logs: [...logs, `Preparing clarification response (auto=${canAuto})`],
        nextNode: 'draft_response'
      };
    }

    // 5. NO-RESPONSE CLASSIFICATIONS (should already be caught by requires_response check above)
    // These handlers exist as fallback if requires_response wasn't set properly
    if (classification === 'RECORDS_READY') {
      reasoning.push('Records are ready for pickup/download');
      await db.updateCaseStatus(caseId, 'completed', { substatus: 'records_received' });
      return {
        isComplete: true,
        proposalActionType: NONE,
        proposalReasoning: reasoning,
        logs: [...logs, 'Case completed: records ready']
      };
    }

    if (classification === 'ACKNOWLEDGMENT') {
      reasoning.push('Acknowledgment received, no action needed');
      return {
        isComplete: true,
        proposalActionType: NONE,
        proposalReasoning: reasoning,
        logs: [...logs, 'Acknowledgment received, waiting for next response']
      };
    }

    // NEW: Portal redirect - no email, create portal task instead
    // CRITICAL: This must create portal_task AND update case status (production readiness gate)
    if (classification === 'PORTAL_REDIRECT') {
      reasoning.push('Agency requires portal submission - no email response');

      // 1. Update case status and portal URL
      await db.updateCasePortalStatus(caseId, { portal_url: portalUrl });
      await db.updateCaseStatus(caseId, 'pending', { substatus: 'portal_required' });

      // 2. Create portal task for UI queue
      try {
        const caseData = await db.getCaseById(caseId);
        await createPortalTask({
          caseId,
          portalUrl: portalUrl || caseData?.portal_url,
          actionType: 'SUBMIT_VIA_PORTAL',
          subject: caseData?.request_summary || 'FOIA Request',
          bodyText: `Agency requires portal submission. Please submit the original request through their portal.`,
          status: 'PENDING',
          instructions: `Submit the FOIA request through the agency portal at: ${portalUrl || 'their website'}`
        });
        reasoning.push(`Portal task created, URL: ${portalUrl || 'unknown'}`);
      } catch (portalTaskError) {
        logger.error('Failed to create portal task', { caseId, error: portalTaskError.message });
        reasoning.push(`Warning: Portal task creation failed: ${portalTaskError.message}`);
      }

      return {
        isComplete: true,
        proposalActionType: NONE,
        proposalReasoning: reasoning,
        logs: [...logs, `Portal redirect - task created. Use: ${portalUrl || 'agency portal'}`]
      };
    }

    // NEW: Wrong agency - no email, find correct agency
    if (classification === 'WRONG_AGENCY') {
      reasoning.push('Wrong agency - needs redirect to correct custodian');
      await db.updateCaseStatus(caseId, 'pending', { substatus: 'wrong_agency' });
      return {
        isComplete: true,
        proposalActionType: NONE,
        proposalReasoning: reasoning,
        logs: [...logs, 'Wrong agency - flagged for manual redirect']
      };
    }

    // NEW: Partial delivery - download and wait
    if (classification === 'PARTIAL_DELIVERY') {
      reasoning.push('Partial delivery received - download and wait for remainder');
      return {
        isComplete: true,
        proposalActionType: NONE,
        proposalReasoning: reasoning,
        logs: [...logs, 'Partial delivery - download available records, await remainder']
      };
    }

    // NEW: Hostile - always escalate with human review
    if (classification === 'HOSTILE') {
      reasoning.push('Hostile response detected - escalating to human review');
      return {
        proposalActionType: ESCALATE,
        canAutoExecute: false,
        requiresHuman: true,
        pauseReason: 'SENSITIVE',
        proposalReasoning: reasoning,
        logs: [...logs, 'Hostile response - requires human review'],
        nextNode: 'gate_or_execute'
      };
    }

    // 6. NO_RESPONSE - time-based/scheduled follow-up
    // Deterministically route SCHEDULED_FOLLOWUP triggers to SEND_FOLLOWUP
    if (classification === 'NO_RESPONSE' ||
        triggerType === 'time_based_followup' ||
        triggerType === 'SCHEDULED_FOLLOWUP' ||
        triggerType === 'followup_trigger') {
      reasoning.push('No response from agency or scheduled follow-up trigger, preparing follow-up');

      const followupSchedule = await db.getFollowUpScheduleByCaseId(caseId);
      const followupCount = followupSchedule?.followup_count || 0;

      if (followupCount >= MAX_FOLLOWUPS) {
        reasoning.push(`Max follow-ups reached (${followupCount}/${MAX_FOLLOWUPS}), escalating`);
        return {
          proposalActionType: ESCALATE,
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
        proposalActionType: SEND_FOLLOWUP,
        canAutoExecute: canAuto,
        requiresHuman: !canAuto,
        proposalReasoning: reasoning,
        logs: [...logs, `Preparing follow-up #${followupCount + 1}`],
        nextNode: 'draft_response'
      };
    }

    // 7. UNKNOWN or hostile sentiment - always gate
    if (classification === 'UNKNOWN' || sentiment === 'hostile') {
      reasoning.push('Uncertain classification or hostile sentiment, escalating to human');
      return {
        proposalActionType: ESCALATE,
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
      proposalActionType: NONE,
      isComplete: true,
      proposalReasoning: reasoning,
      logs: [...logs, 'No action needed']
    };

  } catch (error) {
    logger.error('decide_next_action_node error', { caseId, error: error.message });
    return {
      errors: [`Decision failed: ${error.message}`],
      proposalActionType: ESCALATE,
      requiresHuman: true,
      pauseReason: 'SENSITIVE'
    };
  }
}

module.exports = { decideNextActionNode };
