-- Migration 093: Split real portal URLs from manual/PDF request paths

ALTER TABLE cases
    ADD COLUMN IF NOT EXISTS manual_request_url VARCHAR(1000),
    ADD COLUMN IF NOT EXISTS pdf_form_url VARCHAR(1000);

ALTER TABLE case_agencies
    ADD COLUMN IF NOT EXISTS manual_request_url VARCHAR(1000),
    ADD COLUMN IF NOT EXISTS pdf_form_url VARCHAR(1000);
