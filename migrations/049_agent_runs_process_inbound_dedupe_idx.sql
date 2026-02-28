-- Speed up process-inbound dedupe active-run lookup by case/message/trigger.
-- Active statuses are intentionally limited to in-flight states.

CREATE INDEX IF NOT EXISTS idx_agent_runs_process_inbound_active_dedupe
ON agent_runs (case_id, message_id, lower(trigger_type), started_at DESC)
WHERE status IN ('created', 'queued', 'processing', 'running', 'paused', 'waiting', 'gated');
