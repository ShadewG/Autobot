ALTER TABLE cases
    ADD COLUMN IF NOT EXISTS alternate_agency_email VARCHAR(255),
    ADD COLUMN IF NOT EXISTS last_contact_research_at TIMESTAMP,
    ADD COLUMN IF NOT EXISTS contact_research_notes TEXT;
