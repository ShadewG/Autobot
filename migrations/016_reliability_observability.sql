-- Migration: 016_reliability_observability.sql
-- Description: Add reliability, guardrails, and observability features
-- Deliverables 1, 3, 5 from implementation plan

-- ============================================================================
-- DELIVERABLE 1: Exactly-Once Execution (No Duplicate Emails)
-- ============================================================================

-- Add execution idempotency columns to auto_reply_queue
ALTER TABLE auto_reply_queue ADD COLUMN IF NOT EXISTS execution_key VARCHAR(255);
ALTER TABLE auto_reply_queue ADD COLUMN IF NOT EXISTS email_job_id VARCHAR(255);
ALTER TABLE auto_reply_queue ADD COLUMN IF NOT EXISTS executed_at TIMESTAMP WITH TIME ZONE;

-- Unique constraint on execution_key (only one execution per key)
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'auto_reply_queue_execution_key_key'
    ) THEN
        ALTER TABLE auto_reply_queue ADD CONSTRAINT auto_reply_queue_execution_key_key UNIQUE (execution_key);
    END IF;
END $$;

-- Index for faster execution_key lookups
CREATE INDEX IF NOT EXISTS idx_auto_reply_queue_execution_key ON auto_reply_queue(execution_key) WHERE execution_key IS NOT NULL;

-- ============================================================================
-- DELIVERABLE 3: Proposal Idempotency
-- ============================================================================

-- Add proposal_key column to auto_reply_queue for idempotent proposal creation
ALTER TABLE auto_reply_queue ADD COLUMN IF NOT EXISTS proposal_key VARCHAR(255);

-- Add action_type column for better proposal tracking
ALTER TABLE auto_reply_queue ADD COLUMN IF NOT EXISTS action_type VARCHAR(50) DEFAULT 'SEND_EMAIL';

-- Add blocked_reason column for policy violations
ALTER TABLE auto_reply_queue ADD COLUMN IF NOT EXISTS blocked_reason TEXT;

-- Add proposal_short column for UI display
ALTER TABLE auto_reply_queue ADD COLUMN IF NOT EXISTS proposal_short VARCHAR(255);

-- Unique partial index on proposal_key (allows nulls but unique when set)
CREATE UNIQUE INDEX IF NOT EXISTS idx_auto_reply_proposal_key
ON auto_reply_queue(proposal_key)
WHERE proposal_key IS NOT NULL;

-- ============================================================================
-- DELIVERABLE 5: Observability - agent_runs Table
-- ============================================================================

-- Create agent_runs table for tracking agent executions
CREATE TABLE IF NOT EXISTS agent_runs (
    id SERIAL PRIMARY KEY,
    case_id INTEGER NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
    trigger_type VARCHAR(50) NOT NULL,  -- inbound, cron_followup, resume, manual
    started_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    ended_at TIMESTAMP WITH TIME ZONE,
    status VARCHAR(50) DEFAULT 'running',  -- running, completed, failed, skipped_locked
    error TEXT,
    proposal_id INTEGER REFERENCES auto_reply_queue(id) ON DELETE SET NULL,
    lock_acquired BOOLEAN DEFAULT false,
    lock_key BIGINT,  -- Advisory lock key used
    metadata JSONB DEFAULT '{}'
);

-- Indexes for agent_runs
CREATE INDEX IF NOT EXISTS idx_agent_runs_case_id ON agent_runs(case_id);
CREATE INDEX IF NOT EXISTS idx_agent_runs_status ON agent_runs(status);
CREATE INDEX IF NOT EXISTS idx_agent_runs_started_at ON agent_runs(started_at);
CREATE INDEX IF NOT EXISTS idx_agent_runs_trigger_type ON agent_runs(trigger_type);

-- Add requires_human and pause_reason columns to cases if not exists
ALTER TABLE cases ADD COLUMN IF NOT EXISTS requires_human BOOLEAN DEFAULT false;
ALTER TABLE cases ADD COLUMN IF NOT EXISTS pause_reason VARCHAR(50);
ALTER TABLE cases ADD COLUMN IF NOT EXISTS autopilot_mode VARCHAR(20) DEFAULT 'SUPERVISED';
ALTER TABLE cases ADD COLUMN IF NOT EXISTS next_due_at TIMESTAMP WITH TIME ZONE;

-- Index for requires_human lookups
CREATE INDEX IF NOT EXISTS idx_cases_requires_human ON cases(requires_human) WHERE requires_human = true;

-- Add JSONB columns for richer proposal data
ALTER TABLE auto_reply_queue ADD COLUMN IF NOT EXISTS reasoning_jsonb JSONB;
ALTER TABLE auto_reply_queue ADD COLUMN IF NOT EXISTS warnings_jsonb JSONB;
ALTER TABLE auto_reply_queue ADD COLUMN IF NOT EXISTS constraints_applied_jsonb JSONB;

-- ============================================================================
-- Additional JSONB columns for dashboard data model
-- ============================================================================

ALTER TABLE activity_log ADD COLUMN IF NOT EXISTS meta_jsonb JSONB;
