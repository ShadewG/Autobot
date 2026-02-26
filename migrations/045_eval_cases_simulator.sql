-- 045_eval_cases_simulator.sql
-- Add simulation-sourced eval cases: store the simulated message + AI output
-- directly on eval_cases so the eval runner can score them without a real proposal.

ALTER TABLE eval_cases
    ADD COLUMN IF NOT EXISTS simulated_message_body     TEXT,
    ADD COLUMN IF NOT EXISTS simulated_from_email       VARCHAR(255),
    ADD COLUMN IF NOT EXISTS simulated_subject          VARCHAR(500),
    ADD COLUMN IF NOT EXISTS simulated_predicted_action VARCHAR(50),
    ADD COLUMN IF NOT EXISTS simulated_reasoning        JSONB,
    ADD COLUMN IF NOT EXISTS simulated_draft_body       TEXT;

-- Allow proposal_id to be null for simulator-sourced rows.
-- The existing UNIQUE(proposal_id) allows multiple NULLs in PostgreSQL, so no change needed.

-- Index for filtering simulator-sourced rows (proposal_id IS NULL).
CREATE INDEX IF NOT EXISTS idx_eval_cases_no_proposal
    ON eval_cases(created_at DESC)
    WHERE proposal_id IS NULL AND is_active = true;
