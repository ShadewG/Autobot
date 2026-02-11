-- Add portal_request_number column for matching inbound portal notification emails
ALTER TABLE cases ADD COLUMN IF NOT EXISTS portal_request_number VARCHAR(100);

CREATE INDEX IF NOT EXISTS idx_cases_portal_request_number
    ON cases(portal_request_number) WHERE portal_request_number IS NOT NULL;

-- Backfill from last_portal_details JSON where confirmation_number exists
UPDATE cases
SET portal_request_number = (last_portal_details::jsonb)->>'confirmation_number'
WHERE last_portal_details IS NOT NULL
  AND last_portal_details LIKE '%confirmation_number%'
  AND portal_request_number IS NULL;
