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
    // Fetch message and case data for analysis
    const message = await db.getMessageById(latestInboundMessageId);
    const caseData = await db.getCaseById(caseId);

    if (!message) {
      return {
        errors: [`Message ${latestInboundMessageId} not found`],
        classification: 'UNKNOWN',
        classificationConfidence: 0
      };
    }

    // DETERMINISTIC MODE: Use stubbed classification if provided
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

      // Save stubbed analysis to DB (for consistency)
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

    // Use existing AI analysis
    const analysis = await aiService.analyzeResponse(message, caseData);

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
    // Default to true for safety if not specified
    const requiresResponse = analysis.requires_response !== undefined
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

    return {
      classification,
      classificationConfidence: analysis.confidence_score || analysis.confidence || 0.8,
      sentiment: analysis.sentiment || 'neutral',
      extractedFeeAmount: feeAmount,
      extractedDeadline: analysis.extracted_deadline || analysis.deadline,
      requiresResponse,
      portalUrl,
      suggestedAction: analysis.suggested_action || null,
      reasonNoResponse: analysis.reason_no_response || null,
      logs: [
        `Classified as ${classification} (confidence: ${analysis.confidence_score || analysis.confidence}), ` +
        `sentiment: ${analysis.sentiment}, ` +
        `requires_response: ${requiresResponse}, ` +
        `fee: ${feeAmount || 'none'}`
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
