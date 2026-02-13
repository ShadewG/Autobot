-- Backfill deadline_date for existing cases that have been sent but have no deadline set.
-- Uses state_deadlines table for known states, 10-day default for unknown states.

-- Cases with known states
UPDATE cases c
SET deadline_date = (c.send_date::date + sd.response_days)
FROM state_deadlines sd
WHERE sd.state_code = c.state
  AND c.status IN ('sent', 'awaiting_response')
  AND c.send_date IS NOT NULL
  AND c.deadline_date IS NULL;

-- Cases with unknown states (10-day default)
UPDATE cases c
SET deadline_date = (c.send_date::date + 10)
WHERE c.status IN ('sent', 'awaiting_response')
  AND c.send_date IS NOT NULL
  AND c.deadline_date IS NULL;
