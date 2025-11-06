-- Migration: Add tables for FOIA Case Agent
-- Created: 2025-11-07
-- Description: Adds agent_decisions and escalations tables for autonomous agent system

-- Agent Decisions Table
-- Stores the reasoning and decisions made by the FOIA agent for learning and debugging
CREATE TABLE IF NOT EXISTS agent_decisions (
    id SERIAL PRIMARY KEY,
    case_id INTEGER NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
    reasoning TEXT NOT NULL,
    action_taken TEXT NOT NULL,
    confidence DECIMAL(3,2) DEFAULT 0.80,
    trigger_type VARCHAR(50),
    outcome VARCHAR(50),
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_agent_decisions_case_id ON agent_decisions(case_id);
CREATE INDEX idx_agent_decisions_created_at ON agent_decisions(created_at DESC);

-- Escalations Table
-- Tracks cases that need human review
CREATE TABLE IF NOT EXISTS escalations (
    id SERIAL PRIMARY KEY,
    case_id INTEGER NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
    reason TEXT NOT NULL,
    urgency VARCHAR(20) DEFAULT 'medium' CHECK (urgency IN ('low', 'medium', 'high')),
    suggested_action TEXT,
    status VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending', 'in_review', 'resolved', 'dismissed')),
    resolved_by VARCHAR(255),
    resolved_at TIMESTAMP,
    resolution_notes TEXT,
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_escalations_case_id ON escalations(case_id);
CREATE INDEX idx_escalations_status ON escalations(status);
CREATE INDEX idx_escalations_urgency ON escalations(urgency);
CREATE INDEX idx_escalations_created_at ON escalations(created_at DESC);

-- Add new status options to cases table for agent workflow
-- First check if the type exists
DO $$
BEGIN
    -- We're not using a custom type, status is just TEXT in cases table
    -- So we don't need to alter anything, just documenting new statuses:
    -- 'needs_human_review' - Agent escalated to human
    -- 'pending_fee_decision' - Waiting for fee payment decision
    -- 'needs_rebuttal' - Denial received, preparing rebuttal
END $$;

-- Add substatus column to cases for more granular tracking
ALTER TABLE cases
ADD COLUMN IF NOT EXISTS substatus VARCHAR(100),
ADD COLUMN IF NOT EXISTS escalation_reason TEXT,
ADD COLUMN IF NOT EXISTS agent_handled BOOLEAN DEFAULT false;

-- Create view for pending escalations dashboard
CREATE OR REPLACE VIEW pending_escalations AS
SELECT
    e.id as escalation_id,
    e.case_id,
    c.case_name,
    c.agency_name,
    c.state,
    e.reason,
    e.urgency,
    e.suggested_action,
    e.created_at,
    COUNT(m.id) as message_count,
    c.status as case_status
FROM escalations e
JOIN cases c ON e.case_id = c.id
LEFT JOIN messages m ON m.case_id = c.id
WHERE e.status = 'pending'
GROUP BY e.id, e.case_id, c.case_name, c.agency_name, c.state, e.reason, e.urgency, e.suggested_action, e.created_at, c.status
ORDER BY
    CASE e.urgency
        WHEN 'high' THEN 1
        WHEN 'medium' THEN 2
        WHEN 'low' THEN 3
    END,
    e.created_at DESC;

-- Create view for agent performance metrics
CREATE OR REPLACE VIEW agent_performance AS
SELECT
    DATE(ad.created_at) as decision_date,
    ad.action_taken,
    COUNT(*) as decision_count,
    AVG(ad.confidence) as avg_confidence,
    COUNT(CASE WHEN ad.outcome = 'success' THEN 1 END) as successful_outcomes,
    COUNT(CASE WHEN ad.outcome = 'failure' THEN 1 END) as failed_outcomes
FROM agent_decisions ad
GROUP BY DATE(ad.created_at), ad.action_taken
ORDER BY decision_date DESC, decision_count DESC;

-- Grant permissions (if using specific user)
-- GRANT ALL PRIVILEGES ON agent_decisions TO your_db_user;
-- GRANT ALL PRIVILEGES ON escalations TO your_db_user;

-- Completion message
DO $$
BEGIN
    RAISE NOTICE 'Agent tables created successfully!';
    RAISE NOTICE 'Tables added: agent_decisions, escalations';
    RAISE NOTICE 'Views added: pending_escalations, agent_performance';
END $$;
