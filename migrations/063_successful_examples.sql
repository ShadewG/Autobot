-- 063_successful_examples.sql
-- Store approved proposal patterns for future few-shot retrieval

CREATE TABLE IF NOT EXISTS successful_examples (
    id SERIAL PRIMARY KEY,
    proposal_id INTEGER NOT NULL UNIQUE REFERENCES proposals(id) ON DELETE CASCADE,
    case_id INTEGER REFERENCES cases(id) ON DELETE SET NULL,
    trigger_message_id INTEGER REFERENCES messages(id) ON DELETE SET NULL,
    action_type VARCHAR(50) NOT NULL,
    classification VARCHAR(100),
    agency_name TEXT,
    agency_type VARCHAR(100),
    state_code VARCHAR(16),
    requested_records TEXT,
    draft_subject TEXT NOT NULL,
    draft_body_text TEXT NOT NULL,
    human_edited BOOLEAN NOT NULL DEFAULT false,
    approved_by VARCHAR(100),
    outcome VARCHAR(50) NOT NULL DEFAULT 'approved',
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_successful_examples_action_type
    ON successful_examples(action_type, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_successful_examples_classification
    ON successful_examples(classification, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_successful_examples_agency_type
    ON successful_examples(agency_type, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_successful_examples_state_code
    ON successful_examples(state_code, created_at DESC);
