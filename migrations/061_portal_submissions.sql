-- Portal submission history: durable record of every portal attempt
-- (cases.last_portal_* only stores the latest, overwriting previous attempts)

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
    extracted_data JSONB,
    error_message TEXT,
    started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_portal_submissions_case_id ON portal_submissions(case_id);
CREATE INDEX IF NOT EXISTS idx_portal_submissions_status ON portal_submissions(status);
