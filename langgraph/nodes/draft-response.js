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
    caseId, proposalActionType, humanDecision, constraints, scopeItems,
    extractedFeeAmount
  } = state;

  const logs = [];

  try {
    const caseData = await db.getCaseById(caseId);
    const messages = await db.getMessagesByCaseId(caseId);
    const latestInbound = messages.filter(m => m.direction === 'inbound').pop();
    const latestAnalysis = latestInbound ?
      await db.getResponseAnalysisByMessageId(latestInbound.id) : null;

    let draft = { subject: null, body_text: null, body_html: null };

    // Check for adjustment instruction
    const adjustmentInstruction = humanDecision?.action === 'ADJUST' ?
      humanDecision.instruction : null;

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

      case 'APPROVE_FEE': {
        logs.push(`Drafting fee acceptance for $${extractedFeeAmount}`);

        // Check if generateFeeAcceptance exists
        if (typeof aiService.generateFeeAcceptance === 'function') {
          draft = await aiService.generateFeeAcceptance(
            caseData,
            extractedFeeAmount,
            { adjustmentInstruction }
          );
        } else {
          // Fallback: create a simple fee acceptance
          const subjectName = caseData.subject_name || 'the subject';
          draft = {
            subject: `RE: Fee Acceptance - Public Records Request - ${subjectName}`,
            body_text: `Thank you for your response regarding my public records request.\n\nI am writing to confirm my acceptance of the quoted fee of $${extractedFeeAmount}. Please let me know the preferred method of payment and where to submit it.\n\nThank you for your assistance.\n\nSincerely,\n${process.env.REQUESTER_NAME || 'Requester'}`,
            body_html: null
          };
        }
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
