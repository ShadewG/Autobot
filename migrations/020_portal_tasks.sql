-- Migration: 020_portal_tasks.sql
-- Description: Portal tasks table for manual portal submissions
-- Phase 4: Executor adapter with DRY/LIVE mode support

-- ============================================================================
-- PORTAL_TASKS TABLE
-- Tracks portal submissions that require manual human execution
-- ============================================================================

CREATE TABLE IF NOT EXISTS portal_tasks (
    id SERIAL PRIMARY KEY,
    case_id INTEGER NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
    execution_id INTEGER REFERENCES executions(id) ON DELETE SET NULL,
    proposal_id INTEGER REFERENCES proposals(id) ON DELETE SET NULL,

    -- Portal details
    portal_url TEXT,
    action_type VARCHAR(50) NOT NULL,

    -- Content to submit
    subject TEXT,
    body_text TEXT,
    body_html TEXT,
    instructions TEXT,

    -- Status tracking
    status VARCHAR(50) NOT NULL DEFAULT 'PENDING',  -- PENDING, IN_PROGRESS, COMPLETED, FAILED, CANCELLED
    assigned_to VARCHAR(255),  -- Who is working on this task

    -- Completion details
    completed_at TIMESTAMP WITH TIME ZONE,
    completed_by VARCHAR(255),
    completion_notes TEXT,
    confirmation_number VARCHAR(255),  -- Confirmation/reference from portal

    -- Timestamps
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_portal_tasks_case_id ON portal_tasks(case_id);
CREATE INDEX IF NOT EXISTS idx_portal_tasks_status ON portal_tasks(status);
CREATE INDEX IF NOT EXISTS idx_portal_tasks_created_at ON portal_tasks(created_at);
CREATE INDEX IF NOT EXISTS idx_portal_tasks_execution_id ON portal_tasks(execution_id);

-- Document expected values
COMMENT ON COLUMN portal_tasks.status IS 'Enum: PENDING, IN_PROGRESS, COMPLETED, FAILED, CANCELLED';
COMMENT ON COLUMN portal_tasks.action_type IS 'Action type: SEND_INITIAL_REQUEST, SEND_FOLLOWUP, etc.';

-- ============================================================================
-- EXECUTIONS TABLE UPDATE
-- Add PENDING_HUMAN status support
-- ============================================================================

-- Update status comment to include PENDING_HUMAN
COMMENT ON COLUMN executions.status IS 'Enum: QUEUED, SENT, SKIPPED, FAILED, PENDING_HUMAN';

-- ============================================================================
-- TRIGGER FOR updated_at
-- ============================================================================

DROP TRIGGER IF EXISTS portal_tasks_updated_at ON portal_tasks;
CREATE TRIGGER portal_tasks_updated_at
    BEFORE UPDATE ON portal_tasks
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();
