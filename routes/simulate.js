/**
 * Simulate Route
 *
 * Runs the decision pipeline in dry_run mode against a fake agency email.
 * No case data, messages, executions, or emails are written.
 *
 * POST /api/simulate       - trigger simulate-decision task, return runId
 * GET  /api/simulate/:runId - poll Trigger.dev for run status + output
 * GET  /api/simulate/cases  - list active cases for context dropdown
 */

const express = require('express');
const router = express.Router();
const { tasks, runs } = require('@trigger.dev/sdk/v3');
const db = require('../services/database');
const logger = console;

// POST /api/simulate
// Body: { messageBody, fromEmail, subject, caseId?, hasAttachments? }
router.post('/', express.json({ limit: '100kb' }), async (req, res) => {
    try {
        const { messageBody, fromEmail, subject, caseId, hasAttachments, isPortalNotification } = req.body;

        if (!messageBody || typeof messageBody !== 'string' || messageBody.trim().length < 10) {
            return res.status(400).json({ success: false, error: 'messageBody is required (min 10 chars)' });
        }
        if (!fromEmail || typeof fromEmail !== 'string') {
            return res.status(400).json({ success: false, error: 'fromEmail is required' });
        }
        if (!subject || typeof subject !== 'string') {
            return res.status(400).json({ success: false, error: 'subject is required' });
        }

        // Validate caseId if provided
        let resolvedCaseId = null;
        if (caseId) {
            const parsed = parseInt(caseId, 10);
            if (!isNaN(parsed) && parsed > 0) {
                const caseData = await db.getCaseById(parsed).catch(() => null);
                if (!caseData) {
                    return res.status(404).json({ success: false, error: `Case ${parsed} not found` });
                }
                resolvedCaseId = parsed;
            }
        }

        const handle = await tasks.trigger('simulate-decision', {
            messageBody: messageBody.trim(),
            fromEmail: fromEmail.trim(),
            subject: subject.trim(),
            caseId: resolvedCaseId,
            hasAttachments: !!hasAttachments,
            isPortalNotification: !!isPortalNotification,
        });

        res.json({ success: true, runId: handle.id });
    } catch (error) {
        console.error('[simulate] POST error:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// GET /api/simulate/cases
// Returns a minimal list of active cases for the context dropdown
router.get('/cases', async (req, res) => {
    try {
        const result = await db.query(
            `SELECT id, subject_name, agency_name, status, state
             FROM cases
             WHERE status NOT IN ('completed', 'closed', 'cancelled')
             ORDER BY updated_at DESC
             LIMIT 100`
        );
        res.json({ success: true, cases: result.rows });
    } catch (error) {
        console.error('[simulate] GET /cases error:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// GET /api/simulate/:runId
// Poll Trigger.dev for run status. Returns output when COMPLETED.
router.get('/:runId', async (req, res) => {
    try {
        const { runId } = req.params;
        if (!runId || typeof runId !== 'string') {
            return res.status(400).json({ success: false, error: 'runId is required' });
        }

        const run = await runs.retrieve(runId);

        if (!run) {
            return res.status(404).json({ success: false, error: 'Run not found' });
        }

        if (run.status === 'COMPLETED') {
            return res.json({
                success: true,
                status: 'COMPLETED',
                output: run.output,
            });
        }

        if (run.status === 'FAILED' || run.status === 'CRASHED' || run.status === 'CANCELED') {
            return res.json({
                success: false,
                status: run.status,
                error: run.output?.message || `Simulation ${run.status.toLowerCase()}`,
            });
        }

        // Still running
        res.json({
            success: true,
            status: run.status,
            output: null,
        });
    } catch (error) {
        console.error('[simulate] GET /:runId error:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

module.exports = router;
