const express = require('express');
const router = express.Router();
const {
    db,
    triggerDispatch,
    normalizePortalUrl,
    isSupportedPortalUrl,
    notify
} = require('./_helpers');
const { transitionCaseRuntime, CaseLockContention } = require('../../services/case-runtime');

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function transitionCaseRuntimeWithRetry(caseId, event, context = {}, options = {}) {
    const attempts = Number.isFinite(options.attempts) ? options.attempts : 4;
    const baseDelayMs = Number.isFinite(options.baseDelayMs) ? options.baseDelayMs : 150;
    let lastError = null;

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
        try {
            return await transitionCaseRuntime(caseId, event, context);
        } catch (error) {
            lastError = error;
            const isLockError = error instanceof CaseLockContention || error?.name === 'CaseLockContention';
            if (!isLockError || attempt === attempts) {
                throw error;
            }
            await sleep(baseDelayMs * attempt);
        }
    }

    throw lastError || new Error(`transitionCaseRuntimeWithRetry failed for case ${caseId}`);
}

async function getActivePortalDispatch(caseId) {
    const [activeRunResult, activeSubmissionResult, activeTaskResult] = await Promise.all([
        db.query(
            `SELECT id, status, started_at, updated_at,
                    metadata->>'portal_task_id' AS portal_task_id
             FROM agent_runs
             WHERE case_id = $1
               AND trigger_type IN ('submit_portal', 'portal_submit')
               AND status IN ('created', 'queued', 'processing', 'running', 'paused', 'waiting')
             ORDER BY COALESCE(started_at, updated_at) DESC, id DESC
             LIMIT 1`,
            [caseId]
        ),
        db.query(
            `SELECT id, run_id, skyvern_task_id, status, started_at
             FROM portal_submissions
             WHERE case_id = $1
               AND status = 'started'
             ORDER BY started_at DESC
             LIMIT 1`,
            [caseId]
        ),
        db.query(
            `SELECT id, status, proposal_id, created_at, updated_at
             FROM portal_tasks
             WHERE case_id = $1
               AND status IN ('PENDING', 'IN_PROGRESS')
             ORDER BY COALESCE(updated_at, created_at) DESC
             LIMIT 1`,
            [caseId]
        ),
    ]);

    return {
        run: activeRunResult.rows[0] || null,
        submission: activeSubmissionResult.rows[0] || null,
        portalTask: activeTaskResult.rows[0] || null,
    };
}

/**
 * POST /api/monitor/case/:id/trigger-portal
 * Force trigger a portal submission for manual live testing.
 */
router.post('/case/:id/trigger-portal', express.json(), async (req, res) => {
    let dispatchRun = null;
    let portalTaskId = null;
    let runtimeTransitionApplied = false;
    try {
        const caseId = parseInt(req.params.id);
        const { instructions = null, provider = null, portal_url = null, research_context = null } = req.body || {};

        const caseData = await db.getCaseById(caseId);
        if (!caseData) {
            return res.status(404).json({ success: false, error: `Case ${caseId} not found` });
        }

        const normalizedPortalUrl = portal_url
            ? normalizePortalUrl(String(portal_url).trim())
            : normalizePortalUrl(caseData.portal_url || '');

        if (!normalizedPortalUrl || !isSupportedPortalUrl(normalizedPortalUrl)) {
            return res.status(400).json({ success: false, error: 'Valid portal URL is required' });
        }

        if (!caseData.portal_url || caseData.portal_url !== normalizedPortalUrl || (provider && provider !== caseData.portal_provider)) {
            await db.updateCase(caseId, {
                portal_url: normalizedPortalUrl,
                portal_provider: provider || caseData.portal_provider || null
            });
        }

        if (!normalizedPortalUrl) {
            return res.status(400).json({ success: false, error: 'Case has no portal_url' });
        }

        const activeDispatch = await getActivePortalDispatch(caseId);
        if (activeDispatch.run || activeDispatch.submission || activeDispatch.portalTask) {
            return res.status(409).json({
                success: false,
                error: 'Portal submission is already active for this case',
                code: 'PORTAL_ALREADY_ACTIVE',
                active_run: activeDispatch.run,
                active_submission: activeDispatch.submission,
                active_portal_task: activeDispatch.portalTask,
            });
        }

        const baseInstructions = instructions || `Monitor-triggered portal submission for case ${caseId}`;
        const appendedResearch = research_context
            ? `${baseInstructions}\n\nCase research context:\n${research_context}`
            : baseInstructions;

        const portalTaskResult = await db.query(
            `INSERT INTO portal_tasks (case_id, portal_url, action_type, status, instructions)
             VALUES ($1, $2, 'SUBMIT_VIA_PORTAL', 'PENDING', $3)
             RETURNING id`,
            [caseId, normalizedPortalUrl, appendedResearch]
        );
        portalTaskId = portalTaskResult.rows[0]?.id || null;

        dispatchRun = await db.createAgentRunFull({
            case_id: caseId,
            trigger_type: 'submit_portal',
            status: 'queued',
            autopilot_mode: caseData.autopilot_mode || 'SUPERVISED',
            langgraph_thread_id: `monitor-portal:${caseId}:${portalTaskId || Date.now()}`,
            metadata: {
                source: 'monitor_portal_trigger',
                portal_task_id: portalTaskId,
            }
        });

        const { handle } = await triggerDispatch.triggerTask('submit-portal', {
            caseId,
            portalUrl: normalizedPortalUrl,
            provider: provider || caseData.portal_provider || null,
            instructions: appendedResearch,
            portalTaskId,
            agentRunId: dispatchRun.id,
        }, {
            queue: `case-${caseId}`,
            idempotencyKey: `monitor-portal:${caseId}:${portalTaskId || dispatchRun.id}`,
            idempotencyKeyTTL: '1h',
        }, {
            runId: dispatchRun.id,
            caseId,
            triggerType: 'submit_portal',
            source: 'monitor_portal_trigger',
        });

        // Clear review flags so case leaves the queue
        await transitionCaseRuntimeWithRetry(caseId, 'PORTAL_STARTED', {
            substatus: 'Monitor-triggered portal submission queued',
            portalTaskId: portalTaskId || undefined,
            runId: dispatchRun.id || undefined,
            portalMetadata: {
                last_portal_status: 'Portal submission queued (monitor trigger)',
                last_portal_status_at: new Date().toISOString(),
            },
        });
        runtimeTransitionApplied = true;

        // Dismiss pending proposals — human chose portal retry
        try {
            await db.query(
                `UPDATE proposals SET status = 'DISMISSED', updated_at = NOW()
                 WHERE case_id = $1 AND status IN ('PENDING_APPROVAL', 'BLOCKED')`,
                [caseId]
            );
        } catch (_) {}

        await db.logActivity('monitor_portal_trigger', `Portal submission queued from monitor for case ${caseId}`, {
            case_id: caseId,
            portal_url: normalizedPortalUrl,
            provider: provider || caseData.portal_provider || null,
            portal_task_id: portalTaskId || null,
            run_id: dispatchRun.id || null,
            trigger_run_id: handle?.id || null,
        });

        notify('info', `Portal submission queued for ${caseData.case_name}`, { case_id: caseId });
        res.json({
            success: true,
            message: 'Portal submission queued',
            case_id: caseId,
            portal_task_id: portalTaskId || null,
            run_id: dispatchRun.id || null,
            trigger_run_id: handle?.id || null,
            portal_url: normalizedPortalUrl,
            monitor_case_url: `/api/monitor/case/${caseId}`
        });
    } catch (error) {
        if (dispatchRun && !runtimeTransitionApplied) {
            try {
                await db.updateAgentRun(dispatchRun.id, { status: 'failed', error: String(error?.message || error) });
            } catch (_) {}
        }
        if (portalTaskId && !runtimeTransitionApplied) {
            try {
                await db.query(
                    `UPDATE portal_tasks
                     SET status = 'CANCELLED',
                         updated_at = NOW(),
                         completion_notes = $2
                     WHERE id = $1
                       AND status = 'PENDING'`,
                    [portalTaskId, `Monitor trigger failed before dispatch: ${String(error?.message || error).substring(0, 300)}`]
                );
            } catch (_) {}
        }
        if (error?.name === 'CaseLockContention') {
            return res.status(409).json({
                success: false,
                error: 'Case is currently processing another transition. Please retry in a few seconds.',
            });
        }
        res.status(500).json({ success: false, error: error.message });
    }
});

module.exports = router;
