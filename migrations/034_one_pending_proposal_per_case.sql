-- Enforce at most one PENDING_APPROVAL proposal per case at the database level.
-- This prevents race conditions where two code paths both check-then-insert
-- proposals for the same case simultaneously.
CREATE UNIQUE INDEX IF NOT EXISTS idx_proposals_one_pending_per_case
    ON proposals (case_id)
    WHERE status = 'PENDING_APPROVAL';
