ALTER TABLE auto_reply_queue
    ADD COLUMN IF NOT EXISTS response_type VARCHAR(50) DEFAULT 'general',
    ADD COLUMN IF NOT EXISTS metadata JSONB,
    ADD COLUMN IF NOT EXISTS last_regenerated_at TIMESTAMP;
