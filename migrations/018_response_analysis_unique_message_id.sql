-- Add unique constraint on response_analysis.message_id
-- This enables upsert behavior for AI analysis updates

-- First, remove any duplicates (keep the one with the most data)
DELETE FROM response_analysis a
USING response_analysis b
WHERE a.message_id = b.message_id
  AND a.id < b.id;

-- Now add the unique constraint
ALTER TABLE response_analysis
ADD CONSTRAINT response_analysis_message_id_unique UNIQUE (message_id);

-- Add updated_at column if it doesn't exist
ALTER TABLE response_analysis
ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;
