-- 041_eval_cases_fixes.sql
-- Fix indexes and constraints for eval tables per Codex review

-- 1. Replace separate single-column indexes with a composite index
--    for the LATERAL "latest run per case" query pattern.
DROP INDEX IF EXISTS idx_eval_runs_eval_case_id;
DROP INDEX IF EXISTS idx_eval_runs_ran_at;
CREATE INDEX IF NOT EXISTS idx_eval_runs_eval_case_id_ran_at ON eval_runs(eval_case_id, ran_at DESC);

-- 2. Replace low-selectivity boolean index with a partial index
--    that covers the only query pattern used (active cases, ordered by date).
DROP INDEX IF EXISTS idx_eval_cases_is_active;
CREATE INDEX IF NOT EXISTS idx_eval_cases_active_created ON eval_cases(created_at DESC) WHERE is_active = true;

-- 3. Enforce failure_category to known values only
--    (prevents typos from silently poisoning the failure breakdown dashboard)
ALTER TABLE eval_runs
    ADD CONSTRAINT IF NOT EXISTS eval_runs_failure_category_check
    CHECK (failure_category IS NULL OR failure_category IN (
        'WRONG_CLASSIFICATION',
        'WRONG_ROUTING',
        'THRESHOLD_ERROR',
        'DRAFT_QUALITY',
        'POLICY_VIOLATION',
        'CONTEXT_MISSED',
        'UNKNOWN'
    ));

-- 4. Make eval_case_id NOT NULL (orphan rows are useless)
ALTER TABLE eval_runs
    ALTER COLUMN eval_case_id SET NOT NULL;

-- 5. Add FK on trigger_message_id for referential integrity
ALTER TABLE eval_cases
    ADD CONSTRAINT IF NOT EXISTS eval_cases_trigger_message_id_fk
    FOREIGN KEY (trigger_message_id) REFERENCES messages(id) ON DELETE SET NULL;
