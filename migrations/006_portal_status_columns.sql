-- Add portal tracking columns to cases
ALTER TABLE cases
    ADD COLUMN IF NOT EXISTS portal_url VARCHAR(1000),
    ADD COLUMN IF NOT EXISTS portal_provider VARCHAR(100),
    ADD COLUMN IF NOT EXISTS last_portal_status VARCHAR(255),
    ADD COLUMN IF NOT EXISTS last_portal_status_at TIMESTAMP,
    ADD COLUMN IF NOT EXISTS last_portal_engine VARCHAR(50),
    ADD COLUMN IF NOT EXISTS last_portal_run_id VARCHAR(255),
    ADD COLUMN IF NOT EXISTS last_portal_details TEXT;

-- Add portal notification columns to messages
ALTER TABLE messages
    ADD COLUMN IF NOT EXISTS portal_notification BOOLEAN DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS portal_notification_type VARCHAR(100),
    ADD COLUMN IF NOT EXISTS portal_notification_provider VARCHAR(100);
