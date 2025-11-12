-- Migration 011: Make agency_email optional when portal_url exists
-- Before this migration, agency_email was required (NOT NULL)
-- After portal support was added, cases with portals don't need email
-- This migration makes email optional and adds a constraint to ensure
-- either email OR portal URL is present

-- Make agency_email nullable
ALTER TABLE cases
ALTER COLUMN agency_email DROP NOT NULL;

-- Add constraint to ensure either email OR portal exists
-- This prevents cases from having neither contact method
ALTER TABLE cases
ADD CONSTRAINT email_or_portal_required
CHECK (
    agency_email IS NOT NULL OR portal_url IS NOT NULL
);

-- Add helpful comment
COMMENT ON CONSTRAINT email_or_portal_required ON cases IS
'Ensures that every case has at least one contact method: either an email address or a portal URL';
