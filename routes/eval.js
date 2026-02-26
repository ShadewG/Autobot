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
const { tasks } = require('@trigger.dev/sdk/v3');

const KNOWN_ACTION_TYPES = new Set([
    'SEND_FOLLOWUP', 'SEND_REBUTTAL', 'SEND_CLARIFICATION', 'SEND_APPEAL',
    'SEND_FEE_WAIVER_REQUEST', 'SEND_STATUS_UPDATE', 'SEND_INITIAL_REQUEST',
    'NEGOTIATE_FEE', 'ACCEPT_FEE', 'DECLINE_FEE', 'RESPOND_PARTIAL_APPROVAL',
    'SUBMIT_PORTAL', 'SEND_PDF_EMAIL', 'RESEARCH_AGENCY', 'REFORMULATE_REQUEST',
    'CLOSE_CASE', 'ESCALATE', 'NONE',
    'DISMISSED', // Special value meaning "AI should not have proposed anything"
]);

function parseId(val) {
    const id = parseInt(val, 10);
    return Number.isFinite(id) ? id : null;
}

/**
 * GET /api/eval/cases
 * List all eval cases with their latest eval run result.
 */
router.get('/cases', async (req, res) => {
    try {
        const result = await db.query(`
            SELECT
                ec.id,
                ec.proposal_id,
                ec.case_id,
                ec.trigger_message_id,
                ec.expected_action,
                ec.notes,
                ec.created_at,
                ec.simulated_subject,
                p.action_type AS proposal_action,
                c.case_name,
                c.agency_name,
                -- Latest eval run
                er.id AS last_run_id,
                er.predicted_action AS last_predicted_action,
                er.action_correct AS last_action_correct,
                er.judge_score AS last_judge_score,
                er.failure_category AS last_failure_category,
                er.ran_at AS last_ran_at
            FROM eval_cases ec
            LEFT JOIN proposals p ON p.id = ec.proposal_id
            LEFT JOIN cases c ON c.id = ec.case_id
            LEFT JOIN LATERAL (
                SELECT * FROM eval_runs
                WHERE eval_case_id = ec.id
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
            messageBody, fromEmail, subject, caseId,
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
                simulated_predicted_action, simulated_reasoning, simulated_draft_body)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
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
        const { evalCaseId } = req.body;
        const parsedId = evalCaseId ? parseId(evalCaseId) : null;
        if (evalCaseId && !parsedId) {
            return res.status(400).json({ success: false, error: 'Invalid evalCaseId' });
        }
        const payload = parsedId ? { evalCaseId: parsedId } : { runAll: true };

        const handle = await tasks.trigger('eval-decision', payload);

        res.json({ success: true, trigger_run_id: handle.id, payload });
    } catch (error) {
        console.error('Error triggering eval run:', error);
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
            FROM eval_cases ec
            LEFT JOIN eval_runs er ON er.eval_case_id = ec.id
            WHERE ec.is_active = true
        `);

        const failuresResult = await db.query(`
            SELECT failure_category, COUNT(*)::int AS count
            FROM eval_runs er
            JOIN eval_cases ec ON ec.id = er.eval_case_id
            WHERE ec.is_active = true
              AND er.failure_category IS NOT NULL
              AND er.ran_at > NOW() - INTERVAL '30 days'
            GROUP BY failure_category
            ORDER BY count DESC
        `);

        const s = result.rows[0];
        const passRate7d = s.total_7d > 0 ? s.correct_7d / s.total_7d : null;

        res.json({
            success: true,
            summary: {
                total_cases: s.total_cases,
                runs_last_7d: s.runs_last_7d,
                avg_score_7d: s.avg_score_7d ? parseFloat(s.avg_score_7d) : null,
                pass_rate_7d: passRate7d,
            },
            failure_breakdown: failuresResult.rows,
        });
    } catch (error) {
        console.error('Error fetching eval summary:', error);
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
            SELECT
                ec.id              AS eval_case_id,
                ec.proposal_id,
                ec.case_id,
                ec.expected_action,
                ec.notes,
                ec.created_at,
                p.action_type      AS ai_proposed_action,
                c.case_name,
                c.agency_name,
                c.state,
                er.id              AS last_run_id,
                er.predicted_action AS last_predicted_action,
                er.action_correct  AS last_action_correct,
                er.judge_score     AS last_judge_score,
                er.failure_category AS last_failure_category,
                er.judge_reasoning AS last_judge_reasoning,
                er.ran_at          AS last_ran_at
            FROM eval_cases ec
            LEFT JOIN proposals p ON p.id = ec.proposal_id
            LEFT JOIN cases c ON c.id = ec.case_id
            LEFT JOIN LATERAL (
                SELECT * FROM eval_runs
                WHERE eval_case_id = ec.id
                ORDER BY ran_at DESC
                LIMIT 1
            ) er ON true
            WHERE ec.is_active = true
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
