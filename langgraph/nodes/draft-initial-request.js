/**
 * Draft Initial Request Node
 *
 * Generates the initial FOIA request for a case.
 * Uses AI service to draft based on case details.
 *
 * Part of: Initial Request Graph
 */

const db = require('../../services/database');
const aiService = require('../../services/ai-service');
const logger = require('../../services/logger');

/**
 * Generate proposal key for initial request
 */
function generateInitialRequestProposalKey(caseId) {
  return `${caseId}:initial:SEND_INITIAL_REQUEST:0`;
}

/**
 * Draft initial FOIA request node
 *
 * Inputs from state:
 * - caseId
 * - autopilotMode
 * - llmStubs (for testing)
 *
 * Outputs to state:
 * - proposalActionType: 'SEND_INITIAL_REQUEST'
 * - proposalKey
 * - draftSubject
 * - draftBodyText
 * - draftBodyHtml
 * - proposalReasoning
 */
async function draftInitialRequestNode(state) {
  const { caseId, autopilotMode, llmStubs, runId } = state;
  const logs = [];
  const errors = [];

  try {
    logs.push('Drafting initial FOIA request');

    // Load case data
    const caseData = await db.getCaseById(caseId);
    if (!caseData) {
      throw new Error(`Case ${caseId} not found`);
    }

    logs.push(`Case: ${caseData.case_name}, Agency: ${caseData.agency_name}`);

    // Generate proposal key for idempotency
    const proposalKey = generateInitialRequestProposalKey(caseId);

    // Check if proposal already exists (idempotency)
    const existingProposal = await db.getProposalByKey(proposalKey);
    if (existingProposal) {
      logs.push(`Using existing proposal: ${existingProposal.id}`);
      return {
        proposalId: existingProposal.id,
        proposalKey,
        proposalActionType: 'SEND_INITIAL_REQUEST',
        draftSubject: existingProposal.draft_subject,
        draftBodyText: existingProposal.draft_body_text,
        draftBodyHtml: existingProposal.draft_body_html,
        proposalReasoning: existingProposal.reasoning || [],
        canAutoExecute: existingProposal.can_auto_execute,
        requiresHuman: existingProposal.requires_human,
        logs
      };
    }

    // Generate request using AI service (or stub for testing)
    let draftResult;
    if (llmStubs?.draft_initial) {
      logs.push('Using LLM stub for draft');
      draftResult = llmStubs.draft_initial;
    } else {
      draftResult = await aiService.generateFOIARequest(caseData);
    }

    // Guard: AI service returned nothing
    if (!draftResult || typeof draftResult !== 'object') {
      throw new Error(`AI returned null/invalid result for case ${caseId}`);
    }

    // Build subject line
    const subject = draftResult.subject ||
      `Public Records Request - ${caseData.subject_name || 'Records Request'}`;

    // Build body text
    const bodyText = draftResult.body || draftResult.requestText || draftResult.request_text;

    if (!bodyText || typeof bodyText !== 'string' || !bodyText.trim()) {
      throw new Error(`AI returned empty/invalid body for case ${caseId} — draftResult keys: ${Object.keys(draftResult).join(', ')}`);
    }

    const bodyHtml = draftResult.body_html || `<div style="font-family: Arial, sans-serif;">${bodyText.replace(/\n/g, '<br>')}</div>`;

    // Reasoning
    const reasoning = [
      `Generated initial FOIA request for ${caseData.agency_name}`,
      `Subject: ${caseData.subject_name || 'N/A'}`,
      `Requested records: ${(caseData.requested_records || []).join(', ') || 'Various records'}`,
      `Autopilot mode: ${autopilotMode}`
    ];

    // Determine if can auto-execute
    // Initial requests typically require human approval unless in full AUTO mode
    const canAutoExecute = autopilotMode === 'AUTO';
    const requiresHuman = !canAutoExecute;
    const pauseReason = requiresHuman ? 'INITIAL_REQUEST' : null;

    // Create proposal record (use upsertProposal to write to proposals table, not legacy auto_reply_queue)
    const proposal = await db.upsertProposal({
      proposalKey,
      caseId,
      runId,
      triggerMessageId: null,
      actionType: 'SEND_INITIAL_REQUEST',
      draftSubject: subject,
      draftBodyText: bodyText,
      draftBodyHtml: bodyHtml,
      reasoning,
      canAutoExecute,
      requiresHuman,
      status: requiresHuman ? 'PENDING_APPROVAL' : 'DRAFT'
    });

    logs.push(`Created proposal ${proposal.id} with key ${proposalKey}`);

    return {
      proposalId: proposal.id,
      proposalKey,
      proposalActionType: 'SEND_INITIAL_REQUEST',
      draftSubject: subject,
      draftBodyText: bodyText,
      draftBodyHtml: bodyHtml,
      proposalReasoning: reasoning,
      canAutoExecute,
      requiresHuman,
      pauseReason,
      logs
    };

  } catch (error) {
    logger.error('draft_initial_request_node error', { caseId, error: error.message });
    errors.push(`Draft failed: ${error.message}`);
    return {
      errors,
      logs: [...logs, `Error: ${error.message}`],
      requiresHuman: true,
      pauseReason: 'SENSITIVE'
    };
  }
}

module.exports = { draftInitialRequestNode };
