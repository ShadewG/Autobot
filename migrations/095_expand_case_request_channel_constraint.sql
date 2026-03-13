-- Allow cases to use manual request pages or downloadable PDF forms
-- as their primary request channel, not just direct email or portal URLs.

ALTER TABLE cases
DROP CONSTRAINT IF EXISTS email_or_portal_required;

ALTER TABLE cases
DROP CONSTRAINT IF EXISTS email_or_request_channel_required;

ALTER TABLE cases
ADD CONSTRAINT email_or_request_channel_required
CHECK (
    agency_email IS NOT NULL
    OR portal_url IS NOT NULL
    OR manual_request_url IS NOT NULL
    OR pdf_form_url IS NOT NULL
);

COMMENT ON CONSTRAINT email_or_request_channel_required ON cases IS
'Ensures that every case has at least one request channel: email, automatable portal, manual request page, or downloadable PDF form.';
