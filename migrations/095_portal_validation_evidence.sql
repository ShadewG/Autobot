ALTER TABLE portal_automation_policies
    ADD COLUMN IF NOT EXISTS last_validation_status VARCHAR(100),
    ADD COLUMN IF NOT EXISTS last_validation_page_kind VARCHAR(100),
    ADD COLUMN IF NOT EXISTS last_validation_url TEXT,
    ADD COLUMN IF NOT EXISTS last_validation_title TEXT,
    ADD COLUMN IF NOT EXISTS last_validation_screenshot_url TEXT,
    ADD COLUMN IF NOT EXISTS last_validation_session_url TEXT,
    ADD COLUMN IF NOT EXISTS last_validated_at TIMESTAMPTZ;
