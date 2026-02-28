const express = require('express');
const router = express.Router();
const {
    db,
    portalQueue,
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

/**
 * POST /api/monitor/case/:id/trigger-portal
 * Force queue a portal submission job for manual live testing.
 */
router.post('/case/:id/trigger-portal', express.json(), async (req, res) => {
    let queuedJob = null;
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

        if (!portalQueue) {
            return res.status(503).json({ success: false, error: 'Portal queue unavailable' });
        }

        // Cancel any existing in-flight portal tasks to avoid duplicate submissions
        try {
            await db.query(
                `UPDATE portal_tasks SET status = 'CANCELLED', completed_at = NOW(),
                 completion_notes = 'Superseded by monitor portal retry'
                 WHERE case_id = $1 AND status IN ('PENDING', 'IN_PROGRESS')`,
                [caseId]
            );
        } catch (_) {}

        const baseInstructions = instructions || `Monitor-triggered portal submission for case ${caseId}`;
        const appendedResearch = research_context
            ? `${baseInstructions}\n\nCase research context:\n${research_context}`
            : baseInstructions;

        queuedJob = await portalQueue.add('portal-submit', {
            caseId,
            portalUrl: normalizedPortalUrl,
            provider: provider || caseData.portal_provider || null,
            instructions: appendedResearch
        });

        // Clear review flags so case leaves the queue
        await transitionCaseRuntimeWithRetry(caseId, 'PORTAL_STARTED', {
            substatus: 'Monitor-triggered portal submission queued',
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
            job_id: queuedJob?.id || null
        });

        notify('info', `Portal submission queued for ${caseData.case_name}`, { case_id: caseId });
        res.json({
            success: true,
            message: 'Portal submission queued',
            case_id: caseId,
            job_id: queuedJob?.id || null,
            portal_url: normalizedPortalUrl,
            monitor_case_url: `/api/monitor/case/${caseId}`
        });
    } catch (error) {
        if (queuedJob && !runtimeTransitionApplied) {
            try {
                await queuedJob.remove();
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
