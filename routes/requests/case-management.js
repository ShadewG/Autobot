const express = require('express');
const router = express.Router();
const { db, logger, triggerDispatch, parseConstraints, generateOutcomeSummary } = require('./_helpers');
const sendgridService = require('../../services/sendgrid-service');
const { transitionCaseRuntime } = require('../../services/case-runtime');
const proposalLifecycle = require('../../services/proposal-lifecycle');
const { sanitizeValue } = require('../../services/decision-trace-service');
const { buildOperatorActionErrorResponse } = require('../../services/operator-action-errors');
const recordsDeliveryService = require('../../services/records-delivery-service');
const { buildDismissHumanDecision } = proposalLifecycle;

const SENSITIVE_PAYLOAD_KEY_PATTERNS = [
    /authorization/i,
    /cookie/i,
    /password/i,
    /secret/i,
    /token/i,
    /^api[_-]?key$/i,
    /refresh[_-]?token/i,
    /access[_-]?token/i,
];

function parseIsoTimestamp(value) {
    if (!value) return null;
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function parseCsvParam(value) {
    if (!value) return [];
    return String(value)
        .split(',')
        .map((part) => part.trim())
        .filter(Boolean);
}

function isSensitivePayloadKey(key) {
    return SENSITIVE_PAYLOAD_KEY_PATTERNS.some((pattern) => pattern.test(String(key || '')));
}

function redactSensitiveDebugFields(value, parentKey = null, depth = 0) {
    if (value == null) return value;
    if (depth > 6) return '[max-depth]';

    if (parentKey && isSensitivePayloadKey(parentKey)) {
        return '[redacted]';
    }

    if (Array.isArray(value)) {
        return value.map((entry) => redactSensitiveDebugFields(entry, parentKey, depth + 1));
    }

    if (typeof value !== 'object') {
        return value;
    }

    const output = {};
    for (const [key, entry] of Object.entries(value)) {
        output[key] = redactSensitiveDebugFields(entry, key, depth + 1);
    }
    return output;
}

function sanitizeDebugPayload(value) {
    return redactSensitiveDebugFields(sanitizeValue(value));
}

/**
 * POST /api/requests/:id/research-exemption
 * Research counterarguments to a FOIA exemption claim
 */
router.post('/:id/research-exemption', async (req, res) => {
    try {
        const requestId = parseInt(req.params.id);
        const { constraint_index } = req.body;

        if (constraint_index === undefined) {
            return res.status(400).json({
                success: false,
                error: 'constraint_index is required'
            });
        }

        // Fetch case data
        const caseData = await db.getCaseById(requestId);
        if (!caseData) {
            return res.status(404).json({
                success: false,
                error: 'Request not found'
            });
        }

        // Get constraints
        const constraints = parseConstraints(caseData);
        const constraint = constraints[constraint_index];

        if (!constraint) {
            return res.status(404).json({
                success: false,
                error: 'Constraint not found at specified index'
            });
        }

        // Build research prompt
        const prompt = `Research counterarguments to this FOIA exemption claim:

State: ${caseData.state}
Agency Claim: "${constraint.description}"
Legal Basis: ${constraint.source || 'Not specified'}
Records Affected: ${constraint.affected_items?.join(', ') || 'Not specified'}

Please research and provide:
1. Known exceptions to this exemption
2. Recent court cases that limited or overturned similar exemptions
3. Procedural failures the agency might have made
4. Alternative arguments for record disclosure
5. Questions to ask the agency for clarification

Be specific to ${caseData.state} law where possible.`;

        // Call OpenAI for research
        const OpenAI = require('openai');
        const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

        const completion = await openai.chat.completions.create({
            model: process.env.OPENAI_MODEL || 'gpt-5.2-2025-12-11',
            messages: [
                {
                    role: 'system',
                    content: 'You are a legal research assistant specializing in FOIA/public records law. Provide specific, actionable research to help challenge exemption claims. Cite specific statutes and cases where possible.'
                },
                {
                    role: 'user',
                    content: prompt
                }
            ],
            max_tokens: 2000
        });

        const researchContent = completion.choices[0].message.content;

        // Store research results in constraint (optional - could update constraints_jsonb)
        const researchResults = {
            searched_at: new Date().toISOString(),
            content: researchContent,
            constraint_description: constraint.description
        };

        // Log activity
        await db.logActivity('exemption_researched', `Researched exemption claim: "${constraint.description}"`, {
            case_id: requestId,
            constraint_index: constraint_index,
            state: caseData.state,
            actor_type: 'human',
            source_service: 'dashboard',
        });

        res.json({
            success: true,
            research: researchResults
        });
    } catch (error) {
        console.error('Error researching exemption:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

/**
 * POST /api/requests/:id/withdraw
 * Withdraw/close a FOIA request
 */
router.post('/:id/withdraw', async (req, res) => {
    const requestId = parseInt(req.params.id);
    const { reason } = req.body;
    const log = logger.forCase(requestId);

    try {
        // Verify case exists
        const caseData = await db.getCaseById(requestId);
        if (!caseData) {
            return res.status(404).json({
                success: false,
                error: 'Request not found'
            });
        }

        log.info(`Withdrawing request: ${reason || 'No reason given'}`);

        // Update case to closed/withdrawn status
        await db.updateCase(requestId, {
            status: 'completed',
            requires_human: false,
            pause_reason: null,
            autopilot_mode: 'MANUAL'
        });

        // Log the withdrawal activity
        await db.logActivity('request_withdrawn', `Request withdrawn: ${reason || 'No reason given'}`, {
            case_id: requestId,
            reason: reason || null,
            previous_status: caseData.status,
            actor_type: 'human',
            source_service: 'dashboard',
        });

        // Dismiss any pending proposals
        await db.query(
            `UPDATE auto_reply_queue SET status = 'rejected' WHERE case_id = $1 AND status = 'pending'`,
            [requestId]
        );

        // Sync status to Notion
        try {
            const notionService = require('../../services/notion-service');
            await notionService.syncStatusToNotion(requestId);
            log.info('Notion status synced to Completed');
        } catch (notionError) {
            log.warn(`Failed to sync to Notion: ${notionError.message}`);
            // Don't fail the request if Notion sync fails
        }

        log.info('Request withdrawn successfully');

        res.json({
            success: true,
            message: 'Request withdrawn successfully'
        });
    } catch (error) {
        log.error(`Error withdrawing request: ${error.message}`);
        res.status(500).json(buildOperatorActionErrorResponse(error, 'WITHDRAW_REQUEST_FAILED'));
    }
});

/**
 * POST /api/requests/:id/send-manual
 * Send a manual outbound email from the case detail page.
 */
router.post('/:id/send-manual', async (req, res) => {
    const requestId = parseInt(req.params.id, 10);
    const { body, subject, to_email, attachments } = req.body || {};
    const log = logger.forCase(requestId);

    try {
        const trimmedBody = typeof body === 'string' ? body.trim() : '';
        const explicitTo = typeof to_email === 'string' ? to_email.trim().toLowerCase() : '';
        const explicitSubject = typeof subject === 'string' ? subject.trim() : '';

        if (!trimmedBody) {
            return res.status(400).json({
                success: false,
                error: 'body is required'
            });
        }

        const caseData = await db.getCaseById(requestId);
        if (!caseData) {
            return res.status(404).json({
                success: false,
                error: 'Request not found'
            });
        }

        const latestInbound = await db.getLatestInboundMessage(requestId);
        const currentThread = await db.getThreadByCaseId(requestId);

        const inboundFrom = String(latestInbound?.from_email || '').trim().toLowerCase();
        const caseAgencyEmail = String(caseData.agency_email || '').trim().toLowerCase();
        const targetEmail = explicitTo || inboundFrom || caseAgencyEmail;

        if (!targetEmail) {
            return res.status(400).json({
                success: false,
                error: 'No destination email is available for this case'
            });
        }

        const baseSubject =
            explicitSubject ||
            String(latestInbound?.subject || currentThread?.subject || '').trim() ||
            `Public Records Request - ${caseData.subject_name || caseData.case_name || `Case ${requestId}`}`;

        const replyingToInbound = Boolean(latestInbound?.message_id) && inboundFrom === targetEmail;
        const subjectLine = replyingToInbound && !/^re:/i.test(baseSubject)
            ? `Re: ${baseSubject}`
            : baseSubject;

        const currentThreadAgencyEmail = String(currentThread?.agency_email || '').trim().toLowerCase();
        const canReuseCurrentThread =
            replyingToInbound ||
            (!explicitTo && currentThread && (!currentThreadAgencyEmail || currentThreadAgencyEmail === targetEmail));

        const threadIdentifier = replyingToInbound
            ? latestInbound.message_id
            : (canReuseCurrentThread ? (currentThread?.thread_id || currentThread?.initial_message_id || null) : null);

        const validatedAttachments = Array.isArray(attachments)
            ? attachments.filter(a => a && typeof a.filename === 'string' && typeof a.content === 'string' && typeof a.type === 'string')
            : [];

        const sendResult = await sendgridService.sendEmail({
            to: targetEmail,
            subject: subjectLine,
            text: trimmedBody,
            caseId: requestId,
            messageType: replyingToInbound ? 'manual_reply' : 'manual_outbound',
            ...(threadIdentifier ? {
                inReplyTo: threadIdentifier,
                references: threadIdentifier
            } : {}),
            ...(validatedAttachments.length > 0 ? { attachments: validatedAttachments } : {}),
        });

        if (replyingToInbound) {
            await transitionCaseRuntime(requestId, 'CASE_RECONCILED', {
                targetStatus: 'awaiting_response',
                substatus: 'Manual reply sent'
            });
        } else {
            await transitionCaseRuntime(requestId, 'CASE_SENT', {
                sendDate: new Date().toISOString(),
                substatus: 'Manual email sent'
            });
        }

        await db.logActivity(
            'manual_reply_sent',
            `Manual email sent to ${targetEmail}`,
            {
                case_id: requestId,
                to_email: targetEmail,
                subject: subjectLine,
                sendgrid_message_id: sendResult.sendgridMessageId || null,
                message_type: replyingToInbound ? 'manual_reply' : 'manual_outbound',
                actor_type: 'human',
                source_service: 'dashboard',
            }
        );

        log.info(`Manual email sent to ${targetEmail}`);

        res.json({
            success: true,
            message: 'Manual email sent',
            to_email: targetEmail,
            subject: subjectLine,
            sendgrid_message_id: sendResult.sendgridMessageId || null,
            replying_to_message_id: replyingToInbound ? latestInbound.message_id : null
        });
    } catch (error) {
        log.error(`Error sending manual email: ${error.message}`);
        res.status(500).json(buildOperatorActionErrorResponse(error, 'SEND_MANUAL_FAILED'));
    }
});

/**
 * POST /api/requests/:id/resolve-review
 * Resolve a human review with a chosen action + optional custom instruction
 */
router.post('/:id/resolve-review', async (req, res) => {
    const requestId = parseInt(req.params.id);
    const { action, instruction } = req.body;
    const log = logger.forCase(requestId);
    let triggerRun = null;

    try {
        if (!action) {
            return res.status(400).json({
                success: false,
                error: 'action is required'
            });
        }

        const caseData = await db.getCaseById(requestId);
        if (!caseData) {
            return res.status(404).json({
                success: false,
                error: 'Request not found'
            });
        }

        log.info(`Resolving human review with action: ${action}`);

        // Immediate actions — update status directly, no agent invocation
        const IMMEDIATE_ACTIONS = {
            put_on_hold: { status: 'awaiting_response', substatus: 'On hold (manual)' },
            close: { status: 'completed', substatus: 'Closed by user' },
            submit_manually: { status: 'portal_in_progress', substatus: 'Manual portal submission' },
            mark_sent: { status: 'sent', substatus: 'Marked as sent by user' },
            clear_portal: { status: 'needs_human_review', substatus: 'Portal URL cleared — needs alternative submission method' }
        };

        if (IMMEDIATE_ACTIONS[action]) {
            const { status, substatus } = IMMEDIATE_ACTIONS[action];
            const updates = {
                status,
                substatus,
                requires_human: false,
                pause_reason: null
            };

            // mark_sent: set send_date if not already set
            if (action === 'mark_sent' && !caseData.send_date) {
                updates.send_date = new Date();
            }

            // clear_portal: remove portal URL so case can proceed via email
            if (action === 'clear_portal') {
                updates.portal_url = null;
                updates.portal_provider = null;
                updates.requires_human = true; // keep in review so user can choose next step
            }

            // On close: set closed_at and generate outcome summary
            if (action === 'close') {
                updates.closed_at = new Date();
                updates.outcome_recorded = true;
            }

            await db.updateCase(requestId, updates);

            // When marking as sent, dismiss only submission-related proposals (keep rebuttals, fee negotiations)
            // When closing, dismiss ALL pending proposals
            if (action === 'mark_sent') {
                try { await db.dismissPendingProposals(requestId, `Review resolved: ${action}`, ['SUBMIT_PORTAL', 'SEND_FOLLOWUP', 'SEND_INITIAL_REQUEST']); } catch (err) {
                    log.warn(`Failed to dismiss proposals on mark_sent: ${err.message}`);
                }
            } else if (action === 'close') {
                try { await db.dismissPendingProposals(requestId, `Review resolved: ${action}`); } catch (err) {
                    log.warn(`Failed to dismiss proposals on close: ${err.message}`);
                }
            }

            await db.logActivity('human_decision', `Review resolved: ${action}${instruction ? ` — ${instruction}` : ''}`, {
                case_id: requestId,
                review_action: action,
                instruction: instruction || null,
                previous_status: caseData.status,
                actor_type: 'human',
                actor_id: req.user?.id || req.user?.email || null,
                source_service: 'dashboard',
            });

            // On close: generate AI outcome summary asynchronously
            if (action === 'close') {
                generateOutcomeSummary(requestId, caseData, instruction).catch(err => {
                    log.warn(`Failed to generate outcome summary: ${err.message}`);
                });
            }

            // Sync to Notion
            try {
                const notionService = require('../../services/notion-service');
                await notionService.syncStatusToNotion(requestId);
            } catch (notionError) {
                log.warn(`Failed to sync to Notion: ${notionError.message}`);
            }

            log.info(`Review resolved immediately: ${action}`);
            return res.json({
                success: true,
                message: `Review resolved: ${action}`,
                immediate: true
            });
        }

        // Agent-based actions — clear review flags, enqueue agent job
        const ACTION_INSTRUCTIONS = {
            retry_portal: 'Retry the portal submission',
            send_via_email: 'Switch to email submission',
            appeal: 'Draft an appeal citing legal grounds',
            narrow_scope: 'Narrow scope and resubmit',
            negotiate_fee: 'Negotiate the quoted fee',
            accept_fee: 'Accept fee and proceed',
            reprocess: 'Re-analyze and determine best action',
            decline_fee: 'Decline the quoted fee',
            escalate: 'Escalate to human oversight',
            research_agency: 'Research the correct agency for this request',
            reformulate_request: 'Reformulate the request with a different approach',
            custom: instruction || 'Follow custom instructions'
        };

        const baseInstruction = ACTION_INSTRUCTIONS[action];
        if (!baseInstruction) {
            return res.status(400).json({
                success: false,
                error: `Unknown action: ${action}`
            });
        }

        // Build combined instruction
        const combinedInstruction = instruction
            ? `${baseInstruction}. Additional instructions: ${instruction}`
            : baseInstruction;

        // Loop prevention: if there's already a PENDING_APPROVAL proposal matching
        // this action, don't dismiss it and start over — tell the user to review it.
        const ACTION_TO_PROPOSAL_TYPE = {
            negotiate_fee: 'NEGOTIATE_FEE', accept_fee: 'ACCEPT_FEE', decline_fee: 'DECLINE_FEE',
            appeal: 'SEND_REBUTTAL', narrow_scope: 'SEND_REBUTTAL',
            send_via_email: 'SEND_INITIAL_REQUEST',
        };
        const matchingProposalType = ACTION_TO_PROPOSAL_TYPE[action];
        if (matchingProposalType) {
            const existingProposal = await db.query(
                `SELECT id, action_type, draft_body_text FROM proposals
                 WHERE case_id = $1 AND status = 'PENDING_APPROVAL' AND action_type = $2
                 LIMIT 1`,
                [requestId, matchingProposalType]
            );
            if (existingProposal.rows.length > 0) {
                const ep = existingProposal.rows[0];
                log.info(`Loop prevention: existing ${ep.action_type} proposal #${ep.id} already pending`);
                return res.json({
                    success: true,
                    message: `A ${action.replace(/_/g, ' ')} draft is already waiting for your review (proposal #${ep.id}). Open the case to approve, adjust, or dismiss it.`,
                    immediate: true,
                    existing_proposal_id: ep.id
                });
            }
        }

        // Guard: if a matching proposal was already executed recently, don't duplicate
        if (matchingProposalType) {
            const recentlyExecuted = await db.query(
                `SELECT id, executed_at FROM proposals
                 WHERE case_id = $1 AND action_type = $2 AND status IN ('EXECUTED', 'APPROVED')
                 AND executed_at > NOW() - INTERVAL '10 minutes'
                 LIMIT 1`,
                [requestId, matchingProposalType]
            );
            if (recentlyExecuted.rows.length > 0) {
                log.info(`Already-executed guard: ${matchingProposalType} proposal #${recentlyExecuted.rows[0].id} was recently sent`);
                return res.json({
                    success: true,
                    message: `This action was already executed (proposal #${recentlyExecuted.rows[0].id}). No duplicate needed.`,
                    immediate: true,
                    already_executed: true,
                    executed_proposal_id: recentlyExecuted.rows[0].id
                });
            }
        }

        // Broad guard: if ANY proposal was executed very recently, block rapid double-actions
        const veryRecentExecution = await db.query(
            `SELECT id, action_type, executed_at FROM proposals
             WHERE case_id = $1 AND status IN ('EXECUTED', 'APPROVED')
             AND executed_at > NOW() - INTERVAL '2 minutes'
             LIMIT 1`,
            [requestId]
        );
        if (veryRecentExecution.rows.length > 0) {
            log.info(`Recent execution guard: proposal #${veryRecentExecution.rows[0].id} (${veryRecentExecution.rows[0].action_type}) executed < 2min ago`);
            return res.json({
                success: true,
                message: `A ${veryRecentExecution.rows[0].action_type.replace(/_/g, ' ').toLowerCase()} was just sent (proposal #${veryRecentExecution.rows[0].id}). Wait for it to process.`,
                immediate: true,
                already_executed: true
            });
        }

        // Complete waitpoint tokens on active proposals before dismissing.
        // This unblocks any Trigger.dev tasks waiting on human approval so they exit cleanly.
        try {
            const tokensToComplete = await db.query(
                `SELECT id, waitpoint_token FROM proposals
                 WHERE case_id = $1 AND status IN ('PENDING_APPROVAL', 'BLOCKED')
                 AND waitpoint_token IS NOT NULL`,
                [requestId]
            );
            if (tokensToComplete.rows.length > 0) {
                const { wait: triggerWait } = require('@trigger.dev/sdk');
                for (const p of tokensToComplete.rows) {
                    try {
                        await triggerWait.completeToken(p.waitpoint_token, {
                            action: 'DISMISS',
                            reason: `Superseded by human review action: ${action}`,
                        });
                    } catch (tokenErr) {
                        log.warn(`Failed to complete waitpoint token for proposal ${p.id}: ${tokenErr.message}`);
                    }
                }
            }
        } catch (tokenQueryErr) {
            log.warn(`Failed to query/complete waitpoint tokens: ${tokenQueryErr.message}`);
        }

        // Dismiss all active proposals — human is taking a new direction
        await proposalLifecycle.dismissActiveCaseProposals(requestId, {
            humanDecision: buildDismissHumanDecision({
                decidedBy: 'human',
                reason: `Superseded by human review action: ${action}`,
                supersededByAction: action,
            }),
        });

        // Supersede any still-active runs for this case before creating a fresh
        // human_review_resolution run. Otherwise a waiting/gated run can leave
        // the case locked behind the one-active-run constraint even after its
        // proposal was dismissed.
        await db.query(
            `UPDATE agent_runs
             SET status = 'failed',
                 ended_at = NOW(),
                 error = COALESCE(error, $2)
             WHERE case_id = $1
               AND status IN ('created', 'queued', 'processing', 'running', 'paused', 'waiting', 'gated')`,
            [requestId, `Superseded by human review action: ${action}`]
        );

        // Clear review flags and normalize stale review statuses so the UI
        // doesn't remain in "decision required" with no active proposal.
        const isReviewStatus = String(caseData.status || '').startsWith('needs_');
        await db.updateCase(requestId, {
            status: isReviewStatus ? 'awaiting_response' : caseData.status,
            requires_human: false,
            pause_reason: null,
            substatus: `Resolving: ${action}`
        });

        // Log activity
        await db.logActivity('human_decision', `Review resolved: ${action}${instruction ? ` — ${instruction}` : ''}`, {
            case_id: requestId,
            review_action: action,
            instruction: instruction || null,
            previous_status: caseData.status,
            actor_type: 'human',
            actor_id: req.user?.id || req.user?.email || null,
            source_service: 'dashboard',
        });

        // Trigger Trigger.dev task for re-processing — pass review action + instruction
        const latestMsg = await db.query('SELECT id FROM messages WHERE case_id = $1 AND direction = \'inbound\' ORDER BY created_at DESC LIMIT 1', [requestId]);
        triggerRun = await db.createAgentRunFull({
            case_id: requestId,
            trigger_type: 'human_review_resolution',
            status: 'queued',
            autopilot_mode: 'SUPERVISED',
            langgraph_thread_id: `review:${requestId}:${Date.now()}`
        });
        const { handle } = await triggerDispatch.triggerTask('process-inbound', {
            runId: triggerRun.id,
            caseId: requestId,
            messageId: latestMsg.rows[0]?.id || null,
            autopilotMode: 'SUPERVISED',
            triggerType: 'HUMAN_REVIEW_RESOLUTION',
            reviewAction: action,
            reviewInstruction: combinedInstruction,
        }, {
            queue: `case-${requestId}`,
            idempotencyKey: `human-review-resolution:${requestId}:${triggerRun.id}`,
            idempotencyKeyTTL: '1h',
        }, {
            runId: triggerRun.id,
            caseId: requestId,
            triggerType: 'human_review_resolution',
            source: 'requests_human_review_resolution',
        });
        const job = { id: handle.id };

        // Sync to Notion
        try {
            const notionService = require('../../services/notion-service');
            await notionService.syncStatusToNotion(requestId);
        } catch (notionError) {
            log.warn(`Failed to sync to Notion: ${notionError.message}`);
        }

        log.info(`Review resolved with agent job: ${job.id}`);

        res.json({
            success: true,
            message: `Review resolved: ${action}`,
            job_id: job.id
        });
    } catch (error) {
        log.error(`Error resolving review: ${error.message}`);

        // Rollback: re-flag for human review so the case doesn't get stuck with
        // requires_human=false and a stale "Resolving:" substatus
        try {
            if (triggerRun?.id) {
                await db.updateAgentRun(triggerRun.id, {
                    status: 'failed',
                    ended_at: new Date(),
                    error: `Review resolve dispatch failed: ${error.message}`
                });
            }
            await db.updateCase(requestId, {
                requires_human: true,
                substatus: 'Reprocess dispatch failed',
                pause_reason: 'agent_run_failed',
            });
        } catch (rollbackErr) {
            log.error(`Failed to rollback case ${requestId} after dispatch failure: ${rollbackErr.message}`);
        }

        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

/**
 * GET /api/requests/:id/constraints
 * Get parsed constraints for a case
 */
router.get('/:id/constraints', async (req, res) => {
    try {
        const caseId = parseInt(req.params.id);
        const caseData = await db.getCaseById(caseId);
        if (!caseData) return res.status(404).json({ success: false, error: 'Case not found' });

        const constraints = parseConstraints(caseData);
        res.json({ success: true, constraints });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * POST /api/requests/:id/constraints/remove
 * Remove a constraint by index
 * Body: { index: number, reason?: string }
 */
router.post('/:id/constraints/remove', async (req, res) => {
    try {
        const caseId = parseInt(req.params.id);
        const { index, reason } = req.body || {};
        const userId = req.headers['x-user-id'] || null;

        const caseData = await db.getCaseById(caseId);
        if (!caseData) return res.status(404).json({ success: false, error: 'Case not found' });

        const current = Array.isArray(caseData.constraints_jsonb) ? [...caseData.constraints_jsonb] : [];
        if (index < 0 || index >= current.length) {
            return res.status(400).json({ success: false, error: 'Invalid constraint index' });
        }

        const removed = current.splice(index, 1)[0];
        await db.updateCase(caseId, { constraints_jsonb: current });

        const removedLabel = typeof removed === 'string' ? removed : (removed?.type || JSON.stringify(removed));
        await db.logActivity('constraint_removed', `Constraint removed: ${removedLabel}${reason ? ' — ' + reason : ''}`, {
            case_id: caseId,
            constraint: removedLabel,
            reason: reason || null,
            actor_type: 'human',
            actor_id: userId,
            source_service: 'dashboard',
        });

        res.json({ success: true, removed, constraints: current });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * POST /api/requests/:id/constraints/add
 * Add a new constraint
 * Body: { type: string, description: string, source?: string }
 */
router.post('/:id/constraints/add', async (req, res) => {
    try {
        const caseId = parseInt(req.params.id);
        const { type, description, source } = req.body || {};
        const userId = req.headers['x-user-id'] || null;

        if (!type || !description) {
            return res.status(400).json({ success: false, error: 'type and description are required' });
        }

        const caseData = await db.getCaseById(caseId);
        if (!caseData) return res.status(404).json({ success: false, error: 'Case not found' });

        const constraint = {
            type,
            description,
            source: source || 'Manual override',
            confidence: 1.0,
            affected_items: [],
        };

        const current = Array.isArray(caseData.constraints_jsonb) ? [...caseData.constraints_jsonb] : [];
        current.push(constraint);
        await db.updateCase(caseId, { constraints_jsonb: current });

        await db.logActivity('constraint_added', `Constraint added: ${type}`, {
            case_id: caseId,
            constraint: type,
            description,
            source: source || 'Manual override',
            actor_type: 'human',
            actor_id: userId,
            source_service: 'dashboard',
        });

        res.json({ success: true, constraint, constraints: current });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * POST /api/requests/:id/sync-notion
 * Sync a case's status to its linked Notion page
 */
router.post('/:id/sync-notion', async (req, res) => {
    try {
        const caseId = parseInt(req.params.id);
        const caseData = await db.getCaseById(caseId);
        if (!caseData) return res.status(404).json({ success: false, error: 'Case not found' });
        if (!caseData.notion_page_id) return res.status(400).json({ success: false, error: 'Case has no linked Notion page' });

        const notionService = require('../../services/notion-service');
        await notionService.syncStatusToNotion(caseId);
        await db.updateCase(caseId, { last_notion_synced_at: new Date() });

        await db.logActivity('notion_manual_sync', `Manual Notion sync for case #${caseId}`, {
            case_id: caseId,
            actor_type: 'human',
            actor_id: req.body?.userId || null,
            source_service: 'dashboard',
        });

        res.json({ success: true, message: 'Notion sync triggered' });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * PUT /api/requests/:id/tags
 * Update operator tags on a case
 */
router.put('/:id/tags', async (req, res) => {
    try {
        const caseId = parseInt(req.params.id);
        const { tags } = req.body;

        if (!Array.isArray(tags)) {
            return res.status(400).json({ success: false, error: 'tags must be an array of strings' });
        }

        // Validate: max 10 tags, each under 50 chars, alphanumeric + hyphens + spaces
        const cleaned = [...new Set(tags.map(t => String(t).trim().toLowerCase()).filter(Boolean))];
        if (cleaned.length > 10) {
            return res.status(400).json({ success: false, error: 'Maximum 10 tags per case' });
        }

        const updated = await db.updateCaseTags(caseId, cleaned);
        if (!updated) {
            return res.status(404).json({ success: false, error: 'Case not found' });
        }

        await db.logActivity('tags_updated', `Tags updated to: ${cleaned.join(', ') || '(none)'}`, {
            case_id: caseId,
            tags: cleaned,
            actor_type: 'human',
            actor_id: req.body?.userId || null,
            source_service: 'dashboard',
        });

        res.json({ success: true, tags: updated.tags });
    } catch (error) {
        logger.error('Error updating tags:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * PUT /api/requests/:id/priority
 * Update case priority (0=normal, 1=low, 2=urgent).
 */
router.put('/:id/priority', async (req, res) => {
    try {
        const caseId = parseInt(req.params.id);
        const { priority } = req.body;
        const level = parseInt(priority);

        if (![0, 1, 2].includes(level)) {
            return res.status(400).json({ success: false, error: 'priority must be 0 (normal), 1 (low), or 2 (urgent)' });
        }

        const result = await db.query(
            'UPDATE cases SET priority = $1, updated_at = NOW() WHERE id = $2 RETURNING id, priority',
            [level, caseId]
        );
        if (result.rows.length === 0) {
            return res.status(404).json({ success: false, error: 'Case not found' });
        }

        const labels = { 0: 'normal', 1: 'low', 2: 'urgent' };
        await db.logActivity('priority_updated', `Priority set to ${labels[level]}`, {
            case_id: caseId,
            priority: level,
            actor_type: 'human',
            actor_id: req.body?.userId || null,
            source_service: 'dashboard',
        });

        res.json({ success: true, priority: result.rows[0].priority });
    } catch (error) {
        logger.error('Error updating priority:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * POST /api/requests/create
 * Create a new case from the dashboard form (cookie-auth).
 */
router.post('/create', async (req, res) => {
    try {
        const {
            case_name, subject_name, agency_name, agency_email,
            portal_url, state, incident_date, incident_location,
            additional_details, requested_records,
        } = req.body || {};

        if (!case_name?.trim()) return res.status(400).json({ success: false, error: 'Case name is required' });
        if (!subject_name?.trim()) return res.status(400).json({ success: false, error: 'Subject name is required' });
        if (!agency_name?.trim()) return res.status(400).json({ success: false, error: 'Agency name is required' });
        if (!agency_email?.trim() && !portal_url?.trim()) {
            return res.status(400).json({ success: false, error: 'Agency email or portal URL is required' });
        }

        const { normalizeStateCode, parseStateFromAgencyName } = require('../../utils/state-utils');
        const normalizedState = normalizeStateCode(state) || parseStateFromAgencyName(agency_name) || null;

        let parsedDate = null;
        if (incident_date) {
            const d = new Date(incident_date);
            if (!isNaN(d.getTime())) parsedDate = d.toISOString().split('T')[0];
        }

        const recordsArray = Array.isArray(requested_records)
            ? requested_records.filter(Boolean)
            : requested_records ? [requested_records] : null;

        const syntheticNotionId = `manual-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

        const newCase = await db.createCase({
            notion_page_id: syntheticNotionId,
            case_name: case_name.trim(),
            subject_name: subject_name.trim(),
            agency_name: agency_name.trim(),
            agency_email: agency_email?.trim() || null,
            state: normalizedState,
            incident_date: parsedDate,
            incident_location: incident_location?.trim() || null,
            requested_records: recordsArray,
            additional_details: additional_details?.trim() || null,
            status: 'ready_to_send',
            portal_url: portal_url?.trim() || null,
            tags: ['manual-entry'],
        });

        await db.addCaseAgency(newCase.id, {
            agency_name: agency_name.trim(),
            agency_email: agency_email?.trim() || null,
            portal_url: portal_url?.trim() || null,
            is_primary: true,
            added_source: 'dashboard',
            status: 'pending',
        });

        const userId = req.signedCookies?.autobot_uid || 'dashboard';
        await db.logActivity('case_created_manual', `Case "${case_name}" created from dashboard`, {
            case_id: newCase.id,
            actor_type: 'human',
            actor_id: userId,
            source_service: 'dashboard',
        });

        res.status(201).json({ success: true, case_id: newCase.id, case_name: newCase.case_name });
    } catch (error) {
        logger.error('Error creating case:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * POST /api/requests/batch
 * Create N independent cases from a shared template + list of agencies.
 * Each case gets its own proposal queue and thread.
 */
router.post('/batch', async (req, res) => {
    try {
        const { template = {}, agencies = [] } = req.body || {};
        const {
            case_name, subject_name, incident_date, incident_location,
            additional_details, requested_records,
        } = template;

        if (!case_name?.trim()) return res.status(400).json({ success: false, error: 'template.case_name is required' });
        if (!subject_name?.trim()) return res.status(400).json({ success: false, error: 'template.subject_name is required' });
        if (!agencies.length) return res.status(400).json({ success: false, error: 'At least one agency is required' });
        if (agencies.length > 50) return res.status(400).json({ success: false, error: 'Maximum 50 agencies per batch' });

        const { normalizeStateCode, parseStateFromAgencyName } = require('../../utils/state-utils');

        let parsedDate = null;
        if (incident_date) {
            const d = new Date(incident_date);
            if (!isNaN(d.getTime())) parsedDate = d.toISOString().split('T')[0];
        }

        const recordsArray = Array.isArray(requested_records)
            ? requested_records.filter(Boolean)
            : requested_records ? [requested_records] : null;

        const batchId = `batch-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const userId = req.signedCookies?.autobot_uid || 'dashboard';
        const results = [];
        const errors = [];

        for (let i = 0; i < agencies.length; i++) {
            const agency = agencies[i];
            if (!agency.name?.trim()) {
                errors.push({ index: i, agency_name: agency.name, error: 'Agency name is required' });
                continue;
            }
            if (!agency.email?.trim() && !agency.portal_url?.trim()) {
                errors.push({ index: i, agency_name: agency.name, error: 'Agency email or portal URL required' });
                continue;
            }

            try {
                const state = normalizeStateCode(agency.state) || parseStateFromAgencyName(agency.name) || null;
                const syntheticId = `${batchId}-${i}`;

                const newCase = await db.createCase({
                    notion_page_id: syntheticId,
                    case_name: case_name.trim(),
                    subject_name: subject_name.trim(),
                    agency_name: agency.name.trim(),
                    agency_email: agency.email?.trim() || null,
                    state,
                    incident_date: parsedDate,
                    incident_location: incident_location?.trim() || null,
                    requested_records: recordsArray,
                    additional_details: additional_details?.trim() || null,
                    status: 'ready_to_send',
                    portal_url: agency.portal_url?.trim() || null,
                    portal_provider: agency.portal_provider?.trim() || null,
                    tags: ['batch', `batch:${batchId}`],
                });

                await db.addCaseAgency(newCase.id, {
                    agency_name: agency.name.trim(),
                    agency_email: agency.email?.trim() || null,
                    portal_url: agency.portal_url?.trim() || null,
                    portal_provider: agency.portal_provider?.trim() || null,
                    is_primary: true,
                    added_source: 'batch',
                    status: 'pending',
                });

                results.push({
                    case_id: newCase.id,
                    agency_name: agency.name.trim(),
                    state,
                    status: 'ready_to_send',
                });
            } catch (err) {
                errors.push({ index: i, agency_name: agency.name, error: err.message });
            }
        }

        if (results.length > 0) {
            await db.logActivity('batch_created', `Batch "${case_name}" with ${results.length} cases`, {
                batch_id: batchId,
                total_agencies: agencies.length,
                cases_created: results.length,
                errors: errors.length,
                actor_type: 'human',
                actor_id: userId,
                source_service: 'dashboard',
            });
        }

        res.status(201).json({
            success: true,
            batch_id: batchId,
            cases_created: results.length,
            errors_count: errors.length,
            cases: results,
            errors: errors.length > 0 ? errors : undefined,
        });
    } catch (error) {
        logger.error('Error creating batch:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * GET /api/requests/batch/:batchId/status
 * Aggregated status for all cases in a batch.
 */
router.get('/batch/:batchId/status', async (req, res) => {
    try {
        const { batchId } = req.params;
        const tag = `batch:${batchId}`;

        const result = await db.query(`
            SELECT
                id, case_name, agency_name, state, status, send_date,
                last_response_date, portal_url
            FROM cases
            WHERE tags @> ARRAY[$1]::text[]
            ORDER BY id ASC
        `, [tag]);

        if (result.rows.length === 0) {
            return res.status(404).json({ success: false, error: 'Batch not found' });
        }

        const cases = result.rows;
        const summary = {
            total: cases.length,
            ready_to_send: cases.filter(c => c.status === 'ready_to_send').length,
            pending: cases.filter(c => ['needs_human_review', 'needs_human_fee_approval'].includes(c.status)).length,
            sent: cases.filter(c => c.status === 'sent').length,
            responded: cases.filter(c => ['completed', 'partially_fulfilled'].includes(c.status)).length,
            denied: cases.filter(c => c.status === 'denied').length,
            in_progress: cases.filter(c => !['ready_to_send', 'completed', 'denied', 'cancelled'].includes(c.status)).length,
        };

        res.json({
            success: true,
            batch_id: batchId,
            summary,
            cases: cases.map(c => ({
                case_id: c.id,
                agency_name: c.agency_name,
                state: c.state,
                status: c.status,
                send_date: c.send_date,
                last_response_date: c.last_response_date,
                has_portal: !!c.portal_url,
            })),
        });
    } catch (error) {
        logger.error('Error fetching batch status:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * GET /api/requests/:id/export
 * Export full case package: correspondence, timeline, proposals
 */
router.get('/:id/export', async (req, res) => {
    try {
        const caseId = parseInt(req.params.id);
        const caseData = await db.getCaseById(caseId);
        if (!caseData) {
            return res.status(404).json({ success: false, error: 'Case not found' });
        }

        const [messagesResult, proposalsResult, activityResult, portalResult] = await Promise.all([
            db.query(
                `SELECT id, direction, subject,
                        COALESCE(NULLIF(normalized_body_text, ''), body_text) AS body_text,
                        from_email, to_email,
                        sent_at, received_at, message_type
                 FROM messages WHERE case_id = $1
                 ORDER BY COALESCE(sent_at, received_at) ASC`, [caseId]
            ),
            db.query(
                `SELECT id, action_type, status, draft_subject, draft_body_text,
                        reasoning, human_decision, human_decided_by, human_decided_at,
                        original_draft_subject, original_draft_body_text, human_edited,
                        created_at, executed_at
                 FROM proposals WHERE case_id = $1
                 ORDER BY created_at ASC`, [caseId]
            ),
            db.query(
                `SELECT event_type, description, metadata, created_at
                 FROM activity_log WHERE case_id = $1
                 ORDER BY created_at ASC`, [caseId]
            ),
            db.query(
                `SELECT id, portal_url, status, confirmation_number, created_at, completed_at
                 FROM portal_tasks WHERE case_id = $1
                 ORDER BY created_at ASC`, [caseId]
            ),
        ]);

        const pkg = {
            exported_at: new Date().toISOString(),
            case: {
                id: caseData.id,
                case_name: caseData.case_name,
                subject_name: caseData.subject_name,
                agency_name: caseData.agency_name,
                agency_email: caseData.agency_email,
                state: caseData.state,
                status: caseData.status,
                created_at: caseData.created_at,
                completed_at: caseData.closed_at,
            },
            correspondence: messagesResult.rows.map(m => ({
                direction: m.direction,
                subject: m.subject,
                body: m.body_text,
                from: m.from_email,
                to: m.to_email,
                date: m.direction === 'outbound' ? m.sent_at : m.received_at,
                type: m.message_type,
            })),
            proposals: proposalsResult.rows.map(p => ({
                action: p.action_type,
                status: p.status,
                subject: p.draft_subject,
                body: p.draft_body_text,
                reasoning: p.reasoning,
                decision: p.human_decision,
                decided_at: p.human_decided_at,
                created_at: p.created_at,
                executed_at: p.executed_at,
            })),
            portal_submissions: portalResult.rows.map(pt => ({
                portal_url: pt.portal_url,
                status: pt.status,
                confirmation: pt.confirmation_number,
                started: pt.created_at,
                completed: pt.completed_at,
            })),
            timeline: activityResult.rows.map(a => ({
                event: a.event_type,
                description: a.description,
                metadata: a.metadata,
                at: a.created_at,
            })),
        };

        const format = req.query.format;
        if (format === 'download') {
            const filename = `case-${caseId}-${caseData.case_name?.replace(/[^a-zA-Z0-9]/g, '-') || 'export'}.json`;
            res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
            res.setHeader('Content-Type', 'application/json');
            return res.send(JSON.stringify(pkg, null, 2));
        }

        res.json({ success: true, ...pkg });
    } catch (error) {
        logger.error('Error exporting case:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * GET /api/requests/:id/portal-submissions
 * Return portal submission attempt history for a case.
 */
router.get('/:id/portal-submissions', async (req, res) => {
    try {
        const caseId = parseInt(req.params.id, 10);
        const limit = Math.max(1, Math.min(parseInt(req.query.limit, 10) || 50, 200));
        const caseData = await db.getCaseById(caseId);
        if (!caseData) {
            return res.status(404).json({ success: false, error: 'Case not found' });
        }

        const submissions = await db.getPortalSubmissions(caseId, { limit });
        res.json({
            success: true,
            case_id: caseId,
            count: submissions.length,
            submissions,
        });
    } catch (error) {
        logger.error('Error fetching portal submissions:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * GET /api/requests/:id/completion-report
 * Compare requested scope against received records/delivery artifacts.
 */
router.get('/:id/completion-report', async (req, res) => {
    try {
        const caseId = parseInt(req.params.id, 10);
        const caseData = await db.getCaseById(caseId);
        if (!caseData) {
            return res.status(404).json({ success: false, error: 'Case not found' });
        }

        const report = await recordsDeliveryService.buildCaseCompletionReport(caseId, { db, caseData });
        res.json({
            success: true,
            case_id: caseId,
            report,
        });
    } catch (error) {
        logger.error('Error building completion report:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * GET /api/requests/:id/event-ledger
 * Return append-only event ledger rows for a case.
 */
router.get('/:id/event-ledger', async (req, res) => {
    try {
        const caseId = parseInt(req.params.id, 10);
        const limit = Math.max(1, Math.min(parseInt(req.query.limit, 10) || 100, 500));
        const caseData = await db.getCaseById(caseId);
        if (!caseData) {
            return res.status(404).json({ success: false, error: 'Case not found' });
        }

        const result = await db.query(
            `SELECT id, case_id, event, transition_key, context, mutations_applied, projection, created_at
             FROM case_event_ledger
             WHERE case_id = $1
             ORDER BY created_at DESC, id DESC
             LIMIT $2`,
            [caseId, limit]
        );

        res.json({
            success: true,
            case_id: caseId,
            count: result.rows.length,
            events: result.rows,
        });
    } catch (error) {
        logger.error('Error fetching event ledger:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * GET /api/requests/:id/provider-payloads
 * Return sanitized provider payloads for debugging message/execution state.
 */
router.get('/:id/provider-payloads', async (req, res) => {
    try {
        const caseId = parseInt(req.params.id, 10);
        const limit = Math.max(1, Math.min(parseInt(req.query.limit, 10) || 50, 200));
        const messageId = Number.isFinite(parseInt(req.query.messageId, 10)) ? parseInt(req.query.messageId, 10) : null;
        const executionId = Number.isFinite(parseInt(req.query.executionId, 10)) ? parseInt(req.query.executionId, 10) : null;
        const caseData = await db.getCaseById(caseId);
        if (!caseData) {
            return res.status(404).json({ success: false, error: 'Case not found' });
        }

        const [messageResult, executionResult, emailEvents, allCaseMessageIds] = await Promise.all([
            db.query(
                `SELECT id, direction, message_type, subject, from_email, to_email, provider_payload, created_at,
                        delivered_at, bounced_at, sendgrid_message_id
                 FROM messages
                 WHERE case_id = $1
                   AND provider_payload IS NOT NULL
                   AND ($3::int IS NULL OR id = $3)
                 ORDER BY created_at DESC, id DESC
                 LIMIT $2`,
                [caseId, limit, messageId]
            ),
            db.query(
                `SELECT id, proposal_id, action_type, status, provider, provider_payload, created_at, completed_at,
                        provider_message_id, failure_stage, failure_code
                 FROM executions
                 WHERE case_id = $1
                   AND provider_payload IS NOT NULL
                   AND ($3::int IS NULL OR id = $3)
                 ORDER BY created_at DESC, id DESC
                 LIMIT $2`,
                [caseId, limit, executionId]
            ),
            db.getCaseEmailEvents(caseId, { limit }),
            // Also fetch all message IDs + sendgrid IDs for email-event correlation
            // (messages without provider_payload can still have email_events via sendgrid_message_id)
            db.query(
                `SELECT id, sendgrid_message_id FROM messages WHERE case_id = $1`,
                [caseId]
            ),
        ]);

        const relevantMessageIds = new Set(allCaseMessageIds.rows.map((row) => row.id));
        const relevantProviderMessageIds = new Set(
            allCaseMessageIds.rows.map((row) => row.sendgrid_message_id).filter(Boolean)
        );
        executionResult.rows.forEach((row) => {
            if (row.provider_message_id) {
                relevantProviderMessageIds.add(row.provider_message_id);
            }
        });

        const correlatedEmailEvents = emailEvents.filter((event) => (
            relevantMessageIds.has(event.message_id) ||
            (event.provider_message_id && relevantProviderMessageIds.has(event.provider_message_id))
        ));

        res.json({
            success: true,
            case_id: caseId,
            messages: messageResult.rows.map((row) => ({
                ...row,
                provider_payload: sanitizeDebugPayload(row.provider_payload),
            })),
            executions: executionResult.rows.map((row) => ({
                ...row,
                provider_payload: sanitizeDebugPayload(row.provider_payload),
            })),
            email_events: correlatedEmailEvents.map((row) => ({
                ...row,
                raw_payload: sanitizeDebugPayload(row.raw_payload),
            })),
            filters: {
                message_id: messageId,
                execution_id: executionId,
            },
            summary: {
                message_payload_count: messageResult.rows.length,
                execution_payload_count: executionResult.rows.length,
                email_event_count: correlatedEmailEvents.length,
            },
        });
    } catch (error) {
        logger.error('Error fetching provider payloads:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * GET /api/requests/:id/provider-payloads/:surface/:recordId
 * Return a single payload/event with correlated records for deeper debugging.
 */
router.get('/:id/provider-payloads/:surface/:recordId', async (req, res) => {
    try {
        const caseId = parseInt(req.params.id, 10);
        const recordId = parseInt(req.params.recordId, 10);
        const surface = String(req.params.surface || '').toLowerCase();

        if (!Number.isFinite(recordId)) {
            return res.status(400).json({ success: false, error: 'Invalid record ID' });
        }

        const caseData = await db.getCaseById(caseId);
        if (!caseData) {
            return res.status(404).json({ success: false, error: 'Case not found' });
        }

        let entry = null;
        let relatedMessages = [];
        let relatedExecutions = [];
        let relatedEmailEvents = [];

        if (surface === 'messages') {
            const messageResult = await db.query(
                `SELECT id, case_id, direction, message_type, subject, from_email, to_email, created_at,
                        delivered_at, bounced_at, sendgrid_message_id, provider_payload
                 FROM messages
                 WHERE case_id = $1
                   AND id = $2
                   AND provider_payload IS NOT NULL
                 LIMIT 1`,
                [caseId, recordId]
            );
            entry = messageResult.rows[0] || null;

            if (entry) {
                relatedMessages = [entry];
                relatedEmailEvents = (await db.getCaseEmailEvents(caseId, { limit: 200 }))
                    .filter((event) => event.message_id === entry.id || (entry.sendgrid_message_id && event.provider_message_id === entry.sendgrid_message_id));
                relatedExecutions = entry.sendgrid_message_id
                    ? (await db.query(
                        `SELECT id, case_id, proposal_id, action_type, status, provider, provider_message_id, provider_payload,
                                created_at, completed_at, failure_stage, failure_code
                         FROM executions
                         WHERE case_id = $1
                           AND provider_message_id = $2
                         ORDER BY created_at DESC, id DESC
                         LIMIT 25`,
                        [caseId, entry.sendgrid_message_id]
                    )).rows
                    : [];
            }
        } else if (surface === 'executions') {
            const executionResult = await db.query(
                `SELECT id, case_id, proposal_id, action_type, status, provider, provider_message_id, provider_payload,
                        created_at, completed_at, failure_stage, failure_code
                 FROM executions
                 WHERE case_id = $1
                   AND id = $2
                   AND provider_payload IS NOT NULL
                 LIMIT 1`,
                [caseId, recordId]
            );
            entry = executionResult.rows[0] || null;

            if (entry) {
                relatedExecutions = [entry];
                if (entry.provider_message_id) {
                    relatedMessages = (await db.query(
                        `SELECT id, case_id, direction, message_type, subject, from_email, to_email, created_at,
                                delivered_at, bounced_at, sendgrid_message_id, provider_payload
                         FROM messages
                         WHERE case_id = $1
                           AND sendgrid_message_id = $2
                         ORDER BY created_at DESC, id DESC
                         LIMIT 25`,
                        [caseId, entry.provider_message_id]
                    )).rows;
                }
                relatedEmailEvents = (await db.getCaseEmailEvents(caseId, { limit: 200 }))
                    .filter((event) => entry.provider_message_id && event.provider_message_id === entry.provider_message_id);
            }
        } else if (surface === 'email-events') {
            const emailEventResult = await db.query(
                `SELECT
                    ee.id,
                    ee.message_id,
                    ee.provider_message_id,
                    ee.event_type,
                    ee.event_timestamp,
                    ee.raw_payload,
                    m.case_id,
                    m.direction,
                    m.message_type,
                    m.subject,
                    m.from_email,
                    m.to_email
                 FROM email_events ee
                 LEFT JOIN messages m ON m.id = ee.message_id
                 WHERE ee.id = $2
                   AND (
                     m.case_id = $1
                     OR EXISTS (
                        SELECT 1
                        FROM messages m2
                        WHERE m2.case_id = $1
                          AND m2.sendgrid_message_id IS NOT NULL
                          AND m2.sendgrid_message_id = ee.provider_message_id
                     )
                   )
                 LIMIT 1`,
                [caseId, recordId]
            );
            entry = emailEventResult.rows[0] || null;

            if (entry) {
                relatedEmailEvents = [entry];
                relatedMessages = (await db.query(
                    `SELECT id, case_id, direction, message_type, subject, from_email, to_email, created_at,
                            delivered_at, bounced_at, sendgrid_message_id, provider_payload
                     FROM messages
                     WHERE case_id = $1
                       AND (
                         ($2::int IS NOT NULL AND id = $2)
                         OR ($3::text IS NOT NULL AND sendgrid_message_id = $3)
                       )
                     ORDER BY created_at DESC, id DESC
                     LIMIT 25`,
                    [caseId, entry.message_id || null, entry.provider_message_id || null]
                )).rows;
                relatedExecutions = entry.provider_message_id
                    ? (await db.query(
                        `SELECT id, case_id, proposal_id, action_type, status, provider, provider_message_id, provider_payload,
                                created_at, completed_at, failure_stage, failure_code
                         FROM executions
                         WHERE case_id = $1
                           AND provider_message_id = $2
                         ORDER BY created_at DESC, id DESC
                         LIMIT 25`,
                        [caseId, entry.provider_message_id]
                    )).rows
                    : [];
            }
        } else {
            return res.status(400).json({ success: false, error: 'Unsupported payload surface' });
        }

        if (!entry) {
            return res.status(404).json({ success: false, error: 'Payload record not found for case' });
        }

        const sanitizeMessageRow = (row) => ({
            ...row,
            provider_payload: sanitizeDebugPayload(row.provider_payload),
        });
        const sanitizeExecutionRow = (row) => ({
            ...row,
            provider_payload: sanitizeDebugPayload(row.provider_payload),
        });
        const sanitizeEmailEventRow = (row) => ({
            ...row,
            raw_payload: sanitizeDebugPayload(row.raw_payload),
        });

        const sanitizedEntry = surface === 'messages'
            ? sanitizeMessageRow(entry)
            : surface === 'executions'
                ? sanitizeExecutionRow(entry)
                : sanitizeEmailEventRow(entry);

        res.json({
            success: true,
            case_id: caseId,
            source: surface,
            record_id: recordId,
            entry: sanitizedEntry,
            related: {
                messages: relatedMessages.map(sanitizeMessageRow),
                executions: relatedExecutions.map(sanitizeExecutionRow),
                email_events: relatedEmailEvents.map(sanitizeEmailEventRow),
            },
        });
    } catch (error) {
        logger.error('Error fetching provider payload detail:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * GET /api/requests/:id/audit-stream
 * Return a unified append-only case audit stream across ledger, activity, email events, and portal attempts.
 */
router.get('/:id/audit-stream', async (req, res) => {
    try {
        const caseId = parseInt(req.params.id, 10);
        const limit = Math.max(1, Math.min(parseInt(req.query.limit, 10) || 100, 300));
        const sourceFilters = new Set(parseCsvParam(req.query.source).map((value) => value.toLowerCase()));
        const before = parseIsoTimestamp(req.query.before);
        const after = parseIsoTimestamp(req.query.after);
        const caseData = await db.getCaseById(caseId);
        if (!caseData) {
            return res.status(404).json({ success: false, error: 'Case not found' });
        }

        const [ledgerResult, activityResult, portalSubmissions, emailEvents, errorEventsResult, decisionTraces] = await Promise.all([
            db.query(
                `SELECT id, event, transition_key, context, mutations_applied, projection, created_at
                 FROM case_event_ledger
                 WHERE case_id = $1
                 ORDER BY created_at DESC, id DESC
                 LIMIT $2`,
                [caseId, limit]
            ),
            db.query(
                `SELECT id, event_type, description, metadata, actor_type, actor_id, source_service, created_at
                 FROM activity_log
                 WHERE case_id = $1
                 ORDER BY created_at DESC, id DESC
                 LIMIT $2`,
                [caseId, limit]
            ),
            db.getPortalSubmissions(caseId, { limit }),
            db.getCaseEmailEvents(caseId, { limit }),
            db.query(
                `SELECT id, source_service, operation, error_name, error_code, error_message, retryable, retry_attempt, metadata, created_at
                 FROM error_events
                 WHERE case_id = $1
                 ORDER BY created_at DESC, id DESC
                 LIMIT $2`,
                [caseId, limit]
            ),
            db.getDecisionTracesByCaseId(caseId, limit),
        ]);

        const allEntries = [
            ...ledgerResult.rows.map((row) => ({
                source: 'case_event_ledger',
                timestamp: row.created_at,
                sort_key: row.id,
                payload: row,
            })),
            ...activityResult.rows.map((row) => ({
                source: 'activity_log',
                timestamp: row.created_at,
                sort_key: row.id,
                payload: row,
            })),
            ...portalSubmissions.map((row) => ({
                source: 'portal_submissions',
                timestamp: row.started_at || row.created_at || row.completed_at,
                sort_key: row.id,
                payload: row,
            })),
            ...emailEvents.map((row) => ({
                source: 'email_events',
                timestamp: row.event_timestamp || row.created_at,
                sort_key: row.id,
                payload: row,
            })),
            ...errorEventsResult.rows.map((row) => ({
                source: 'error_events',
                timestamp: row.created_at,
                sort_key: row.id,
                payload: row,
            })),
            ...decisionTraces.map((row) => ({
                source: 'decision_traces',
                timestamp: row.created_at,
                sort_key: row.id,
                payload: {
                    id: row.id,
                    run_id: row.run_id,
                    classification: row.classification,
                    router_output: row.router_output,
                    node_trace: row.node_trace,
                    gate_decision: row.gate_decision,
                    duration_ms: row.duration_ms,
                    started_at: row.started_at,
                    completed_at: row.completed_at,
                },
            })),
        ]
            .filter((row) => row.timestamp)
            .filter((row) => sourceFilters.size === 0 || sourceFilters.has(row.source))
            .filter((row) => !before || new Date(row.timestamp).getTime() < before.getTime())
            .filter((row) => !after || new Date(row.timestamp).getTime() > after.getTime())
            .sort((a, b) => {
                const tsDiff = new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime();
                if (tsDiff !== 0) return tsDiff;
                return Number(b.sort_key || 0) - Number(a.sort_key || 0);
            });

        const summary = allEntries.reduce((acc, entry) => {
            acc.total += 1;
            acc.by_source[entry.source] = (acc.by_source[entry.source] || 0) + 1;
            return acc;
        }, { total: 0, by_source: {} });

        const entries = allEntries.slice(0, limit);

        res.json({
            success: true,
            case_id: caseId,
            count: entries.length,
            summary,
            filters: {
                sources: Array.from(sourceFilters),
                before: before ? before.toISOString() : null,
                after: after ? after.toISOString() : null,
            },
            next_before: entries.length === limit ? entries[entries.length - 1]?.timestamp || null : null,
            entries,
        });
    } catch (error) {
        logger.error('Error fetching audit stream:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * DELETE /api/requests/:id/attachments/:attachmentId
 * Remove an outbound attachment from a case
 */
router.delete('/:id/attachments/:attachmentId', async (req, res) => {
    const requestId = parseInt(req.params.id);
    const attachmentId = parseInt(req.params.attachmentId);
    const log = logger.forCase(requestId);

    try {
        const attachment = await db.getAttachmentById(attachmentId);
        if (!attachment) {
            return res.status(404).json({ success: false, error: 'Attachment not found' });
        }
        if (attachment.case_id !== requestId) {
            return res.status(403).json({ success: false, error: 'Attachment does not belong to this case' });
        }
        // Only allow deleting outbound (no message_id) attachments
        if (attachment.message_id) {
            return res.status(400).json({ success: false, error: 'Cannot delete inbound message attachments' });
        }

        await db.deleteAttachment(attachmentId);
        log.info(`Deleted attachment ${attachmentId} (${attachment.filename})`);

        // Clean up S3/R2 if stored there
        if (attachment.storage_url && attachment.storage_url.startsWith('s3://')) {
            try {
                const storageService = require('../../services/storage-service');
                const key = attachment.storage_url.replace(/^s3:\/\/[^/]+\//, '');
                await storageService.remove(key);
            } catch (cleanupErr) {
                log.warn(`Failed to clean up S3 object for attachment ${attachmentId}: ${cleanupErr.message}`);
            }
        }

        res.json({ success: true, deleted: { id: attachmentId, filename: attachment.filename } });
    } catch (error) {
        log.error(`Error deleting attachment: ${error.message}`);
        res.status(500).json(buildOperatorActionErrorResponse(error, 'DELETE_ATTACHMENT_FAILED'));
    }
});

module.exports = router;
