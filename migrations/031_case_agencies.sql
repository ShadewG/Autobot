-- Migration 031: Multi-agency support via case_agencies junction table
-- Each case can now track multiple agencies independently

-- 1. Create case_agencies junction table
CREATE TABLE IF NOT EXISTS case_agencies (
    id SERIAL PRIMARY KEY,
    case_id INTEGER NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
    agency_id INTEGER REFERENCES agencies(id),
    -- Denormalized (agency may not be in agencies table)
    agency_name VARCHAR(255) NOT NULL,
    agency_email VARCHAR(255),
    portal_url VARCHAR(1000),
    portal_provider VARCHAR(100),
    -- Role
    is_primary BOOLEAN DEFAULT false,
    is_active BOOLEAN DEFAULT true,
    added_source VARCHAR(50) DEFAULT 'manual',  -- notion_import | research | manual
    -- Per-agency status
    status VARCHAR(50) DEFAULT 'pending',
    substatus VARCHAR(255),
    send_date TIMESTAMP WITH TIME ZONE,
    last_response_date TIMESTAMP WITH TIME ZONE,
    -- Per-agency email thread link
    email_thread_id INTEGER REFERENCES email_threads(id),
    -- Per-agency portal state
    last_portal_status VARCHAR(255),
    last_portal_status_at TIMESTAMP WITH TIME ZONE,
    portal_request_number VARCHAR(255),
    -- Per-agency research
    contact_research_notes TEXT,
    last_contact_research_at TIMESTAMP WITH TIME ZONE,
    notes TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 2. Indexes
CREATE INDEX IF NOT EXISTS idx_case_agencies_case_id ON case_agencies(case_id);
CREATE INDEX IF NOT EXISTS idx_case_agencies_agency_id ON case_agencies(agency_id);

-- Unique constraint: only one primary per case (partial index on is_primary=true)
CREATE UNIQUE INDEX IF NOT EXISTS idx_case_agencies_one_primary
    ON case_agencies(case_id) WHERE is_primary = true AND is_active = true;

-- 3. Add case_agency_id columns to related tables
ALTER TABLE proposals ADD COLUMN IF NOT EXISTS case_agency_id INTEGER REFERENCES case_agencies(id);
ALTER TABLE email_threads ADD COLUMN IF NOT EXISTS case_agency_id INTEGER REFERENCES case_agencies(id);

-- 4. Data migration: populate case_agencies from existing cases
INSERT INTO case_agencies (case_id, agency_id, agency_name, agency_email, portal_url, portal_provider, is_primary, is_active, added_source, status)
SELECT
    c.id,
    c.agency_id,
    COALESCE(c.agency_name, 'Unknown Agency'),
    c.agency_email,
    c.portal_url,
    c.portal_provider,
    true,   -- is_primary
    true,   -- is_active
    'notion_import',
    CASE
        WHEN c.status IN ('completed', 'closed') THEN 'completed'
        WHEN c.status IN ('awaiting_response', 'sent') THEN 'sent'
        ELSE 'pending'
    END
FROM cases c
WHERE NOT EXISTS (
    SELECT 1 FROM case_agencies ca WHERE ca.case_id = c.id AND ca.is_primary = true
);

-- 5. Link existing email_threads to their primary case_agency
UPDATE email_threads et
SET case_agency_id = ca.id
FROM case_agencies ca
WHERE ca.case_id = et.case_id
  AND ca.is_primary = true
  AND et.case_agency_id IS NULL;
