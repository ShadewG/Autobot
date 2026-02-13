/**
 * Draft Response Node
 *
 * Drafts the appropriate response based on proposalActionType.
 * Handles: SEND_FOLLOWUP, SEND_REBUTTAL, SEND_CLARIFICATION, APPROVE_FEE
 */

const aiService = require('../../services/ai-service');
const db = require('../../services/database');
const logger = require('../../services/logger');
const decisionMemory = require('../../services/decision-memory-service');

/**
 * Draft the appropriate response based on proposalActionType
 */
async function draftResponseNode(state) {
  const {
    caseId, proposalActionType, constraints, scopeItems,
    extractedFeeAmount, adjustmentInstruction: stateAdjustmentInstruction,
    llmStubs,
    latestInboundMessageId
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

    // Prefer the inbound message that triggered this run
    let latestInbound = null;
    let latestAnalysis = null;
    if (latestInboundMessageId) {
      latestInbound = await db.getMessageById(latestInboundMessageId);
      latestAnalysis = latestInbound
        ? await db.getResponseAnalysisByMessageId(latestInboundMessageId)
        : null;
    }

    // Fallback to most recent inbound if trigger message missing
    if (!latestInbound) {
      const messages = await db.getMessagesByCaseId(caseId);
      latestInbound = messages.filter(m => m.direction === 'inbound').pop();
      latestAnalysis = latestInbound
        ? await db.getResponseAnalysisByMessageId(latestInbound.id)
        : null;
    }

    // --- Fetch decision memory lessons for AI context ---
    let lessonsContext = '';
    let lessonsApplied = [];
    try {
      const allMessages = await db.getMessagesByCaseId(caseId);
      const priorProposals = await db.getAllProposalsByCaseId(caseId);
      const followupSchedule = await db.getFollowUpScheduleByCaseId(caseId);

      // Enrich caseData with followup_count (lives on follow_up_schedule table)
      const enrichedCaseData = {
        ...caseData,
        followup_count: followupSchedule?.followup_count || 0
      };

      const lessons = await decisionMemory.getRelevantLessons(enrichedCaseData, {
        messages: allMessages,
        priorProposals
      });

      if (lessons.length > 0) {
        lessonsContext = decisionMemory.formatLessonsForPrompt(lessons);
        lessonsApplied = lessons.map(l => ({
          id: l.id,
          category: l.category,
          trigger: l.trigger_pattern,
          lesson: l.lesson,
          score: l.relevance_score,
          priority: l.priority
        }));
        logs.push(`Injected ${lessons.length} decision lessons into draft context`);
      }
    } catch (lessonErr) {
      logger.warn('Failed to fetch decision lessons for draft', { caseId, error: lessonErr.message });
    }

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
          adjustmentInstruction,
          lessonsContext
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
            adjustmentInstruction,
            lessonsContext
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
            { adjustmentInstruction, lessonsContext }
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
            instructions: adjustmentInstruction,
            lessonsContext
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
            instructions: adjustmentInstruction,
            lessonsContext
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
            instructions: adjustmentInstruction,
            lessonsContext
          }
        );
        break;
      }

      case 'RESPOND_PARTIAL_APPROVAL': {
        logs.push('Drafting partial approval response (accept released + challenge withheld)');

        // Check if generatePartialApprovalResponse exists, otherwise use generateDenialRebuttal
        // with partial approval context
        if (typeof aiService.generatePartialApprovalResponse === 'function') {
          draft = await aiService.generatePartialApprovalResponse(
            latestInbound,
            latestAnalysis,
            caseData,
            {
              feeAmount: extractedFeeAmount,
              adjustmentInstruction,
              lessonsContext
            }
          );
        } else {
          // Fallback: Use denial rebuttal generator with partial approval instructions
          const partialApprovalInstructions = `
This is a PARTIAL APPROVAL response. The agency is releasing some records but withholding others.
Your response should:
1. Thank them for the partial release and accept any associated fee for the released records
2. Ask for a detailed list of what records are being withheld and the specific statutory basis for each
3. Request release of non-exempt portions with appropriate redactions (segregability)
4. If applicable, request rolling/phased production of approved records while withheld items are reviewed
${adjustmentInstruction ? `\nAdditional instruction: ${adjustmentInstruction}` : ''}
          `.trim();

          draft = await aiService.generateDenialRebuttal(
            latestInbound,
            latestAnalysis,
            caseData,
            {
              scopeItems,
              adjustmentInstruction: partialApprovalInstructions,
              lessonsContext
            }
          );
        }
        break;
      }

      case 'RESEARCH_AGENCY': {
        logs.push('Running agency research (pd-contact lookup + AI brief)');

        let contactResult = null;
        try {
          const pdContactService = require('../../services/pd-contact-service');
          contactResult = await pdContactService.lookupContact(
            caseData.agency_name,
            caseData.state || caseData.incident_location
          );
        } catch (e) {
          logs.push(`PD-contact lookup unavailable: ${e.message}`);
        }

        const brief = await aiService.generateAgencyResearchBrief(caseData);

        // Store research results on case
        await db.updateCase(caseId, {
          contact_research_notes: JSON.stringify({ contactResult, brief }),
          last_contact_research_at: new Date()
        });

        // No email draft — proposal with research findings for human review
        return {
          draftSubject: null,
          draftBodyText: null,
          lessonsApplied,
          proposalReasoning: [...(state.proposalReasoning || []),
            `Research findings: ${brief.summary}`,
            contactResult ? `PD Contact found: ${contactResult.contact_email || contactResult.portal_url}` : 'No PD contact data found'
          ],
          logs: [...logs, 'Agency research complete — findings attached to proposal']
        };
      }

      case 'REFORMULATE_REQUEST': {
        logs.push('Generating reformulated FOIA request');

        const latestAnalysisForReform = await db.getLatestResponseAnalysis(caseId);
        const reformulated = await aiService.generateReformulatedRequest(caseData, latestAnalysisForReform);

        // Draft is a new FOIA request, not a reply
        return {
          draftSubject: reformulated.subject,
          draftBodyText: reformulated.body_text,
          draftBodyHtml: reformulated.body_html || null,
          lessonsApplied,
          logs: [...logs, 'Reformulated request generated']
        };
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
      lessonsApplied,
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
