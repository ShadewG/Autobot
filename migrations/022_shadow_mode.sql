-- Migration: 022_shadow_mode.sql
-- Description: Shadow mode review tracking for production validation
-- Phase 7.1: Shadow mode (1-3 days) for validating routing, gating, and draft quality

-- ============================================================================
-- SHADOW_REVIEWS TABLE
-- ============================================================================

CREATE TABLE IF NOT EXISTS shadow_reviews (
    id SERIAL PRIMARY KEY,

    -- Link to proposal being reviewed
    proposal_id INTEGER NOT NULL REFERENCES proposals(id) ON DELETE CASCADE,

    -- Reviewer info
    reviewer_email VARCHAR(255),

    -- Routing correctness: Was the classification/routing correct?
    routing_correct VARCHAR(20) DEFAULT 'unsure'
        CHECK (routing_correct IN ('correct', 'incorrect', 'unsure')),

    -- What the correct classification should have been (if routing_correct = 'incorrect')
    correct_classification VARCHAR(50),

    -- Gating correctness: Did it gate appropriately?
    gating_correct VARCHAR(30) DEFAULT 'unsure'
        CHECK (gating_correct IN ('correct', 'should_have_gated', 'should_not_have_gated', 'unsure')),

    -- What action should have been taken (if gating was wrong)
    correct_action VARCHAR(50),

    -- Draft quality: 1-5 rating
    draft_quality_score INTEGER CHECK (draft_quality_score BETWEEN 1 AND 5),

    -- Free text feedback on the draft
    draft_feedback TEXT,

    -- Timestamps
    reviewed_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,

    -- Ensure one review per proposal
    UNIQUE(proposal_id)
);

-- Indexes for efficient querying
CREATE INDEX IF NOT EXISTS idx_shadow_reviews_proposal ON shadow_reviews(proposal_id);
CREATE INDEX IF NOT EXISTS idx_shadow_reviews_reviewed_at ON shadow_reviews(reviewed_at);
CREATE INDEX IF NOT EXISTS idx_shadow_reviews_routing ON shadow_reviews(routing_correct);
CREATE INDEX IF NOT EXISTS idx_shadow_reviews_gating ON shadow_reviews(gating_correct);

-- ============================================================================
-- COMMENTS
-- ============================================================================

COMMENT ON TABLE shadow_reviews IS 'Phase 7.1: Human reviews of proposals during shadow mode validation';
COMMENT ON COLUMN shadow_reviews.routing_correct IS 'Was the classification/routing decision correct? correct|incorrect|unsure';
COMMENT ON COLUMN shadow_reviews.gating_correct IS 'Did the system gate appropriately? correct|should_have_gated|should_not_have_gated|unsure';
COMMENT ON COLUMN shadow_reviews.draft_quality_score IS 'Quality rating 1-5: 1=poor, 2=below_average, 3=acceptable, 4=good, 5=excellent';

-- ============================================================================
-- SHADOW MODE ACTIVITY TRACKING VIEW
-- ============================================================================

CREATE OR REPLACE VIEW shadow_mode_summary AS
SELECT
    DATE(p.created_at) as date,
    COUNT(p.id) as total_proposals,
    COUNT(sr.id) as reviewed,
    COUNT(CASE WHEN sr.routing_correct = 'correct' THEN 1 END) as routing_correct,
    COUNT(CASE WHEN sr.routing_correct = 'incorrect' THEN 1 END) as routing_incorrect,
    COUNT(CASE WHEN sr.gating_correct = 'correct' THEN 1 END) as gating_correct,
    COUNT(CASE WHEN sr.gating_correct != 'correct' AND sr.gating_correct != 'unsure' THEN 1 END) as gating_incorrect,
    ROUND(AVG(sr.draft_quality_score), 2) as avg_draft_quality,
    COUNT(CASE WHEN sr.draft_quality_score >= 4 THEN 1 END) as good_drafts,
    COUNT(CASE WHEN sr.draft_quality_score <= 2 THEN 1 END) as poor_drafts
FROM proposals p
LEFT JOIN shadow_reviews sr ON p.id = sr.proposal_id
WHERE p.created_at >= NOW() - INTERVAL '30 days'
GROUP BY DATE(p.created_at)
ORDER BY date DESC;

COMMENT ON VIEW shadow_mode_summary IS 'Daily summary of shadow mode metrics for the last 30 days';
