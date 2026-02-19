/**
 * Classify Inbound Node
 *
 * Analyzes inbound message and classifies intent.
 * Uses aiService.analyzeResponse() with structured constraint extraction.
 */

const aiService = require('../../services/ai-service');
const db = require('../../services/database');
const logger = require('../../services/logger');

/**
 * Analyze inbound message and classify intent
 */
async function classifyInboundNode(state) {
  const { caseId, latestInboundMessageId, triggerType, llmStubs } = state;

  // Skip classification for time-based/scheduled triggers (no new message)
  if (triggerType === 'time_based_followup' || triggerType === 'SCHEDULED_FOLLOWUP' || triggerType === 'followup_trigger') {
    return {
      classification: 'NO_RESPONSE',
      classificationConfidence: 1.0,
      logs: [`Skipped classification: ${triggerType} trigger (no new message)`]
    };
  }

  // Skip classification for human review resolution (action comes from human, not message)
  if (triggerType === 'HUMAN_REVIEW_RESOLUTION') {
    return {
      classification: 'HUMAN_REVIEW_RESOLUTION',
      classificationConfidence: 1.0,
      logs: [`Skipped classification: human review resolution (reviewAction=${state.reviewAction})`]
    };
  }

  // Skip if no inbound message
  if (!latestInboundMessageId) {
    return {
      classification: 'NO_RESPONSE',
      classificationConfidence: 1.0,
      logs: ['Skipped classification: no inbound message ID']
    };
  }

  try {
    // DETERMINISTIC MODE: Use stubbed classification if provided
    // Check stubs BEFORE message fetch to allow testing without real data
    if (llmStubs?.classify) {
      const stub = llmStubs.classify;
      logger.info('Using stubbed classification for E2E testing', { caseId, stub });

      // Ensure fee_amount is a number (not string)
      const feeAmount = stub.fee_amount != null ? Number(stub.fee_amount) : null;

      // Normalize classification to uppercase (e.g., 'clarification_request' -> 'CLARIFICATION_REQUEST')
      // This ensures stubbed tests match the expected format used in decide-next-action
      const normalizedClassification = stub.classification?.toUpperCase() || 'UNKNOWN';

      // Extract requires_response - default to true for safety
      const stubRequiresResponse = stub.requires_response !== undefined
        ? stub.requires_response
        : true;

      // Save stubbed analysis to DB (for consistency) — skip if message doesn't exist
      try {
        await db.saveResponseAnalysis({
          messageId: latestInboundMessageId,
          caseId,
          intent: stub.classification?.toLowerCase().replace('_', '_') || 'unknown',
          confidenceScore: stub.confidence || 0.95,
          sentiment: stub.sentiment || 'neutral',
          keyPoints: stub.key_points || [],
          extractedDeadline: stub.deadline || null,
          extractedFeeAmount: feeAmount,
          requiresAction: stubRequiresResponse,
          suggestedAction: stub.suggested_action || null,
          portalUrl: stub.portal_url || null,
          fullAnalysisJson: { stubbed: true, ...stub }
        });
      } catch (dbErr) {
        // Non-fatal: stub data may reference non-existent message in testing
        logger.warn('Could not save stubbed analysis to DB', { caseId, error: dbErr.message });
      }

      logger.info('Stubbed classification normalized', {
        caseId,
        original: stub.classification,
        normalized: normalizedClassification,
        requiresResponse: stubRequiresResponse
      });

      return {
        classification: normalizedClassification,
        classificationConfidence: stub.confidence || 0.95,
        sentiment: stub.sentiment || 'neutral',
        extractedFeeAmount: feeAmount,
        extractedDeadline: stub.deadline || null,
        denialSubtype: stub.denial_subtype || null,
        // NEW: Pass through requires_response and portal_url to state
        requiresResponse: stubRequiresResponse,
        portalUrl: stub.portal_url || null,
        suggestedAction: stub.suggested_action || null,
        reasonNoResponse: stub.reason_no_response || null,
        logs: [
          `[STUBBED] Classified as ${normalizedClassification} (confidence: ${stub.confidence || 0.95}), ` +
          `sentiment: ${stub.sentiment || 'neutral'}, ` +
          `requires_response: ${stubRequiresResponse}, ` +
          `fee: ${feeAmount ?? 'none'}`
        ]
      };
    }

    // Fetch message and case data for analysis (non-stubbed path)
    const message = await db.getMessageById(latestInboundMessageId);
    const caseData = await db.getCaseById(caseId);

    if (!message) {
      return {
        errors: [`Message ${latestInboundMessageId} not found`],
        classification: 'UNKNOWN',
        classificationConfidence: 0
      };
    }

    // Pre-check: detect automated portal system emails and skip AI classification
    const fromAddr = (message.from_email || message.sender_email || '').toLowerCase();
    const subjectLower = (message.subject || '').toLowerCase();
    const bodySnippet = ((message.body_text || message.body_html || '').substring(0, 500)).toLowerCase();
    const portalSystems = ['justfoia', 'nextrequest', 'govqa', 'jotform', 'smartsheet'];
    const isPortalSystem = portalSystems.some(p => fromAddr.includes(p) || subjectLower.includes(p));
    const isNoReply = /no.?reply|do.?not.?reply/.test(fromAddr);
    const isConfirmationOrVerification =
        subjectLower.includes('verify') || subjectLower.includes('confirm your') ||
        subjectLower.includes('submission confirmation') || subjectLower.includes('request confirmation') ||
        subjectLower.includes('request received') || subjectLower.includes('thank you for submitting') ||
        bodySnippet.includes('verify your email') || bodySnippet.includes('confirm your email') ||
        bodySnippet.includes('confirm your account') || bodySnippet.includes('thank you for submitting') ||
        bodySnippet.includes('request has been received') || bodySnippet.includes('your request has been submitted') ||
        bodySnippet.includes('submission confirmation');

    if ((isPortalSystem || isNoReply) && isConfirmationOrVerification) {
      logger.info('Auto-classified as portal confirmation/verification email', { caseId, from: fromAddr, subject: message.subject });
      await db.saveResponseAnalysis({
        messageId: latestInboundMessageId, caseId,
        intent: 'acknowledgment', confidenceScore: 0.99, sentiment: 'neutral',
        keyPoints: ['Automated portal confirmation/verification email — no action needed'],
        requiresAction: false, suggestedAction: 'wait',
        fullAnalysisJson: { auto_classified: true, reason: 'portal_verification_email' }
      });
      return {
        classification: 'ACKNOWLEDGMENT', classificationConfidence: 0.99,
        requiresResponse: false,
        logs: [`Auto-classified: portal verification email from ${fromAddr} — no action needed`]
      };
    }

    // Load full thread so GPT has conversation context
    const threadMessages = await db.getMessagesByCaseId(caseId);

    // Use existing AI analysis — with full thread context
    const analysis = await aiService.analyzeResponse(message, caseData, { threadMessages });

    // Map intent to our classification enum
    // CANONICAL INTENT LIST (sync with prompts/response-handling-prompts.js)
    // Intent precedence: fee_request > question > portal_redirect > records_ready
    const classificationMap = {
      // Blocking intents (require response)
      'fee_request': 'FEE_QUOTE',                    // Fee must be accepted/declined
      'question': 'CLARIFICATION_REQUEST',           // Agency asking us something
      'more_info_needed': 'CLARIFICATION_REQUEST',   // Alias for question
      'hostile': 'HOSTILE',                          // Hostile response, needs escalation
      'denial': 'DENIAL',                            // Request denied
      'partial_denial': 'PARTIAL_APPROVAL',          // Some records approved, some denied
      'partial_approval': 'PARTIAL_APPROVAL',
      'partial_release': 'PARTIAL_APPROVAL',
      // Non-blocking intents (no response needed)
      'portal_redirect': 'PORTAL_REDIRECT',          // Must use portal instead
      'acknowledgment': 'ACKNOWLEDGMENT',            // Just wait
      'records_ready': 'RECORDS_READY',              // Download available, no action needed
      'delivery': 'RECORDS_READY',                   // Alias for records_ready
      'partial_delivery': 'PARTIAL_DELIVERY',        // Some records delivered
      'wrong_agency': 'WRONG_AGENCY',                // Wrong custodian
      'other': 'UNKNOWN'
    };

    const classification = classificationMap[analysis.intent] || 'UNKNOWN';

    // Extract requires_response - this is the key field from prompt tuning
    // Default to true for safety if not specified (let — may be overridden by unanswered question check)
    let requiresResponse = analysis.requires_response !== undefined
      ? analysis.requires_response
      : (analysis.requires_action !== false);

    // Extract portal_url (single canonical field)
    const portalUrl = analysis.portal_url || null;
    const feeAmount = analysis.fee_amount || null;

    // Save analysis to DB
    await db.saveResponseAnalysis({
      messageId: latestInboundMessageId,
      caseId,
      intent: analysis.intent,
      confidenceScore: analysis.confidence_score || analysis.confidence,
      sentiment: analysis.sentiment,
      keyPoints: analysis.key_points,
      extractedDeadline: analysis.extracted_deadline || analysis.deadline,
      extractedFeeAmount: feeAmount,
      requiresAction: requiresResponse,
      suggestedAction: analysis.suggested_action,
      portalUrl: portalUrl,
      fullAnalysisJson: analysis
    });

    // Feature 2: Log fee quote event
    if (feeAmount != null) {
      try {
        await db.logFeeEvent(caseId, 'quote_received', Number(feeAmount), `Fee quote detected in inbound message`, latestInboundMessageId);
      } catch (feeErr) {
        logger.warn('Failed to log fee event', { caseId, error: feeErr.message });
      }
    }

    // If GPT detected an unanswered agency question, override requires_response
    const unansweredQuestion = analysis.unanswered_agency_question || null;
    if (unansweredQuestion && !requiresResponse) {
      logger.info('GPT detected unanswered agency question — overriding requires_response to true', {
        caseId, unansweredQuestion
      });
      requiresResponse = true;
    }

    return {
      classification,
      classificationConfidence: analysis.confidence_score || analysis.confidence || 0.8,
      sentiment: analysis.sentiment || 'neutral',
      extractedFeeAmount: feeAmount,
      extractedDeadline: analysis.extracted_deadline || analysis.deadline,
      denialSubtype: analysis.denial_subtype || null,
      requiresResponse,
      portalUrl,
      suggestedAction: analysis.suggested_action || null,
      reasonNoResponse: analysis.reason_no_response || null,
      unansweredAgencyQuestion: unansweredQuestion,
      logs: [
        `Classified as ${classification} (confidence: ${analysis.confidence_score || analysis.confidence}), ` +
        `sentiment: ${analysis.sentiment}, ` +
        `requires_response: ${requiresResponse}, ` +
        `fee: ${feeAmount || 'none'}` +
        (unansweredQuestion ? `, unanswered_question: "${unansweredQuestion}"` : '')
      ]
    };
  } catch (error) {
    logger.error('classify_inbound_node error', { caseId, error: error.message });
    return {
      errors: [`Classification failed: ${error.message}`],
      classification: 'UNKNOWN',
      classificationConfidence: 0
    };
  }
}

module.exports = { classifyInboundNode };
