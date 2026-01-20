-- Migration: 017_reliability_constraints.sql
-- Description: Ship-ready guardrails - unique constraints for idempotency

-- ============================================================================
-- UNIQUE CONSTRAINTS FOR IDEMPOTENCY
-- ============================================================================

-- auto_reply_queue.execution_key should be unique when set
-- Already added in 016, but ensure it's a proper unique constraint
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'auto_reply_queue_execution_key_unique'
    ) THEN
        ALTER TABLE auto_reply_queue
        ADD CONSTRAINT auto_reply_queue_execution_key_unique
        UNIQUE (execution_key);
    END IF;
EXCEPTION WHEN duplicate_object THEN
    NULL; -- constraint already exists
END $$;

-- proposals.proposal_key should be unique
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'proposals_proposal_key_unique'
    ) THEN
        ALTER TABLE proposals
        ADD CONSTRAINT proposals_proposal_key_unique
        UNIQUE (proposal_key);
    END IF;
EXCEPTION WHEN duplicate_object THEN
    NULL;
END $$;

-- proposals.execution_key should be unique when set
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'proposals_execution_key_unique'
    ) THEN
        ALTER TABLE proposals
        ADD CONSTRAINT proposals_execution_key_unique
        UNIQUE (execution_key);
    END IF;
EXCEPTION WHEN duplicate_object THEN
    NULL;
END $$;

-- ============================================================================
-- STUCK LOCK/RUN TRACKING COLUMNS
-- ============================================================================

-- Add lock_expires_at column to agent_runs for TTL tracking
ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS lock_expires_at TIMESTAMP WITH TIME ZONE;

-- Add stale detection columns
ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS heartbeat_at TIMESTAMP WITH TIME ZONE;
ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS recovery_attempted BOOLEAN DEFAULT false;
ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS recovered_by_reaper BOOLEAN DEFAULT false;

-- Index for finding stuck runs efficiently
CREATE INDEX IF NOT EXISTS idx_agent_runs_stuck_detection
ON agent_runs(status, started_at)
WHERE status = 'running';

-- Index for finding runs needing heartbeat
CREATE INDEX IF NOT EXISTS idx_agent_runs_heartbeat
ON agent_runs(heartbeat_at)
WHERE status = 'running';

-- ============================================================================
-- DEAD LETTER QUEUE TABLE
-- ============================================================================

CREATE TABLE IF NOT EXISTS dead_letter_queue (
    id SERIAL PRIMARY KEY,
    queue_name VARCHAR(100) NOT NULL,
    job_id VARCHAR(255) NOT NULL,
    job_name VARCHAR(100),
    job_data JSONB NOT NULL,
    error_message TEXT,
    error_stack TEXT,
    attempt_count INTEGER DEFAULT 0,
    original_job_id VARCHAR(255),
    case_id INTEGER REFERENCES cases(id) ON DELETE SET NULL,
    agent_run_id INTEGER REFERENCES agent_runs(id) ON DELETE SET NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    processed_at TIMESTAMP WITH TIME ZONE,
    resolution VARCHAR(50) DEFAULT 'pending', -- pending, retried, discarded, manual
    resolution_notes TEXT
);

CREATE INDEX IF NOT EXISTS idx_dlq_queue_name ON dead_letter_queue(queue_name);
CREATE INDEX IF NOT EXISTS idx_dlq_case_id ON dead_letter_queue(case_id);
CREATE INDEX IF NOT EXISTS idx_dlq_resolution ON dead_letter_queue(resolution);
CREATE INDEX IF NOT EXISTS idx_dlq_created_at ON dead_letter_queue(created_at);

-- ============================================================================
-- REAPER AUDIT LOG
-- ============================================================================

CREATE TABLE IF NOT EXISTS reaper_audit_log (
    id SERIAL PRIMARY KEY,
    reaper_type VARCHAR(50) NOT NULL, -- lock_reaper, run_reaper
    target_type VARCHAR(50) NOT NULL, -- agent_run, advisory_lock
    target_id VARCHAR(255),
    case_id INTEGER REFERENCES cases(id) ON DELETE SET NULL,
    action_taken VARCHAR(50) NOT NULL, -- released, marked_stale, notified
    details JSONB,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_reaper_audit_type ON reaper_audit_log(reaper_type);
CREATE INDEX IF NOT EXISTS idx_reaper_audit_created ON reaper_audit_log(created_at);

-- ============================================================================
-- REPLAY/DRY-RUN SUPPORT
-- ============================================================================

-- Add replay tracking to agent_runs
ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS is_replay BOOLEAN DEFAULT false;
ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS replay_of_run_id INTEGER REFERENCES agent_runs(id);
ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS dry_run BOOLEAN DEFAULT false;

-- Add diff storage for replay comparison
ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS replay_diff JSONB;

-- ============================================================================
-- IDEMPOTENCY HELPER FUNCTIONS
-- ============================================================================

-- Function to safely claim an execution slot (returns true if claimed, false if already claimed)
CREATE OR REPLACE FUNCTION claim_execution_slot(
    p_table TEXT,
    p_id INTEGER,
    p_execution_key TEXT
) RETURNS BOOLEAN AS $$
DECLARE
    claimed BOOLEAN := FALSE;
BEGIN
    IF p_table = 'auto_reply_queue' THEN
        UPDATE auto_reply_queue
        SET execution_key = p_execution_key
        WHERE id = p_id
          AND execution_key IS NULL
          AND status IN ('pending', 'approved');
        claimed := FOUND;
    ELSIF p_table = 'proposals' THEN
        UPDATE proposals
        SET execution_key = p_execution_key
        WHERE id = p_id
          AND execution_key IS NULL
          AND status NOT IN ('EXECUTED', 'BLOCKED');
        claimed := FOUND;
    END IF;
    RETURN claimed;
END;
$$ LANGUAGE plpgsql;
