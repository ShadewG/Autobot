/**
 * Shadow Mode Routes
 *
 * Phase 7.1: API endpoints for shadow mode validation.
 *
 * Routes:
 * - GET  /shadow/status         - Check shadow mode status
 * - GET  /shadow/metrics        - Get aggregated metrics
 * - GET  /shadow/proposals      - Get proposals for review
 * - GET  /shadow/proposals/:id  - Get specific proposal with details
 * - POST /shadow/proposals/:id/review - Submit a review
 * - GET  /shadow/export         - Export review data (JSON/CSV)
 */

const express = require('express');
const router = express.Router();
const shadowMode = require('../services/shadow-mode');
const db = require('../services/database');
const logger = require('../services/logger');

/**
 * GET /shadow/status
 *
 * Check if shadow mode is active and get configuration
 */
router.get('/status', async (req, res) => {
  try {
    res.json({
      success: true,
      shadow_mode: shadowMode.SHADOW_MODE,
      execution_mode: shadowMode.EXECUTION_MODE,
      is_shadow: shadowMode.isShadowMode(),
      description: shadowMode.isShadowMode() ?
        'Shadow mode ACTIVE: Live ingestion, DRY execution, human review enabled' :
        'Production mode: Live execution enabled'
    });
  } catch (error) {
    logger.error('Error getting shadow status', { error: error.message });
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /shadow/metrics
 *
 * Get aggregated shadow mode metrics
 *
 * Query params:
 * - startDate: ISO date string (default: 7 days ago)
 * - endDate: ISO date string (default: now)
 */
router.get('/metrics', async (req, res) => {
  try {
    const { startDate, endDate } = req.query;

    const metrics = await shadowMode.getShadowMetrics({
      startDate: startDate ? new Date(startDate) : undefined,
      endDate: endDate ? new Date(endDate) : undefined
    });

    res.json({
      success: true,
      metrics
    });
  } catch (error) {
    logger.error('Error getting shadow metrics', { error: error.message });
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /shadow/proposals
 *
 * Get proposals for shadow review
 *
 * Query params:
 * - limit: Number of proposals (default: 50)
 * - includeReviewed: Include already reviewed (default: false)
 * - actionType: Filter by action type
 */
router.get('/proposals', async (req, res) => {
  try {
    const {
      limit = 50,
      includeReviewed = 'false',
      actionType
    } = req.query;

    const proposals = await shadowMode.getProposalsForReview({
      limit: parseInt(limit),
      includeReviewed: includeReviewed === 'true',
      actionType: actionType || undefined
    });

    res.json({
      success: true,
      count: proposals.length,
      proposals
    });
  } catch (error) {
    logger.error('Error getting proposals for review', { error: error.message });
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /shadow/proposals/:id
 *
 * Get detailed proposal information for review
 */
router.get('/proposals/:id', async (req, res) => {
  try {
    const proposalId = parseInt(req.params.id);

    // Get proposal with full context
    const proposal = await db.getProposalById(proposalId);
    if (!proposal) {
      return res.status(404).json({
        success: false,
        error: `Proposal ${proposalId} not found`
      });
    }

    // Get case data
    const caseData = await db.getCaseById(proposal.case_id);

    // Get run and decision trace
    let runData = null;
    let decisionTrace = null;
    if (proposal.run_id) {
      runData = await db.getAgentRunById(proposal.run_id);
      decisionTrace = await db.getDecisionTraceByRunId(proposal.run_id);
    }

    // Get existing review if any
    const existingReview = await shadowMode.getReviewForProposal(proposalId);

    // Get recent messages for context
    const messages = await db.getMessagesByCaseId(proposal.case_id);
    const recentMessages = messages.slice(-5); // Last 5 messages

    res.json({
      success: true,
      proposal,
      case: {
        id: caseData.id,
        case_name: caseData.case_name,
        agency_name: caseData.agency_name,
        agency_email: caseData.agency_email,
        status: caseData.status,
        autopilot_mode: caseData.autopilot_mode
      },
      run: runData ? {
        id: runData.id,
        trigger_type: runData.trigger_type,
        autopilot_mode: runData.autopilot_mode,
        status: runData.status
      } : null,
      decision_trace: decisionTrace,
      recent_messages: recentMessages.map(m => ({
        id: m.id,
        direction: m.direction,
        subject: m.subject,
        body_preview: (m.body_text || '').substring(0, 500),
        created_at: m.created_at
      })),
      existing_review: existingReview
    });
  } catch (error) {
    logger.error('Error getting proposal for review', { proposalId: req.params.id, error: error.message });
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /shadow/proposals/:id/review
 *
 * Submit a shadow review for a proposal
 *
 * Body:
 * - reviewerEmail: string (optional)
 * - routingCorrect: 'correct' | 'incorrect' | 'unsure'
 * - correctClassification: string (if routing incorrect)
 * - gatingCorrect: 'correct' | 'should_have_gated' | 'should_not_have_gated' | 'unsure'
 * - correctAction: string (if gating incorrect)
 * - draftQualityScore: 1-5
 * - draftFeedback: string (optional)
 */
router.post('/proposals/:id/review', async (req, res) => {
  try {
    const proposalId = parseInt(req.params.id);
    const {
      reviewerEmail,
      routingCorrect,
      correctClassification,
      gatingCorrect,
      correctAction,
      draftQualityScore,
      draftFeedback
    } = req.body;

    // Validate proposal exists
    const proposal = await db.getProposalById(proposalId);
    if (!proposal) {
      return res.status(404).json({
        success: false,
        error: `Proposal ${proposalId} not found`
      });
    }

    // Validate routingCorrect
    const validRouting = ['correct', 'incorrect', 'unsure'];
    if (routingCorrect && !validRouting.includes(routingCorrect)) {
      return res.status(400).json({
        success: false,
        error: `routingCorrect must be one of: ${validRouting.join(', ')}`
      });
    }

    // Validate gatingCorrect
    const validGating = ['correct', 'should_have_gated', 'should_not_have_gated', 'unsure'];
    if (gatingCorrect && !validGating.includes(gatingCorrect)) {
      return res.status(400).json({
        success: false,
        error: `gatingCorrect must be one of: ${validGating.join(', ')}`
      });
    }

    // Validate draftQualityScore
    if (draftQualityScore !== undefined) {
      const score = parseInt(draftQualityScore);
      if (isNaN(score) || score < 1 || score > 5) {
        return res.status(400).json({
          success: false,
          error: 'draftQualityScore must be between 1 and 5'
        });
      }
    }

    // Record the review
    const review = await shadowMode.recordShadowReview(proposalId, {
      reviewerEmail,
      routingCorrect,
      correctClassification,
      gatingCorrect,
      correctAction,
      draftQualityScore: draftQualityScore ? parseInt(draftQualityScore) : null,
      draftFeedback
    });

    logger.info('Shadow review submitted', { proposalId, review });

    res.json({
      success: true,
      message: 'Review recorded',
      review
    });
  } catch (error) {
    logger.error('Error submitting shadow review', { proposalId: req.params.id, error: error.message });
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /shadow/export
 *
 * Export shadow review data for analysis
 *
 * Query params:
 * - format: 'json' | 'csv' (default: json)
 * - startDate: ISO date string (default: 30 days ago)
 * - endDate: ISO date string (default: now)
 */
router.get('/export', async (req, res) => {
  try {
    const { format = 'json', startDate, endDate } = req.query;

    const data = await shadowMode.exportReviewData({
      format,
      startDate: startDate ? new Date(startDate) : undefined,
      endDate: endDate ? new Date(endDate) : undefined
    });

    if (format === 'csv') {
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename=shadow-reviews-${new Date().toISOString().split('T')[0]}.csv`);
      res.send(data);
    } else {
      res.json({
        success: true,
        count: Array.isArray(data) ? data.length : 0,
        data
      });
    }
  } catch (error) {
    logger.error('Error exporting shadow data', { error: error.message });
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /shadow/daily
 *
 * Get daily summary view (uses the shadow_mode_summary view)
 */
router.get('/daily', async (req, res) => {
  try {
    const result = await db.query(`
      SELECT * FROM shadow_mode_summary
      ORDER BY date DESC
      LIMIT 30
    `);

    res.json({
      success: true,
      count: result.rows.length,
      daily: result.rows
    });
  } catch (error) {
    logger.error('Error getting daily shadow summary', { error: error.message });
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
