/**
 * Load Context Node
 *
 * Fetches all context needed for decision-making:
 * - Case data
 * - Messages in thread
 * - Latest analysis
 * - Scheduled followups
 * - Existing pending proposal
 */

const db = require('../../services/database');
const logger = require('../../services/logger');

/**
 * Load all context needed for decision-making
 */
async function loadContextNode(state) {
  const { caseId, latestInboundMessageId } = state;

  try {
    // Fetch case details
    const caseData = await db.getCaseById(caseId);
    if (!caseData) {
      return {
        errors: [`Case ${caseId} not found`],
        isComplete: true
      };
    }

    // Fetch messages in thread
    const messages = await db.getMessagesByCaseId(caseId);

    // Fetch latest analysis if there's an inbound message
    let analysis = null;
    if (latestInboundMessageId) {
      analysis = await db.getResponseAnalysisByMessageId(latestInboundMessageId);
    }

    // Fetch scheduled followups
    const followups = await db.getFollowUpScheduleByCaseId(caseId);

    // Fetch existing pending proposal
    const existingProposal = await db.getLatestPendingProposal(caseId);

    // Extract constraints and scope from case data (use JSONB columns with fallbacks)
    const constraints = caseData.constraints_jsonb || caseData.constraints || [];
    let scopeItems = caseData.scope_items_jsonb || caseData.scope_items || [];

    // If no scope items but we have requested_records, generate and persist them
    if ((!scopeItems || scopeItems.length === 0) && caseData.requested_records) {
      const records = Array.isArray(caseData.requested_records)
        ? caseData.requested_records
        : [caseData.requested_records];
      scopeItems = records.map(r => ({
        name: typeof r === 'string' ? r : (r.name || r.description || JSON.stringify(r)),
        status: 'REQUESTED',
        reason: null,
        confidence: null
      }));

      // Persist to database so future loads use the JSONB column
      await db.updateCase(caseId, {
        scope_items_jsonb: JSON.stringify(scopeItems)
      });
      logger.info('Generated and persisted scope_items_jsonb from requested_records', { caseId, count: scopeItems.length });
    }

    return {
      // Store IDs/references, not full objects (fetch in nodes that need them)
      autopilotMode: caseData.autopilot_mode || 'SUPERVISED',
      constraints,
      scopeItems,
      proposalId: existingProposal?.id || null,
      proposalKey: existingProposal?.proposal_key || null,
      logs: [
        `Loaded context: ${messages.length} messages, ` +
        `${constraints.length} constraints, ` +
        `${scopeItems.length} scope items, ` +
        `autopilot=${caseData.autopilot_mode || 'SUPERVISED'}`
      ]
    };
  } catch (error) {
    logger.error('load_context_node error', { caseId, error: error.message });
    return {
      errors: [`Failed to load context: ${error.message}`],
      isComplete: true
    };
  }
}

module.exports = { loadContextNode };
