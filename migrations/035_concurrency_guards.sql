-- Fix J: One active run per case
-- Prevents multiple agent runs from executing simultaneously for the same case.
-- Only one run in 'created', 'queued', or 'running' status per case at a time.
-- Pre-cleanup: expire any duplicate active runs (keep the most recent per case)
UPDATE agent_runs SET status = 'failed', ended_at = NOW(), error = 'Expired by migration 035: duplicate active run'
WHERE id IN (
  SELECT id FROM (
    SELECT id, ROW_NUMBER() OVER (PARTITION BY case_id ORDER BY started_at DESC NULLS LAST, id DESC) AS rn
    FROM agent_runs WHERE status IN ('created', 'queued', 'running')
  ) sub WHERE rn > 1
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_runs_one_active_per_case
ON agent_runs (case_id) WHERE status IN ('created', 'queued', 'running');

-- Fix N: One thread per case
-- Prevents duplicate email threads from being created for the same case.
-- Pre-cleanup: remove duplicate threads (keep the most recent per case)
DELETE FROM email_threads WHERE id IN (
  SELECT id FROM (
    SELECT id, ROW_NUMBER() OVER (PARTITION BY case_id ORDER BY updated_at DESC NULLS LAST, created_at DESC) AS rn
    FROM email_threads
  ) sub WHERE rn > 1
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_email_threads_case_id_unique
ON email_threads (case_id);
