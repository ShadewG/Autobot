-- Migration: Add workflow fields for request dashboard
-- Date: 2026-01-20

-- Add workflow fields to cases table
ALTER TABLE cases ADD COLUMN IF NOT EXISTS requires_human BOOLEAN DEFAULT false;
ALTER TABLE cases ADD COLUMN IF NOT EXISTS pause_reason VARCHAR(50);
ALTER TABLE cases ADD COLUMN IF NOT EXISTS next_due_at TIMESTAMP WITH TIME ZONE;
ALTER TABLE cases ADD COLUMN IF NOT EXISTS autopilot_mode VARCHAR(20) DEFAULT 'SUPERVISED';

-- Add constraints for enum values (safe to run multiple times)
DO $$
BEGIN
    -- Drop constraints if they exist (for re-runnability)
    ALTER TABLE cases DROP CONSTRAINT IF EXISTS chk_pause_reason;
    ALTER TABLE cases DROP CONSTRAINT IF EXISTS chk_autopilot_mode;

    -- Add pause_reason constraint
    ALTER TABLE cases ADD CONSTRAINT chk_pause_reason
        CHECK (pause_reason IS NULL OR pause_reason IN (
            'FEE_QUOTE', 'SCOPE', 'DENIAL', 'ID_REQUIRED', 'SENSITIVE', 'CLOSE_ACTION'
        ));

    -- Add autopilot_mode constraint
    ALTER TABLE cases ADD CONSTRAINT chk_autopilot_mode
        CHECK (autopilot_mode IN ('AUTO', 'SUPERVISED', 'MANUAL'));
END $$;

-- Backfill requires_human from existing status/substatus
UPDATE cases SET requires_human = true
WHERE status IN ('needs_human_review', 'needs_contact_info', 'needs_human_fee_approval')
   OR substatus = 'needs_human_review';

-- Backfill pause_reason from existing status
UPDATE cases SET pause_reason = 'FEE_QUOTE'
WHERE status = 'needs_human_fee_approval' AND pause_reason IS NULL;

UPDATE cases SET pause_reason = 'ID_REQUIRED'
WHERE status = 'needs_contact_info' AND pause_reason IS NULL;

-- Index for dashboard queries
CREATE INDEX IF NOT EXISTS idx_cases_requires_human ON cases(requires_human) WHERE requires_human = true;
CREATE INDEX IF NOT EXISTS idx_cases_next_due_at ON cases(next_due_at) WHERE next_due_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_cases_autopilot_mode ON cases(autopilot_mode);
CREATE INDEX IF NOT EXISTS idx_cases_pause_reason ON cases(pause_reason) WHERE pause_reason IS NOT NULL;
