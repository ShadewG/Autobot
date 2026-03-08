/**
 * Eval Routes
 *
 * API for the AI decision eval system.
 * - Mark proposals as eval cases (ground truth dataset)
 * - Trigger eval runs via Trigger.dev
 * - Fetch eval results and aggregate stats
 */

const express = require('express');
const router = express.Router();
const db = require('../services/database');
const draftQualityEvalService = require('../services/draft-quality-eval-service');
const qualityReportService = require('../services/quality-report-service');
const errorTrackingService = require('../services/error-tracking-service');
const promptPatternDatasetService = require('../services/prompt-pattern-dataset-service');
const { tasks } = require('@trigger.dev/sdk');

const AUTO_CAPTURE_NOTES_PREFIX = 'Auto-captured from monitor decision:%';
const DEDUPED_EVAL_CASES_CTE = `
    WITH ranked_eval_cases AS (
        SELECT
            ec.*,
            regexp_replace(COALESCE(ec.simulated_subject, c.case_name, ''), '<[^>]+>', '', 'g') AS normalized_case_name,
            ROW_NUMBER() OVER (
                PARTITION BY CASE
                    WHEN COALESCE(ec.notes, '') LIKE '${AUTO_CAPTURE_NOTES_PREFIX}'
                    THEN CONCAT(
                        'auto-monitor:',
                        COALESCE(
                            NULLIF(
                                lower(trim(regexp_replace(COALESCE(ec.simulated_subject, c.case_name, ''), '<[^>]+>', '', 'g'))),
                                ''
                            ),
                            COALESCE(ec.case_id::text, 'none')
                        ),
                        ':',
                        COALESCE(ec.expected_action, 'none')
                    )
                    WHEN ec.proposal_id IS NOT NULL
                    THEN CONCAT('proposal:', ec.proposal_id::text)
                    ELSE CONCAT('eval-case:', ec.id::text)
                END
                ORDER BY ec.created_at DESC, ec.id DESC
            ) AS logical_rank
        FROM eval_cases ec
        LEFT JOIN cases c ON c.id = ec.case_id
        WHERE ec.is_active = true
    ),
    deduped_eval_cases AS (
        SELECT * FROM ranked_eval_cases WHERE logical_rank = 1
    )
`;

const KNOWN_ACTION_TYPES = new Set([
    'SEND_FOLLOWUP', 'SEND_REBUTTAL', 'SEND_CLARIFICATION', 'SEND_APPEAL',
    'SEND_FEE_WAIVER_REQUEST', 'SEND_STATUS_UPDATE', 'SEND_INITIAL_REQUEST',
    'NEGOTIATE_FEE', 'ACCEPT_FEE', 'DECLINE_FEE', 'RESPOND_PARTIAL_APPROVAL',
    'SUBMIT_PORTAL', 'SEND_PDF_EMAIL', 'RESEARCH_AGENCY', 'REFORMULATE_REQUEST',
    'CLOSE_CASE', 'ESCALATE', 'NONE',
    'DISMISSED', // Special value meaning "AI should not have proposed anything"
]);

const FEEDBACK_METRICS_WINDOW_DAYS = 30;
const FEEDBACK_METRICS_CTE = `
    WITH reviewed_proposals AS (
        SELECT
            p.id AS proposal_id,
            COALESCE(NULLIF(p.action_type, ''), 'UNKNOWN') AS proposal_action_type,
            COALESCE(NULLIF(c.agency_name, ''), 'Unknown agency') AS agency_name,
            COALESCE(NULLIF(ra.intent, ''), 'UNCLASSIFIED') AS classification,
            UPPER(COALESCE(NULLIF(p.human_decision->>'action', ''), '')) AS human_action
        FROM proposals p
        LEFT JOIN cases c ON c.id = p.case_id
        LEFT JOIN response_analysis ra ON ra.message_id = p.trigger_message_id
        WHERE p.human_decided_at > NOW() - INTERVAL '${FEEDBACK_METRICS_WINDOW_DAYS} days'
    )
`;

function rate(count, total) {
    return total > 0 ? Number((count / total).toFixed(4)) : null;
}

function normalizeFeedbackBreakdown(rows, labelKey) {
    return rows.map((row) => {
        const total = Number(row.total_reviews) || 0;
        const approve = Number(row.approve_count) || 0;
        const adjust = Number(row.adjust_count) || 0;
        const dismiss = Number(row.dismiss_count) || 0;
        return {
            [labelKey]: row[labelKey],
            total_reviews: total,
            approve_count: approve,
            adjust_count: adjust,
            dismiss_count: dismiss,
            approval_rate: rate(approve, total),
            adjust_rate: rate(adjust, total),
            dismiss_rate: rate(dismiss, total),
        };
    });
}

function parseId(val) {
    const id = parseInt(val, 10);
    return Number.isFinite(id) ? id : null;
}

function parseDecimal(value, fallback) {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizeEvaluationType(value) {
    return value === 'draft_quality' ? 'draft_quality' : 'decision_quality';
}

/**
 * GET /api/eval/cases
 * List all eval cases with their latest eval run result.
 */
router.get('/cases', async (req, res) => {
    try {
        const result = await db.query(`
            ${DEDUPED_EVAL_CASES_CTE}
            SELECT
                ec.id,
                ec.proposal_id,
                ec.case_id,
                ec.trigger_message_id,
                ec.expected_action,
                ec.source_action_type,
                ec.capture_source,
                ec.feedback_action,
                ec.feedback_instruction,
                ec.feedback_reason,
                ec.feedback_decided_by,
                ec.notes,
                ec.created_at,
                ec.simulated_subject,
                p.action_type AS proposal_action,
                NULLIF(regexp_replace(COALESCE(ec.simulated_subject, c.case_name, ''), '<[^>]+>', '', 'g'), '') AS case_name,
                c.agency_name,
                -- Latest eval run
                er.id AS last_run_id,
                er.predicted_action AS last_predicted_action,
                er.action_correct AS last_action_correct,
                er.judge_score AS last_judge_score,
                er.failure_category AS last_failure_category,
                er.ran_at AS last_ran_at
            FROM deduped_eval_cases ec
            LEFT JOIN proposals p ON p.id = ec.proposal_id
            LEFT JOIN cases c ON c.id = ec.case_id
            LEFT JOIN LATERAL (
                SELECT * FROM eval_runs
                WHERE eval_case_id = ec.id
                  AND COALESCE(evaluation_type, 'decision_quality') = 'decision_quality'
                ORDER BY ran_at DESC
                LIMIT 1
            ) er ON true
            WHERE ec.is_active = true
            ORDER BY ec.created_at DESC
        `);
        res.json({ success: true, cases: result.rows });
    } catch (error) {
        console.error('Error fetching eval cases:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * POST /api/eval/cases
 * Mark a proposal as an eval case with the human-verified expected action.
 * Body: { proposalId, expectedAction, notes? }
 */
router.post('/cases', async (req, res) => {
    try {
        const { proposalId, expectedAction, notes } = req.body;

        if (!proposalId) {
            return res.status(400).json({ success: false, error: 'proposalId is required' });
        }

        if (expectedAction && !KNOWN_ACTION_TYPES.has(expectedAction)) {
            return res.status(400).json({ success: false, error: `Unknown expectedAction: ${expectedAction}` });
        }

        const proposalResult = await db.query('SELECT * FROM proposals WHERE id = $1', [proposalId]);
        const proposal = proposalResult.rows[0];
        if (!proposal) {
            return res.status(404).json({ success: false, error: 'Proposal not found' });
        }

        const result = await db.query(
            `INSERT INTO eval_cases (proposal_id, case_id, trigger_message_id, expected_action, notes)
             VALUES ($1, $2, $3, $4, $5)
             ON CONFLICT (proposal_id) DO UPDATE
               SET expected_action = EXCLUDED.expected_action,
                   notes = COALESCE(EXCLUDED.notes, eval_cases.notes),
                   is_active = true
             RETURNING *`,
            [
                proposalId,
                proposal.case_id,
                proposal.trigger_message_id || null,
                expectedAction || proposal.action_type,
                notes || null,
            ]
        );

        res.json({ success: true, eval_case: result.rows[0] });
    } catch (error) {
        console.error('Error creating eval case:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * POST /api/eval/cases/from-simulation
 * Save a simulator result as an eval case (no real proposal required).
 * Body: {
 *   expectedAction,        // correct action per human
 *   notes?,
 *   predictedAction,       // what the simulator decided
 *   reasoning,             // string[]
 *   draftBody?,            // simulated draft reply body
 *   messageBody,           // the input message text
 *   fromEmail,
 *   subject,
 *   caseId?                // real case ID if one was selected
 * }
 */
router.post('/cases/from-simulation', async (req, res) => {
    try {
        const {
            expectedAction, notes,
            predictedAction, reasoning, draftBody,
            messageBody, fromEmail, subject, caseId, attachments,
        } = req.body;

        if (!expectedAction || !KNOWN_ACTION_TYPES.has(expectedAction)) {
            return res.status(400).json({ success: false, error: `expectedAction is required and must be a known action type` });
        }
        if (!predictedAction || typeof predictedAction !== 'string' || !KNOWN_ACTION_TYPES.has(predictedAction)) {
            return res.status(400).json({ success: false, error: 'predictedAction must be a known action type' });
        }
        if (!messageBody || typeof messageBody !== 'string') {
            return res.status(400).json({ success: false, error: 'messageBody is required' });
        }

        let resolvedCaseId = null;
        if (caseId) {
            const parsed = parseInt(caseId, 10);
            if (!isNaN(parsed) && parsed > 0) {
                const caseCheck = await db.getCaseById(parsed).catch(() => null);
                if (!caseCheck) {
                    return res.status(400).json({ success: false, error: `Case ${parsed} not found` });
                }
                resolvedCaseId = parsed;
            }
        }

        const result = await db.query(
            `INSERT INTO eval_cases
               (case_id, expected_action, notes,
                simulated_message_body, simulated_from_email, simulated_subject,
                simulated_predicted_action, simulated_reasoning, simulated_draft_body,
                simulated_attachments_jsonb)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
             RETURNING *`,
            [
                resolvedCaseId,
                expectedAction,
                notes || null,
                messageBody.substring(0, 10000),
                fromEmail || null,
                subject || null,
                predictedAction,
                JSON.stringify(Array.isArray(reasoning) ? reasoning : []),
                draftBody ? draftBody.substring(0, 5000) : null,
                attachments ? JSON.stringify(attachments) : null,
            ]
        );

        res.json({ success: true, eval_case: result.rows[0] });
    } catch (error) {
        console.error('Error saving simulation eval case:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * DELETE /api/eval/cases/:id
 * Deactivate an eval case.
 */
router.delete('/cases/:id', async (req, res) => {
    try {
        const id = parseId(req.params.id);
        if (!id) return res.status(400).json({ success: false, error: 'Invalid ID' });
        await db.query('UPDATE eval_cases SET is_active = false WHERE id = $1', [id]);
        res.json({ success: true });
    } catch (error) {
        console.error('Error deleting eval case:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * POST /api/eval/run
 * Trigger an eval run.
 * Body: { evalCaseId? } — omit to run all cases.
 */
router.post('/run', async (req, res) => {
    try {
        const { evalCaseId, evaluationType } = req.body;
        const parsedId = evalCaseId ? parseId(evalCaseId) : null;
        if (evalCaseId && !parsedId) {
            return res.status(400).json({ success: false, error: 'Invalid evalCaseId' });
        }
        const normalizedEvaluationType = normalizeEvaluationType(evaluationType);
        const payload = parsedId
            ? { evalCaseId: parsedId, evaluationType: normalizedEvaluationType }
            : { runAll: true, evaluationType: normalizedEvaluationType };

        const handle = await tasks.trigger('eval-decision', payload);

        res.json({ success: true, trigger_run_id: handle.id, payload });
    } catch (error) {
        console.error('Error triggering eval run:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * POST /api/eval/capture-draft-quality
 * Capture newly resolved sent drafts into eval_cases and optionally trigger judge runs.
 * Body: { windowDays?, triggerRuns? }
 */
router.post('/capture-draft-quality', async (req, res) => {
    try {
        const parsedWindowDays = parseId(req.body?.windowDays);
        const windowDays = parsedWindowDays || 30;
        const triggerRuns = req.body?.triggerRuns !== false;

        const capture = await draftQualityEvalService.captureResolvedDraftQualityEvalCases({ windowDays });
        const triggered = [];

        if (triggerRuns && capture.captured.length > 0) {
            for (const item of capture.captured) {
                const handle = await tasks.trigger('eval-decision', {
                    evalCaseId: item.eval_case_id,
                    evaluationType: 'draft_quality',
                });
                triggered.push({
                    eval_case_id: item.eval_case_id,
                    trigger_run_id: handle.id,
                });
            }
        }

        res.json({
            success: true,
            capture,
            triggered,
        });
    } catch (error) {
        console.error('Error capturing resolved draft quality eval cases:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * GET /api/eval/summary
 * Aggregate stats for the eval dashboard header.
 */
router.get('/summary', async (req, res) => {
    try {
        const result = await db.query(`
            ${DEDUPED_EVAL_CASES_CTE}
            SELECT
                COUNT(DISTINCT ec.id)::int                                                      AS total_cases,
                COUNT(er.id) FILTER (WHERE er.ran_at > NOW() - INTERVAL '7 days')::int          AS runs_last_7d,
                ROUND(AVG(er.judge_score)
                    FILTER (WHERE er.ran_at > NOW() - INTERVAL '7 days'), 2)                    AS avg_score_7d,
                COUNT(*) FILTER (
                    WHERE er.action_correct = true
                    AND er.ran_at > NOW() - INTERVAL '7 days'
                )::int                                                                          AS correct_7d,
                COUNT(*) FILTER (
                    WHERE er.ran_at > NOW() - INTERVAL '7 days'
                )::int                                                                          AS total_7d
            FROM deduped_eval_cases ec
            LEFT JOIN eval_runs er
              ON er.eval_case_id = ec.id
             AND COALESCE(er.evaluation_type, 'decision_quality') = 'decision_quality'
        `);

        const failuresResult = await db.query(`
            ${DEDUPED_EVAL_CASES_CTE}
            SELECT failure_category, COUNT(*)::int AS count
            FROM eval_runs er
            JOIN deduped_eval_cases ec ON ec.id = er.eval_case_id
            WHERE true
              AND COALESCE(er.evaluation_type, 'decision_quality') = 'decision_quality'
              AND er.failure_category IS NOT NULL
              AND er.ran_at > NOW() - INTERVAL '30 days'
            GROUP BY failure_category
            ORDER BY count DESC
        `);

        const feedbackOverviewResult = await db.query(`
            ${FEEDBACK_METRICS_CTE}
            SELECT
                COUNT(*) FILTER (WHERE human_action IN ('APPROVE', 'ADJUST', 'DISMISS'))::int AS total_reviews,
                COUNT(*) FILTER (WHERE human_action = 'APPROVE')::int AS approve_count,
                COUNT(*) FILTER (WHERE human_action = 'ADJUST')::int AS adjust_count,
                COUNT(*) FILTER (WHERE human_action = 'DISMISS')::int AS dismiss_count
            FROM reviewed_proposals
        `);

        const feedbackByActionTypeResult = await db.query(`
            ${FEEDBACK_METRICS_CTE}
            SELECT
                proposal_action_type,
                COUNT(*) FILTER (WHERE human_action IN ('APPROVE', 'ADJUST', 'DISMISS'))::int AS total_reviews,
                COUNT(*) FILTER (WHERE human_action = 'APPROVE')::int AS approve_count,
                COUNT(*) FILTER (WHERE human_action = 'ADJUST')::int AS adjust_count,
                COUNT(*) FILTER (WHERE human_action = 'DISMISS')::int AS dismiss_count
            FROM reviewed_proposals
            WHERE human_action IN ('APPROVE', 'ADJUST', 'DISMISS')
            GROUP BY proposal_action_type
            ORDER BY total_reviews DESC, proposal_action_type ASC
        `);

        const feedbackByAgencyResult = await db.query(`
            ${FEEDBACK_METRICS_CTE}
            SELECT
                agency_name,
                COUNT(*) FILTER (WHERE human_action IN ('APPROVE', 'ADJUST', 'DISMISS'))::int AS total_reviews,
                COUNT(*) FILTER (WHERE human_action = 'APPROVE')::int AS approve_count,
                COUNT(*) FILTER (WHERE human_action = 'ADJUST')::int AS adjust_count,
                COUNT(*) FILTER (WHERE human_action = 'DISMISS')::int AS dismiss_count
            FROM reviewed_proposals
            WHERE human_action IN ('APPROVE', 'ADJUST', 'DISMISS')
            GROUP BY agency_name
            HAVING COUNT(*) FILTER (WHERE human_action IN ('APPROVE', 'ADJUST', 'DISMISS')) > 0
            ORDER BY total_reviews DESC, agency_name ASC
            LIMIT 20
        `);

        const feedbackByClassificationResult = await db.query(`
            ${FEEDBACK_METRICS_CTE}
            SELECT
                classification,
                COUNT(*) FILTER (WHERE human_action IN ('APPROVE', 'ADJUST', 'DISMISS'))::int AS total_reviews,
                COUNT(*) FILTER (WHERE human_action = 'APPROVE')::int AS approve_count,
                COUNT(*) FILTER (WHERE human_action = 'ADJUST')::int AS adjust_count,
                COUNT(*) FILTER (WHERE human_action = 'DISMISS')::int AS dismiss_count
            FROM reviewed_proposals
            WHERE human_action IN ('APPROVE', 'ADJUST', 'DISMISS')
            GROUP BY classification
            ORDER BY total_reviews DESC, classification ASC
        `);

        const s = result.rows[0];
        const passRate7d = s.total_7d > 0 ? s.correct_7d / s.total_7d : null;
        const feedbackOverview = feedbackOverviewResult.rows[0] || {};
        const totalReviews = Number(feedbackOverview.total_reviews) || 0;
        const approveCount = Number(feedbackOverview.approve_count) || 0;
        const adjustCount = Number(feedbackOverview.adjust_count) || 0;
        const dismissCount = Number(feedbackOverview.dismiss_count) || 0;

        res.json({
            success: true,
            summary: {
                total_cases: s.total_cases,
                runs_last_7d: s.runs_last_7d,
                avg_score_7d: s.avg_score_7d ? parseFloat(s.avg_score_7d) : null,
                pass_rate_7d: passRate7d,
            },
            failure_breakdown: failuresResult.rows,
            feedback_metrics: {
                window_days: FEEDBACK_METRICS_WINDOW_DAYS,
                overview: {
                    total_reviews: totalReviews,
                    approve_count: approveCount,
                    adjust_count: adjustCount,
                    dismiss_count: dismissCount,
                    approval_rate: rate(approveCount, totalReviews),
                    adjust_rate: rate(adjustCount, totalReviews),
                    dismiss_rate: rate(dismissCount, totalReviews),
                },
                by_action_type: normalizeFeedbackBreakdown(feedbackByActionTypeResult.rows, 'proposal_action_type'),
                by_agency: normalizeFeedbackBreakdown(feedbackByAgencyResult.rows, 'agency_name'),
                by_classification: normalizeFeedbackBreakdown(feedbackByClassificationResult.rows, 'classification'),
            },
        });
    } catch (error) {
        console.error('Error fetching eval summary:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * GET /api/eval/decision-quality-trend?days=30
 * Daily approval/adjust/dismiss rates for time-series charting.
 */
router.get('/decision-quality-trend', async (req, res) => {
    try {
        const days = Math.min(Math.max(parseInt(req.query.days) || 30, 7), 90);

        const result = await db.query(`
            WITH daily_decisions AS (
                SELECT
                    DATE(p.human_decided_at) AS decision_date,
                    COUNT(*) FILTER (WHERE UPPER(COALESCE(p.human_decision->>'action', '')) IN ('APPROVE', 'ADJUST', 'DISMISS'))::int AS total_reviews,
                    COUNT(*) FILTER (WHERE UPPER(COALESCE(p.human_decision->>'action', '')) = 'APPROVE')::int AS approve_count,
                    COUNT(*) FILTER (WHERE UPPER(COALESCE(p.human_decision->>'action', '')) = 'ADJUST')::int AS adjust_count,
                    COUNT(*) FILTER (WHERE UPPER(COALESCE(p.human_decision->>'action', '')) = 'DISMISS')::int AS dismiss_count
                FROM proposals p
                WHERE p.human_decided_at > NOW() - INTERVAL '1 day' * $1
                  AND UPPER(COALESCE(p.human_decision->>'action', '')) IN ('APPROVE', 'ADJUST', 'DISMISS')
                GROUP BY DATE(p.human_decided_at)
                ORDER BY decision_date ASC
            )
            SELECT
                decision_date,
                total_reviews,
                approve_count,
                adjust_count,
                dismiss_count
            FROM daily_decisions
        `, [days]);

        const trend = result.rows.map(row => {
            const total = Number(row.total_reviews) || 0;
            return {
                date: row.decision_date,
                total_reviews: total,
                approve_count: Number(row.approve_count) || 0,
                adjust_count: Number(row.adjust_count) || 0,
                dismiss_count: Number(row.dismiss_count) || 0,
                approval_rate: rate(Number(row.approve_count) || 0, total),
                adjust_rate: rate(Number(row.adjust_count) || 0, total),
                dismiss_rate: rate(Number(row.dismiss_count) || 0, total),
            };
        });

        res.json({ success: true, days, trend });
    } catch (error) {
        console.error('Error fetching decision quality trend:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * GET /api/eval/quality-report?windowDays=7
 * Build the backend weekly quality report used by cron/reporting.
 */
router.get('/quality-report', async (req, res) => {
    try {
        const windowDays = parseId(req.query.windowDays) || 7;
        const report = await qualityReportService.buildWeeklyQualityReport({ windowDays });
        res.json({ success: true, report });
    } catch (error) {
        await errorTrackingService.captureException(error, {
            sourceService: 'eval_api',
            operation: 'quality_report',
            metadata: {
                windowDays: req.query.windowDays || null,
            },
        });
        console.error('Error building quality report:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * GET /api/eval/classification-confusion?windowDays=30
 * Confusion matrix using classifier output vs inferred actual class from human-corrected actions.
 */
router.get('/classification-confusion', async (req, res) => {
    try {
        const windowDays = parseId(req.query.windowDays) || 30;
        const confusion_matrix = await qualityReportService.buildClassificationConfusionMatrix({ windowDays });
        res.json({ success: true, confusion_matrix });
    } catch (error) {
        await errorTrackingService.captureException(error, {
            sourceService: 'eval_api',
            operation: 'classification_confusion',
            metadata: {
                windowDays: req.query.windowDays || null,
            },
        });
        console.error('Error building classification confusion matrix:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * GET /api/eval/review-candidates
 * Surface recent low-confidence / "other" classifier outputs for prompt set curation.
 */
router.get('/review-candidates', async (req, res) => {
    try {
        const dataset = await promptPatternDatasetService.buildReviewCandidateDataset({
            sinceDays: parseId(req.query.sinceDays) || 30,
            limit: parseId(req.query.limit) || 500,
            perReason: parseId(req.query.perReason) || 25,
            confidenceThreshold: parseDecimal(req.query.confidenceThreshold, 0.6),
        });
        res.json({ success: true, dataset });
    } catch (error) {
        await errorTrackingService.captureException(error, {
            sourceService: 'eval_api',
            operation: 'review_candidates',
            metadata: {
                sinceDays: req.query.sinceDays || null,
                limit: req.query.limit || null,
                perReason: req.query.perReason || null,
                confidenceThreshold: req.query.confidenceThreshold || null,
            },
        });
        console.error('Error building review candidate dataset:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * GET /api/eval/reconciliation
 * System health reconciliation: dropped actions, processing errors, orphaned messages.
 */
router.get('/reconciliation', async (req, res) => {
    try {
        const report = await qualityReportService.buildReconciliationReport();
        res.json({ success: true, report });
    } catch (error) {
        await errorTrackingService.captureException(error, {
            sourceService: 'eval_api',
            operation: 'reconciliation_report',
        });
        console.error('Error building reconciliation report:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

router.get('/errors', async (req, res) => {
    try {
        const rows = await errorTrackingService.searchErrorEvents({
            sourceService: req.query.sourceService || null,
            caseId: parseId(req.query.caseId) || null,
            operation: req.query.operation || null,
            errorCode: req.query.errorCode || null,
            sinceHours: parseId(req.query.sinceHours) || null,
            search: req.query.search || null,
            limit: parseId(req.query.limit) || 50,
        });
        res.json({ success: true, errors: rows });
    } catch (error) {
        await errorTrackingService.captureException(error, {
            sourceService: 'eval_api',
            operation: 'list_error_events',
            metadata: {
                sourceService: req.query.sourceService || null,
                caseId: req.query.caseId || null,
                operationFilter: req.query.operation || null,
                sinceHours: req.query.sinceHours || null,
                limit: req.query.limit || null,
            },
        });
        console.error('Error fetching tracked errors:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * GET /api/eval/cases/:id/history
 * All eval runs for a specific eval case (for trend tracking).
 */
router.get('/cases/:id/history', async (req, res) => {
    try {
        const id = parseId(req.params.id);
        if (!id) return res.status(400).json({ success: false, error: 'Invalid ID' });
        const result = await db.query(
            `SELECT * FROM eval_runs WHERE eval_case_id = $1 ORDER BY ran_at DESC LIMIT 50`,
            [id]
        );
        res.json({ success: true, runs: result.rows });
    } catch (error) {
        console.error('Error fetching eval case history:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * GET /api/eval/export?format=csv|json
 * Export all eval cases with latest run results.
 * Default: JSON. Pass ?format=csv to download a CSV file.
 */
router.get('/export', async (req, res) => {
    try {
        const result = await db.query(`
            ${DEDUPED_EVAL_CASES_CTE}
            SELECT
                ec.id              AS eval_case_id,
                ec.proposal_id,
                ec.case_id,
                ec.expected_action,
                ec.source_action_type,
                ec.capture_source,
                ec.feedback_action,
                ec.feedback_instruction,
                ec.feedback_reason,
                ec.feedback_decided_by,
                ec.notes,
                ec.created_at,
                p.action_type      AS ai_proposed_action,
                NULLIF(regexp_replace(COALESCE(ec.simulated_subject, c.case_name, ''), '<[^>]+>', '', 'g'), '') AS case_name,
                c.agency_name,
                c.state,
                er.id              AS last_run_id,
                er.predicted_action AS last_predicted_action,
                er.action_correct  AS last_action_correct,
                er.judge_score     AS last_judge_score,
                er.failure_category AS last_failure_category,
                er.judge_reasoning AS last_judge_reasoning,
                er.ran_at          AS last_ran_at
            FROM deduped_eval_cases ec
            LEFT JOIN proposals p ON p.id = ec.proposal_id
            LEFT JOIN cases c ON c.id = ec.case_id
            LEFT JOIN LATERAL (
                SELECT * FROM eval_runs
                WHERE eval_case_id = ec.id
                  AND COALESCE(evaluation_type, 'decision_quality') = 'decision_quality'
                ORDER BY ran_at DESC
                LIMIT 1
            ) er ON true
            ORDER BY ec.created_at ASC
        `);

        if (req.query.format === 'csv') {
            const cols = [
                'eval_case_id', 'proposal_id', 'case_id', 'case_name', 'agency_name', 'state',
                'expected_action', 'ai_proposed_action', 'notes', 'created_at',
                'last_run_id', 'last_predicted_action', 'last_action_correct',
                'last_judge_score', 'last_failure_category', 'last_judge_reasoning', 'last_ran_at',
            ];

            const escape = (v) => {
                if (v == null) return '';
                const s = String(v).replace(/"/g, '""');
                return /[,"\n\r]/.test(s) ? `"${s}"` : s;
            };

            const lines = [
                cols.join(','),
                ...result.rows.map(row => cols.map(col => escape(row[col])).join(',')),
            ];

            const date = new Date().toISOString().split('T')[0];
            res.setHeader('Content-Type', 'text/csv');
            res.setHeader('Content-Disposition', `attachment; filename="eval-cases-${date}.csv"`);
            return res.send(lines.join('\n'));
        }

        res.json({ success: true, cases: result.rows, total: result.rows.length });
    } catch (error) {
        console.error('Error exporting eval cases:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

module.exports = router;
