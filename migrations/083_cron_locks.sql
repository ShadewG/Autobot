-- Deduplicate cron job execution across Railway replicas.
-- Each cron tick claims a slot by inserting a unique key (job:minute).
-- ON CONFLICT DO NOTHING ensures only one instance wins.

CREATE TABLE IF NOT EXISTS cron_locks (
    lock_key TEXT PRIMARY KEY,
    acquired_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_cron_locks_acquired_at ON cron_locks (acquired_at);
