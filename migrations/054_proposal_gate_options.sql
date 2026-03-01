-- Migration: 054_proposal_gate_options.sql
-- Description: Add gate_options JSONB column to proposals table
-- Purpose: Allow proposals to specify which actions are available to reviewers
--          (e.g., RETRY_RESEARCH, ADJUST, DISMISS — no APPROVE when research failed)

ALTER TABLE proposals ADD COLUMN IF NOT EXISTS gate_options JSONB DEFAULT NULL;

COMMENT ON COLUMN proposals.gate_options IS 'JSON array of allowed decision actions for this proposal (e.g. ["RETRY_RESEARCH","ADJUST","DISMISS"]). NULL = default set (APPROVE/ADJUST/DISMISS).';
