ALTER TABLE messages ADD COLUMN IF NOT EXISTS delivered_at TIMESTAMP;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS bounced_at TIMESTAMP;

CREATE TABLE IF NOT EXISTS email_events (
    id SERIAL PRIMARY KEY,
    message_id INTEGER REFERENCES messages(id) ON DELETE SET NULL,
    provider_message_id VARCHAR(255),
    event_type VARCHAR(50) NOT NULL,
    event_timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    raw_payload JSONB NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_email_events_message_id ON email_events(message_id);
CREATE INDEX IF NOT EXISTS idx_email_events_provider_message_id ON email_events(provider_message_id);
CREATE INDEX IF NOT EXISTS idx_email_events_type ON email_events(event_type);
