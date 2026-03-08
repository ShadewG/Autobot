ALTER TABLE messages
    ADD COLUMN IF NOT EXISTS provider_payload JSONB;
