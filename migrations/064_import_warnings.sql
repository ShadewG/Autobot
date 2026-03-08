-- Add import_warnings JSONB column to cases for agency validation at import
ALTER TABLE cases ADD COLUMN IF NOT EXISTS import_warnings JSONB DEFAULT NULL;

COMMENT ON COLUMN cases.import_warnings IS 'Validation warnings generated at import time (agency mismatch, missing email, directory miss, etc.)';
