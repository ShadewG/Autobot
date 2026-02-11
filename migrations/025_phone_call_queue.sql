-- Migration 025: Phone Call Queue
-- Escalation path for email cases with no response after follow-ups exhausted

CREATE TABLE IF NOT EXISTS phone_call_queue (
    id SERIAL PRIMARY KEY,
    case_id INTEGER NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
    agency_name VARCHAR(255),
    agency_phone VARCHAR(50),
    agency_state VARCHAR(2),
    reason VARCHAR(100) NOT NULL DEFAULT 'no_email_response',
    status VARCHAR(50) NOT NULL DEFAULT 'pending',
    priority INTEGER DEFAULT 0,
    notes TEXT,
    days_since_sent INTEGER,
    assigned_to VARCHAR(255),
    claimed_at TIMESTAMP,
    completed_at TIMESTAMP,
    completed_by VARCHAR(255),
    call_outcome VARCHAR(100),
    call_notes TEXT,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_phone_call_queue_status ON phone_call_queue(status);
CREATE INDEX IF NOT EXISTS idx_phone_call_queue_case_id ON phone_call_queue(case_id);
