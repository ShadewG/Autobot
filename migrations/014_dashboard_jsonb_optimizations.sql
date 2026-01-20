-- Migration: JSONB optimizations for dashboard
-- Date: 2026-01-20
--
-- Key changes:
-- 1. Add JSONB columns for scope_items, constraints, due_info, fee_quote
-- 2. Add meta_jsonb to activity_log for timeline enrichment
-- 3. Add operational fields (schema_version, updated_by)
-- 4. Keep next_due_at at top level for sorting (due_info_jsonb has context)
-- 5. at_risk is computed dynamically, not stored

-- ============================================
-- CASES TABLE ADDITIONS
-- ============================================

-- Scope tracking: what records were requested and their status
-- Example: [{"name": "BWC footage", "status": "REQUESTED"}, {"name": "CAD logs", "status": "NOT_HELD", "reason": "..."}]
ALTER TABLE cases ADD COLUMN IF NOT EXISTS scope_items_jsonb JSONB DEFAULT '[]'::jsonb;

-- Constraints detected from agency responses (exemptions, not-held, redactions)
-- Example: [{"type": "EXEMPTION", "description": "BWC exempt under...", "confidence": 0.92, "affected_items": ["BWC footage"]}]
ALTER TABLE cases ADD COLUMN IF NOT EXISTS constraints_jsonb JSONB DEFAULT '[]'::jsonb;

-- Due date context (keeps next_due_at for sorting, this has the context)
-- Example: {"due_type": "STATUTORY", "statutory_days": 10, "snoozed_until": null, "agency_promised_at": null}
ALTER TABLE cases ADD COLUMN IF NOT EXISTS due_info_jsonb JSONB DEFAULT '{}'::jsonb;

-- Fee quote details (replaces separate fee columns for richer data)
-- Example: {"amount": 150.00, "currency": "USD", "quoted_at": "...", "breakdown": [...], "waiver_possible": false}
ALTER TABLE cases ADD COLUMN IF NOT EXISTS fee_quote_jsonb JSONB DEFAULT NULL;

-- Operational tracking
ALTER TABLE cases ADD COLUMN IF NOT EXISTS schema_version INTEGER DEFAULT 1;
ALTER TABLE cases ADD COLUMN IF NOT EXISTS updated_by VARCHAR(100);

-- ============================================
-- ACTIVITY_LOG TABLE (TIMELINE EVENTS)
-- ============================================

-- Add meta_jsonb for rich timeline event data instead of many columns
-- Example: {"category": "MESSAGE", "classification": {...}, "gate_details": {...}, "ai_audit": {...}}
ALTER TABLE activity_log ADD COLUMN IF NOT EXISTS meta_jsonb JSONB DEFAULT '{}'::jsonb;

-- Add idempotency key to prevent duplicate events
ALTER TABLE activity_log ADD COLUMN IF NOT EXISTS idempotency_key VARCHAR(255);

-- ============================================
-- AUTO_REPLY_QUEUE ADDITIONS (for NextAction)
-- ============================================

-- Split proposal vs draft content with richer structure
-- action_type: SEND_EMAIL, SEND_PORTAL, ESCALATE, NARROW_SCOPE, etc.
ALTER TABLE auto_reply_queue ADD COLUMN IF NOT EXISTS action_type VARCHAR(50) DEFAULT 'SEND_EMAIL';

-- Short proposal text for buttons
ALTER TABLE auto_reply_queue ADD COLUMN IF NOT EXISTS proposal_short VARCHAR(100);

-- Proposal reasoning as array
ALTER TABLE auto_reply_queue ADD COLUMN IF NOT EXISTS reasoning_jsonb JSONB DEFAULT '[]'::jsonb;

-- Warnings/risk flags
ALTER TABLE auto_reply_queue ADD COLUMN IF NOT EXISTS warnings_jsonb JSONB DEFAULT '[]'::jsonb;

-- Why blocked (human review reason)
ALTER TABLE auto_reply_queue ADD COLUMN IF NOT EXISTS blocked_reason VARCHAR(255);

-- Constraints applied to draft
ALTER TABLE auto_reply_queue ADD COLUMN IF NOT EXISTS constraints_applied_jsonb JSONB DEFAULT '[]'::jsonb;

-- ============================================
-- INDEXES
-- ============================================

-- GIN indexes for JSONB querying
CREATE INDEX IF NOT EXISTS idx_cases_scope_items ON cases USING GIN (scope_items_jsonb);
CREATE INDEX IF NOT EXISTS idx_cases_constraints ON cases USING GIN (constraints_jsonb);
CREATE INDEX IF NOT EXISTS idx_activity_log_meta ON activity_log USING GIN (meta_jsonb);

-- Idempotency key unique constraint
CREATE UNIQUE INDEX IF NOT EXISTS idx_activity_log_idempotency
    ON activity_log(idempotency_key)
    WHERE idempotency_key IS NOT NULL;

-- ============================================
-- BACKFILL: Migrate existing fee data to JSONB (if columns exist)
-- ============================================

DO $$
BEGIN
    -- Only run if the legacy fee columns exist
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'cases' AND column_name = 'last_fee_quote_amount'
    ) THEN
        UPDATE cases
        SET fee_quote_jsonb = jsonb_build_object(
            'amount', last_fee_quote_amount,
            'currency', COALESCE(last_fee_quote_currency, 'USD'),
            'quoted_at', last_fee_quote_at,
            'status', CASE
                WHEN last_fee_quote_amount IS NOT NULL THEN 'QUOTED'
                ELSE 'NONE'
            END
        )
        WHERE last_fee_quote_amount IS NOT NULL
          AND fee_quote_jsonb IS NULL;
    END IF;
END $$;

-- ============================================
-- BACKFILL: Set due_info from existing deadline_date (if columns exist)
-- ============================================

DO $$
BEGIN
    -- Only run if deadline_date column exists
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'cases' AND column_name = 'deadline_date'
    ) THEN
        UPDATE cases
        SET due_info_jsonb = jsonb_build_object(
            'due_type', 'STATUTORY',
            'statutory_due_at', deadline_date,
            'statutory_days', sd.response_days
        )
        FROM state_deadlines sd
        WHERE cases.state = sd.state_code
          AND cases.deadline_date IS NOT NULL
          AND cases.due_info_jsonb = '{}'::jsonb;
    END IF;
END $$;

-- ============================================
-- HELPFUL COMMENTS
-- ============================================

COMMENT ON COLUMN cases.scope_items_jsonb IS
    'Array of {name, status, reason?, confidence?}. Status: REQUESTED, CONFIRMED_AVAILABLE, NOT_DISCLOSABLE, NOT_HELD, PENDING';

COMMENT ON COLUMN cases.constraints_jsonb IS
    'Array of {type, description, source, confidence, affected_items[]}. Type: EXEMPTION, NOT_HELD, REDACTION_REQUIRED, FEE_REQUIRED';

COMMENT ON COLUMN cases.due_info_jsonb IS
    'Context for next_due_at: {due_type, statutory_days?, statutory_due_at?, snoozed_until?, agency_promised_at?}. due_type: FOLLOW_UP, STATUTORY, AGENCY_PROMISED, SNOOZED';

COMMENT ON COLUMN cases.fee_quote_jsonb IS
    'Full fee info: {amount, currency, quoted_at, status, breakdown[]?, waiver_possible?, notes?}';

COMMENT ON COLUMN activity_log.meta_jsonb IS
    'Rich event metadata: {category, classification?, gate_details?, ai_audit?}. category: MESSAGE, STATUS, COST, RESEARCH, AGENT, GATE';
