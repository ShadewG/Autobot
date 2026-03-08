CREATE TABLE IF NOT EXISTS error_events (
    id SERIAL PRIMARY KEY,
    source_service VARCHAR(100) NOT NULL,
    operation VARCHAR(120),
    case_id INTEGER REFERENCES cases(id) ON DELETE SET NULL,
    proposal_id INTEGER REFERENCES proposals(id) ON DELETE SET NULL,
    message_id INTEGER REFERENCES messages(id) ON DELETE SET NULL,
    run_id INTEGER REFERENCES agent_runs(id) ON DELETE SET NULL,
    error_name VARCHAR(100) NOT NULL,
    error_code VARCHAR(100),
    error_message TEXT NOT NULL,
    stack TEXT,
    retryable BOOLEAN,
    retry_attempt INTEGER,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_error_events_created_at ON error_events(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_error_events_source_service ON error_events(source_service, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_error_events_case_id ON error_events(case_id, created_at DESC) WHERE case_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_error_events_operation ON error_events(operation, created_at DESC) WHERE operation IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_error_events_error_code ON error_events(error_code, created_at DESC) WHERE error_code IS NOT NULL;
