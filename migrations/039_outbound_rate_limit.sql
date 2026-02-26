-- Migration 039: Index for outbound rate limiting
-- Enables fast lookup of recent outbound executions per case
CREATE INDEX IF NOT EXISTS idx_executions_outbound_rate
  ON executions (case_id, created_at DESC)
  WHERE status IN ('QUEUED', 'SENT');
