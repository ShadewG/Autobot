-- Fix J: One active run per case
-- Prevents multiple agent runs from executing simultaneously for the same case.
-- Only one run in 'created', 'queued', or 'running' status per case at a time.
CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_runs_one_active_per_case
ON agent_runs (case_id) WHERE status IN ('created', 'queued', 'running');

-- Fix N: One thread per case
-- Prevents duplicate email threads from being created for the same case.
CREATE UNIQUE INDEX IF NOT EXISTS idx_email_threads_case_id_unique
ON email_threads (case_id);
