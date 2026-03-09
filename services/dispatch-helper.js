const db = require('./database');
const { notify } = require('./event-bus');
const triggerDispatch = require('./trigger-dispatch-service');
const aiService = require('./ai-service');
const { evaluateImportAutoDispatchSafety } = require('../utils/request-normalization');

function canMaterializeReadyToSendLocally(caseData) {
    return (
        process.env.NODE_ENV !== 'production' &&
        !process.env.TRIGGER_SECRET_KEY &&
        Boolean(caseData?.agency_email) &&
        !caseData?.portal_url
    );
}

async function materializeReadyToSendLocally(caseData, run, source) {
    const generated = await aiService.generateFOIARequest(caseData);
    const subject =
        generated.subject ||
        `Public Records Request - ${caseData.subject_name || 'Records Request'}`;
    const bodyText = generated.body || generated.requestText || generated.request_text;

    if (!bodyText || typeof bodyText !== 'string' || !bodyText.trim()) {
        throw new Error(`Local ready_to_send materialization generated an empty draft for case ${caseData.id}`);
    }

    const bodyHtml = generated.body_html || null;
    const proposal = await db.upsertProposal({
        proposalKey: `${caseData.id}:initial:SEND_INITIAL_REQUEST:0`,
        caseId: caseData.id,
        runId: run.id,
        triggerMessageId: null,
        actionType: 'SEND_INITIAL_REQUEST',
        draftSubject: subject,
        draftBodyText: bodyText,
        draftBodyHtml: bodyHtml,
        reasoning: [
            `Locally materialized initial request for ${caseData.agency_name}`,
            `Delivery: Email: ${caseData.agency_email}`,
            `Autopilot: SUPERVISED`,
        ],
        canAutoExecute: false,
        requiresHuman: true,
        status: 'PENDING_APPROVAL',
        gateOptions: ['APPROVE', 'ADJUST', 'DISMISS', 'WITHDRAW'],
    });

    await db.updateProposal(proposal.id, {
        waitpoint_token: `local-ready-to-send:${caseData.id}:${run.id}`,
    });

    await db.updateAgentRun(run.id, {
        status: 'waiting',
        started_at: new Date(),
        metadata: {
            ...(run.metadata || {}),
            source,
            local_materialized_initial_request: true,
            proposalId: proposal.id,
        },
    });

    try {
        await db.logActivity('dispatch_run_created', `Locally materialized initial request for case ${caseData.case_name}`, {
            case_id: caseData.id,
            run_id: run.id,
            proposal_id: proposal.id,
            source,
            local_materialized: true,
        });
        notify('info', `Case ${caseData.id} locally materialized (${source})`, {
            case_id: caseData.id,
            run_id: run.id,
            proposal_id: proposal.id,
        });
    } catch (sideEffectErr) {
        console.warn(`[dispatch] Local materialization side-effect failed for case ${caseData.id}:`, sideEffectErr.message);
    }

    return { dispatched: true, runId: run.id, localFallback: true, proposalId: proposal.id };
}

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

    const importSafety = evaluateImportAutoDispatchSafety({
        caseName: caseData.case_name,
        subjectName: caseData.subject_name,
        agencyName: caseData.agency_name,
        state: caseData.state,
        additionalDetails: caseData.additional_details,
        importWarnings: caseData.import_warnings,
        agencyEmail: caseData.agency_email,
        portalUrl: caseData.portal_url,
    });
    if (importSafety.shouldBlockAutoDispatch) {
        const reasonDetail = importSafety.metadataMismatch?.expectedAgencyName
            ? `Imported case agency does not match case details (${importSafety.metadataMismatch.expectedAgencyName})`
            : importSafety.agencyStateMismatch
                ? `Imported case state (${importSafety.agencyStateMismatch.caseState}) does not match routed agency state (${importSafety.agencyStateMismatch.agencyState})`
            : importSafety.reasonCode === 'PLACEHOLDER_TITLE'
                ? 'Imported case title/subject is still placeholder text'
                : 'Imported case needs human review before auto-dispatch';
        try {
            await db.query(
                `UPDATE cases
                    SET status = 'needs_human_review',
                        substatus = $2,
                        updated_at = NOW()
                  WHERE id = $1`,
                [caseId, reasonDetail]
            );
            await db.logActivity('import_dispatch_blocked', reasonDetail, {
                case_id: caseId,
                source,
                reason_code: importSafety.reasonCode,
                expected_agency_name: importSafety.metadataMismatch?.expectedAgencyName || null,
            });
        } catch (err) {
            console.warn(`[dispatch] Failed to persist blocked import status for case ${caseId}:`, err.message);
        }
        return { dispatched: false, reason: 'unsafe_import_routing' };
    }

    // Don't dispatch if there's already a pending proposal waiting for human review
    const pendingProposal = await db.query(
        `SELECT id FROM proposals WHERE case_id = $1 AND status IN ('PENDING_APPROVAL', 'BLOCKED') LIMIT 1`,
        [caseId]
    );
    if (pendingProposal.rows.length > 0) {
        return { dispatched: false, reason: 'pending_proposal_exists' };
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
        if (canMaterializeReadyToSendLocally(caseData)) {
            return await materializeReadyToSendLocally(caseData, run, source);
        }

        await triggerDispatch.triggerTask('process-initial-request', {
            runId: run.id,
            caseId,
            autopilotMode: 'SUPERVISED',
        }, {
            queue: `case-${caseId}`,
            idempotencyKey: `ready-to-send:${caseId}:${run.id}`,
            idempotencyKeyTTL: '1h',
        }, {
            runId: run.id,
            caseId,
            triggerType: 'initial_request',
            source,
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
