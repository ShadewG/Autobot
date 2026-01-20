-- Migration: 019_schema_completeness.sql
-- Description: Complete schema for end-to-end flow with idempotency + auditability
-- Adds missing columns to agent_runs, messages, proposals and creates executions + decision_traces

-- ============================================================================
-- 1.1 AGENT_RUNS TABLE COMPLETENESS (maps to "runs" in spec)
-- ============================================================================

-- Thread ID for LangGraph state isolation
ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS langgraph_thread_id VARCHAR(255);

-- Message ID that triggered this run (nullable for time-based triggers)
ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS message_id INTEGER REFERENCES messages(id) ON DELETE SET NULL;

-- Scheduled key for followup triggers (nullable)
ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS scheduled_key VARCHAR(255);

-- Autopilot mode snapshot at run start (immutable record of mode when run started)
ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS autopilot_mode VARCHAR(20);

-- Updated timestamp for tracking
ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW();

-- Indexes
CREATE INDEX IF NOT EXISTS idx_agent_runs_thread_id ON agent_runs(langgraph_thread_id);
CREATE INDEX IF NOT EXISTS idx_agent_runs_message_id ON agent_runs(message_id);

-- ============================================================================
-- 1.2 MESSAGES TABLE COMPLETENESS
-- ============================================================================

-- Processing tracking - when was this message processed by the agent
ALTER TABLE messages ADD COLUMN IF NOT EXISTS processed_at TIMESTAMP WITH TIME ZONE;

-- Which run processed this message (for auditability)
ALTER TABLE messages ADD COLUMN IF NOT EXISTS processed_run_id INTEGER REFERENCES agent_runs(id) ON DELETE SET NULL;

-- Last error if processing failed
ALTER TABLE messages ADD COLUMN IF NOT EXISTS last_error TEXT;

-- Provider message ID for deduplication (gmail msg id, etc)
-- Make sendgrid_message_id unique if we want inbound deduplication
-- NOTE: Only adding index, not unique constraint as sendgrid_message_id may have nulls/duplicates historically
CREATE INDEX IF NOT EXISTS idx_messages_sendgrid_id ON messages(sendgrid_message_id) WHERE sendgrid_message_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_messages_processed_at ON messages(processed_at);

-- ============================================================================
-- 1.3 PROPOSALS TABLE COMPLETENESS
-- ============================================================================

-- Link proposal to the run that created it
ALTER TABLE proposals ADD COLUMN IF NOT EXISTS run_id INTEGER REFERENCES agent_runs(id) ON DELETE SET NULL;

-- Pause reason (why human review is needed) - mirrors cases.pause_reason for proposal-level tracking
ALTER TABLE proposals ADD COLUMN IF NOT EXISTS pause_reason VARCHAR(50);

-- Router reasoning as explicit column (alias for clarity - uses existing 'reasoning' jsonb)
-- Adding comment for documentation
COMMENT ON COLUMN proposals.reasoning IS 'Router reasoning JSONB: includes classification, routing decision, risk assessment';

-- Index for run linkage
CREATE INDEX IF NOT EXISTS idx_proposals_run_id ON proposals(run_id);

-- ============================================================================
-- 1.4 EXECUTIONS TABLE (NEW)
-- Tracks actual execution attempts, separate from proposals
-- ============================================================================

CREATE TABLE IF NOT EXISTS executions (
    id SERIAL PRIMARY KEY,
    case_id INTEGER NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
    proposal_id INTEGER REFERENCES proposals(id) ON DELETE SET NULL,
    run_id INTEGER REFERENCES agent_runs(id) ON DELETE SET NULL,

    -- Idempotency key (unique execution attempt)
    execution_key VARCHAR(255) NOT NULL UNIQUE,

    -- What was executed
    action_type VARCHAR(50) NOT NULL,

    -- Execution status
    status VARCHAR(50) NOT NULL DEFAULT 'QUEUED',  -- QUEUED, SENT, SKIPPED, FAILED

    -- Provider info
    provider VARCHAR(50),  -- email, portal, none
    provider_payload JSONB,  -- message id, smtp response, portal response, etc.
    provider_message_id VARCHAR(255),  -- External ID from provider

    -- Error tracking
    error_message TEXT,
    retry_count INTEGER DEFAULT 0,

    -- Timestamps
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    completed_at TIMESTAMP WITH TIME ZONE
);

-- Indexes for executions
CREATE INDEX IF NOT EXISTS idx_executions_case_id ON executions(case_id);
CREATE INDEX IF NOT EXISTS idx_executions_proposal_id ON executions(proposal_id);
CREATE INDEX IF NOT EXISTS idx_executions_status ON executions(status);
CREATE INDEX IF NOT EXISTS idx_executions_provider ON executions(provider);
CREATE INDEX IF NOT EXISTS idx_executions_created_at ON executions(created_at);

-- ============================================================================
-- 1.5 DECISION_TRACES TABLE (NEW)
-- Captures classification, routing, and node trace for observability
-- ============================================================================

CREATE TABLE IF NOT EXISTS decision_traces (
    id SERIAL PRIMARY KEY,
    run_id INTEGER NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
    case_id INTEGER NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
    message_id INTEGER REFERENCES messages(id) ON DELETE SET NULL,

    -- Classification output
    classification JSONB,  -- { intent, confidence, sentiment, fee_amount, key_points, etc. }

    -- Router output
    router_output JSONB,  -- { action_type, can_auto_execute, requires_human, pause_reason }

    -- Node execution trace
    node_trace JSONB,  -- Array of nodes executed: ['load_context', 'classify_inbound', 'decide_next_action', ...]

    -- Gate decision
    gate_decision JSONB,  -- { gated: bool, pause_reason, gate_type }

    -- Timing
    started_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    completed_at TIMESTAMP WITH TIME ZONE,
    duration_ms INTEGER,

    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Indexes for decision_traces
CREATE INDEX IF NOT EXISTS idx_decision_traces_run_id ON decision_traces(run_id);
CREATE INDEX IF NOT EXISTS idx_decision_traces_case_id ON decision_traces(case_id);
CREATE INDEX IF NOT EXISTS idx_decision_traces_message_id ON decision_traces(message_id);
CREATE INDEX IF NOT EXISTS idx_decision_traces_created_at ON decision_traces(created_at);

-- ============================================================================
-- ENUM-LIKE CHECK CONSTRAINTS (soft enforcement via comments + app logic)
-- ============================================================================

-- Document expected values via comments
COMMENT ON COLUMN agent_runs.trigger_type IS 'Enum: initial_request, inbound_message, followup_trigger, resume, manual';
COMMENT ON COLUMN agent_runs.status IS 'Enum: created, running, paused, completed, failed, skipped_locked';
COMMENT ON COLUMN agent_runs.autopilot_mode IS 'Enum: AUTO, SUPERVISED';

COMMENT ON COLUMN proposals.action_type IS 'Enum: SEND_REBUTTAL, ACCEPT_FEE, NEGOTIATE_FEE, SEND_CLARIFICATION, SEND_FOLLOWUP, ESCALATE, SUBMIT_PORTAL, NONE';
COMMENT ON COLUMN proposals.status IS 'Enum: DRAFT, PENDING_APPROVAL, APPROVED, ADJUSTED, DISMISSED, WITHDRAWN, EXECUTED, FAILED, SUPERSEDED';
COMMENT ON COLUMN proposals.pause_reason IS 'Enum: FEE_QUOTE, DENIAL, SENSITIVE, SCOPE, CLOSE_ACTION';

COMMENT ON COLUMN executions.status IS 'Enum: QUEUED, SENT, SKIPPED, FAILED';
COMMENT ON COLUMN executions.provider IS 'Enum: email, portal, none';

-- ============================================================================
-- TRIGGER FOR updated_at
-- ============================================================================

-- Generic updated_at trigger function
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Apply to agent_runs
DROP TRIGGER IF EXISTS agent_runs_updated_at ON agent_runs;
CREATE TRIGGER agent_runs_updated_at
    BEFORE UPDATE ON agent_runs
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- Apply to executions
DROP TRIGGER IF EXISTS executions_updated_at ON executions;
CREATE TRIGGER executions_updated_at
    BEFORE UPDATE ON executions
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();
