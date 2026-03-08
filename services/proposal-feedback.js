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

function normalizeInstructionText(instruction) {
  if (!instruction) return null;
  const normalized = String(instruction).replace(/\s+/g, " ").trim();
  if (!normalized) return null;
  return normalized.replace(/^["']+|["']+$/g, "");
}

function deriveAdjustCategory(proposal, instruction) {
  const corpus = `${proposal?.action_type || ""} ${instruction || ""}`.toLowerCase();
  if (/\bfee|cost|waiver|estimate|charge/.test(corpus)) return "fee";
  if (/\bportal|govqa|nextrequest|webform|submit\b/.test(corpus)) return "portal";
  if (/\bfollow[ -]?up\b/.test(corpus) || proposal?.action_type === "SEND_FOLLOWUP") return "followup";
  if (/\bdenial|appeal|rebuttal|exemption|privilege/.test(corpus)) return "denial";
  if (/\bbody[- ]?cam|bwc|video/.test(corpus)) return "bwc";
  return "general";
}

function deriveAdjustLesson(proposal, caseData, instruction, reason = null) {
  const normalized = normalizeInstructionText(instruction);
  if (!normalized) return null;
  const lower = normalized.toLowerCase();

  if (/don't be aggressive|do not be aggressive|less aggressive|more collaborative|softer tone|friendlier|less adversarial/.test(lower)) {
    return "Use a collaborative, non-aggressive tone unless the agency has clearly denied the request with cited authority.";
  }
  if (/\bshorter\b|\bshorten\b|\bmore concise\b|\btoo long\b|\bbrief\b/.test(lower)) {
    return "Keep the draft concise and remove unnecessary detail when a shorter response will accomplish the same goal.";
  }
  if (/remove the fee paragraph|don['’]t mention fee|do not mention fee|no fee paragraph/.test(lower)) {
    return "Do not mention fee language unless the agency has actually raised a fee issue or fee waiver question.";
  }
  if (/keep this as a pdf email|attached as a pdf|completed form is attached|completed request form/.test(lower)) {
    return "When the agency requests a completed form, keep the response as a PDF email and explicitly mention that the completed form is attached.";
  }
  if (/\bcall them\b|\bphone\b|manual follow-?up/.test(lower)) {
    return "When reliable phone contact is available and the human requests it, prefer a manual phone follow-up handoff instead of another automated email.";
  }

  const agencyName = caseData?.agency_name || "this agency";
  const suffix = reason ? ` (${reason})` : "";
  return `When handling ${proposal?.action_type || "this action"} for ${agencyName}, follow this human adjustment: ${normalized}${suffix}`;
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

    if (action === "ADJUST" && instruction) {
      await learnFromAdjust(proposal, { instruction, reason });
    }
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

async function learnFromAdjust(proposal, { instruction = null, reason = null } = {}) {
  try {
    if (!proposal?.id || !proposal?.action_type || !proposal?.case_id) return;
    const normalizedInstruction = normalizeInstructionText(instruction);
    if (!normalizedInstruction) return;

    const decisionMemory = require('./decision-memory-service');
    const caseData = await db.getCaseById(proposal.case_id);
    const lesson = deriveAdjustLesson(proposal, caseData, normalizedInstruction, reason);
    if (!lesson) return;

    await decisionMemory.learnFromOutcome({
      category: deriveAdjustCategory(proposal, normalizedInstruction),
      triggerPattern: `adjusted ${proposal.action_type} for ${caseData?.agency_name || 'unknown agency'}`,
      lesson,
      sourceCaseId: proposal.case_id,
      priority: 7,
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
  learnFromAdjust,
  learnFromDismiss,
  captureDismissFeedback,
  normalizeExpectedAction,
  buildNotes,
  deriveAdjustCategory,
  deriveAdjustLesson,
  normalizeInstructionText,
};
