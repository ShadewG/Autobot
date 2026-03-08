const express = require('express');
const router = express.Router();
const { db, logger, triggerDispatch, parseConstraints, generateOutcomeSummary } = require('./_helpers');
const sendgridService = require('../../services/sendgrid-service');
const { transitionCaseRuntime } = require('../../services/case-runtime');
const proposalLifecycle = require('../../services/proposal-lifecycle');
const { buildHumanDecision } = proposalLifecycle;

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
            state: caseData.state
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
            previous_status: caseData.status
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
        res.status(500).json({
            success: false,
            error: error.message
        });
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

        const threadIdentifier = replyingToInbound
            ? latestInbound.message_id
            : (currentThread?.thread_id || currentThread?.initial_message_id || null);

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
                message_type: replyingToInbound ? 'manual_reply' : 'manual_outbound'
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
        res.status(500).json({
            success: false,
            error: error.message
        });
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
                try { await db.dismissPendingProposals(requestId, `Review resolved: ${action}`, ['SUBMIT_PORTAL', 'SEND_FOLLOWUP', 'SEND_INITIAL_REQUEST']); } catch (_) {}
            } else if (action === 'close') {
                try { await db.dismissPendingProposals(requestId, `Review resolved: ${action}`); } catch (_) {}
            }

            await db.logActivity('human_decision', `Review resolved: ${action}${instruction ? ` — ${instruction}` : ''}`, {
                case_id: requestId,
                review_action: action,
                instruction: instruction || null,
                previous_status: caseData.status
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
                    } catch (_) {} // Token may already be expired/completed
                }
            }
        } catch (_) {}

        // Dismiss all active proposals — human is taking a new direction
        await proposalLifecycle.dismissActiveCaseProposals(requestId, {
            humanDecision: buildHumanDecision('DISMISS', {
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
            previous_status: caseData.status
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

        await db.logActivity(caseId, 'constraint_removed', {
            removed_constraint: removed,
            reason: reason || null,
            user_id: userId,
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

        await db.logActivity(caseId, 'constraint_added', {
            added_constraint: constraint,
            user_id: userId,
        });

        res.json({ success: true, constraint, constraints: current });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

module.exports = router;
