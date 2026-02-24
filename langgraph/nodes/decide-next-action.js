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
  DECLINE_FEE,
  ESCALATE,
  NONE,
  CLOSE_CASE,
  RESEARCH_AGENCY,
  REFORMULATE_REQUEST,
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
    'privacy', 'confidential', 'sealed', 'court', 'pending litigation',
    'active case'
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
    humanDecision, denialSubtype,
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
    // BYPASS: Scheduled followups and NO_RESPONSE should go to the followup handler,
    // not get blocked here — "no response needed" means no reply to an agency message,
    // but we still need to send proactive follow-ups for unanswered requests.
    const isFollowupTrigger = triggerType === 'SCHEDULED_FOLLOWUP' || triggerType === 'time_based_followup' || triggerType === 'followup_trigger';
    // OVERRIDE: When the AI explicitly recommends a response-requiring action (send_rebuttal,
    // respond to denial, etc.) but also sets requires_action=false, trust the action over the
    // flag. This contradiction happens frequently with denials — the AI recognizes the denial
    // is challengeable but still marks requires_action=false.
    const responseRequiringActions = ['send_rebuttal', 'negotiate_fee', 'pay_fee', 'challenge'];
    const actionOverridesNoResponse = responseRequiringActions.includes(suggestedAction)
      || (suggestedAction === 'respond' && classification === 'DENIAL');
    if (actionOverridesNoResponse) {
      logs.push(`Override: suggestedAction=${suggestedAction} overrides requires_response=false for ${classification}`);
    }
    if (requiresResponse === false && !actionOverridesNoResponse && !(isFollowupTrigger || classification === 'NO_RESPONSE')) {
      reasoning.push(`No response needed: ${reasonNoResponse || 'Analysis determined no email required'}`);
      logs.push(`Skipping email draft: requires_response=false (${classification})`);

      // OVERRIDE: Even when the AI says "no response needed" for a denial/closure,
      // check if there's an unanswered clarification request in the thread.
      // Agencies often close requests when clarifications go unanswered — the right
      // action is to answer their question and ask to reopen, not to do nothing.
      if (classification === 'DENIAL') {
        const threadMessages = await db.getMessagesByCaseId(caseId);
        const inboundAnalyses = await db.query(
          `SELECT ra.message_id, ra.intent FROM response_analysis ra
           JOIN messages m ON m.id = ra.message_id
           WHERE ra.case_id = $1 AND m.direction = 'inbound'
           ORDER BY ra.created_at ASC`,
          [caseId]
        );

        const clarificationMsgIds = inboundAnalyses.rows
          .filter(a => a.intent === 'question' || a.intent === 'more_info_needed')
          .map(a => a.message_id);

        if (clarificationMsgIds.length > 0) {
          const lastClarificationId = clarificationMsgIds[clarificationMsgIds.length - 1];
          const outboundAfter = threadMessages.filter(m =>
            m.direction === 'outbound' && m.id > lastClarificationId
          );

          if (outboundAfter.length === 0) {
            reasoning.length = 0; // Clear the "no response needed" reasoning
            reasoning.push(`Denial received, but found unanswered clarification request (msg #${lastClarificationId})`);
            reasoning.push('Agency likely closed due to no response — answering their original question instead');
            return {
              proposalActionType: SEND_CLARIFICATION,
              latestInboundMessageId: lastClarificationId,
              canAutoExecute: false,
              requiresHuman: true,
              pauseReason: 'DENIAL',
              proposalReasoning: reasoning,
              logs: [...logs, `Unanswered clarification detected (msg #${lastClarificationId}) — overriding requires_response=false`],
              nextNode: 'draft_response'
            };
          }
        }
      }

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
        await db.updateCase(caseId, { outcome_type: 'full_approval', outcome_recorded: new Date() });
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

        case 'decline_fee': {
          reasoning.push('Declining fee per human review');
          return {
            proposalActionType: DECLINE_FEE,
            canAutoExecute: false,
            requiresHuman: true,
            pauseReason: null,
            adjustmentInstruction: reviewInstruction || 'Decline the quoted fee and explain why',
            proposalReasoning: reasoning,
            logs: [...logs, 'Declining fee per human review'],
            nextNode: 'draft_response'
          };
        }

        case 'escalate': {
          reasoning.push('Escalating to human oversight per review');
          return {
            proposalActionType: ESCALATE,
            canAutoExecute: false,
            requiresHuman: true,
            pauseReason: null,
            proposalReasoning: reasoning,
            logs: [...logs, 'Escalating per human review'],
            nextNode: 'gate_or_execute'
          };
        }

        case 'research_agency': {
          reasoning.push('Researching correct agency per human review');
          return {
            proposalActionType: RESEARCH_AGENCY,
            canAutoExecute: false,
            requiresHuman: true,
            pauseReason: null,
            adjustmentInstruction: reviewInstruction || 'Research the correct agency for this request',
            proposalReasoning: reasoning,
            logs: [...logs, 'Researching agency per human review'],
            nextNode: 'draft_response'
          };
        }

        case 'reformulate_request': {
          reasoning.push('Reformulating request per human review');
          return {
            proposalActionType: REFORMULATE_REQUEST,
            canAutoExecute: false,
            requiresHuman: true,
            pauseReason: null,
            adjustmentInstruction: reviewInstruction || 'Reformulate the request with a different approach',
            proposalReasoning: reasoning,
            logs: [...logs, 'Reformulating request per human review'],
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

        case 'call_agency': {
          // Escalate to phone call queue — details too complex for email
          reasoning.push('Escalating to phone call queue per human review');
          const phoneReason = reviewInstruction ? 'details_needed' : 'complex_inquiry';
          try {
            const followupScheduler = require('../../services/followup-scheduler');
            await followupScheduler.escalateToPhoneQueue(caseId, phoneReason, {
              notes: reviewInstruction || 'Human reviewer requested phone call to agency'
            });
          } catch (phoneErr) {
            logger.error('Failed to escalate to phone queue from review', { caseId, error: phoneErr.message });
          }
          return {
            isComplete: true,
            proposalActionType: NONE,
            proposalReasoning: reasoning,
            logs: [...logs, `Escalated to phone queue (${phoneReason})`]
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
            humanDecision: null,  // Clear consumed decision to prevent stale routing
            proposalActionType,  // Use hydrated value
            canAutoExecute: true,  // Now approved for execution
            requiresHuman: false,
            adjustmentInstruction: null,  // Clear stale adjustment text
            logs,
            proposalReasoning: reasoning,
            nextNode: 'execute_action'
          };

        case 'ADJUST':
          reasoning.push(`Human requested adjustment: ${humanDecision.instruction}`);
          return {
            humanDecision: null,  // Clear consumed decision to prevent stale routing
            proposalActionType,  // Use hydrated value
            adjustmentInstruction: humanDecision.instruction,  // Pass instruction to draft node
            proposalReasoning: reasoning,
            logs: [...logs, 'Re-drafting with adjustment instruction'],
            nextNode: 'draft_response'
          };

        case 'DISMISS':
          reasoning.push('Human dismissed proposal - ending graph run');
          // For now, DISMISS ends the graph. User can manually re-invoke later.
          return {
            proposalId: null,
            proposalKey: null,
            humanDecision: null,
            adjustmentInstruction: null,  // Clear stale adjustment text
            isComplete: true,  // End the graph run
            logs: [...logs, 'Proposal dismissed by user'],
            proposalReasoning: reasoning
          };

        case 'WITHDRAW':
          reasoning.push('Human chose to withdraw/close the request');
          await db.updateCaseStatus(caseId, 'cancelled', {
            substatus: 'withdrawn_by_user'
          });
          await db.updateCase(caseId, { outcome_type: 'withdrawn', outcome_recorded: new Date() });
          return {
            humanDecision: null,  // Clear consumed decision to prevent stale routing
            adjustmentInstruction: null,  // Clear stale adjustment text
            isComplete: true,
            logs: [...logs, 'Request withdrawn by user'],
            proposalReasoning: reasoning
          };

        default:
          reasoning.push(`Unknown human decision action: ${humanDecision.action}`);
          logger.warn('Unknown human decision action', { caseId, action: humanDecision.action });
          return {
            humanDecision: null,  // Clear to prevent infinite re-routing
            proposalActionType: ESCALATE,
            canAutoExecute: false,
            requiresHuman: true,
            pauseReason: 'SENSITIVE',
            proposalReasoning: reasoning,
            logs: [...logs, `Unknown decision action "${humanDecision.action}" — escalating`],
            nextNode: 'gate_or_execute'
          };
      }
    }

    // === Deterministic routing based on classification ===

    // 1. FEE QUOTE handling
    if (classification === 'FEE_QUOTE') {
      // Coerce fee amount to number for comparisons
      const fee = extractedFeeAmount != null ? Number(extractedFeeAmount) : null;

      // Guard: if fee is missing, NaN, or negative, gate for human review
      if (fee === null || !isFinite(fee) || fee < 0) {
        reasoning.push(`Fee quote detected but amount is invalid or missing (raw: ${extractedFeeAmount})`);
        return {
          proposalActionType: NEGOTIATE_FEE,
          canAutoExecute: false,
          requiresHuman: true,
          pauseReason: 'FEE_QUOTE',
          proposalReasoning: reasoning,
          logs: [...logs, `Fee amount invalid (${extractedFeeAmount}) — gating for human review`],
          nextNode: 'draft_response'
        };
      }
      reasoning.push(`Fee quote received: $${fee}`);

      // CRITICAL CHECK: Did the agency also deny critical records (BWC/video) in this message?
      // If so, we should NOT accept the fee — we need to challenge the denial first.
      // No point paying for records if BWC (the most important record) is withheld.
      const latestAnalysis = await db.getLatestResponseAnalysis(caseId);
      const keyPoints = latestAnalysis?.key_points || latestAnalysis?.full_analysis_json?.key_points || [];
      const keyPointsText = keyPoints.join(' ').toLowerCase();
      const caseForRecords = await db.getCaseById(caseId);
      const requestedRecords = (Array.isArray(caseForRecords?.requested_records)
        ? caseForRecords.requested_records.join(' ')
        : (caseForRecords?.requested_records || '')).toLowerCase();

      const bwcRequested = requestedRecords.includes('body cam') || requestedRecords.includes('bodycam') ||
                           requestedRecords.includes('bwc') || requestedRecords.includes('body worn') ||
                           requestedRecords.includes('video');
      const hasBwcMention = keyPointsText.includes('body cam') || keyPointsText.includes('bodycam') ||
                            keyPointsText.includes('bwc') || keyPointsText.includes('body worn') ||
                            keyPointsText.includes('body-worn') || keyPointsText.includes('video');
      const hasDenialLanguage = keyPointsText.includes('not disclos') || keyPointsText.includes('disclosable') ||
                                keyPointsText.includes('denied') || keyPointsText.includes('withheld') ||
                                keyPointsText.includes('exempt') || keyPointsText.includes('not subject') ||
                                keyPointsText.includes('not available') || keyPointsText.includes('unable to release') ||
                                keyPointsText.includes('not releasable') || keyPointsText.includes('not foia') ||
                                keyPointsText.includes('not public record') || keyPointsText.includes('not provid');
      const bwcDenied = hasBwcMention && hasDenialLanguage;

      if (bwcRequested && bwcDenied) {
        reasoning.push('CRITICAL: Agency denied BWC/video — the most important record. Cannot accept fee without BWC.');
        reasoning.push('Routing to SEND_REBUTTAL to challenge BWC denial before paying any fees.');
        return {
          proposalActionType: SEND_REBUTTAL,
          canAutoExecute: false,
          requiresHuman: true,
          pauseReason: 'DENIAL',
          proposalReasoning: reasoning,
          logs: [...logs, `BWC denied alongside fee quote ($${fee}) — challenging denial before accepting fee`],
          nextNode: 'draft_response'
        };
      }

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

    // 2. DENIAL handling — subtype-aware routing
    if (classification === 'DENIAL') {
      reasoning.push('Denial received from agency');

      const caseData = await db.getCaseById(caseId);

      // CHECK: Was there an unanswered clarification request in this thread?
      // If the agency asked us a question and we never replied, the "denial" is likely
      // just the agency closing the request due to no response — not a true denial.
      // The right action is to answer the original question, not reformulate/research.
      const threadMessages = await db.getMessagesByCaseId(caseId);
      const inboundAnalyses = await db.query(
        `SELECT ra.message_id, ra.intent FROM response_analysis ra
         JOIN messages m ON m.id = ra.message_id
         WHERE ra.case_id = $1 AND m.direction = 'inbound'
         ORDER BY ra.created_at ASC`,
        [caseId]
      );
      const analysisMap = {};
      for (const a of inboundAnalyses.rows) {
        analysisMap[a.message_id] = a.intent;
      }

      // Find inbound clarification/question messages
      const clarificationMsgIds = inboundAnalyses.rows
        .filter(a => a.intent === 'question' || a.intent === 'more_info_needed')
        .map(a => a.message_id);

      if (clarificationMsgIds.length > 0) {
        // Check if we replied to any of them (outbound message after the clarification)
        const lastClarificationId = clarificationMsgIds[clarificationMsgIds.length - 1];
        const outboundAfter = threadMessages.filter(m =>
          m.direction === 'outbound' &&
          m.id > lastClarificationId
        );

        if (outboundAfter.length === 0) {
          reasoning.push(`Found unanswered clarification request (msg #${lastClarificationId}) — agency likely closed due to no response, not a true denial`);
          reasoning.push('Proposing SEND_CLARIFICATION to answer their original question');
          return {
            proposalActionType: SEND_CLARIFICATION,
            latestInboundMessageId: lastClarificationId,
            canAutoExecute: false,
            requiresHuman: true,
            pauseReason: 'DENIAL',
            proposalReasoning: reasoning,
            logs: [...logs, `Unanswered clarification detected (msg #${lastClarificationId}) — responding to original question instead of treating as denial`],
            nextNode: 'draft_response'
          };
        }
      }

      // Resolve denial subtype: prefer state, fallback to latest analysis
      let resolvedSubtype = denialSubtype;
      if (!resolvedSubtype) {
        const latestAnalysis = await db.getLatestResponseAnalysis(caseId);
        resolvedSubtype = latestAnalysis?.full_analysis_json?.denial_subtype || null;
      }
      reasoning.push(`Denial subtype: ${resolvedSubtype || 'unknown'}`);

      switch (resolvedSubtype) {
        case 'no_records': {
          // "No responsive records" — may be wrong agency or request needs reformulation
          if (!caseData.contact_research_notes) {
            reasoning.push('No prior agency research — proposing RESEARCH_AGENCY (may be wrong PD)');
            return {
              proposalActionType: RESEARCH_AGENCY,
              canAutoExecute: false,
              requiresHuman: true,
              pauseReason: 'DENIAL',
              proposalReasoning: reasoning,
              logs: [...logs, 'No records denial — researching correct agency'],
              nextNode: 'draft_response'
            };
          } else {
            reasoning.push('Agency already researched — proposing REFORMULATE_REQUEST (narrow/different angle)');
            return {
              proposalActionType: REFORMULATE_REQUEST,
              canAutoExecute: false,
              requiresHuman: true,
              pauseReason: 'DENIAL',
              proposalReasoning: reasoning,
              logs: [...logs, 'No records denial — reformulating request'],
              nextNode: 'draft_response'
            };
          }
        }

        case 'wrong_agency': {
          reasoning.push('Agency explicitly said "not us" — proposing RESEARCH_AGENCY');
          return {
            proposalActionType: RESEARCH_AGENCY,
            canAutoExecute: false,
            requiresHuman: true,
            pauseReason: 'DENIAL',
            proposalReasoning: reasoning,
            logs: [...logs, 'Wrong agency denial — researching correct agency'],
            nextNode: 'draft_response'
          };
        }

        case 'overly_broad': {
          reasoning.push('Request too broad — proposing REFORMULATE_REQUEST (narrow scope)');
          return {
            proposalActionType: REFORMULATE_REQUEST,
            canAutoExecute: false,
            requiresHuman: true,
            pauseReason: 'DENIAL',
            proposalReasoning: reasoning,
            logs: [...logs, 'Overly broad denial — reformulating with narrower scope'],
            nextNode: 'draft_response'
          };
        }

        case 'ongoing_investigation':
        case 'privacy_exemption': {
          // Challenge the exemption with legal arguments — unless unchallengeable
          const denialStrength = await assessDenialStrength(caseData);
          reasoning.push(`Exemption-based denial (${resolvedSubtype}), strength: ${denialStrength}`);

          if (denialStrength === 'strong') {
            reasoning.push('Strong/unchallengeable denial — recommending CLOSE_CASE for human decision');
            return {
              proposalActionType: CLOSE_CASE,
              canAutoExecute: false,
              requiresHuman: true,
              pauseReason: 'DENIAL',
              gateOptions: ['APPROVE', 'ADJUST', 'DISMISS'],
              proposalReasoning: reasoning,
              logs: [...logs, `Strong exemption denial (${resolvedSubtype}) — recommending case closure`],
              nextNode: 'gate_or_execute'
            };
          }

          const canAuto = autopilotMode === 'AUTO' && denialStrength === 'weak';
          return {
            proposalActionType: SEND_REBUTTAL,
            canAutoExecute: canAuto,
            requiresHuman: !canAuto,
            pauseReason: canAuto ? null : 'DENIAL',
            proposalReasoning: reasoning,
            logs: [...logs, `Exemption denial (${resolvedSubtype}) — drafting rebuttal`],
            nextNode: 'draft_response'
          };
        }

        case 'excessive_fees': {
          reasoning.push('Excessive fees cited as denial — proposing NEGOTIATE_FEE');
          return {
            proposalActionType: NEGOTIATE_FEE,
            canAutoExecute: false,
            requiresHuman: true,
            pauseReason: 'FEE_QUOTE',
            proposalReasoning: reasoning,
            logs: [...logs, 'Fee-based denial — negotiating fees'],
            nextNode: 'draft_response'
          };
        }

        case 'retention_expired': {
          reasoning.push('Records retention expired — nothing to retrieve, escalating to human');
          return {
            proposalActionType: ESCALATE,
            canAutoExecute: false,
            requiresHuman: true,
            pauseReason: 'DENIAL',
            proposalReasoning: reasoning,
            logs: [...logs, 'Retention expired — escalating for human decision'],
            nextNode: 'gate_or_execute'
          };
        }

        default: {
          // Unknown or null subtype — fall back to existing denial strength logic
          const denialStrength = await assessDenialStrength(caseData);
          reasoning.push(`Unknown subtype, denial strength: ${denialStrength} — using legacy routing`);

          if (denialStrength === 'strong' && autopilotMode !== 'AUTO') {
            reasoning.push('Strong unchallengeable denial — recommending CLOSE_CASE for human decision');
            return {
              proposalActionType: CLOSE_CASE,
              canAutoExecute: false,
              requiresHuman: true,
              pauseReason: 'DENIAL',
              gateOptions: ['APPROVE', 'ADJUST', 'DISMISS'],
              proposalReasoning: reasoning,
              logs: [...logs, 'Strong denial — recommending case closure'],
              nextNode: 'gate_or_execute'
            };
          }

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
            reasoning.push('Medium denial or supervised mode, gating for human review');
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
      await db.updateCase(caseId, { outcome_type: 'full_approval', outcome_recorded: new Date() });
      return {
        isComplete: true,
        proposalActionType: NONE,
        proposalReasoning: reasoning,
        logs: [...logs, 'Case completed: records ready']
      };
    }

    if (classification === 'ACKNOWLEDGMENT') {
      reasoning.push('Acknowledgment received, no action needed — reverting to awaiting_response');
      // Revert status: processInboundEmail sets every inbound to 'responded', but an
      // acknowledgment isn't a substantive response. Reset so the case doesn't look stuck.
      await db.updateCaseStatus(caseId, 'awaiting_response');
      return {
        isComplete: true,
        proposalActionType: NONE,
        proposalReasoning: reasoning,
        logs: [...logs, 'Acknowledgment received, status reset to awaiting_response']
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

    // NEW: Wrong agency — route to RESEARCH_AGENCY if response suggests where to go
    if (classification === 'WRONG_AGENCY') {
      if (requiresResponse) {
        reasoning.push('Wrong agency with redirect info — proposing RESEARCH_AGENCY to find correct custodian');
        return {
          proposalActionType: RESEARCH_AGENCY,
          canAutoExecute: false,
          requiresHuman: true,
          pauseReason: 'DENIAL',
          proposalReasoning: reasoning,
          logs: [...logs, 'Wrong agency — researching correct agency'],
          nextNode: 'draft_response'
        };
      }
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
      await db.updateCaseStatus(caseId, 'awaiting_response');
      return {
        isComplete: true,
        proposalActionType: NONE,
        proposalReasoning: reasoning,
        logs: [...logs, 'Partial delivery received, status reset to awaiting_response']
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
      canAutoExecute: false,
      requiresHuman: true,
      pauseReason: 'SENSITIVE',
      nextNode: 'gate_or_execute',  // Explicit routing prevents stale nextNode from prior run
      proposalReasoning: [`Error during decision: ${error.message}`, 'Escalating to human review']
    };
  }
}

module.exports = { decideNextActionNode };
