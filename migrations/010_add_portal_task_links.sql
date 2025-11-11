ALTER TABLE cases
    ADD COLUMN IF NOT EXISTS last_portal_task_url TEXT,
    ADD COLUMN IF NOT EXISTS last_portal_recording_url TEXT,
    ADD COLUMN IF NOT EXISTS last_portal_account_email VARCHAR(255);
