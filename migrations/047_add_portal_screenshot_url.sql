-- Add column to store the latest Skyvern browser screenshot during portal submissions
ALTER TABLE cases ADD COLUMN IF NOT EXISTS last_portal_screenshot_url TEXT;
