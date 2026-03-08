ALTER TABLE IF EXISTS executions ADD COLUMN IF NOT EXISTS failure_stage VARCHAR(100);
ALTER TABLE IF EXISTS executions ADD COLUMN IF NOT EXISTS failure_code VARCHAR(100);
ALTER TABLE IF EXISTS executions ADD COLUMN IF NOT EXISTS retryable BOOLEAN;
ALTER TABLE IF EXISTS executions ADD COLUMN IF NOT EXISTS retry_attempt INTEGER;

CREATE INDEX IF NOT EXISTS idx_executions_failure_stage
  ON executions(failure_stage, created_at DESC)
  WHERE failure_stage IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_executions_failure_code
  ON executions(failure_code, created_at DESC)
  WHERE failure_code IS NOT NULL;
