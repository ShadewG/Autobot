-- Migration: 058_proposal_original_draft_history.sql
-- Description: Preserve the original AI draft before human edits overwrite proposal content

ALTER TABLE proposals
  ADD COLUMN IF NOT EXISTS original_draft_subject TEXT,
  ADD COLUMN IF NOT EXISTS original_draft_body_text TEXT,
  ADD COLUMN IF NOT EXISTS human_edited BOOLEAN NOT NULL DEFAULT FALSE;

UPDATE proposals
SET original_draft_subject = COALESCE(original_draft_subject, draft_subject),
    original_draft_body_text = COALESCE(original_draft_body_text, draft_body_text),
    human_edited = COALESCE(human_edited, FALSE)
WHERE original_draft_subject IS NULL
   OR original_draft_body_text IS NULL
   OR human_edited IS NULL;

COMMENT ON COLUMN proposals.original_draft_subject IS 'Initial AI-generated draft subject before any human edit overwrites the proposal.';
COMMENT ON COLUMN proposals.original_draft_body_text IS 'Initial AI-generated draft body before any human edit overwrites the proposal.';
COMMENT ON COLUMN proposals.human_edited IS 'True when the final approved draft differs from the original AI draft.';
