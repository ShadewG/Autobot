-- Migration: 018_agencies_table.sql
-- Description: Create dedicated agencies table with Notion sync support
-- Enables two-way sync between PostgreSQL and Notion Police Departments database

-- ============================================================================
-- EXTENSIONS (must be created BEFORE using their features)
-- ============================================================================

-- Enable trigram extension for fuzzy search (safe to run even if already exists)
-- Wrapped in DO block to handle environments where pg_trgm isn't available
DO $$
BEGIN
    CREATE EXTENSION IF NOT EXISTS pg_trgm;
EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'pg_trgm extension not available, skipping fuzzy search support';
END;
$$;

-- ============================================================================
-- AGENCIES TABLE
-- ============================================================================

CREATE TABLE IF NOT EXISTS agencies (
    id SERIAL PRIMARY KEY,

    -- Notion sync identifiers
    notion_page_id VARCHAR(255) UNIQUE,  -- Notion page ID for two-way sync

    -- Core agency info
    name VARCHAR(255) NOT NULL,
    state VARCHAR(2),
    county VARCHAR(255),

    -- Contact information
    address TEXT,
    mailing_address TEXT,
    email_main VARCHAR(255),              -- Primary contact email
    email_foia VARCHAR(255),              -- FOIA-specific email
    phone VARCHAR(50),
    fax VARCHAR(50),
    contact_name VARCHAR(255),            -- Name of contact person

    -- Submission methods
    portal_url VARCHAR(1000),
    portal_url_alt VARCHAR(1000),         -- Alternative portal URL
    portal_provider VARCHAR(100),         -- GovQA, NextRequest, etc.
    request_form_url VARCHAR(1000),       -- Downloadable request form
    preferred_method VARCHAR(50) DEFAULT 'EMAIL',  -- EMAIL, PORTAL, MAIL, FAX

    -- Agency capabilities and requirements
    allows_in_house_redaction BOOLEAN DEFAULT false,
    bwc_availability VARCHAR(100),        -- Body-worn camera policy
    forms_required BOOLEAN DEFAULT false,
    id_required BOOLEAN DEFAULT false,
    notarization_required BOOLEAN DEFAULT false,

    -- Performance tracking
    rating DECIMAL(3,2),                  -- 1-5 star rating
    typical_response_days INTEGER,
    typical_fee_min DECIMAL(10,2),
    typical_fee_max DECIMAL(10,2),
    fee_waiver_success_rate DECIMAL(3,2),

    -- Autopilot settings
    default_autopilot_mode VARCHAR(20) DEFAULT 'SUPERVISED',

    -- Metadata
    notes TEXT,
    last_info_verified_at TIMESTAMP WITH TIME ZONE,
    verified_by VARCHAR(255),

    -- Sync tracking
    last_synced_from_notion TIMESTAMP WITH TIME ZONE,
    last_synced_to_notion TIMESTAMP WITH TIME ZONE,
    sync_status VARCHAR(50) DEFAULT 'pending',  -- pending, synced, error, conflict
    sync_error TEXT,
    sync_hash VARCHAR(64),                -- Hash of synced data to detect changes

    -- Timestamps
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Indexes for agencies
CREATE INDEX IF NOT EXISTS idx_agencies_notion_page_id ON agencies(notion_page_id);
CREATE INDEX IF NOT EXISTS idx_agencies_name ON agencies(name);
CREATE INDEX IF NOT EXISTS idx_agencies_state ON agencies(state);
CREATE INDEX IF NOT EXISTS idx_agencies_sync_status ON agencies(sync_status);
CREATE INDEX IF NOT EXISTS idx_agencies_portal_url ON agencies(portal_url) WHERE portal_url IS NOT NULL;

-- Full-text search on agency name (requires pg_trgm extension)
-- Wrapped in DO block to skip if pg_trgm isn't available
DO $$
BEGIN
    CREATE INDEX IF NOT EXISTS idx_agencies_name_trgm ON agencies USING gin (name gin_trgm_ops);
EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'Skipping trigram index: pg_trgm extension not available';
END;
$$;

-- ============================================================================
-- AGENCY COMMENTS TABLE (for Notion comments sync)
-- ============================================================================

CREATE TABLE IF NOT EXISTS agency_comments (
    id SERIAL PRIMARY KEY,
    agency_id INTEGER NOT NULL REFERENCES agencies(id) ON DELETE CASCADE,
    notion_comment_id VARCHAR(255) UNIQUE,
    author VARCHAR(255),
    content TEXT NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    synced_from_notion BOOLEAN DEFAULT false
);

CREATE INDEX IF NOT EXISTS idx_agency_comments_agency_id ON agency_comments(agency_id);
CREATE INDEX IF NOT EXISTS idx_agency_comments_notion_id ON agency_comments(notion_comment_id);

-- ============================================================================
-- LINK CASES TO AGENCIES
-- ============================================================================

-- Add agency_id foreign key to cases table
ALTER TABLE cases ADD COLUMN IF NOT EXISTS agency_id INTEGER REFERENCES agencies(id);
CREATE INDEX IF NOT EXISTS idx_cases_agency_id ON cases(agency_id);

-- ============================================================================
-- SYNC AUDIT LOG
-- ============================================================================

CREATE TABLE IF NOT EXISTS agency_sync_log (
    id SERIAL PRIMARY KEY,
    agency_id INTEGER REFERENCES agencies(id) ON DELETE SET NULL,
    notion_page_id VARCHAR(255),
    sync_direction VARCHAR(20) NOT NULL,  -- from_notion, to_notion
    sync_type VARCHAR(50) NOT NULL,       -- full, incremental, manual
    fields_changed JSONB,
    status VARCHAR(50) NOT NULL,          -- success, error, skipped
    error_message TEXT,
    started_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    completed_at TIMESTAMP WITH TIME ZONE
);

CREATE INDEX IF NOT EXISTS idx_agency_sync_log_agency ON agency_sync_log(agency_id);
CREATE INDEX IF NOT EXISTS idx_agency_sync_log_status ON agency_sync_log(status);
CREATE INDEX IF NOT EXISTS idx_agency_sync_log_started ON agency_sync_log(started_at);

-- ============================================================================
-- HELPER FUNCTION: Update timestamp trigger
-- ============================================================================

CREATE OR REPLACE FUNCTION update_agencies_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_agencies_updated_at ON agencies;
CREATE TRIGGER trigger_agencies_updated_at
    BEFORE UPDATE ON agencies
    FOR EACH ROW
    EXECUTE FUNCTION update_agencies_updated_at();

-- ============================================================================
-- MIGRATION: Populate agencies from existing cases data
-- ============================================================================

-- Insert unique agencies from cases (initial population)
INSERT INTO agencies (name, state, portal_url, portal_provider, email_main, created_at)
SELECT DISTINCT ON (agency_name, state)
    agency_name as name,
    state,
    portal_url,
    portal_provider,
    agency_email as email_main,
    MIN(created_at) as created_at
FROM cases
WHERE agency_name IS NOT NULL
GROUP BY agency_name, state, portal_url, portal_provider, agency_email
ON CONFLICT DO NOTHING;

-- Link existing cases to their agencies
UPDATE cases c
SET agency_id = a.id
FROM agencies a
WHERE c.agency_name = a.name
  AND (c.state = a.state OR (c.state IS NULL AND a.state IS NULL))
  AND c.agency_id IS NULL;
