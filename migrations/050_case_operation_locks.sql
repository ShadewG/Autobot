-- Per-case operation locks with TTL semantics.
-- Used by reset/replay APIs to prevent concurrent reset_to_last_inbound operations.

CREATE TABLE IF NOT EXISTS case_operation_locks (
  case_id INTEGER NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  operation TEXT NOT NULL,
  lock_token UUID NOT NULL,
  holder_run_id INTEGER NULL REFERENCES agent_runs(id) ON DELETE SET NULL,
  holder_metadata JSONB NULL DEFAULT '{}'::jsonb,
  acquired_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (case_id, operation)
);

CREATE INDEX IF NOT EXISTS idx_case_operation_locks_expires_at
  ON case_operation_locks (expires_at);
