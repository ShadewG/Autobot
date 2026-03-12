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
    decided_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_portal_automation_policies_host_provider
    ON portal_automation_policies(host, provider);
