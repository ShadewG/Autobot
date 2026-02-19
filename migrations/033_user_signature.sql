-- Per-user signature fields for FOIA email generation
ALTER TABLE users ADD COLUMN IF NOT EXISTS signature_name VARCHAR(255);
ALTER TABLE users ADD COLUMN IF NOT EXISTS signature_title VARCHAR(255) DEFAULT 'Documentary Researcher, Matcher';
ALTER TABLE users ADD COLUMN IF NOT EXISTS signature_phone VARCHAR(50);
