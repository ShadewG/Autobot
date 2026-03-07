const db = require('./database');

async function autoCaptureEvalCase(proposal, { action, instruction = null, reason = null, decidedBy = null } = {}) {
  try {
    if (!proposal?.id) return;
    const expectedAction = action === 'DISMISS' ? 'DISMISSED' : proposal.action_type;
    const notesParts = [
      `Auto-captured from monitor decision: ${action}`,
      instruction ? `Instruction: ${instruction}` : null,
      reason ? `Reason: ${reason}` : null,
      decidedBy ? `Decided by: ${decidedBy}` : null,
    ].filter(Boolean);

    await db.query(
      `INSERT INTO eval_cases (proposal_id, case_id, trigger_message_id, expected_action, notes)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (proposal_id) DO UPDATE
         SET expected_action = EXCLUDED.expected_action,
             notes = EXCLUDED.notes,
             is_active = true`,
      [
        proposal.id,
        proposal.case_id || null,
        proposal.trigger_message_id || null,
        expectedAction,
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
};
