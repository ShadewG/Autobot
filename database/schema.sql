-- Autobot MVP Database Schema

-- Cases imported from Notion
CREATE TABLE IF NOT EXISTS cases (
    id SERIAL PRIMARY KEY,
    notion_page_id VARCHAR(255) UNIQUE NOT NULL,
    case_name VARCHAR(500) NOT NULL,
    subject_name VARCHAR(255),
    agency_name VARCHAR(255),
    agency_email VARCHAR(255),
    state VARCHAR(2),
    incident_date DATE,
    incident_location TEXT,
    requested_records TEXT[], -- Array of record types
    additional_details TEXT,
    status VARCHAR(50) DEFAULT 'ready_to_send', -- ready_to_send, sent, awaiting_response, responded, completed, error, needs_human_review, needs_contact_info, needs_human_fee_approval, portal_in_progress
    substatus VARCHAR(100), -- More granular status detail (e.g., 'Missing contact information', 'No valid portal or email contact detected')
    portal_url VARCHAR(1000),
    portal_provider VARCHAR(100),
    manual_request_url VARCHAR(1000),
    pdf_form_url VARCHAR(1000),
    last_portal_status VARCHAR(255),
    last_portal_status_at TIMESTAMP,
    last_portal_engine VARCHAR(50),
    last_portal_run_id VARCHAR(255),
    last_portal_details TEXT,
    last_portal_task_url TEXT,
    last_portal_recording_url TEXT,
    last_portal_account_email VARCHAR(255),
    alternate_agency_email VARCHAR(255),
    last_contact_research_at TIMESTAMP,
    contact_research_notes TEXT,
    last_fee_quote_amount DECIMAL(10,2),
    last_fee_quote_currency VARCHAR(10),
    last_fee_quote_at TIMESTAMP,
    send_date TIMESTAMP,
    last_response_date TIMESTAMP,
    days_overdue INTEGER DEFAULT 0,
    deadline_date DATE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT email_or_request_channel_required CHECK (
        agency_email IS NOT NULL
        OR portal_url IS NOT NULL
        OR manual_request_url IS NOT NULL
        OR pdf_form_url IS NOT NULL
    )
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
    normalized_body_text TEXT,
    normalized_body_source VARCHAR(50),
    is_substantive BOOLEAN,
    has_attachments BOOLEAN DEFAULT FALSE,
    attachment_count INTEGER DEFAULT 0,
    message_type VARCHAR(50), -- initial_request, follow_up, response, auto_reply
    portal_notification BOOLEAN DEFAULT FALSE,
    portal_notification_type VARCHAR(100),
    portal_notification_provider VARCHAR(100),
    sent_at TIMESTAMP,
    delivered_at TIMESTAMP,
    bounced_at TIMESTAMP,
    received_at TIMESTAMP,
    summary TEXT, -- One-sentence AI-generated summary
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS email_events (
    id SERIAL PRIMARY KEY,
    message_id INTEGER REFERENCES messages(id) ON DELETE SET NULL,
    provider_message_id VARCHAR(255),
    event_type VARCHAR(50) NOT NULL,
    event_timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    raw_payload JSONB NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS portal_submissions (
    id SERIAL PRIMARY KEY,
    case_id INTEGER NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
    run_id INTEGER REFERENCES agent_runs(id) ON DELETE SET NULL,
    skyvern_task_id VARCHAR(255),
    status VARCHAR(100) NOT NULL,
    engine VARCHAR(100),
    account_email VARCHAR(255),
    screenshot_url TEXT,
    recording_url TEXT,
    browser_backend VARCHAR(50),
    browser_session_id VARCHAR(255),
    browser_session_url TEXT,
    browser_debugger_url TEXT,
    browser_debugger_fullscreen_url TEXT,
    browser_region VARCHAR(50),
    browser_status VARCHAR(50),
    browser_metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    browser_live_urls_jsonb JSONB NOT NULL DEFAULT '{}'::jsonb,
    browser_logs_synced_at TIMESTAMPTZ,
    auth_context_id VARCHAR(255),
    auth_intervention_status VARCHAR(50),
    auth_intervention_reason TEXT,
    auth_intervention_requested_at TIMESTAMPTZ,
    auth_intervention_completed_at TIMESTAMPTZ,
    browser_keep_alive BOOLEAN NOT NULL DEFAULT FALSE,
    browser_cost_policy JSONB NOT NULL DEFAULT '{}'::jsonb,
    extracted_data JSONB,
    error_message TEXT,
    started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS portal_automation_policies (
    id SERIAL PRIMARY KEY,
    portal_fingerprint VARCHAR(500) UNIQUE NOT NULL,
    host VARCHAR(255) NOT NULL,
    provider VARCHAR(100) NOT NULL,
    path_class VARCHAR(100) NOT NULL,
    path_hint VARCHAR(255) NOT NULL,
    sample_portal_url TEXT,
    policy_status VARCHAR(20),
    decision_source VARCHAR(100),
    decision_reason TEXT,
    success_count INTEGER NOT NULL DEFAULT 0,
    failure_count INTEGER NOT NULL DEFAULT 0,
    last_case_id INTEGER REFERENCES cases(id) ON DELETE SET NULL,
    last_submission_id INTEGER REFERENCES portal_submissions(id) ON DELETE SET NULL,
    last_validation_status VARCHAR(100),
    last_validation_page_kind VARCHAR(100),
    last_validation_url TEXT,
    last_validation_title TEXT,
    last_validation_screenshot_url TEXT,
    last_validation_session_url TEXT,
    last_validated_at TIMESTAMPTZ,
    decided_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
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
    message_id INTEGER UNIQUE REFERENCES messages(id) ON DELETE CASCADE,
    case_id INTEGER REFERENCES cases(id) ON DELETE CASCADE,
    generated_reply TEXT NOT NULL,
    confidence_score DECIMAL(3,2),
    status VARCHAR(50) DEFAULT 'pending', -- pending, approved, rejected, sent
    requires_approval BOOLEAN DEFAULT FALSE,
    approved_by VARCHAR(100),
    approved_at TIMESTAMP,
    sent_at TIMESTAMP,
    response_type VARCHAR(50) DEFAULT 'general',
    metadata JSONB,
    last_regenerated_at TIMESTAMP,
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

-- Portal accounts (store credentials for reuse)
CREATE TABLE IF NOT EXISTS portal_accounts (
    id SERIAL PRIMARY KEY,
    portal_url VARCHAR(1000) NOT NULL, -- Full portal URL
    portal_domain VARCHAR(255) NOT NULL, -- Extracted domain (e.g., "colliercountyshofl.govqa.us")
    portal_type VARCHAR(100), -- e.g., "GovQA", "NextRequest", "Custom"
    email VARCHAR(255) NOT NULL,
    password_encrypted TEXT NOT NULL, -- Encrypted password
    first_name VARCHAR(100),
    last_name VARCHAR(100),
    additional_info JSONB, -- Any other account details
    account_status VARCHAR(50) DEFAULT 'active', -- active, inactive, locked
    browserbase_context_id VARCHAR(255),
    browserbase_context_status VARCHAR(50),
    browserbase_authenticated_at TIMESTAMPTZ,
    browserbase_last_auth_at TIMESTAMPTZ,
    browserbase_auth_metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    last_used_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(portal_domain, email)
);

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
CREATE UNIQUE INDEX IF NOT EXISTS idx_cases_notion_id_unique ON cases(notion_page_id);
CREATE INDEX IF NOT EXISTS idx_email_threads_case ON email_threads(case_id);
CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(thread_id);
CREATE INDEX IF NOT EXISTS idx_messages_direction ON messages(direction);
CREATE INDEX IF NOT EXISTS idx_followup_schedule_date ON follow_up_schedule(next_followup_date);
CREATE INDEX IF NOT EXISTS idx_activity_log_event ON activity_log(event_type);
CREATE INDEX IF NOT EXISTS idx_activity_log_created ON activity_log(created_at);
CREATE INDEX IF NOT EXISTS idx_portal_accounts_domain ON portal_accounts(portal_domain);
CREATE INDEX IF NOT EXISTS idx_portal_accounts_status ON portal_accounts(account_status);
CREATE INDEX IF NOT EXISTS idx_portal_automation_policies_host_provider ON portal_automation_policies(host, provider);
