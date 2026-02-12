-- Migration 028: Add phone_options JSONB column to phone_call_queue
-- Stores dual lookup results: { notion: { phone, source, pd_page_id, pd_page_url }, web_search: { phone, source, confidence, reasoning } }
ALTER TABLE phone_call_queue ADD COLUMN IF NOT EXISTS phone_options JSONB;
