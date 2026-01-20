/**
 * Classify Inbound Node
 *
 * Analyzes inbound message and classifies intent.
 * Uses aiService.analyzeResponse() with structured constraint extraction.
 */

const aiService = require('../../services/ai-service');
const db = require('../../services/database');
const logger = require('../../utils/logger');

/**
 * Analyze inbound message and classify intent
 */
async function classifyInboundNode(state) {
  const { caseId, latestInboundMessageId, triggerType } = state;

  // Skip classification for time-based triggers (no new message)
  if (triggerType === 'time_based_followup') {
    return {
      classification: 'NO_RESPONSE',
      classificationConfidence: 1.0,
      logs: ['Skipped classification: time-based trigger (no new message)']
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

    // Use existing AI analysis
    const analysis = await aiService.analyzeResponse(message, caseData);

    // Map intent to our classification enum
    const classificationMap = {
      'fee_request': 'FEE_QUOTE',
      'denial': 'DENIAL',
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
