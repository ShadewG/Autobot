-- Replace the old PENDING_APPROVAL-only constraint with one covering ALL active statuses.
-- This makes it IMPOSSIBLE at the DB level to have two active proposals for the same case.

-- Step 1: Clean up existing violations (keep the newest active proposal per case, dismiss others)
UPDATE proposals SET status = 'DISMISSED', updated_at = NOW()
WHERE id IN (
  SELECT id FROM (
    SELECT id, ROW_NUMBER() OVER (
      PARTITION BY case_id
      ORDER BY
        CASE status
          WHEN 'PENDING_APPROVAL' THEN 0
          WHEN 'DECISION_RECEIVED' THEN 1
          WHEN 'BLOCKED' THEN 2
          WHEN 'PENDING_PORTAL' THEN 3
        END ASC,
        created_at DESC
    ) AS rn
    FROM proposals
    WHERE status IN ('PENDING_APPROVAL', 'BLOCKED', 'DECISION_RECEIVED', 'PENDING_PORTAL')
  ) sub WHERE rn > 1
);

-- Step 2: Drop the old narrow constraint
DROP INDEX IF EXISTS idx_proposals_one_pending_per_case;

-- Step 3: Create the new broad constraint
CREATE UNIQUE INDEX idx_proposals_one_active_per_case
  ON proposals (case_id)
  WHERE status IN ('PENDING_APPROVAL', 'BLOCKED', 'DECISION_RECEIVED', 'PENDING_PORTAL');
