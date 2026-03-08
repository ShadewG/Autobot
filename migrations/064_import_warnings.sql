-- Add import_warnings JSONB column to cases for agency validation at import
ALTER TABLE cases ADD COLUMN IF NOT EXISTS import_warnings JSONB DEFAULT NULL;
COMMENT ON COLUMN cases.import_warnings IS 'Validation warnings generated at import time (agency mismatch, missing email, directory miss, etc.)';

-- Add last_notion_synced_at timestamp for sync visibility
ALTER TABLE cases ADD COLUMN IF NOT EXISTS last_notion_synced_at TIMESTAMP DEFAULT NULL;
COMMENT ON COLUMN cases.last_notion_synced_at IS 'Last time this case was synced from/to Notion';
