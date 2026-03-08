CREATE TABLE IF NOT EXISTS received_records (
    id SERIAL PRIMARY KEY,
    case_id INTEGER NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
    message_id INTEGER REFERENCES messages(id) ON DELETE SET NULL,
    attachment_id INTEGER REFERENCES attachments(id) ON DELETE SET NULL,
    source_type VARCHAR(50) NOT NULL,
    source_url TEXT,
    filename TEXT,
    content_type TEXT,
    size_bytes INTEGER,
    matched_scope_item TEXT,
    match_confidence NUMERIC(4,3),
    notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_received_records_case_id ON received_records(case_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_received_records_message_id ON received_records(message_id) WHERE message_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_received_records_attachment_unique ON received_records(attachment_id) WHERE attachment_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_received_records_case_source_url_unique ON received_records(case_id, source_url) WHERE source_url IS NOT NULL;
