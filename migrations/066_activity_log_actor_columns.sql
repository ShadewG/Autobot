-- Add actor context columns to activity_log for audit trail
-- These are nullable and backward-compatible: existing logActivity calls work unchanged
ALTER TABLE activity_log ADD COLUMN IF NOT EXISTS actor_type VARCHAR(20);
ALTER TABLE activity_log ADD COLUMN IF NOT EXISTS actor_id TEXT;
ALTER TABLE activity_log ADD COLUMN IF NOT EXISTS source_service VARCHAR(50);

-- Index for filtering by actor type (human vs system events)
CREATE INDEX IF NOT EXISTS idx_activity_log_actor_type ON activity_log(actor_type) WHERE actor_type IS NOT NULL;
