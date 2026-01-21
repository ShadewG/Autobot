-- Migration: 021_followup_scheduler.sql
-- Description: Enhanced follow-up scheduler for Run Engine integration
-- Phase 6: Production follow-up scheduling with idempotency

-- ============================================================================
-- FOLLOW_UP_SCHEDULE TABLE ENHANCEMENTS
-- ============================================================================

-- Add scheduled_key for idempotency (prevents duplicate runs for same followup trigger)
ALTER TABLE follow_up_schedule ADD COLUMN IF NOT EXISTS scheduled_key VARCHAR(255);

-- Add last_run_id to track which agent run processed this followup
ALTER TABLE follow_up_schedule ADD COLUMN IF NOT EXISTS last_run_id INTEGER REFERENCES agent_runs(id) ON DELETE SET NULL;

-- Add error tracking
ALTER TABLE follow_up_schedule ADD COLUMN IF NOT EXISTS last_error TEXT;
ALTER TABLE follow_up_schedule ADD COLUMN IF NOT EXISTS error_count INTEGER DEFAULT 0;

-- Add autopilot_mode to control how followups are processed
ALTER TABLE follow_up_schedule ADD COLUMN IF NOT EXISTS autopilot_mode VARCHAR(20) DEFAULT 'SUPERVISED';

-- Indexes
CREATE INDEX IF NOT EXISTS idx_follow_up_schedule_next_date ON follow_up_schedule(next_followup_date);
CREATE INDEX IF NOT EXISTS idx_follow_up_schedule_status ON follow_up_schedule(status);
CREATE INDEX IF NOT EXISTS idx_follow_up_schedule_scheduled_key ON follow_up_schedule(scheduled_key);

-- ============================================================================
-- DOCUMENT STATUS VALUES
-- ============================================================================

COMMENT ON COLUMN follow_up_schedule.status IS 'Enum: scheduled, processing, sent, paused, max_reached, failed, cancelled';
COMMENT ON COLUMN follow_up_schedule.autopilot_mode IS 'Enum: AUTO, SUPERVISED - controls whether followups need human approval';
COMMENT ON COLUMN follow_up_schedule.scheduled_key IS 'Idempotency key: followup:{case_id}:{followup_count}:{date}';

-- ============================================================================
-- UPDATE EXISTING RECORDS
-- ============================================================================

-- Set default autopilot_mode for existing records based on case autopilot_mode
UPDATE follow_up_schedule fs
SET autopilot_mode = COALESCE(
    (SELECT c.autopilot_mode FROM cases c WHERE c.id = fs.case_id),
    'SUPERVISED'
)
WHERE fs.autopilot_mode IS NULL;
