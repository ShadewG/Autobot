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
 * DELETE /api/eval/cases/:id
 * Deactivate an eval case.
 */
router.delete('/cases/:id', async (req, res) => {
    try {
        const id = parseInt(req.params.id);
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
        const payload = evalCaseId ? { evalCaseId: parseInt(evalCaseId) } : { runAll: true };

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
                    FILTER (WHERE er.ran_at > NOW() - INTERVAL '7 days')::numeric, 2)            AS avg_score_7d,
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
        const id = parseInt(req.params.id);
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

module.exports = router;
