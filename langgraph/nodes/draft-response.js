/**
 * Draft Response Node
 *
 * Drafts the appropriate response based on proposalActionType.
 * Handles: SEND_FOLLOWUP, SEND_REBUTTAL, SEND_CLARIFICATION, APPROVE_FEE
 */

const aiService = require('../../services/ai-service');
const db = require('../../services/database');
const logger = require('../../services/logger');

/**
 * Draft the appropriate response based on proposalActionType
 */
async function draftResponseNode(state) {
  const {
    caseId, proposalActionType, constraints, scopeItems,
    extractedFeeAmount, adjustmentInstruction: stateAdjustmentInstruction,
    llmStubs
  } = state;

  const logs = [];

  try {
    // DETERMINISTIC MODE: Use stubbed draft if provided
    if (llmStubs?.draft) {
      const stub = llmStubs.draft;
      logger.info('Using stubbed draft for E2E testing', { caseId, stub });
      logs.push(`[STUBBED] Draft created from test stub`);

      return {
        draftSubject: stub.subject || `[Stubbed] Response for ${proposalActionType}`,
        draftBodyText: stub.body || stub.body_text || 'Stubbed response body',
        draftBodyHtml: stub.body_html || null,
        logs
      };
    }

    const caseData = await db.getCaseById(caseId);
    const messages = await db.getMessagesByCaseId(caseId);
    const latestInbound = messages.filter(m => m.direction === 'inbound').pop();
    const latestAnalysis = latestInbound ?
      await db.getResponseAnalysisByMessageId(latestInbound.id) : null;

    let draft = { subject: null, body_text: null, body_html: null };

    // Read adjustment instruction from state (set by decideNextActionNode on ADJUST)
    // This is the single source of truth - don't read from humanDecision
    const adjustmentInstruction = stateAdjustmentInstruction || null;

    if (adjustmentInstruction) {
      logs.push(`Applying adjustment: ${adjustmentInstruction}`);
    }

    switch (proposalActionType) {
      case 'SEND_FOLLOWUP': {
        const followupSchedule = await db.getFollowUpScheduleByCaseId(caseId);
        const attemptNumber = (followupSchedule?.followup_count || 0) + 1;

        logs.push(`Drafting follow-up #${attemptNumber}`);

        // Use existing generateFollowUp method
        draft = await aiService.generateFollowUp(caseData, attemptNumber, {
          adjustmentInstruction
        });
        break;
      }

      case 'SEND_REBUTTAL': {
        logs.push('Drafting denial rebuttal with legal research');

        // Validate against constraints - don't request exempt items
        const exemptItems = (constraints || []).filter(c => c.endsWith('_EXEMPT'));

        draft = await aiService.generateDenialRebuttal(
          latestInbound,
          latestAnalysis,
          caseData,
          {
            excludeItems: exemptItems,
            scopeItems,
            adjustmentInstruction
          }
        );
        break;
      }

      case 'SEND_CLARIFICATION': {
        logs.push('Drafting clarification response');

        // Check if generateClarificationResponse exists, otherwise use generateAutoReply
        if (typeof aiService.generateClarificationResponse === 'function') {
          draft = await aiService.generateClarificationResponse(
            latestInbound,
            latestAnalysis,
            caseData,
            { adjustmentInstruction }
          );
        } else {
          // Fallback to generateAutoReply
          draft = await aiService.generateAutoReply(
            latestInbound,
            latestAnalysis,
            caseData
          );
          if (adjustmentInstruction && draft.body_text) {
            // Prepend adjustment note
            draft.body_text = `[Adjusted per instruction: ${adjustmentInstruction}]\n\n${draft.body_text}`;
          }
        }
        break;
      }

      case 'APPROVE_FEE':
      case 'ACCEPT_FEE': {
        logs.push(`Drafting fee acceptance for $${extractedFeeAmount}`);

        // Use generateFeeResponse with 'accept' action
        draft = await aiService.generateFeeResponse(
          caseData,
          {
            feeAmount: extractedFeeAmount,
            recommendedAction: 'accept',
            instructions: adjustmentInstruction
          }
        );
        break;
      }

      case 'NEGOTIATE_FEE': {
        logs.push(`Drafting fee negotiation for $${extractedFeeAmount}`);

        // Use generateFeeResponse with 'negotiate' action
        draft = await aiService.generateFeeResponse(
          caseData,
          {
            feeAmount: extractedFeeAmount,
            recommendedAction: 'negotiate',
            instructions: adjustmentInstruction
          }
        );
        break;
      }

      case 'DECLINE_FEE': {
        logs.push(`Drafting fee decline for $${extractedFeeAmount}`);

        // Use generateFeeResponse with 'decline' action
        draft = await aiService.generateFeeResponse(
          caseData,
          {
            feeAmount: extractedFeeAmount,
            recommendedAction: 'decline',
            instructions: adjustmentInstruction
          }
        );
        break;
      }

      case 'ESCALATE': {
        // No draft needed for escalation
        logs.push('No draft needed for escalation action');
        return { logs };
      }

      case 'NONE': {
        logs.push('No draft needed - no action required');
        return { logs };
      }

      default:
        logs.push(`Unknown action type: ${proposalActionType}`);
        return {
          errors: [`Unknown proposal action type: ${proposalActionType}`],
          logs
        };
    }

    // Ensure draft has all fields
    if (!draft.body_html && draft.body_text) {
      // Convert text to simple HTML
      draft.body_html = `<p>${draft.body_text.replace(/\n\n/g, '</p><p>').replace(/\n/g, '<br>')}</p>`;
    }

    return {
      draftSubject: draft.subject,
      draftBodyText: draft.body_text,
      draftBodyHtml: draft.body_html,
      logs: [...logs, `Draft created: "${(draft.subject || '').substring(0, 50)}..."`]
    };

  } catch (error) {
    logger.error('draft_response_node error', { caseId, error: error.message });
    return {
      errors: [`Draft failed: ${error.message}`],
      logs
    };
  }
}

module.exports = { draftResponseNode };
