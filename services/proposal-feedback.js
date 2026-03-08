const db = require('./database');

function normalizeExpectedAction(proposal, action, expectedAction) {
  if (expectedAction) return expectedAction;
  if (action === 'DISMISS') return 'DISMISSED';
  return proposal?.action_type || 'NONE';
}

function buildNotes({ action, instruction = null, reason = null, decidedBy = null } = {}) {
  return [
    `Auto-captured from monitor decision: ${action}`,
    instruction ? `Instruction: ${instruction}` : null,
    reason ? `Reason: ${reason}` : null,
    decidedBy ? `Decided by: ${decidedBy}` : null,
  ].filter(Boolean);
}

async function autoCaptureEvalCase(
  proposal,
  {
    action,
    instruction = null,
    reason = null,
    decidedBy = null,
    expectedAction = null,
    captureSource = 'human_review',
  } = {}
) {
  try {
    if (!proposal?.id) return;
    const normalizedExpectedAction = normalizeExpectedAction(proposal, action, expectedAction);
    const notesParts = buildNotes({ action, instruction, reason, decidedBy });

    await db.query(
      `INSERT INTO eval_cases (
          proposal_id,
          case_id,
          trigger_message_id,
          expected_action,
          source_action_type,
          capture_source,
          feedback_action,
          feedback_instruction,
          feedback_reason,
          feedback_decided_by,
          notes
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       ON CONFLICT (proposal_id) DO UPDATE
         SET expected_action = EXCLUDED.expected_action,
             source_action_type = EXCLUDED.source_action_type,
             capture_source = EXCLUDED.capture_source,
             feedback_action = EXCLUDED.feedback_action,
             feedback_instruction = EXCLUDED.feedback_instruction,
             feedback_reason = EXCLUDED.feedback_reason,
             feedback_decided_by = EXCLUDED.feedback_decided_by,
             notes = EXCLUDED.notes,
             is_active = true`,
      [
        proposal.id,
        proposal.case_id || null,
        proposal.trigger_message_id || null,
        normalizedExpectedAction,
        proposal.action_type || null,
        captureSource,
        action || null,
        instruction || null,
        reason || null,
        decidedBy || null,
        notesParts.join(' | ') || null,
      ]
    );
  } catch (err) {
    console.warn(`Auto eval-case capture failed for proposal ${proposal?.id}: ${err.message}`);
  }
}

async function learnFromDismiss(proposal, { reason = null } = {}) {
  try {
    if (!proposal?.id || !proposal?.action_type || !proposal?.case_id) return;
    const decisionMemory = require('./decision-memory-service');
    const caseData = await db.getCaseById(proposal.case_id);
    await decisionMemory.learnFromOutcome({
      category: 'general',
      triggerPattern: `dismissed ${proposal.action_type} for ${caseData?.agency_name || 'unknown agency'}`,
      lesson: `Do not propose ${proposal.action_type} for case #${proposal.case_id} (${caseData?.case_name || 'unknown'}) — it was dismissed by human reviewer.${reason ? ' Reason: ' + reason : ''}`,
      sourceCaseId: proposal.case_id,
      priority: 6,
    });
  } catch (_) {
    // Non-blocking
  }
}

async function captureDismissFeedback(proposal, { instruction = null, reason = null, decidedBy = null } = {}) {
  await autoCaptureEvalCase(proposal, {
    action: 'DISMISS',
    instruction,
    reason,
    decidedBy,
  });
  await learnFromDismiss(proposal, { reason });
}

module.exports = {
  autoCaptureEvalCase,
  learnFromDismiss,
  captureDismissFeedback,
  normalizeExpectedAction,
  buildNotes,
};
