-- Migration: 015_proposals_table.sql
-- Description: Add proposals table for LangGraph agent workflow
-- CRITICAL: Uses proposal_key for idempotency (P0 fix #2)

-- Proposals table for NextActionProposal
CREATE TABLE IF NOT EXISTS proposals (
    id SERIAL PRIMARY KEY,
    case_id INTEGER REFERENCES cases(id) ON DELETE CASCADE,

    -- IDEMPOTENCY KEY (P0 fix): deterministic key for upsert
    -- Format: {case_id}:{trigger_message_id}:{action_type}:{attempt}
    proposal_key VARCHAR(255) NOT NULL,

    -- Proposal content
    action_type VARCHAR(50) NOT NULL,  -- SEND_FOLLOWUP, SEND_REBUTTAL, SEND_CLARIFICATION, APPROVE_FEE, ESCALATE, SUBMIT_PORTAL, etc.
    trigger_message_id INTEGER,  -- The inbound message that triggered this proposal (null for time-based)
    draft_subject TEXT,
    draft_body_text TEXT,
    draft_body_html TEXT,

    -- Reasoning
    reasoning JSONB,  -- Array of reasoning steps
    confidence DECIMAL(3,2),
    risk_flags TEXT[],
    warnings TEXT[],

    -- Execution control
    can_auto_execute BOOLEAN DEFAULT false,
    requires_human BOOLEAN DEFAULT true,

    -- Status lifecycle
    status VARCHAR(50) DEFAULT 'DRAFT',  -- DRAFT, PENDING_APPROVAL, APPROVED, EXECUTED, SUPERSEDED, REJECTED, DISMISSED

    -- EXECUTION IDEMPOTENCY (P0 fix #3)
    execution_key VARCHAR(255),  -- Set when execution starts, prevents duplicate sends
    email_job_id VARCHAR(255),          -- BullMQ job ID if email was queued

    -- Human interaction
    approved_by VARCHAR(255),
    approved_at TIMESTAMP WITH TIME ZONE,
    adjustment_instruction TEXT,
    adjustment_count INTEGER DEFAULT 0,  -- Tracks re-draft attempts

    -- LangGraph tracking
    langgraph_thread_id VARCHAR(255),
    langgraph_checkpoint_id VARCHAR(255),

    -- Human decision
    human_decision VARCHAR(50),  -- APPROVE, ADJUST, DISMISS, WITHDRAW
    human_decided_at TIMESTAMP WITH TIME ZONE,
    human_decided_by VARCHAR(255),

    -- Timestamps
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    executed_at TIMESTAMP WITH TIME ZONE
);

-- Add missing columns if table already exists (idempotent)
DO $$
BEGIN
    -- Add execution_key if not exists
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'proposals' AND column_name = 'execution_key') THEN
        ALTER TABLE proposals ADD COLUMN execution_key VARCHAR(255);
    END IF;

    -- Add email_job_id if not exists
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'proposals' AND column_name = 'email_job_id') THEN
        ALTER TABLE proposals ADD COLUMN email_job_id VARCHAR(255);
    END IF;

    -- Add human_decision columns if not exists
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'proposals' AND column_name = 'human_decision') THEN
        ALTER TABLE proposals ADD COLUMN human_decision VARCHAR(50);
    END IF;

    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'proposals' AND column_name = 'human_decided_at') THEN
        ALTER TABLE proposals ADD COLUMN human_decided_at TIMESTAMP WITH TIME ZONE;
    END IF;

    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'proposals' AND column_name = 'human_decided_by') THEN
        ALTER TABLE proposals ADD COLUMN human_decided_by VARCHAR(255);
    END IF;

    -- Add adjustment_count if not exists
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'proposals' AND column_name = 'adjustment_count') THEN
        ALTER TABLE proposals ADD COLUMN adjustment_count INTEGER DEFAULT 0;
    END IF;
END $$;

-- Add unique constraints (idempotent)
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'proposals_proposal_key_key') THEN
        ALTER TABLE proposals ADD CONSTRAINT proposals_proposal_key_key UNIQUE (proposal_key);
    END IF;
EXCEPTION WHEN duplicate_table THEN
    NULL;
END $$;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'proposals_execution_key_key') THEN
        ALTER TABLE proposals ADD CONSTRAINT proposals_execution_key_key UNIQUE (execution_key);
    END IF;
EXCEPTION WHEN duplicate_table THEN
    NULL;
END $$;

-- Indexes for proposals (safe - IF NOT EXISTS)
CREATE INDEX IF NOT EXISTS idx_proposals_case_id ON proposals(case_id);
CREATE INDEX IF NOT EXISTS idx_proposals_status ON proposals(status);
CREATE INDEX IF NOT EXISTS idx_proposals_thread_id ON proposals(langgraph_thread_id);
CREATE INDEX IF NOT EXISTS idx_proposals_key ON proposals(proposal_key);

-- Create execution_key index only if column exists
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'proposals' AND column_name = 'execution_key') THEN
        CREATE INDEX IF NOT EXISTS idx_proposals_execution_key ON proposals(execution_key);
    END IF;
END $$;

-- Add langgraph_thread_id to cases table
ALTER TABLE cases ADD COLUMN IF NOT EXISTS langgraph_thread_id VARCHAR(255);
CREATE INDEX IF NOT EXISTS idx_cases_langgraph_thread_id ON cases(langgraph_thread_id);

-- Add constraints and scope_items columns if not exists
ALTER TABLE cases ADD COLUMN IF NOT EXISTS constraints TEXT[] DEFAULT '{}';
ALTER TABLE cases ADD COLUMN IF NOT EXISTS scope_items JSONB DEFAULT '[]';

-- Escalations table for ESCALATE action type
CREATE TABLE IF NOT EXISTS escalations (
    id SERIAL PRIMARY KEY,
    case_id INTEGER REFERENCES cases(id) ON DELETE CASCADE,

    -- IDEMPOTENCY KEY
    execution_key VARCHAR(255) UNIQUE,

    -- Escalation details
    reason TEXT NOT NULL,
    urgency VARCHAR(20) DEFAULT 'medium',  -- low, medium, high, critical
    suggested_action TEXT,

    -- Status
    status VARCHAR(50) DEFAULT 'OPEN',  -- OPEN, IN_PROGRESS, RESOLVED, DISMISSED
    resolution TEXT,
    resolved_at TIMESTAMP WITH TIME ZONE,
    resolved_by VARCHAR(255),

    -- Timestamps
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Indexes for escalations
CREATE INDEX IF NOT EXISTS idx_escalations_case_id ON escalations(case_id);
CREATE INDEX IF NOT EXISTS idx_escalations_status ON escalations(status);
CREATE INDEX IF NOT EXISTS idx_escalations_execution_key ON escalations(execution_key);

-- Add last_followup_sent_at to follow_up_schedule if not exists
ALTER TABLE follow_up_schedule ADD COLUMN IF NOT EXISTS last_followup_sent_at TIMESTAMP WITH TIME ZONE;

-- Add unique constraint on case_id for follow_up_schedule (for upsert)
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'follow_up_schedule_case_id_key'
    ) THEN
        -- Only create if no existing constraint
        BEGIN
            ALTER TABLE follow_up_schedule ADD CONSTRAINT follow_up_schedule_case_id_key UNIQUE (case_id);
        EXCEPTION WHEN unique_violation THEN
            -- If duplicate values exist, we can't add the constraint
            RAISE NOTICE 'Cannot add unique constraint on follow_up_schedule.case_id due to duplicates';
        END;
    END IF;
END $$;
