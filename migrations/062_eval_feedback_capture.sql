-- 062_eval_feedback_capture.sql
-- Add structured human feedback capture to eval cases

ALTER TABLE eval_cases
    ADD COLUMN IF NOT EXISTS source_action_type VARCHAR(50),
    ADD COLUMN IF NOT EXISTS capture_source VARCHAR(50),
    ADD COLUMN IF NOT EXISTS feedback_action VARCHAR(50),
    ADD COLUMN IF NOT EXISTS feedback_instruction TEXT,
    ADD COLUMN IF NOT EXISTS feedback_reason TEXT,
    ADD COLUMN IF NOT EXISTS feedback_decided_by VARCHAR(100);

CREATE INDEX IF NOT EXISTS idx_eval_cases_feedback_action_active
    ON eval_cases(feedback_action, created_at DESC)
    WHERE is_active = true;
