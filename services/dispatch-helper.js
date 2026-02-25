const db = require('./database');
const { notify } = require('./event-bus');
const { tasks } = require('@trigger.dev/sdk/v3');

/**
 * Dispatch a ready_to_send case through the Run Engine.
 * Deduplicates, creates agent_run, enqueues, logs, notifies.
 *
 * @param {number} caseId
 * @param {object} options
 * @param {string} options.source - 'reactive' | 'cron_sweep' | 'notion_sync' | 'notion_webhook'
 * @returns {{ dispatched: boolean, reason?: string, runId?: number }}
 */
async function dispatchReadyToSend(caseId, { source = 'reactive' } = {}) {
    // 1. Verify case exists and is ready_to_send (or at least not already advanced)
    const caseData = await db.getCaseById(caseId);
    if (!caseData) {
        return { dispatched: false, reason: 'case_not_found' };
    }
    const skipStatuses = ['sent', 'awaiting_response', 'portal_in_progress', 'completed', 'needs_phone_call'];
    if (skipStatuses.includes(caseData.status)) {
        return { dispatched: false, reason: `already_${caseData.status}` };
    }
    // Only dispatch cases that are actually ready_to_send
    if (caseData.status !== 'ready_to_send') {
        return { dispatched: false, reason: `unexpected_status_${caseData.status}` };
    }

    // 2. Dedup: skip if there's already an active run
    const existingRun = await db.getActiveRunForCase(caseId);
    if (existingRun) {
        return { dispatched: false, reason: 'active_run_exists', runId: existingRun.id };
    }

    // 3. Create agent_run record (catch unique constraint race from concurrent dispatchers)
    let run;
    try {
        run = await db.createAgentRunFull({
            case_id: caseId,
            trigger_type: 'initial_request',
            status: 'queued',
            autopilot_mode: 'SUPERVISED',
            langgraph_thread_id: `initial:${caseId}:${Date.now()}`,
            metadata: { source }
        });
    } catch (err) {
        if (err.code === '23505' && String(err.constraint || '').includes('one_active_per_case')) {
            return { dispatched: false, reason: 'active_run_exists' };
        }
        throw err;
    }

    // 4. Trigger Trigger.dev task (clean up run on failure)
    try {
        await tasks.trigger('process-initial-request', {
            runId: run.id,
            caseId,
            autopilotMode: 'SUPERVISED',
        });
    } catch (triggerErr) {
        await db.updateAgentRun(run.id, {
            status: 'failed',
            ended_at: new Date(),
            error: `Trigger failed: ${triggerErr.message}`
        });
        throw triggerErr;
    }

    // 5. Log + notify (fire-and-forget — don't fail dispatch on side-effect errors)
    try {
        await db.logActivity('dispatch_run_created', `Auto-dispatched initial request for case ${caseData.case_name}`, {
            case_id: caseId,
            run_id: run.id,
            source
        });
        notify('info', `Case ${caseId} dispatched (${source})`, { case_id: caseId, run_id: run.id });
    } catch (sideEffectErr) {
        console.warn(`[dispatch] Side-effect failed for case ${caseId}:`, sideEffectErr.message);
    }

    return { dispatched: true, runId: run.id };
}

module.exports = { dispatchReadyToSend };
