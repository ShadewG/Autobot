/**
 * Shadow Mode Service
 *
 * Phase 7.1: Production validation with DRY execution.
 *
 * Shadow mode enables:
 * - LIVE inbox ingestion (real emails processed)
 * - EXECUTION_MODE=DRY (no actual sends)
 * - Human review of proposals without execution
 * - Tracking of routing, gating, and draft quality
 *
 * Metrics tracked:
 * - Routing correctness: Was classification correct?
 * - Gating correctness: Did it gate when it should have?
 * - Draft quality: Human rating of generated drafts
 */

const db = require('./database');
const logger = require('./logger');

// Hardcoded mode: shadow mode disabled, execution always live
const SHADOW_MODE = false;
const EXECUTION_MODE = 'LIVE';

/**
 * Check if running in shadow mode
 */
function isShadowMode() {
  return false;
}

/**
 * Log shadow mode status on startup
 */
function logShadowModeStatus() {
  if (isShadowMode()) {
    logger.info('='.repeat(60));
    logger.info('SHADOW MODE ACTIVE');
    logger.info('- Inbox ingestion: LIVE');
    logger.info('- Execution mode: DRY (no actual sends)');
    logger.info('- Proposals will be created for human review');
    logger.info('- Track metrics at GET /api/shadow/metrics');
    logger.info('='.repeat(60));
  }
}

/**
 * Record a shadow review for a proposal
 *
 * @param {number} proposalId - The proposal being reviewed
 * @param {Object} review - Review data
 * @param {string} review.reviewerEmail - Who reviewed
 * @param {string} review.routingCorrect - 'correct' | 'incorrect' | 'unsure'
 * @param {string} review.gatingCorrect - 'correct' | 'should_have_gated' | 'should_not_have_gated' | 'unsure'
 * @param {number} review.draftQualityScore - 1-5 rating
 * @param {string} review.draftFeedback - Free text feedback
 * @param {string} review.correctClassification - What classification should have been
 * @param {string} review.correctAction - What action should have been taken
 */
async function recordShadowReview(proposalId, review) {
  const query = `
    INSERT INTO shadow_reviews (
      proposal_id,
      reviewer_email,
      routing_correct,
      correct_classification,
      gating_correct,
      correct_action,
      draft_quality_score,
      draft_feedback,
      reviewed_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
    ON CONFLICT (proposal_id) DO UPDATE SET
      reviewer_email = EXCLUDED.reviewer_email,
      routing_correct = EXCLUDED.routing_correct,
      correct_classification = EXCLUDED.correct_classification,
      gating_correct = EXCLUDED.gating_correct,
      correct_action = EXCLUDED.correct_action,
      draft_quality_score = EXCLUDED.draft_quality_score,
      draft_feedback = EXCLUDED.draft_feedback,
      reviewed_at = NOW()
    RETURNING *
  `;

  const values = [
    proposalId,
    review.reviewerEmail || 'anonymous',
    review.routingCorrect || 'unsure',
    review.correctClassification || null,
    review.gatingCorrect || 'unsure',
    review.correctAction || null,
    review.draftQualityScore || null,
    review.draftFeedback || null
  ];

  const result = await db.query(query, values);
  logger.info('Shadow review recorded', { proposalId, review: result.rows[0] });
  return result.rows[0];
}

/**
 * Get shadow mode metrics
 *
 * Returns aggregated metrics for the specified time period.
 */
async function getShadowMetrics(options = {}) {
  const { startDate, endDate, limit = 1000 } = options;

  // Default to last 7 days
  const start = startDate || new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const end = endDate || new Date();

  // Get total proposals in period
  const proposalsResult = await db.query(`
    SELECT COUNT(*) as total,
           COUNT(CASE WHEN status = 'PENDING_APPROVAL' THEN 1 END) as pending,
           COUNT(CASE WHEN status = 'APPROVED' THEN 1 END) as approved,
           COUNT(CASE WHEN status = 'DISMISSED' THEN 1 END) as dismissed
    FROM proposals
    WHERE created_at BETWEEN $1 AND $2
  `, [start, end]);

  // Get review metrics
  const reviewsResult = await db.query(`
    SELECT
      COUNT(*) as total_reviewed,

      -- Routing correctness
      COUNT(CASE WHEN routing_correct = 'correct' THEN 1 END) as routing_correct,
      COUNT(CASE WHEN routing_correct = 'incorrect' THEN 1 END) as routing_incorrect,
      COUNT(CASE WHEN routing_correct = 'unsure' THEN 1 END) as routing_unsure,

      -- Gating correctness
      COUNT(CASE WHEN gating_correct = 'correct' THEN 1 END) as gating_correct,
      COUNT(CASE WHEN gating_correct = 'should_have_gated' THEN 1 END) as gating_should_have,
      COUNT(CASE WHEN gating_correct = 'should_not_have_gated' THEN 1 END) as gating_should_not_have,
      COUNT(CASE WHEN gating_correct = 'unsure' THEN 1 END) as gating_unsure,

      -- Draft quality
      AVG(draft_quality_score) as avg_draft_quality,
      COUNT(CASE WHEN draft_quality_score >= 4 THEN 1 END) as drafts_good,
      COUNT(CASE WHEN draft_quality_score <= 2 THEN 1 END) as drafts_poor,
      COUNT(CASE WHEN draft_quality_score IS NOT NULL THEN 1 END) as drafts_rated

    FROM shadow_reviews sr
    JOIN proposals p ON sr.proposal_id = p.id
    WHERE p.created_at BETWEEN $1 AND $2
  `, [start, end]);

  // Get classification breakdown
  const classificationResult = await db.query(`
    SELECT
      sr.correct_classification,
      COUNT(*) as count
    FROM shadow_reviews sr
    JOIN proposals p ON sr.proposal_id = p.id
    WHERE p.created_at BETWEEN $1 AND $2
      AND sr.routing_correct = 'incorrect'
      AND sr.correct_classification IS NOT NULL
    GROUP BY sr.correct_classification
    ORDER BY count DESC
  `, [start, end]);

  // Get action type breakdown
  const actionResult = await db.query(`
    SELECT
      p.action_type,
      COUNT(*) as total,
      COUNT(CASE WHEN sr.routing_correct = 'correct' THEN 1 END) as routing_correct,
      COUNT(CASE WHEN sr.gating_correct = 'correct' THEN 1 END) as gating_correct,
      AVG(sr.draft_quality_score) as avg_quality
    FROM proposals p
    LEFT JOIN shadow_reviews sr ON p.id = sr.proposal_id
    WHERE p.created_at BETWEEN $1 AND $2
    GROUP BY p.action_type
    ORDER BY total DESC
  `, [start, end]);

  // Get unreviewed proposals
  const unreviewedResult = await db.query(`
    SELECT p.id, p.action_type, p.case_id, p.status, p.created_at,
           c.case_name, c.agency_name
    FROM proposals p
    JOIN cases c ON p.case_id = c.id
    LEFT JOIN shadow_reviews sr ON p.id = sr.proposal_id
    WHERE p.created_at BETWEEN $1 AND $2
      AND sr.id IS NULL
    ORDER BY p.created_at DESC
    LIMIT $3
  `, [start, end, limit]);

  const proposals = proposalsResult.rows[0];
  const reviews = reviewsResult.rows[0];

  // Calculate percentages
  const totalReviewed = parseInt(reviews.total_reviewed) || 0;

  return {
    period: { start, end },
    mode: {
      shadow: SHADOW_MODE,
      execution: EXECUTION_MODE
    },
    proposals: {
      total: parseInt(proposals.total) || 0,
      pending: parseInt(proposals.pending) || 0,
      approved: parseInt(proposals.approved) || 0,
      dismissed: parseInt(proposals.dismissed) || 0
    },
    reviews: {
      totalReviewed,
      reviewRate: proposals.total > 0 ?
        ((totalReviewed / parseInt(proposals.total)) * 100).toFixed(1) + '%' : '0%'
    },
    routing: {
      correct: parseInt(reviews.routing_correct) || 0,
      incorrect: parseInt(reviews.routing_incorrect) || 0,
      unsure: parseInt(reviews.routing_unsure) || 0,
      accuracy: totalReviewed > 0 ?
        ((parseInt(reviews.routing_correct) / totalReviewed) * 100).toFixed(1) + '%' : 'N/A'
    },
    gating: {
      correct: parseInt(reviews.gating_correct) || 0,
      shouldHaveGated: parseInt(reviews.gating_should_have) || 0,
      shouldNotHaveGated: parseInt(reviews.gating_should_not_have) || 0,
      unsure: parseInt(reviews.gating_unsure) || 0,
      accuracy: totalReviewed > 0 ?
        ((parseInt(reviews.gating_correct) / totalReviewed) * 100).toFixed(1) + '%' : 'N/A'
    },
    draftQuality: {
      averageScore: reviews.avg_draft_quality ?
        parseFloat(reviews.avg_draft_quality).toFixed(2) : 'N/A',
      good: parseInt(reviews.drafts_good) || 0,
      poor: parseInt(reviews.drafts_poor) || 0,
      rated: parseInt(reviews.drafts_rated) || 0
    },
    misclassifications: classificationResult.rows,
    byActionType: actionResult.rows,
    unreviewedProposals: unreviewedResult.rows
  };
}

/**
 * Get recent proposals for shadow review
 */
async function getProposalsForReview(options = {}) {
  const { limit = 50, includeReviewed = false, actionType } = options;

  let query = `
    SELECT
      p.*,
      c.case_name,
      c.agency_name,
      c.agency_email,
      ar.trigger_type,
      ar.autopilot_mode,
      sr.id as review_id,
      sr.routing_correct,
      sr.gating_correct,
      sr.draft_quality_score,
      sr.reviewed_at
    FROM proposals p
    JOIN cases c ON p.case_id = c.id
    LEFT JOIN agent_runs ar ON p.run_id = ar.id
    LEFT JOIN shadow_reviews sr ON p.id = sr.proposal_id
    WHERE 1=1
  `;

  const params = [];
  let paramIndex = 1;

  if (!includeReviewed) {
    query += ` AND sr.id IS NULL`;
  }

  if (actionType) {
    query += ` AND p.action_type = $${paramIndex++}`;
    params.push(actionType);
  }

  query += ` ORDER BY p.created_at DESC LIMIT $${paramIndex++}`;
  params.push(limit);

  const result = await db.query(query, params);
  return result.rows;
}

/**
 * Get shadow review details for a proposal
 */
async function getReviewForProposal(proposalId) {
  const result = await db.query(`
    SELECT sr.*, p.action_type, p.draft_subject, p.draft_body_text,
           c.case_name, c.agency_name
    FROM shadow_reviews sr
    JOIN proposals p ON sr.proposal_id = p.id
    JOIN cases c ON p.case_id = c.id
    WHERE sr.proposal_id = $1
  `, [proposalId]);

  return result.rows[0];
}

/**
 * Export shadow review data for analysis
 */
async function exportReviewData(options = {}) {
  const { startDate, endDate, format = 'json' } = options;

  const start = startDate || new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const end = endDate || new Date();

  const result = await db.query(`
    SELECT
      p.id as proposal_id,
      p.action_type,
      p.status as proposal_status,
      p.draft_subject,
      p.created_at as proposal_created,
      c.id as case_id,
      c.case_name,
      c.agency_name,
      c.status as case_status,
      ar.trigger_type,
      ar.autopilot_mode,
      dt.classification,
      dt.classification_confidence,
      dt.sentiment,
      sr.routing_correct,
      sr.correct_classification,
      sr.gating_correct,
      sr.correct_action,
      sr.draft_quality_score,
      sr.draft_feedback,
      sr.reviewed_at,
      sr.reviewer_email
    FROM proposals p
    JOIN cases c ON p.case_id = c.id
    LEFT JOIN agent_runs ar ON p.run_id = ar.id
    LEFT JOIN decision_traces dt ON ar.id = dt.run_id
    LEFT JOIN shadow_reviews sr ON p.id = sr.proposal_id
    WHERE p.created_at BETWEEN $1 AND $2
    ORDER BY p.created_at DESC
  `, [start, end]);

  if (format === 'csv') {
    // Convert to CSV
    const rows = result.rows;
    if (rows.length === 0) return '';

    const headers = Object.keys(rows[0]);
    const csv = [
      headers.join(','),
      ...rows.map(row =>
        headers.map(h => {
          const val = row[h];
          if (val === null) return '';
          if (typeof val === 'string' && (val.includes(',') || val.includes('"'))) {
            return `"${val.replace(/"/g, '""')}"`;
          }
          return val;
        }).join(',')
      )
    ].join('\n');

    return csv;
  }

  return result.rows;
}

module.exports = {
  isShadowMode,
  logShadowModeStatus,
  recordShadowReview,
  getShadowMetrics,
  getProposalsForReview,
  getReviewForProposal,
  exportReviewData,
  SHADOW_MODE,
  EXECUTION_MODE
};
