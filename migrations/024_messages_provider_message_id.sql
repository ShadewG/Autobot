-- Migration: 024_messages_provider_message_id.sql
-- Description: Add provider_message_id column to messages table for inbound deduplication

-- Add provider_message_id column to messages table
ALTER TABLE messages ADD COLUMN IF NOT EXISTS provider_message_id VARCHAR(255);

-- Add index for fast deduplication lookups
CREATE INDEX IF NOT EXISTS idx_messages_provider_message_id ON messages(provider_message_id) WHERE provider_message_id IS NOT NULL;

-- Add metadata column if not exists (for storing additional message metadata)
ALTER TABLE messages ADD COLUMN IF NOT EXISTS metadata JSONB;
