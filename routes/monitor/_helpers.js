const db = require('../../services/database');
const sgMail = require('@sendgrid/mail');
const { wait: triggerWait } = require('@trigger.dev/sdk/v3');
const triggerDispatch = require('../../services/trigger-dispatch-service');
const { portalQueue } = require('../../queues/email-queue');
const crypto = require('crypto');
const { normalizePortalUrl, isSupportedPortalUrl, detectPortalProviderByUrl } = require('../../utils/portal-utils');
const { eventBus, notify, emitDataUpdate } = require('../../services/event-bus');
const { transitionCaseRuntime } = require('../../services/case-runtime');
const pdContactService = require('../../services/pd-contact-service');

// Initialize SendGrid
if (process.env.SENDGRID_API_KEY) {
    sgMail.setApiKey(process.env.SENDGRID_API_KEY);
}

// Trigger.dev queue + idempotency options for per-case concurrency control
function triggerOpts(caseId, taskType, uniqueId) {
  return {
    queue: `case-${caseId}`,
    idempotencyKey: `${taskType}:${caseId}:${uniqueId || Date.now()}`,
    idempotencyKeyTTL: "1h",
  };
}

// NOTE: idempotency keys take precedence over debounce, so we omit them here
function triggerOptsDebounced(caseId, taskType, uniqueId) {
  return {
    queue: `case-${caseId}`,
    debounce: { key: `${taskType}:${caseId}`, delay: "5s", mode: "trailing" },
  };
}

async function autoCaptureEvalCase(proposal, { action, instruction = null, reason = null, decidedBy = null } = {}) {
    try {
        if (!proposal?.id) return;
        const expectedAction = action === 'DISMISS' ? 'DISMISSED' : proposal.action_type;
        const notesParts = [
            `Auto-captured from monitor decision: ${action}`,
            instruction ? `Instruction: ${instruction}` : null,
            reason ? `Reason: ${reason}` : null,
            decidedBy ? `Decided by: ${decidedBy}` : null,
        ].filter(Boolean);

        await db.query(
            `INSERT INTO eval_cases (proposal_id, case_id, trigger_message_id, expected_action, notes)
             VALUES ($1, $2, $3, $4, $5)
             ON CONFLICT (proposal_id) DO UPDATE
               SET expected_action = EXCLUDED.expected_action,
                   notes = EXCLUDED.notes,
                   is_active = true`,
            [
                proposal.id,
                proposal.case_id || null,
                proposal.trigger_message_id || null,
                expectedAction,
                notesParts.join(' | ') || null,
            ]
        );
    } catch (err) {
        // Non-blocking: never fail the human decision flow due to eval capture.
        console.warn(`Auto eval-case capture failed for proposal ${proposal?.id}: ${err.message}`);
    }
}

function normalizeProposalReasoning(row, context = {}) {
    const base = Array.isArray(row?.reasoning) ? row.reasoning.filter(Boolean) : [];
    const genericOnly = base.length > 0 && base.every((line) => /human review resolution: action=/i.test(String(line)));
    const hasUnknown = base.some((line) => /unknown review action/i.test(String(line)));
    const shouldExpand = base.length === 0 || genericOnly || hasUnknown;
    if (!shouldExpand) return base;

    const action = String((context.reviewAction || 'reprocess')).toLowerCase();
    const expanded = [
        `This proposal was generated after a human review decision (${action}).`,
    ];
    if (context.reviewInstruction) {
        expanded.push(`Instruction provided: ${context.reviewInstruction}`);
    } else {
        expanded.push('No specific instruction was found on the latest review decision for this case.');
    }
    expanded.push('The system could not select a concrete next action with high confidence, so it escalated for clearer guidance.');
    return expanded;
}

function deriveMessageSource(message) {
    if (!message) return 'unknown';
    if (message.message_type === 'manual_trigger') return 'manual trigger clone';
    if (message.message_type === 'simulated_inbound') return 'simulated inbound';
    if ((message.message_id || '').startsWith('monitor:')) return 'manual trigger clone';
    return 'webhook inbound';
}

function uniqStrings(values = []) {
    return [...new Set(values.filter(Boolean).map((v) => String(v).trim()).filter(Boolean))];
}

function extractAttachmentInsights(attachments = []) {
    const text = attachments.map((a) => a.extracted_text || '').join('\n');
    const hasExtractedText = text.trim().length > 0;

    const feeMatches = [...text.matchAll(/\$\s?([0-9]{1,3}(?:,[0-9]{3})*(?:\.[0-9]{2})?)/g)]
        .map((m) => Number(String(m[1]).replace(/,/g, '')))
        .filter((n) => Number.isFinite(n) && n >= 0);
    const feeAmounts = [...new Set(feeMatches)].slice(0, 5);

    const dateMatches = [
        ...text.matchAll(/\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/g),
        ...text.matchAll(/\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\s+\d{1,2},\s+\d{4}\b/gi),
    ].map((m) => m[0]);
    const deadlineMentions = uniqStrings(dateMatches).slice(0, 6);

    const lines = text
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l.length >= 12);
    const highlightLines = uniqStrings(
        lines.filter((l) => /(fee|invoice|payment|due|deadline|business day|waiver|appeal|denial|exempt|redact)/i.test(l))
    ).slice(0, 4);

    const filenameSignals = uniqStrings(
        attachments.flatMap((a) => {
            const name = String(a.filename || '').toLowerCase();
            const out = [];
            if (!name) return out;
            if (/(invoice|billing|bill|receipt|fee|cost|quote)/i.test(name)) out.push('possible_fee_document');
            if (/(denial|reject|withhold|exempt|appeal)/i.test(name)) out.push('possible_denial_document');
            if (/(report|records|response|release|disclosure)/i.test(name)) out.push('possible_records_document');
            if (/(deadline|due|notice)/i.test(name)) out.push('possible_deadline_document');
            return out;
        })
    );

    return {
        total: attachments.length,
        has_pdf: attachments.some((a) => (a.content_type || '').toLowerCase().includes('pdf')),
        has_extracted_text: hasExtractedText,
        fee_amounts: feeAmounts,
        deadline_mentions: deadlineMentions,
        highlights: highlightLines,
        filename_signals: filenameSignals
    };
}

async function queueInboundRunForMessage(message, { autopilotMode = 'SUPERVISED', force_new_run = false } = {}) {
    const caseData = message.case_id ? await db.getCaseById(message.case_id) : null;
    if (!caseData) {
        throw new Error('Message is not associated with a case');
    }

    const existingRun = await db.getActiveRunForCase(caseData.id);
    if (existingRun) {
        if (!force_new_run) {
            const err = new Error('Case already has an active agent run');
            err.status = 409;
            err.payload = {
                activeRun: {
                    id: existingRun.id,
                    status: existingRun.status,
                    trigger_type: existingRun.trigger_type,
                    started_at: existingRun.started_at
                }
            };
            throw err;
        }

        await db.query(`
            UPDATE agent_runs
            SET status = 'failed',
                ended_at = NOW(),
                error = 'Cancelled by monitor trigger force_new_run'
            WHERE id = $1
        `, [existingRun.id]);
    }

    const run = await db.createAgentRunFull({
        case_id: caseData.id,
        trigger_type: 'inbound_message',
        status: 'queued',
        message_id: message.id,
        autopilot_mode: autopilotMode,
        langgraph_thread_id: `case:${caseData.id}:msg-${message.id}`
    });

    const { handle } = await triggerDispatch.triggerTask('process-inbound', {
        runId: run.id,
        caseId: caseData.id,
        messageId: message.id,
        autopilotMode,
    }, triggerOpts(caseData.id, 'monitor-inbound', message.id));

    return {
        caseData,
        run,
        job: { id: handle.id }
    };
}

async function processProposalDecision(proposalId, action, { instruction = null, reason = null, route_mode = null, decidedBy = 'monitor', userId = null } = {}) {
    const allowedActions = ['APPROVE', 'ADJUST', 'DISMISS', 'RETRY_RESEARCH'];
    if (!allowedActions.includes(action)) {
        const err = new Error(`action must be one of: ${allowedActions.join(', ')}`);
        err.status = 400;
        throw err;
    }

    const proposal = await db.getProposalById(proposalId);
    if (!proposal) {
        const err = new Error(`Proposal ${proposalId} not found`);
        err.status = 404;
        throw err;
    }

    if (proposal.status !== 'PENDING_APPROVAL') {
        const err = new Error(`Proposal is not pending approval`);
        err.status = 409;
        err.payload = { current_status: proposal.status };
        throw err;
    }

    // Server-side gate validation: if proposal has gate_options, verify action is allowed
    if (proposal.gate_options && Array.isArray(proposal.gate_options)) {
        if (!proposal.gate_options.includes(action)) {
            const err = new Error(`Action '${action}' is not allowed for this proposal. Allowed: ${proposal.gate_options.join(', ')}`);
            err.status = 400;
            throw err;
        }
    }

    const caseId = proposal.case_id;
    const existingRun = await db.getActiveRunForCase(caseId);
    if (existingRun) {
        // Paused/waiting runs are safe to complete — they're waiting on human decision.
        if (['paused', 'waiting'].includes(existingRun.status)) {
            await db.updateAgentRun(existingRun.id, {
                status: 'completed',
                ended_at: new Date()
            });
        } else if (['queued', 'created'].includes(existingRun.status)) {
            // Queued/created runs may still execute in Trigger.dev — only complete if stale (>2min)
            const runAge = Date.now() - new Date(existingRun.started_at || existingRun.created_at).getTime();
            if (runAge > 120000) {
                await db.updateAgentRun(existingRun.id, {
                    status: 'completed',
                    ended_at: new Date()
                });
            } else {
                const err = new Error('Case has a recently queued agent run — wait for it to complete or try again shortly');
                err.status = 409;
                err.payload = { activeRun: { id: existingRun.id, status: existingRun.status, trigger_type: existingRun.trigger_type } };
                throw err;
            }
        } else if (existingRun.status === 'running') {
            const err = new Error('Case already has an active agent run');
            err.status = 409;
            err.payload = { activeRun: { id: existingRun.id, status: existingRun.status, trigger_type: existingRun.trigger_type } };
            throw err;
        }
    }

    const trimmedInstruction = typeof instruction === 'string' ? instruction.trim() : '';

    const humanDecision = {
        action,
        proposalId,
        instruction: trimmedInstruction || null,
        route_mode,
        reason,
        decidedAt: new Date().toISOString(),
        decidedBy: userId || decidedBy
    };

    if (action === 'RETRY_RESEARCH') {
        const humanDecisionForRetry = {
            action,
            proposalId,
            instruction: null,
            route_mode,
            reason: reason || 'User requested research retry',
            decidedAt: new Date().toISOString(),
            decidedBy: userId || decidedBy
        };

        // Dismiss the current proposal
        await db.updateProposal(proposalId, {
            human_decision: humanDecisionForRetry,
            status: 'DISMISSED'
        });

        // Clear old research notes but preserve audit trail
        await db.updateCase(caseId, {
            contact_research_notes: JSON.stringify({ cleared: true, retryReason: 'user_retry', previouslyClearedAt: new Date().toISOString() }),
        });

        // Find the latest inbound message for re-triggering
        const latestInbound = await db.query(
            `SELECT id FROM messages WHERE case_id = $1 AND direction = 'inbound' ORDER BY COALESCE(received_at, created_at) DESC LIMIT 1`,
            [caseId]
        );
        const messageId = latestInbound.rows[0]?.id || proposal.trigger_message_id || null;

        let handle;
        try {
            handle = (await triggerDispatch.triggerTask('process-inbound', {
                runId: 0,
                caseId,
                messageId,
                autopilotMode: proposal.autopilot_mode || 'SUPERVISED',
                triggerType: 'HUMAN_REVIEW_RESOLUTION',
                reviewAction: 'RETRY_RESEARCH',
                reviewInstruction: 'Research failed previously. Retry agency research from scratch.',
            }, triggerOpts(caseId, 'retry-research', proposalId))).handle;
        } catch (triggerError) {
            // Roll back proposal to PENDING_APPROVAL if dispatch fails
            await db.updateProposal(proposalId, {
                status: 'PENDING_APPROVAL',
                human_decision: null
            });
            await db.logActivity('proposal_dispatch_failed', `Retry research for proposal #${proposalId} failed to dispatch: ${triggerError.message}`, {
                case_id: caseId,
                proposal_id: proposalId,
                error: triggerError.message
            });
            throw triggerError;
        }

        await db.logActivity('proposal_retry_research', `Research retry triggered for proposal #${proposalId} — re-processing case ${caseId}`, {
            case_id: caseId,
            proposal_id: proposalId,
            trigger_run_id: handle.id,
            user_id: userId || undefined
        });
        notify('info', `Research retry started for case ${caseId}`, { case_id: caseId });
        emitDataUpdate('proposal_update', { case_id: caseId, proposal_id: proposalId, action });
        return {
            success: true,
            message: 'Research retry started. A new research proposal will be generated.',
            proposal_id: proposalId,
            action,
            trigger_run_id: handle.id
        };
    }

    if (action === 'DISMISS') {
        await db.updateProposal(proposalId, {
            human_decision: humanDecision,
            status: 'DISMISSED'
        });
        await autoCaptureEvalCase(proposal, { action, instruction: trimmedInstruction, reason, decidedBy: userId || decidedBy });

        // Auto-learn from dismissal so AI doesn't repeat the same mistake
        try {
            const decisionMemory = require('../../services/decision-memory-service');
            const caseData = await db.getCaseById(caseId);
            await decisionMemory.learnFromOutcome({
                category: 'general',
                triggerPattern: `dismissed ${proposal.action_type} for ${caseData?.agency_name || 'unknown agency'}`,
                lesson: `Do not propose ${proposal.action_type} for case #${caseId} (${caseData?.case_name || 'unknown'}) — it was dismissed by human reviewer.${reason ? ' Reason: ' + reason : ''}`,
                sourceCaseId: caseId,
                priority: 6
            });
        } catch (_) {}

        await db.logActivity('proposal_dismissed', `Proposal #${proposalId} (${proposal.action_type}) dismissed${reason ? ': ' + reason : ''}`, { case_id: caseId, user_id: userId || undefined });
        notify('info', `Proposal dismissed for case ${caseId}`, { case_id: caseId });
        emitDataUpdate('proposal_update', { case_id: caseId, proposal_id: proposalId, action: 'DISMISS' });

        // Reconcile case state so it doesn't stay orphaned in a review status
        const remaining = await db.query(
            `SELECT 1 FROM proposals WHERE case_id = $1 AND status IN ('PENDING_APPROVAL','BLOCKED') LIMIT 1`,
            [caseId]
        );
        if (remaining.rows.length === 0) {
            const caseRow = await db.getCaseById(caseId);
            if (caseRow?.requires_human) {
                const REVIEW_STATUSES = ['needs_human_review','needs_phone_call','needs_contact_info','needs_human_fee_approval'];
                if (REVIEW_STATUSES.includes(caseRow.status)) {
                    const hasInbound = await db.query(`SELECT 1 FROM messages WHERE case_id = $1 AND direction = 'inbound' LIMIT 1`, [caseId]);
                    const targetStatus = hasInbound.rows.length > 0 ? 'responded' : 'awaiting_response';
                    await transitionCaseRuntime(caseId, 'CASE_RECONCILED', { targetStatus });
                    console.log(`[reconcile] Case ${caseId}: cleared review state ${caseRow.status} → ${targetStatus}`);
                } else {
                    await transitionCaseRuntime(caseId, 'CASE_RECONCILED', { targetStatus: caseRow.status });
                    console.log(`[reconcile] Case ${caseId}: cleared stale flags (status: ${caseRow.status})`);
                }
            }
        }

        return {
            success: true,
            message: 'Proposal dismissed',
            proposal_id: proposalId,
            action
        };
    }

    // ESCALATE is a human-routing placeholder. Approving it should always include
    // guidance and then reprocess to produce a concrete next proposal.
    if (proposal.action_type === 'ESCALATE' && action === 'APPROVE') {
        if (!trimmedInstruction) {
            const err = new Error('Instruction is required when approving an ESCALATE proposal');
            err.status = 400;
            throw err;
        }

        await db.updateProposal(proposalId, {
            human_decision: humanDecision,
            status: 'DISMISSED'
        });
        await autoCaptureEvalCase(proposal, { action, instruction: trimmedInstruction, reason, decidedBy: userId || decidedBy });

        let handle;
        try {
            handle = (await triggerDispatch.triggerTask('process-inbound', {
                runId: 0, // task creates canonical agent_run
                caseId,
                messageId: proposal.trigger_message_id || null,
                autopilotMode: proposal.autopilot_mode || 'SUPERVISED',
                triggerType: 'HUMAN_REVIEW_RESOLUTION',
                reviewAction: 'custom',
                reviewInstruction: trimmedInstruction,
            }, triggerOpts(caseId, 'escalate-guided', proposalId))).handle;
        } catch (triggerError) {
            // Keep it actionable if dispatch fails.
            await db.updateProposal(proposalId, {
                status: 'PENDING_APPROVAL',
                human_decision: null
            });
            await db.logActivity('proposal_dispatch_failed', `Guided reprocess for proposal #${proposalId} failed to dispatch: ${triggerError.message}`, {
                case_id: caseId,
                proposal_id: proposalId,
                error: triggerError.message
            });
            throw triggerError;
        }

        await db.logActivity('proposal_guided_reprocess', `ESCALATE converted to guided reprocess for proposal #${proposalId}`, {
            case_id: caseId,
            proposal_id: proposalId,
            instruction: trimmedInstruction,
            trigger_run_id: handle.id
        });
        notify('info', `Guided reprocess started for case ${caseId}`, { case_id: caseId });
        emitDataUpdate('proposal_update', { case_id: caseId, proposal_id: proposalId, action });
        return {
            success: true,
            message: 'Guided reprocess started. A new concrete proposal will be generated.',
            proposal_id: proposalId,
            action,
            trigger_run_id: handle.id
        };
    }

    // SEND_PDF_EMAIL: Execute directly — these proposals are created outside
    // the LangGraph flow so there's no checkpoint to resume from.
    if (proposal.action_type === 'SEND_PDF_EMAIL') {
        const caseData = await db.getCaseById(caseId);
        const targetEmail = caseData?.agency_email;
        if (!targetEmail) {
            const err = new Error(`Cannot send PDF email: no agency_email on case ${caseId}`);
            err.status = 400;
            throw err;
        }

        // Find the filled PDF attachment
        const attachments = await db.getAttachmentsByCaseId(caseId);
        const pdfAttachment = attachments.find(a =>
            a.filename?.startsWith('filled_') && a.content_type === 'application/pdf'
        );
        if (!pdfAttachment) {
            const err = new Error('No filled PDF attachment found for this case');
            err.status = 400;
            throw err;
        }

        // Read PDF from disk or DB
        const fs = require('fs');
        let pdfBuffer;
        if (pdfAttachment.storage_path && fs.existsSync(pdfAttachment.storage_path)) {
            pdfBuffer = fs.readFileSync(pdfAttachment.storage_path);
        } else {
            const fullAtt = await db.getAttachmentById(pdfAttachment.id);
            if (fullAtt?.file_data) pdfBuffer = fullAtt.file_data;
        }
        if (!pdfBuffer) {
            const err = new Error('PDF file not available — please retrigger the case to regenerate');
            err.status = 400;
            throw err;
        }

        // Send email with PDF attachment
        const sendgridService = require('../../services/sendgrid-service');
        const sendResult = await sendgridService.sendEmail({
            to: targetEmail,
            subject: proposal.draft_subject || `Public Records Request - ${caseData.subject_name || caseData.case_name}`,
            text: proposal.draft_body_text,
            html: proposal.draft_body_html || null,
            caseId,
            messageType: 'send_pdf_email',
            attachments: [{
                content: pdfBuffer.toString('base64'),
                filename: pdfAttachment.filename,
                type: 'application/pdf',
                disposition: 'attachment'
            }]
        });

        // Update proposal
        await db.updateProposal(proposalId, {
            human_decision: humanDecision,
            status: 'EXECUTED',
            executedAt: new Date(),
            emailJobId: sendResult.messageId
        });
        await autoCaptureEvalCase(proposal, { action, instruction: trimmedInstruction, reason, decidedBy: userId || decidedBy });

        // Update case status
        await transitionCaseRuntime(caseId, 'CASE_SENT', {
            sendDate: caseData.send_date ? new Date(caseData.send_date).toISOString() : new Date().toISOString(),
            substatus: `PDF form emailed to ${targetEmail}`,
        });

        await db.logActivity('pdf_email_sent', `PDF form emailed to ${targetEmail} for case ${caseId}`, {
            case_id: caseId,
            to: targetEmail,
            attachment_id: pdfAttachment.id,
            sendgrid_message_id: sendResult.messageId
        });

        try {
            const notionService = require('../../services/notion-service');
            await notionService.syncStatusToNotion(caseId);
        } catch (_) {}

        notify('info', `PDF email sent to ${targetEmail} for case ${caseId}`, { case_id: caseId });
        emitDataUpdate('proposal_update', { case_id: caseId, proposal_id: proposalId, action });
        return {
            success: true,
            message: `PDF email sent to ${targetEmail}`,
            proposal_id: proposalId,
            action,
            messageId: sendResult.messageId
        };
    }

    // SUBMIT_PORTAL: Execute directly only for legacy/manual proposals that do
    // not have a Trigger.dev waitpoint token. If a token exists, let the normal
    // waitpoint completion path resume the run.
    if (proposal.action_type === 'SUBMIT_PORTAL' && action === 'APPROVE' && !proposal.waitpoint_token) {
        const caseData = await db.getCaseById(caseId);
        if (!caseData) {
            const err = new Error(`Case ${caseId} not found`);
            err.status = 404;
            throw err;
        }

        const portalUrl = caseData.portal_url;
        if (!portalUrl) {
            const err = new Error(`No portal URL on case ${caseId}`);
            err.status = 400;
            throw err;
        }

        // Mark proposal as approved
        await db.updateProposal(proposalId, {
            human_decision: humanDecision,
            status: 'APPROVED',
        });

        // Trigger submit-portal task via Trigger.dev
        let portalTaskId = null;
        // Create a portal_task record for tracking (action_type is required)
        const ptResult = await db.query(
            `INSERT INTO portal_tasks (case_id, portal_url, action_type, status, proposal_id, instructions)
             VALUES ($1, $2, $3, 'PENDING', $4, $5)
             RETURNING id`,
            [caseId, portalUrl, proposal.action_type, proposalId, proposal.draft_body_text || null]
        );
        portalTaskId = ptResult.rows[0]?.id || null;

        const dispatchRun = await db.createAgentRunFull({
            case_id: caseId,
            trigger_type: 'portal_submit',
            status: 'queued',
            autopilot_mode: proposal.autopilot_mode || caseData.autopilot_mode || 'SUPERVISED',
            langgraph_thread_id: `portal:${caseId}:proposal-${proposalId}:${Date.now()}`,
            metadata: {
                proposal_id: proposalId,
                portal_task_id: portalTaskId,
                source: 'monitor_approve_portal',
            }
        });

        const { handle } = await triggerDispatch.triggerTask('submit-portal', {
            caseId,
            portalUrl,
            provider: caseData.portal_provider || null,
            instructions: proposal.draft_body_text || null,
            portalTaskId,
        }, triggerOpts(caseId, 'portal', dispatchRun.id), {
            runId: dispatchRun.id,
            caseId,
            triggerType: 'portal_submit',
            source: 'monitor_approve_portal',
        });

        // Update proposal to PENDING_PORTAL
        await db.updateProposal(proposalId, { status: 'PENDING_PORTAL', run_id: dispatchRun.id });
        await autoCaptureEvalCase(proposal, { action, instruction: trimmedInstruction, reason, decidedBy: userId || decidedBy });

        notify('info', `Portal submission approved — Trigger.dev task started for case ${caseId}`, { case_id: caseId });
        emitDataUpdate('proposal_update', { case_id: caseId, proposal_id: proposalId, action });
        return {
            success: true,
            message: 'Portal submission approved and triggered',
            proposal_id: proposalId,
            action,
            triggerRunId: handle?.id,
        };
    }

    // Trigger.dev path: if proposal has waitpoint_token, complete it
    if (proposal.waitpoint_token) {
        try {
            await triggerWait.completeToken(proposal.waitpoint_token, {
                action,
                instruction: instruction || null,
                reason: reason || null,
            });

            await db.updateProposal(proposalId, {
                human_decision: humanDecision,
                status: 'DECISION_RECEIVED'
            });
            await db.query(
                `UPDATE cases SET requires_human = false, pause_reason = NULL, updated_at = NOW() WHERE id = $1`,
                [caseId]
            );
            await autoCaptureEvalCase(proposal, { action, instruction: trimmedInstruction, reason, decidedBy: userId || decidedBy });

            await db.logActivity(action === 'APPROVE' ? 'proposal_approved' : 'proposal_adjusted', `Proposal #${proposalId} (${proposal.action_type}) ${action.toLowerCase()}${instruction ? ' — ' + instruction : ''}`, { case_id: caseId, user_id: userId || undefined });
            notify('info', `Proposal ${action.toLowerCase()} — Trigger.dev task resuming for case ${caseId}`, { case_id: caseId });
            emitDataUpdate('proposal_update', { case_id: caseId, proposal_id: proposalId, action });
            return {
                success: true,
                message: 'Decision received, Trigger.dev task resuming',
                proposal_id: proposalId,
                action,
            };
        } catch (tokenError) {
            // Token expired or task timed out — fall through to legacy re-trigger path
            console.warn(`Waitpoint token stale for proposal ${proposalId}: ${tokenError.message}`);
        }
    }

    // Legacy path: re-trigger through Trigger.dev (stale waitpoint or old proposals)
    // Don't create agent_run here — the Trigger.dev task creates its own run with proper lifecycle.
    // Creating one here leads to orphaned 'queued' runs if Trigger.dev fails to start.
    await db.updateProposal(proposalId, {
        human_decision: humanDecision,
        status: 'DECISION_RECEIVED'
    });
    await db.query(
        `UPDATE cases SET requires_human = false, pause_reason = NULL, updated_at = NOW() WHERE id = $1`,
        [caseId]
    );
    await autoCaptureEvalCase(proposal, { action, instruction: trimmedInstruction, reason, decidedBy: userId || decidedBy });

    let handle;
    const triggerContext = {
        triggerType: action === 'ADJUST' ? 'ADJUSTMENT' : 'HUMAN_REVIEW_RESOLUTION',
        reviewAction: action,
        reviewInstruction: instruction || null,
        originalActionType: action === 'ADJUST' ? proposal.action_type : undefined,
        originalProposalId: proposalId,
    };
    try {
        if (proposal.action_type === 'SEND_INITIAL_REQUEST') {
            handle = (await triggerDispatch.triggerTask('process-initial-request', {
                runId: 0, // placeholder — task creates its own agent_run
                caseId,
                autopilotMode: proposal.autopilot_mode || 'SUPERVISED',
                ...triggerContext,
            }, triggerOpts(caseId, 'approve-initial', proposalId))).handle;
        } else {
            handle = (await triggerDispatch.triggerTask('process-inbound', {
                runId: 0,
                caseId,
                messageId: proposal.trigger_message_id,
                autopilotMode: proposal.autopilot_mode || 'SUPERVISED',
                ...triggerContext,
            }, triggerOpts(caseId, 'approve-inbound', proposalId))).handle;
        }
    } catch (triggerError) {
        // Never leave proposals stranded in DECISION_RECEIVED when dispatch fails.
        await db.updateProposal(proposalId, {
            status: 'PENDING_APPROVAL',
            human_decision: null
        });
        await db.logActivity('proposal_dispatch_failed', `Decision for proposal #${proposalId} could not be dispatched to Trigger.dev: ${triggerError.message}`, {
            case_id: caseId,
            proposal_id: proposalId,
            action,
            error: triggerError.message
        });
        throw triggerError;
    }

    notify('info', `Proposal ${action.toLowerCase()} — re-triggered via Trigger.dev for case ${caseId}`, { case_id: caseId });
    emitDataUpdate('proposal_update', { case_id: caseId, proposal_id: proposalId, action });
    return {
        success: true,
        message: 'Decision received, re-processing via Trigger.dev',
        proposal_id: proposalId,
        action,
        trigger_run_id: handle.id
    };
}

module.exports = {
    db, sgMail, triggerWait, triggerDispatch, portalQueue, crypto,
    normalizePortalUrl, isSupportedPortalUrl, detectPortalProviderByUrl,
    eventBus, notify, emitDataUpdate, pdContactService,
    triggerOpts, triggerOptsDebounced, autoCaptureEvalCase,
    normalizeProposalReasoning, deriveMessageSource, uniqStrings,
    extractAttachmentInsights, queueInboundRunForMessage, processProposalDecision
};
