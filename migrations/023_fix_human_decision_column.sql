-- Migration 023: Fix human_decision column type
-- The column was VARCHAR(50) but we need to store JSON objects

-- Change human_decision to JSONB
ALTER TABLE proposals
    ALTER COLUMN human_decision TYPE JSONB
    USING CASE
        WHEN human_decision IS NULL THEN NULL
        WHEN human_decision = '' THEN NULL
        ELSE jsonb_build_object('action', human_decision)
    END;

-- Add comment
COMMENT ON COLUMN proposals.human_decision IS 'JSON object: {action, instruction, reason, decidedAt, decidedBy}';
