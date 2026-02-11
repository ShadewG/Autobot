-- Migration 027: Add AI briefing column to phone_call_queue
ALTER TABLE phone_call_queue ADD COLUMN IF NOT EXISTS ai_briefing JSONB;
