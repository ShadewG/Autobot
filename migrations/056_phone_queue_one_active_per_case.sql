-- Ensure only one active phone-call task per case at any time.
-- Active = pending or claimed.

-- First, collapse existing duplicates by skipping older active tasks.
WITH ranked AS (
    SELECT
        id,
        case_id,
        ROW_NUMBER() OVER (
            PARTITION BY case_id
            ORDER BY created_at DESC, id DESC
        ) AS rn
    FROM phone_call_queue
    WHERE status IN ('pending', 'claimed')
)
UPDATE phone_call_queue pcq
SET
    status = 'skipped',
    call_outcome = COALESCE(pcq.call_outcome, 'duplicate_cleanup'),
    call_notes = CASE
        WHEN pcq.call_notes IS NULL OR pcq.call_notes = '' THEN 'Auto-skipped duplicate active phone task during migration 056.'
        ELSE pcq.call_notes
    END,
    completed_at = COALESCE(pcq.completed_at, NOW()),
    updated_at = NOW()
FROM ranked r
WHERE pcq.id = r.id
  AND r.rn > 1;

-- Then enforce at the DB level so races cannot recreate duplicates.
CREATE UNIQUE INDEX IF NOT EXISTS idx_phone_call_queue_one_active_per_case
ON phone_call_queue (case_id)
WHERE status IN ('pending', 'claimed');
