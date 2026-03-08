ALTER TABLE eval_runs
    ADD COLUMN IF NOT EXISTS evaluation_type VARCHAR(50) NOT NULL DEFAULT 'decision_quality';

UPDATE eval_runs
SET evaluation_type = 'decision_quality'
WHERE evaluation_type IS NULL;

CREATE INDEX IF NOT EXISTS idx_eval_runs_eval_case_type_ran_at
    ON eval_runs(eval_case_id, evaluation_type, ran_at DESC);

COMMENT ON COLUMN eval_runs.evaluation_type IS 'decision_quality for action-selection evals; draft_quality for post-resolution draft scoring.';
