function normalizeStoredValue(value) {
  return value == null ? null : value;
}

function buildOriginalDraftInsertFields({ draftSubject = null, draftBodyText = null } = {}) {
  return {
    originalDraftSubject: normalizeStoredValue(draftSubject),
    originalDraftBodyText: normalizeStoredValue(draftBodyText),
    humanEdited: false,
  };
}

function buildApprovalDraftUpdates(proposal, { draft_subject = undefined, draft_body_text = undefined } = {}) {
  const currentSubject = normalizeStoredValue(proposal?.draft_subject);
  const currentBody = normalizeStoredValue(proposal?.draft_body_text);
  const originalSubject = proposal?.original_draft_subject == null
    ? currentSubject
    : normalizeStoredValue(proposal.original_draft_subject);
  const originalBody = proposal?.original_draft_body_text == null
    ? currentBody
    : normalizeStoredValue(proposal.original_draft_body_text);

  const nextSubject = draft_subject === undefined ? currentSubject : normalizeStoredValue(draft_subject);
  const nextBody = draft_body_text === undefined ? currentBody : normalizeStoredValue(draft_body_text);

  const subjectChanged = draft_subject !== undefined && nextSubject !== currentSubject;
  const bodyChanged = draft_body_text !== undefined && nextBody !== currentBody;

  if (!subjectChanged && !bodyChanged) {
    return {};
  }

  const updates = {};

  if (proposal?.original_draft_subject == null && currentSubject != null) {
    updates.original_draft_subject = currentSubject;
  }
  if (proposal?.original_draft_body_text == null && currentBody != null) {
    updates.original_draft_body_text = currentBody;
  }

  if (subjectChanged) {
    updates.draft_subject = nextSubject;
  }
  if (bodyChanged) {
    updates.draft_body_text = nextBody;
    updates.draft_body_html = null;
  }

  updates.human_edited = nextSubject !== originalSubject || nextBody !== originalBody;

  return updates;
}

module.exports = {
  buildApprovalDraftUpdates,
  buildOriginalDraftInsertFields,
};
