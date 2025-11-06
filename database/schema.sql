-- Autobot MVP Database Schema

-- Cases imported from Notion
CREATE TABLE IF NOT EXISTS cases (
    id SERIAL PRIMARY KEY,
    notion_page_id VARCHAR(255) UNIQUE NOT NULL,
    case_name VARCHAR(500) NOT NULL,
    subject_name VARCHAR(255),
    agency_name VARCHAR(255),
    agency_email VARCHAR(255) NOT NULL,
    state VARCHAR(2),
    incident_date DATE,
    incident_location TEXT,
    requested_records TEXT[], -- Array of record types
    additional_details TEXT,
    status VARCHAR(50) DEFAULT 'ready_to_send', -- ready_to_send, sent, awaiting_response, responded, completed, error
    send_date TIMESTAMP,
    last_response_date TIMESTAMP,
    days_overdue INTEGER DEFAULT 0,
    deadline_date DATE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Email threads (one per case/agency)
CREATE TABLE IF NOT EXISTS email_threads (
    id SERIAL PRIMARY KEY,
    case_id INTEGER REFERENCES cases(id) ON DELETE CASCADE,
    thread_id VARCHAR(255), -- SendGrid thread ID
    subject VARCHAR(500) NOT NULL,
    agency_email VARCHAR(255) NOT NULL,
    initial_message_id VARCHAR(255), -- First email sent
    status VARCHAR(50) DEFAULT 'active', -- active, responded, closed, overdue
    message_count INTEGER DEFAULT 0,
    last_message_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Individual messages (sent and received)
CREATE TABLE IF NOT EXISTS messages (
    id SERIAL PRIMARY KEY,
    thread_id INTEGER REFERENCES email_threads(id) ON DELETE CASCADE,
    case_id INTEGER REFERENCES cases(id) ON DELETE CASCADE,
    message_id VARCHAR(255) UNIQUE, -- RFC 2822 Message-ID
    sendgrid_message_id VARCHAR(255), -- SendGrid's internal ID
    direction VARCHAR(10) NOT NULL, -- outbound, inbound
    from_email VARCHAR(255) NOT NULL,
    to_email VARCHAR(255) NOT NULL,
    cc_emails TEXT[],
    subject VARCHAR(500),
    body_text TEXT,
    body_html TEXT,
    has_attachments BOOLEAN DEFAULT FALSE,
    attachment_count INTEGER DEFAULT 0,
    message_type VARCHAR(50), -- initial_request, follow_up, response, auto_reply
    sent_at TIMESTAMP,
    received_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Attachments
CREATE TABLE IF NOT EXISTS attachments (
    id SERIAL PRIMARY KEY,
    message_id INTEGER REFERENCES messages(id) ON DELETE CASCADE,
    filename VARCHAR(500),
    content_type VARCHAR(100),
    size_bytes INTEGER,
    sendgrid_attachment_id VARCHAR(255),
    storage_url TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- AI analysis of received responses
CREATE TABLE IF NOT EXISTS response_analysis (
    id SERIAL PRIMARY KEY,
    message_id INTEGER REFERENCES messages(id) ON DELETE CASCADE,
    case_id INTEGER REFERENCES cases(id) ON DELETE CASCADE,
    intent VARCHAR(50), -- acknowledgment, question, delivery, denial, fee_request, more_info_needed
    confidence_score DECIMAL(3,2), -- 0.00 to 1.00
    sentiment VARCHAR(20), -- positive, neutral, negative, hostile
    key_points TEXT[], -- Extracted important points
    extracted_deadline DATE,
    extracted_fee_amount DECIMAL(10,2),
    requires_action BOOLEAN DEFAULT FALSE,
    suggested_action TEXT,
    full_analysis_json JSONB, -- Complete AI response
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Follow-up schedule
CREATE TABLE IF NOT EXISTS follow_up_schedule (
    id SERIAL PRIMARY KEY,
    case_id INTEGER REFERENCES cases(id) ON DELETE CASCADE,
    thread_id INTEGER REFERENCES email_threads(id) ON DELETE CASCADE,
    next_followup_date DATE NOT NULL,
    followup_count INTEGER DEFAULT 0,
    last_followup_sent_at TIMESTAMP,
    auto_send BOOLEAN DEFAULT TRUE,
    status VARCHAR(50) DEFAULT 'scheduled', -- scheduled, sent, cancelled, max_reached
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Auto-reply queue (for manual approval if needed)
CREATE TABLE IF NOT EXISTS auto_reply_queue (
    id SERIAL PRIMARY KEY,
    message_id INTEGER REFERENCES messages(id) ON DELETE CASCADE,
    case_id INTEGER REFERENCES cases(id) ON DELETE CASCADE,
    generated_reply TEXT NOT NULL,
    confidence_score DECIMAL(3,2),
    status VARCHAR(50) DEFAULT 'pending', -- pending, approved, rejected, sent
    requires_approval BOOLEAN DEFAULT FALSE,
    approved_by VARCHAR(100),
    approved_at TIMESTAMP,
    sent_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Generated FOIA requests (drafts before sending)
CREATE TABLE IF NOT EXISTS generated_requests (
    id SERIAL PRIMARY KEY,
    case_id INTEGER REFERENCES cases(id) ON DELETE CASCADE,
    request_text TEXT NOT NULL,
    ai_model VARCHAR(50), -- gpt-5, claude-3-opus, etc.
    generation_metadata JSONB, -- Tokens used, cost, etc.
    status VARCHAR(50) DEFAULT 'draft', -- draft, approved, sent
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- State-specific FOIA deadline configurations
CREATE TABLE IF NOT EXISTS state_deadlines (
    id SERIAL PRIMARY KEY,
    state_code VARCHAR(2) UNIQUE NOT NULL,
    state_name VARCHAR(100),
    response_days INTEGER NOT NULL, -- Number of business days for response
    statute_citation TEXT,
    notes TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Insert default state deadlines (common ones)
INSERT INTO state_deadlines (state_code, state_name, response_days, statute_citation) VALUES
('CA', 'California', 10, 'California Public Records Act'),
('NY', 'New York', 5, 'Freedom of Information Law (FOIL)'),
('TX', 'Texas', 10, 'Texas Public Information Act'),
('FL', 'Florida', 7, 'Florida Sunshine Law'),
('IL', 'Illinois', 5, 'Illinois Freedom of Information Act'),
('PA', 'Pennsylvania', 5, 'Right-to-Know Law'),
('OH', 'Ohio', 7, 'Ohio Public Records Act'),
('GA', 'Georgia', 3, 'Georgia Open Records Act'),
('NC', 'North Carolina', 7, 'North Carolina Public Records Law'),
('MI', 'Michigan', 5, 'Michigan Freedom of Information Act')
ON CONFLICT (state_code) DO NOTHING;

-- Activity log for monitoring
CREATE TABLE IF NOT EXISTS activity_log (
    id SERIAL PRIMARY KEY,
    event_type VARCHAR(100) NOT NULL, -- email_sent, email_received, followup_scheduled, etc.
    case_id INTEGER REFERENCES cases(id) ON DELETE SET NULL,
    message_id INTEGER REFERENCES messages(id) ON DELETE SET NULL,
    description TEXT,
    metadata JSONB,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Create indexes for performance
CREATE INDEX IF NOT EXISTS idx_cases_status ON cases(status);
CREATE INDEX IF NOT EXISTS idx_cases_notion_id ON cases(notion_page_id);
CREATE INDEX IF NOT EXISTS idx_email_threads_case ON email_threads(case_id);
CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(thread_id);
CREATE INDEX IF NOT EXISTS idx_messages_direction ON messages(direction);
CREATE INDEX IF NOT EXISTS idx_followup_schedule_date ON follow_up_schedule(next_followup_date);
CREATE INDEX IF NOT EXISTS idx_activity_log_event ON activity_log(event_type);
CREATE INDEX IF NOT EXISTS idx_activity_log_created ON activity_log(created_at);
