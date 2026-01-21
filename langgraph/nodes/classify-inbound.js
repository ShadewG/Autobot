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
        requiresAction: true,
        suggestedAction: stub.suggested_action || null,
        fullAnalysisJson: { stubbed: true, ...stub }
      });

      logger.info('Stubbed classification normalized', {
        caseId,
        original: stub.classification,
        normalized: normalizedClassification
      });

      return {
        classification: normalizedClassification,
        classificationConfidence: stub.confidence || 0.95,
        sentiment: stub.sentiment || 'neutral',
        extractedFeeAmount: feeAmount,
        extractedDeadline: stub.deadline || null,
        logs: [
          `[STUBBED] Classified as ${normalizedClassification} (confidence: ${stub.confidence || 0.95}), ` +
          `sentiment: ${stub.sentiment || 'neutral'}, ` +
          `fee: ${feeAmount ?? 'none'}`
        ]
      };
    }

    // Use existing AI analysis
    const analysis = await aiService.analyzeResponse(message, caseData);

    // Map intent to our classification enum
    const classificationMap = {
      'fee_request': 'FEE_QUOTE',
      'denial': 'DENIAL',
      'partial_denial': 'PARTIAL_APPROVAL',  // Some records approved, some denied
      'partial_approval': 'PARTIAL_APPROVAL',
      'partial_release': 'PARTIAL_APPROVAL',
      'acknowledgment': 'ACKNOWLEDGMENT',
      'delivery': 'RECORDS_READY',
      'more_info_needed': 'CLARIFICATION_REQUEST',
      'question': 'CLARIFICATION_REQUEST'
    };

    const classification = classificationMap[analysis.intent] || 'UNKNOWN';

    // Save analysis to DB
    await db.saveResponseAnalysis({
      messageId: latestInboundMessageId,
      caseId,
      intent: analysis.intent,
      confidenceScore: analysis.confidence_score,
      sentiment: analysis.sentiment,
      keyPoints: analysis.key_points,
      extractedDeadline: analysis.extracted_deadline,
      extractedFeeAmount: analysis.extracted_fee_amount,
      requiresAction: analysis.requires_action,
      suggestedAction: analysis.suggested_action,
      fullAnalysisJson: analysis
    });

    return {
      classification,
      classificationConfidence: analysis.confidence_score || 0.8,
      sentiment: analysis.sentiment || 'neutral',
      extractedFeeAmount: analysis.extracted_fee_amount,
      extractedDeadline: analysis.extracted_deadline,
      logs: [
        `Classified as ${classification} (confidence: ${analysis.confidence_score}), ` +
        `sentiment: ${analysis.sentiment}, ` +
        `fee: ${analysis.extracted_fee_amount || 'none'}`
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
