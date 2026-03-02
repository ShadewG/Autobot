-- Action Chains: allow proposing & executing multiple actions together
-- e.g., DECLINE_FEE then REFORMULATE_REQUEST

-- Chain metadata on proposals
ALTER TABLE proposals ADD COLUMN IF NOT EXISTS action_chain JSONB DEFAULT NULL;
ALTER TABLE proposals ADD COLUMN IF NOT EXISTS chain_id UUID DEFAULT NULL;
ALTER TABLE proposals ADD COLUMN IF NOT EXISTS chain_step INTEGER DEFAULT NULL;

-- Index for chain lookups
CREATE INDEX IF NOT EXISTS idx_proposals_chain_id ON proposals (chain_id) WHERE chain_id IS NOT NULL;

-- Relax one-active-proposal constraint: allow multiple PENDING proposals if they share a chain_id.
-- Drop the old constraint and replace with chain-aware version.
DROP INDEX IF EXISTS idx_proposals_one_active_per_case;

-- Enforce exactly one active PRIMARY proposal per case.
-- - Non-chain proposals: chain_id IS NULL (primary)
-- - Chain primaries: chain_step = 0 (primary)
-- Chain siblings (chain_step > 0, CHAIN_PENDING) are exempt.
CREATE UNIQUE INDEX idx_proposals_one_active_per_case
  ON proposals (case_id)
  WHERE status IN ('PENDING_APPROVAL', 'BLOCKED', 'DECISION_RECEIVED', 'PENDING_PORTAL')
    AND (
      chain_id IS NULL
      OR chain_step = 0
    );

-- Chain siblings are allowed (multiple active per case as long as they share a chain_id).
-- The primary proposal (chain_step=0) owns the waitpoint_token; siblings use CHAIN_PENDING status.
