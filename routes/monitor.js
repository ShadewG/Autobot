const express = require('express');
const router = express.Router();
const db = require('../services/database');
const sgMail = require('@sendgrid/mail');
const { tasks, wait: triggerWait } = require('@trigger.dev/sdk/v3');
const { portalQueue } = require('../queues/email-queue');
const crypto = require('crypto');
const { normalizePortalUrl, isSupportedPortalUrl, detectPortalProviderByUrl } = require('../utils/portal-utils');
const { eventBus, notify } = require('../services/event-bus');
const pdContactService = require('../services/pd-contact-service');

// Initialize SendGrid
if (process.env.SENDGRID_API_KEY) {
    sgMail.setApiKey(process.env.SENDGRID_API_KEY);
}

// Trigger.dev queue + idempotency options for per-case concurrency control
function triggerOpts(caseId, taskType, uniqueId) {
  return {
    queue: { name: `case-${caseId}`, concurrencyLimit: 1 },
    idempotencyKey: `${taskType}:${caseId}:${uniqueId || Date.now()}`,
    idempotencyKeyTTL: "1h",
  };
}

// NOTE: idempotency keys take precedence over debounce, so we omit them here
function triggerOptsDebounced(caseId, taskType, uniqueId) {
  return {
    queue: { name: `case-${caseId}`, concurrencyLimit: 1 },
    debounce: { key: `${taskType}:${caseId}`, delay: "5s", mode: "trailing" },
  };
}

function deriveMessageSource(message) {
    if (!message) return 'unknown';
    if (message.message_type === 'manual_trigger') return 'manual trigger clone';
    if (message.message_type === 'simulated_inbound') return 'simulated inbound';
    if ((message.message_id || '').startsWith('monitor:')) return 'manual trigger clone';
    return 'webhook inbound';
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

    const handle = await tasks.trigger('process-inbound', {
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
    const allowedActions = ['APPROVE', 'ADJUST', 'DISMISS'];
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

    const caseId = proposal.case_id;
    const existingRun = await db.getActiveRunForCase(caseId);
    if (existingRun) {
        if (existingRun.status === 'paused') {
            await db.updateAgentRun(existingRun.id, {
                status: 'completed',
                ended_at: new Date()
            });
        } else {
            const err = new Error('Case already has an active agent run');
            err.status = 409;
            err.payload = {
                activeRun: {
                    id: existingRun.id,
                    status: existingRun.status,
                    trigger_type: existingRun.trigger_type
                }
            };
            throw err;
        }
    }

    const humanDecision = {
        action,
        proposalId,
        instruction,
        route_mode,
        reason,
        decidedAt: new Date().toISOString(),
        decidedBy: userId || decidedBy
    };

    if (action === 'DISMISS') {
        await db.updateProposal(proposalId, {
            human_decision: humanDecision,
            status: 'DISMISSED'
        });

        // Auto-learn from dismissal so AI doesn't repeat the same mistake
        try {
            const decisionMemory = require('../services/decision-memory-service');
            const caseData = await db.getCaseById(caseId);
            await decisionMemory.learnFromOutcome({
                category: 'general',
                triggerPattern: `dismissed ${proposal.action_type} for ${caseData?.agency_name || 'unknown agency'}`,
                lesson: `Do not propose ${proposal.action_type} for case #${caseId} (${caseData?.case_name || 'unknown'}) — it was dismissed by human reviewer.${reason ? ' Reason: ' + reason : ''}`,
                sourceCaseId: caseId,
                priority: 6
            });
        } catch (_) {}

        notify('info', `Proposal dismissed for case ${caseId}`, { case_id: caseId });
        return {
            success: true,
            message: 'Proposal dismissed',
            proposal_id: proposalId,
            action
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
        const sendgridService = require('../services/sendgrid-service');
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

        // Update case status
        await db.updateCaseStatus(caseId, 'sent', {
            substatus: `PDF form emailed to ${targetEmail}`,
            send_date: caseData.send_date || new Date()
        });

        await db.logActivity('pdf_email_sent', `PDF form emailed to ${targetEmail} for case ${caseId}`, {
            case_id: caseId,
            to: targetEmail,
            attachment_id: pdfAttachment.id,
            sendgrid_message_id: sendResult.messageId
        });

        try {
            const notionService = require('../services/notion-service');
            await notionService.syncStatusToNotion(caseId);
        } catch (_) {}

        notify('info', `PDF email sent to ${targetEmail} for case ${caseId}`, { case_id: caseId });
        return {
            success: true,
            message: `PDF email sent to ${targetEmail}`,
            proposal_id: proposalId,
            action,
            messageId: sendResult.messageId
        };
    }

    // SUBMIT_PORTAL: Execute directly — trigger the portal submission task.
    // These proposals are created by cron-service or Skyvern failure handlers
    // outside the Trigger.dev gate flow, so they have no waitpoint_token.
    if (proposal.action_type === 'SUBMIT_PORTAL' && action === 'APPROVE') {
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
        try {
            // Create a portal_task record for tracking
            const ptResult = await db.query(
                `INSERT INTO portal_tasks (case_id, portal_url, status, proposal_id)
                 VALUES ($1, $2, 'PENDING', $3) RETURNING id`,
                [caseId, portalUrl, proposalId]
            );
            portalTaskId = ptResult.rows[0]?.id;
        } catch (_) {}

        const handle = await tasks.trigger('submit-portal', {
            caseId,
            portalUrl,
            provider: caseData.portal_provider || null,
            instructions: proposal.draft_body_text || null,
            portalTaskId,
        }, triggerOpts(caseId, 'portal', proposalId));

        // Update proposal to PENDING_PORTAL
        await db.updateProposal(proposalId, { status: 'PENDING_PORTAL' });

        notify('info', `Portal submission approved — Trigger.dev task started for case ${caseId}`, { case_id: caseId });
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
        await triggerWait.completeToken(proposal.waitpoint_token, {
            action,
            instruction: instruction || null,
            reason: reason || null,
        });

        await db.updateProposal(proposalId, {
            human_decision: humanDecision,
            status: 'DECISION_RECEIVED'
        });

        notify('info', `Proposal ${action.toLowerCase()} — Trigger.dev task resuming for case ${caseId}`, { case_id: caseId });
        return {
            success: true,
            message: 'Decision received, Trigger.dev task resuming',
            proposal_id: proposalId,
            action,
        };
    }

    // Legacy path: re-trigger through Trigger.dev (old LangGraph proposals)
    await db.updateProposal(proposalId, {
        human_decision: humanDecision,
        status: 'DECISION_RECEIVED'
    });

    const run = await db.createAgentRunFull({
        case_id: caseId,
        trigger_type: 'resume',
        status: 'queued',
        autopilot_mode: proposal.autopilot_mode || 'SUPERVISED',
        langgraph_thread_id: `resume:${caseId}:proposal-${proposalId}`
    });

    let handle;
    // Pass the human's decision context so the agent follows the instruction
    const triggerContext = {
        triggerType: action === 'ADJUST' ? 'ADJUSTMENT' : 'HUMAN_REVIEW_RESOLUTION',
        reviewAction: action,
        reviewInstruction: instruction || null,
        // For ADJUST: carry the original action type so the agent re-drafts with the same action
        originalActionType: action === 'ADJUST' ? proposal.action_type : undefined,
        originalProposalId: proposalId,
    };
    if (proposal.action_type === 'SEND_INITIAL_REQUEST') {
        handle = await tasks.trigger('process-initial-request', {
            runId: run.id,
            caseId,
            autopilotMode: proposal.autopilot_mode || 'SUPERVISED',
            ...triggerContext,
        }, triggerOptsDebounced(caseId, 'approve-initial', proposalId));
    } else {
        handle = await tasks.trigger('process-inbound', {
            runId: run.id,
            caseId,
            messageId: proposal.trigger_message_id,
            autopilotMode: proposal.autopilot_mode || 'SUPERVISED',
            ...triggerContext,
        }, triggerOptsDebounced(caseId, 'approve-inbound', proposalId));
    }

    notify('info', `Proposal ${action.toLowerCase()} — re-triggered via Trigger.dev for case ${caseId}`, { case_id: caseId });
    return {
        success: true,
        message: 'Decision received, re-processing via Trigger.dev',
        run: { id: run.id, status: run.status },
        proposal_id: proposalId,
        action,
        trigger_run_id: handle.id
    };
}

/**
 * Monitor Dashboard - View all system activity for debugging
 */

/**
 * GET /api/monitor
 * Returns all inbound, outbound, activity logs for monitoring
 */
router.get('/', async (req, res) => {
    try {
        const limit = parseInt(req.query.limit) || 50;
        const userIdParam = req.query.user_id;
        const userId = userIdParam && userIdParam !== 'unowned' ? parseInt(userIdParam, 10) || null : null;
        const unownedOnly = userIdParam === 'unowned';

        // Build user filter clause for messages (via cases)
        const userJoin = (userId || unownedOnly)
            ? 'INNER JOIN email_threads t2 ON m.thread_id = t2.id INNER JOIN cases c2 ON t2.case_id = c2.id'
            : '';
        const userWhere = userId ? `AND c2.user_id = ${userId}`
            : unownedOnly ? 'AND c2.user_id IS NULL' : '';

        // Get all messages (inbound and outbound)
        const messagesResult = await db.query(`
            SELECT
                m.id,
                m.direction,
                m.from_email,
                m.to_email,
                m.subject,
                m.body_text,
                m.sent_at,
                m.received_at,
                m.created_at,
                m.sendgrid_message_id,
                c.id as case_id,
                c.case_name,
                c.agency_name,
                c.agency_email,
                c.portal_url,
                c.status as case_status
            FROM messages m
            LEFT JOIN email_threads t ON m.thread_id = t.id
            LEFT JOIN cases c ON t.case_id = c.id
            ${userId || unownedOnly ? `WHERE EXISTS (SELECT 1 FROM email_threads t2 JOIN cases c2 ON t2.case_id = c2.id WHERE t2.id = m.thread_id ${userWhere})` : ''}
            ORDER BY COALESCE(m.received_at, m.sent_at, m.created_at) DESC
            LIMIT $1
        `, [limit]);

        const messages = messagesResult.rows;
        const inbound = messages.filter(m => m.direction === 'inbound');
        const outbound = messages.filter(m => m.direction === 'outbound');

        // Get actual total counts (not limited)
        const countsResult = await db.query(`
            SELECT
                COUNT(*) as total,
                COUNT(*) FILTER (WHERE m.direction = 'inbound') as inbound_total,
                COUNT(*) FILTER (WHERE m.direction = 'outbound') as outbound_total
            FROM messages m
            ${userId || unownedOnly ? `WHERE EXISTS (SELECT 1 FROM email_threads t2 JOIN cases c2 ON t2.case_id = c2.id WHERE t2.id = m.thread_id ${userWhere})` : ''}
        `);
        const counts = countsResult.rows[0];

        // Get recent activity logs
        const activityResult = await db.query(`
            SELECT
                al.id,
                al.event_type,
                al.case_id,
                al.message_id,
                al.description,
                al.metadata,
                al.created_at
            FROM activity_log al
            ${userId || unownedOnly ? `LEFT JOIN cases c3 ON al.case_id = c3.id WHERE (al.case_id IS NULL OR ${userId ? `c3.user_id = ${userId}` : 'c3.user_id IS NULL'})` : ''}
            ORDER BY al.created_at DESC
            LIMIT $1
        `, [limit]);

        // Get queue status
        let queueStatus = { generation: {}, email: {} };
        try {
            const { generateQueue, emailQueue } = require('../queues/email-queue');
            if (generateQueue) {
                const [active, waiting, delayed] = await Promise.all([
                    generateQueue.getActiveCount(),
                    generateQueue.getWaitingCount(),
                    generateQueue.getDelayedCount()
                ]);
                queueStatus.generation = { active, waiting, delayed };
            }
            if (emailQueue) {
                const [active, waiting, delayed] = await Promise.all([
                    emailQueue.getActiveCount(),
                    emailQueue.getWaitingCount(),
                    emailQueue.getDelayedCount()
                ]);
                queueStatus.email = { active, waiting, delayed };
            }
        } catch (e) {
            // Queue might not be available
        }

        // Get case stats
        const caseUserWhere = userId ? `WHERE user_id = ${userId}` : unownedOnly ? 'WHERE user_id IS NULL' : '';
        const statsResult = await db.query(`
            SELECT
                status,
                COUNT(*) as count
            FROM cases
            ${caseUserWhere}
            GROUP BY status
        `);

        res.json({
            success: true,
            timestamp: new Date().toISOString(),
            summary: {
                total_messages: parseInt(counts.total) || 0,
                inbound_count: parseInt(counts.inbound_total) || 0,
                outbound_count: parseInt(counts.outbound_total) || 0,
                activity_count: activityResult.rows.length,
                showing: messages.length
            },
            queue: queueStatus,
            case_stats: statsResult.rows,
            inbound,
            outbound,
            activity: activityResult.rows
        });
    } catch (error) {
        console.error('Monitor error:', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * GET /api/monitor/inbound
 * Just inbound messages
 */
router.get('/inbound', async (req, res) => {
    try {
        const limit = parseInt(req.query.limit) || 100;
        const userIdParam = req.query.user_id;
        const userId = userIdParam && userIdParam !== 'unowned' ? parseInt(userIdParam, 10) || null : null;
        const unownedOnly = userIdParam === 'unowned';

        const userFilter = userId
            ? `AND EXISTS (SELECT 1 FROM email_threads t2 JOIN cases c2 ON t2.case_id = c2.id WHERE t2.id = m.thread_id AND c2.user_id = ${userId})`
            : unownedOnly
                ? `AND EXISTS (SELECT 1 FROM email_threads t2 JOIN cases c2 ON t2.case_id = c2.id WHERE t2.id = m.thread_id AND c2.user_id IS NULL)`
                : '';

        const suggestedCasesUserFilter = userId ? `AND c2.user_id = ${userId}` : unownedOnly ? 'AND c2.user_id IS NULL' : '';

        const result = await db.query(`
            SELECT
                m.id,
                m.from_email,
                m.to_email,
                m.subject,
                m.body_text,
                m.received_at,
                m.created_at,
                c.id as case_id,
                c.case_name,
                c.agency_name,
                c.agency_email,
                c.portal_url,
                ra.intent,
                ra.sentiment,
                ra.suggested_action,
                ra.key_points,
                CASE WHEN c.id IS NULL THEN (
                    SELECT json_agg(json_build_object('id', sc.id, 'case_name', sc.case_name, 'agency_name', sc.agency_name))
                    FROM (
                        SELECT DISTINCT c2.id, c2.case_name, c2.agency_name
                        FROM cases c2
                        WHERE c2.agency_email IS NOT NULL
                          AND split_part(c2.agency_email, '@', 2) = split_part(m.from_email, '@', 2)
                          ${suggestedCasesUserFilter}
                        LIMIT 5
                    ) sc
                ) ELSE NULL END AS suggested_cases
            FROM messages m
            LEFT JOIN email_threads t ON m.thread_id = t.id
            LEFT JOIN cases c ON t.case_id = c.id
            LEFT JOIN response_analysis ra ON ra.message_id = m.id
            WHERE m.direction = 'inbound'
            ${userFilter}
            ORDER BY COALESCE(m.received_at, m.created_at) DESC
            LIMIT $1
        `, [limit]);

        res.json({
            success: true,
            count: result.rows.length,
            inbound: result.rows
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

/**
 * GET /api/monitor/outbound
 * Just outbound messages
 */
router.get('/outbound', async (req, res) => {
    try {
        const limit = parseInt(req.query.limit) || 100;
        const userIdParam = req.query.user_id;
        const userId = userIdParam && userIdParam !== 'unowned' ? parseInt(userIdParam, 10) || null : null;
        const unownedOnly = userIdParam === 'unowned';

        const userFilter = userId
            ? `AND EXISTS (SELECT 1 FROM email_threads t2 JOIN cases c2 ON t2.case_id = c2.id WHERE t2.id = m.thread_id AND c2.user_id = ${userId})`
            : unownedOnly
                ? `AND EXISTS (SELECT 1 FROM email_threads t2 JOIN cases c2 ON t2.case_id = c2.id WHERE t2.id = m.thread_id AND c2.user_id IS NULL)`
                : '';

        const result = await db.query(`
            SELECT
                m.id,
                m.from_email,
                m.to_email,
                m.subject,
                m.body_text,
                m.sent_at,
                m.created_at,
                m.sendgrid_message_id,
                c.id as case_id,
                c.case_name,
                c.agency_name,
                c.agency_email,
                c.portal_url
            FROM messages m
            LEFT JOIN email_threads t ON m.thread_id = t.id
            LEFT JOIN cases c ON t.case_id = c.id
            WHERE m.direction = 'outbound'
            ${userFilter}
            ORDER BY COALESCE(m.sent_at, m.created_at) DESC
            LIMIT $1
        `, [limit]);

        res.json({
            success: true,
            count: result.rows.length,
            outbound: result.rows
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

/**
 * GET /api/monitor/activity
 * Activity logs with filtering
 */
router.get('/activity', async (req, res) => {
    try {
        const limit = parseInt(req.query.limit) || 100;
        const eventType = req.query.event_type;
        const userIdParam = req.query.user_id;
        const userId = userIdParam && userIdParam !== 'unowned' ? parseInt(userIdParam, 10) || null : null;
        const unownedOnly = userIdParam === 'unowned';

        const whereParts = [];
        const params = [];

        if (eventType) {
            params.push(eventType);
            whereParts.push(`al.event_type = $${params.length}`);
        }

        if (userId) {
            whereParts.push(`(al.case_id IS NOT NULL AND EXISTS (SELECT 1 FROM cases c WHERE c.id = al.case_id AND c.user_id = ${userId}))`);
        } else if (unownedOnly) {
            whereParts.push(`(al.case_id IS NULL OR EXISTS (SELECT 1 FROM cases c WHERE c.id = al.case_id AND c.user_id IS NULL))`);
        }

        const whereClause = whereParts.length > 0 ? 'WHERE ' + whereParts.join(' AND ') : '';
        params.push(limit);

        const query = `
            SELECT
                al.id,
                al.event_type,
                al.case_id,
                al.message_id,
                al.description,
                al.metadata,
                al.created_at
            FROM activity_log al
            ${whereClause}
            ORDER BY al.created_at DESC
            LIMIT $${params.length}
        `;

        const result = await db.query(query, params);

        res.json({
            success: true,
            count: result.rows.length,
            activity: result.rows
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

/**
 * GET /api/monitor/unmatched
 * Emails that arrived but couldn't be matched to a case
 */
router.get('/unmatched', async (req, res) => {
    try {
        const limit = parseInt(req.query.limit) || 50;
        const userIdParam = req.query.user_id;
        const userId = userIdParam && userIdParam !== 'unowned' ? parseInt(userIdParam, 10) || null : null;
        const unownedOnly = userIdParam === 'unowned';

        // Unmatched messages have no thread/case, so filter by TO email address
        let toFilter = '';
        const params = [limit];
        if (userId) {
            const user = await db.getUserById(userId);
            if (user?.email) {
                params.push(user.email);
                toFilter = `AND m.to_email ILIKE '%' || $${params.length} || '%'`;
            }
        } else if (unownedOnly) {
            toFilter = `AND (m.to_email ILIKE '%requests@foib-request.com%' OR m.to_email IS NULL)`;
        }

        const result = await db.query(`
            SELECT
                m.id,
                m.from_email,
                m.to_email,
                m.subject,
                m.body_text,
                m.received_at,
                m.created_at
            FROM messages m
            WHERE m.direction = 'inbound'
            AND m.thread_id IS NULL
            ${toFilter}
            ORDER BY m.created_at DESC
            LIMIT $1
        `, params);

        res.json({
            success: true,
            count: result.rows.length,
            unmatched: result.rows
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

/**
 * POST /api/monitor/send-test
 * Send a test email and track it for replies
 */
router.post('/send-test', express.json(), async (req, res) => {
    try {
        const { to, subject, body } = req.body;

        if (!to || !subject) {
            return res.status(400).json({ error: 'Missing required fields: to, subject' });
        }

        // Use foib-request.com domain - this is where Inbound Parse is configured
        const fromEmail = 'requests@foib-request.com';
        const fromName = 'FOIA Request Team';
        const emailBody = body || 'This is a test email from the Autobot monitor. Please reply to test inbound email detection.';

        // Send via SendGrid
        const msg = {
            to: to,
            from: { email: fromEmail, name: fromName },
            replyTo: fromEmail,
            subject: subject,
            text: emailBody,
            html: `<p>${emailBody.replace(/\n/g, '<br>')}</p>`
        };

        const [response] = await sgMail.send(msg);
        const sendgridMessageId = response?.headers?.['x-message-id'] || null;

        // Save to database for tracking
        const messageResult = await db.query(`
            INSERT INTO messages (direction, from_email, to_email, subject, body_text, body_html, sent_at, sendgrid_message_id, created_at)
            VALUES ('outbound', $1, $2, $3, $4, $5, NOW(), $6, NOW())
            RETURNING id
        `, [fromEmail, to, subject, emailBody, msg.html, sendgridMessageId]);

        const messageId = messageResult.rows[0]?.id;

        // Log activity
        await db.logActivity('test_email_sent', `Test email sent to ${to}`, {
            message_id: messageId,
            to,
            subject,
            sendgrid_message_id: sendgridMessageId
        });

        res.json({
            success: true,
            message: 'Test email sent successfully',
            message_id: messageId,
            sendgrid_message_id: sendgridMessageId,
            from: fromEmail,
            to: to,
            subject: subject,
            note: `Reply to ${fromEmail} to test inbound detection`
        });

    } catch (error) {
        console.error('Failed to send test email:', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * GET /api/monitor/config
 * Get current email configuration
 */
// =========================================================================
// AI Decision Lessons (experience memory)
// =========================================================================

router.get('/lessons', async (req, res) => {
    try {
        const decisionMemory = require('../services/decision-memory-service');
        const lessons = await decisionMemory.listLessons({ activeOnly: req.query.active !== 'false' });
        res.json({ success: true, lessons });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

router.post('/lessons', async (req, res) => {
    try {
        const decisionMemory = require('../services/decision-memory-service');
        const { category, trigger_pattern, lesson, priority } = req.body;
        if (!category || !trigger_pattern || !lesson) {
            return res.status(400).json({ success: false, error: 'category, trigger_pattern, and lesson are required' });
        }
        const created = await decisionMemory.addManualLesson({
            category, triggerPattern: trigger_pattern, lesson, priority: priority || 7
        });
        res.json({ success: true, lesson: created });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

router.put('/lessons/:id', async (req, res) => {
    try {
        const decisionMemory = require('../services/decision-memory-service');
        const updated = await decisionMemory.updateLesson(parseInt(req.params.id), req.body);
        res.json({ success: true, lesson: updated });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * POST /api/monitor/lessons/parse
 * AI-powered: translate natural language into a structured lesson
 */
router.post('/lessons/parse', express.json(), async (req, res) => {
    try {
        const { text } = req.body;
        if (!text || !text.trim()) {
            return res.status(400).json({ success: false, error: 'text is required' });
        }

        const Anthropic = require('@anthropic-ai/sdk');
        const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

        const response = await anthropic.messages.create({
            model: process.env.CLAUDE_MODEL || 'claude-sonnet-4-20250514',
            max_tokens: 1000,
            system: `You translate natural language instructions into structured AI decision lessons for a FOIA (Freedom of Information Act) case management system.

The system processes agency responses and decides actions. Lessons teach the AI how to handle specific situations.

Available action types (use the CODE, not the label):
- SEND_INITIAL_REQUEST — Send the first FOIA request to an agency
- SEND_FOLLOWUP — Send a follow-up when no response received
- SEND_REBUTTAL — Challenge a denial with legal arguments
- SEND_CLARIFICATION — Respond to agency asking for more info
- RESPOND_PARTIAL_APPROVAL — Accept released records + challenge withheld ones
- ACCEPT_FEE — Agree to pay a quoted fee
- NEGOTIATE_FEE — Counter-offer or request fee waiver
- DECLINE_FEE — Reject fee and explain why
- ESCALATE — Flag for human review
- RESEARCH_AGENCY — Find the correct agency/contact info
- REFORMULATE_REQUEST — Rewrite the request differently
- SUBMIT_PORTAL — Submit via an online portal instead of email
- CLOSE_CASE — Mark case as done
- WITHDRAW — Cancel/withdraw the request
- NONE — No action needed

Available categories: denial, portal, fee, followup, agency, general

Available denial subtypes: no_records, ongoing_investigation, privacy_exemption, overly_broad, excessive_fees, wrong_agency, retention_expired, format_issue

Respond with ONLY a JSON object:
{
  "category": "one of: denial, portal, fee, followup, agency, general",
  "trigger_pattern": "space-separated keywords that would match this scenario",
  "lesson": "Precise instruction for the AI, referencing the action type code. e.g. 'When agency cites ongoing investigation exemption, propose SEND_REBUTTAL requesting segregable non-exempt portions under state FOIA law.'",
  "priority": 1-10 (10 = highest, default 7),
  "recommended_action": "the primary ACTION_TYPE code this lesson recommends"
}`,
            messages: [{ role: 'user', content: text.trim() }]
        });

        const raw = response.content[0].text.trim();
        // Extract JSON from response (handle markdown code blocks)
        const jsonMatch = raw.match(/\{[\s\S]*\}/);
        if (!jsonMatch) {
            return res.status(422).json({ success: false, error: 'AI could not parse the lesson', raw });
        }

        const parsed = JSON.parse(jsonMatch[0]);
        res.json({ success: true, parsed });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

router.delete('/lessons/:id', async (req, res) => {
    try {
        const decisionMemory = require('../services/decision-memory-service');
        await decisionMemory.deleteLesson(parseInt(req.params.id));
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

router.get('/config', async (req, res) => {
    let queue = { generation: {}, email: {} };
    try {
        const { generateQueue, emailQueue } = require('../queues/email-queue');
        if (generateQueue) {
            const [active, waiting, delayed] = await Promise.all([
                generateQueue.getActiveCount(),
                generateQueue.getWaitingCount(),
                generateQueue.getDelayedCount()
            ]);
            queue.generation = { active, waiting, delayed };
        }
        if (emailQueue) {
            const [active, waiting, delayed] = await Promise.all([
                emailQueue.getActiveCount(),
                emailQueue.getWaitingCount(),
                emailQueue.getDelayedCount()
            ]);
            queue.email = { active, waiting, delayed };
        }
    } catch (e) {
        // Ignore queue fetch errors for UI config
    }

    res.json({
        from_email: 'requests@foib-request.com',
        from_name: 'FOIA Request Team',
        sendgrid_configured: !!process.env.SENDGRID_API_KEY,
        inbound_webhook: '/webhooks/inbound',
        inbound_domains: ['foib-request.com', 'foia.foib-request.com', 'c.foib-request.com'],
        execution_mode: 'LIVE',
        shadow_mode: false,
        default_autopilot_mode: 'SUPERVISED',
        require_human_approval: true,
        queue
    });
});

/**
 * GET /api/monitor/live-overview
 * Operational summary focused on missed routing / missed response paths.
 */
router.get('/live-overview', async (req, res) => {
    try {
        const limit = Math.min(parseInt(req.query.limit, 10) || 25, 100);
        const userIdParam = req.query.user_id;
        const userId = userIdParam && userIdParam !== 'unowned' ? parseInt(userIdParam, 10) || null : null;
        const unownedOnly = userIdParam === 'unowned';

        const msgUserFilter = userId
            ? `AND EXISTS (SELECT 1 FROM email_threads t2 JOIN cases c2 ON t2.case_id = c2.id WHERE t2.id = m.thread_id AND c2.user_id = ${userId})`
            : unownedOnly
                ? `AND EXISTS (SELECT 1 FROM email_threads t2 JOIN cases c2 ON t2.case_id = c2.id WHERE t2.id = m.thread_id AND c2.user_id IS NULL)`
                : '';
        const caseUserFilter = userId ? `AND c.user_id = ${userId}` : unownedOnly ? 'AND c.user_id IS NULL' : '';

        const summaryResult = await db.query(`
            SELECT
                COUNT(*) FILTER (
                    WHERE m.direction = 'inbound'
                      AND COALESCE(m.received_at, m.created_at) >= NOW() - INTERVAL '24 hours'
                ) AS inbound_24h,
                COUNT(*) FILTER (
                    WHERE m.direction = 'inbound'
                      AND (m.thread_id IS NULL OR m.case_id IS NULL)
                ) AS unmatched_inbound_total,
                COUNT(*) FILTER (
                    WHERE m.direction = 'inbound'
                      AND m.processed_at IS NULL
                ) AS unprocessed_inbound_total
            FROM messages m
            ${userId || unownedOnly ? `WHERE EXISTS (SELECT 1 FROM email_threads t2 JOIN cases c2 ON t2.case_id = c2.id WHERE t2.id = m.thread_id ${userId ? `AND c2.user_id = ${userId}` : 'AND c2.user_id IS NULL'})` : ''}
        `);

        const pendingApprovalsResult = await db.query(`
            SELECT
                p.id,
                p.case_id,
                p.action_type,
                p.confidence,
                p.created_at,
                p.trigger_message_id,
                p.reasoning,
                p.draft_subject,
                p.pause_reason AS proposal_pause_reason,
                p.risk_flags,
                p.warnings,
                c.case_name,
                c.agency_name,
                c.status AS case_status,
                c.portal_url,
                c.agency_email,
                c.user_id,
                c.pause_reason AS case_pause_reason,
                (c.fee_quote_jsonb->>'amount')::numeric AS last_fee_quote_amount,
                (SELECT COUNT(*) FROM messages m WHERE m.case_id = c.id) AS message_count,
                (SELECT COUNT(*) FROM messages m WHERE m.case_id = c.id AND m.direction = 'inbound') AS inbound_count,
                (SELECT m2.body_text FROM messages m2 WHERE m2.case_id = c.id AND m2.direction = 'inbound' ORDER BY COALESCE(m2.received_at, m2.created_at) DESC LIMIT 1) AS last_inbound_preview,
                (SELECT m3.subject FROM messages m3 WHERE m3.case_id = c.id AND m3.direction = 'inbound' ORDER BY COALESCE(m3.received_at, m3.created_at) DESC LIMIT 1) AS last_inbound_subject,
                (SELECT COALESCE(m4.received_at, m4.created_at) FROM messages m4 WHERE m4.case_id = c.id AND m4.direction = 'inbound' ORDER BY COALESCE(m4.received_at, m4.created_at) DESC LIMIT 1) AS last_inbound_date
            FROM proposals p
            LEFT JOIN cases c ON c.id = p.case_id
            WHERE p.status IN ('PENDING_APPROVAL', 'BLOCKED')
            ${caseUserFilter}
            ORDER BY
                CASE WHEN p.risk_flags IS NOT NULL AND array_length(p.risk_flags, 1) > 0 THEN 0
                     WHEN p.confidence < 0.6 THEN 1 ELSE 2 END ASC,
                p.created_at DESC
            LIMIT $1
        `, [limit]);

        const activeRunsResult = await db.query(`
            SELECT
                r.id,
                r.case_id,
                r.status,
                r.trigger_type,
                r.started_at,
                r.metadata,
                c.case_name
            FROM agent_runs r
            LEFT JOIN cases c ON c.id = r.case_id
            WHERE r.status IN ('queued', 'running', 'paused')
            ${caseUserFilter}
            ORDER BY r.started_at DESC
            LIMIT $1
        `, [limit]);

        // Resolve user email for TO-address filtering on unmatched messages
        let unmatchedUserEmail = null;
        if (userId) {
            const user = await db.getUserById(userId);
            unmatchedUserEmail = user?.email || null;
        }
        const unmatchedToFilter = unmatchedUserEmail
            ? `AND m.to_email ILIKE '%' || $2 || '%'`
            : unownedOnly
                ? `AND (m.to_email ILIKE '%requests@foib-request.com%' OR m.to_email IS NULL)`
                : '';
        const suggestedCasesUserFilter = userId ? `AND c2.user_id = ${userId}` : unownedOnly ? 'AND c2.user_id IS NULL' : '';
        const unmatchedParams = [limit];
        if (unmatchedUserEmail) unmatchedParams.push(unmatchedUserEmail);

        const unmatchedInboundResult = await db.query(`
            SELECT
                m.id,
                m.from_email,
                m.subject,
                m.received_at,
                m.created_at,
                LEFT(m.body_text, 200) AS body_preview,
                (
                    SELECT json_agg(json_build_object('id', c.id, 'case_name', c.case_name, 'agency_name', c.agency_name))
                    FROM (
                        SELECT DISTINCT c2.id, c2.case_name, c2.agency_name
                        FROM cases c2
                        WHERE c2.agency_email IS NOT NULL
                          AND split_part(c2.agency_email, '@', 2) = split_part(m.from_email, '@', 2)
                          ${suggestedCasesUserFilter}
                        LIMIT 3
                    ) c
                ) AS suggested_cases
            FROM messages m
            WHERE m.direction = 'inbound'
              AND (m.thread_id IS NULL OR m.case_id IS NULL)
              ${unmatchedToFilter}
            ORDER BY COALESCE(m.received_at, m.created_at) DESC
            LIMIT $1
        `, unmatchedParams);

        const unprocessedInboundResult = await db.query(`
            SELECT
                m.id,
                m.case_id,
                m.from_email,
                m.subject,
                m.received_at,
                m.created_at,
                c.case_name
            FROM messages m
            LEFT JOIN cases c ON c.id = m.case_id
            WHERE m.direction = 'inbound'
              AND m.processed_at IS NULL
              ${caseUserFilter}
            ORDER BY COALESCE(m.received_at, m.created_at) DESC
            LIMIT $1
        `, [limit]);

        const stuckRunsResult = await db.query(`
            SELECT
                r.id,
                r.case_id,
                r.trigger_type,
                r.status,
                r.started_at,
                r.metadata
            FROM agent_runs r
            ${userId || unownedOnly ? 'LEFT JOIN cases c ON c.id = r.case_id' : ''}
            WHERE r.status = 'running'
              AND r.started_at < NOW() - INTERVAL '2 minutes'
              ${userId || unownedOnly ? (userId ? `AND c.user_id = ${userId}` : 'AND c.user_id IS NULL') : ''}
            ORDER BY r.started_at ASC
            LIMIT $1
        `, [limit]);

        const humanReviewResult = await db.query(`
            SELECT
                c.id,
                c.case_name,
                c.agency_name,
                c.status,
                c.substatus,
                c.updated_at,
                c.portal_url,
                c.last_portal_task_url,
                c.last_portal_run_id,
                c.last_portal_status,
                c.pause_reason,
                (c.fee_quote_jsonb->>'amount')::numeric AS last_fee_quote_amount,
                c.agency_email,
                c.user_id,
                (SELECT COUNT(*) FROM messages m WHERE m.case_id = c.id AND m.direction = 'inbound') AS inbound_count,
                (SELECT m2.body_text FROM messages m2 WHERE m2.case_id = c.id AND m2.direction = 'inbound' ORDER BY COALESCE(m2.received_at, m2.created_at) DESC LIMIT 1) AS last_inbound_preview
            FROM cases c
            WHERE c.status IN ('needs_human_review', 'needs_phone_call', 'needs_contact_info', 'needs_human_fee_approval')
              AND NOT EXISTS (SELECT 1 FROM proposals p WHERE p.case_id = c.id AND p.status IN ('PENDING_APPROVAL', 'BLOCKED'))
              ${caseUserFilter}
            ORDER BY
                CASE c.pause_reason WHEN 'FEE_QUOTE' THEN 0 WHEN 'DENIAL' THEN 1
                     WHEN 'SENSITIVE' THEN 2 ELSE 3 END ASC,
                c.updated_at ASC
            LIMIT $1
        `, [limit]);

        res.json({
            success: true,
            summary: {
                inbound_24h: parseInt(summaryResult.rows[0]?.inbound_24h || 0, 10),
                unmatched_inbound_total: parseInt(summaryResult.rows[0]?.unmatched_inbound_total || 0, 10),
                unprocessed_inbound_total: parseInt(summaryResult.rows[0]?.unprocessed_inbound_total || 0, 10),
                pending_approvals_total: pendingApprovalsResult.rows.length,
                active_runs_total: activeRunsResult.rows.length,
                stuck_runs_total: stuckRunsResult.rows.length,
                human_review_total: humanReviewResult.rows.length
            },
            pending_approvals: pendingApprovalsResult.rows,
            active_runs: activeRunsResult.rows,
            unmatched_inbound: unmatchedInboundResult.rows,
            unprocessed_inbound: unprocessedInboundResult.rows,
            stuck_runs: stuckRunsResult.rows,
            human_review_cases: humanReviewResult.rows
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * GET /api/monitor/daily-stats
 * Today's activity summary for the daily stats bar.
 */
router.get('/daily-stats', async (req, res) => {
    try {
        const userIdParam = req.query.user_id;
        const userId = userIdParam && userIdParam !== 'unowned' ? parseInt(userIdParam, 10) || null : null;
        const unownedOnly = userIdParam === 'unowned';

        const userFilter = userId
            ? `WHERE EXISTS (SELECT 1 FROM cases c WHERE c.id = al.case_id AND c.user_id = ${userId})`
            : unownedOnly
                ? 'WHERE EXISTS (SELECT 1 FROM cases c WHERE c.id = al.case_id AND c.user_id IS NULL)'
                : '';

        const result = await db.query(`
            SELECT
                COUNT(*) FILTER (WHERE event_type = 'proposal_approved' AND al.created_at >= CURRENT_DATE) AS approved_today,
                COUNT(*) FILTER (WHERE event_type = 'proposal_dismissed' AND al.created_at >= CURRENT_DATE) AS dismissed_today,
                COUNT(*) FILTER (WHERE event_type IN ('status_change') AND al.created_at >= CURRENT_DATE AND al.metadata->>'new_status' IN ('completed', 'records_received', 'closed')) AS completed_today,
                COUNT(*) FILTER (WHERE event_type = 'inbound_received' AND al.created_at >= CURRENT_DATE) AS inbound_today,
                COUNT(*) FILTER (WHERE event_type = 'outbound_sent' AND al.created_at >= CURRENT_DATE) AS sent_today
            FROM activity_log al
            ${userFilter}
        `);
        const row = result.rows[0] || {};
        res.json({
            success: true,
            stats: {
                approved_today: parseInt(row.approved_today || 0, 10),
                dismissed_today: parseInt(row.dismissed_today || 0, 10),
                completed_today: parseInt(row.completed_today || 0, 10),
                inbound_today: parseInt(row.inbound_today || 0, 10),
                sent_today: parseInt(row.sent_today || 0, 10)
            }
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * GET /api/monitor/cases
 * Case-centric monitoring list with progress signals.
 */
router.get('/cases', async (req, res) => {
    try {
        const limit = Math.min(parseInt(req.query.limit, 10) || 200, 500);
        const status = req.query.status || null;
        const userIdParam = req.query.user_id;
        const params = [];
        const whereParts = [];

        if (status) {
            params.push(status);
            whereParts.push(`c.status = $${params.length}`);
        }

        if (userIdParam === 'unowned') {
            whereParts.push('c.user_id IS NULL');
        } else if (userIdParam && !isNaN(parseInt(userIdParam))) {
            params.push(parseInt(userIdParam));
            whereParts.push(`c.user_id = $${params.length}`);
        }

        const whereClause = whereParts.length > 0 ? 'WHERE ' + whereParts.join(' AND ') : '';

        params.push(limit);
        const limitParam = `$${params.length}`;

        const result = await db.query(`
            SELECT
                c.id,
                c.case_name,
                c.agency_name,
                c.subject_name,
                c.status,
                c.substatus,
                c.agency_email,
                c.portal_url,
                c.created_at,
                c.updated_at,
                c.user_id,
                c.deadline_date,
                c.send_date,
                c.last_contact_research_at,
                c.tags,
                c.priority,
                c.outcome_type,
                CASE
                    WHEN c.deadline_date IS NOT NULL AND c.deadline_date < CURRENT_DATE
                         AND c.status IN ('sent', 'awaiting_response')
                    THEN (CURRENT_DATE - c.deadline_date::date)
                    ELSE 0
                END AS days_overdue,
                CASE
                    WHEN c.deadline_date IS NOT NULL AND c.deadline_date >= CURRENT_DATE
                         AND c.status IN ('sent', 'awaiting_response')
                    THEN (c.deadline_date::date - CURRENT_DATE)
                    ELSE NULL
                END AS days_remaining,
                u.name AS user_name,
                u.email_handle AS user_handle,
                msg_counts.total_messages,
                msg_counts.inbound_messages,
                msg_counts.outbound_messages,
                last_msg.last_message_at,
                last_msg.last_message_subject,
                proposal_counts.pending_approvals,
                active_run.id AS active_run_id,
                active_run.status AS active_run_status,
                active_run.trigger_type AS active_run_trigger_type
            FROM cases c
            LEFT JOIN users u ON c.user_id = u.id
            LEFT JOIN LATERAL (
                SELECT
                    COUNT(*)::int AS total_messages,
                    COUNT(*) FILTER (WHERE m.direction = 'inbound')::int AS inbound_messages,
                    COUNT(*) FILTER (WHERE m.direction = 'outbound')::int AS outbound_messages
                FROM messages m
                WHERE m.case_id = c.id
            ) msg_counts ON true
            LEFT JOIN LATERAL (
                SELECT
                    COALESCE(m.received_at, m.sent_at, m.created_at) AS last_message_at,
                    m.subject AS last_message_subject
                FROM messages m
                WHERE m.case_id = c.id
                ORDER BY COALESCE(m.received_at, m.sent_at, m.created_at) DESC
                LIMIT 1
            ) last_msg ON true
            LEFT JOIN LATERAL (
                SELECT
                    COUNT(*) FILTER (WHERE p.status = 'PENDING_APPROVAL')::int AS pending_approvals
                FROM proposals p
                WHERE p.case_id = c.id
            ) proposal_counts ON true
            LEFT JOIN LATERAL (
                SELECT
                    r.id,
                    r.status,
                    r.trigger_type
                FROM agent_runs r
                WHERE r.case_id = c.id
                  AND r.status IN ('created', 'queued', 'running', 'paused')
                ORDER BY r.started_at DESC
                LIMIT 1
            ) active_run ON true
            ${whereClause}
            ORDER BY c.updated_at DESC
            LIMIT ${limitParam}
        `, params);

        res.json({ success: true, cases: result.rows, count: result.rows.length });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * GET /api/monitor/case/:id
 * Full case inspection view with correspondence and progress.
 */
router.get('/case/:id', async (req, res) => {
    try {
        const caseId = parseInt(req.params.id, 10);
        if (!caseId) {
            return res.status(400).json({ success: false, error: 'Invalid case id' });
        }

        const caseData = await db.getCaseById(caseId);
        if (!caseData) {
            return res.status(404).json({ success: false, error: `Case ${caseId} not found` });
        }

        const portalAccount = caseData.portal_url
            ? await db.getPortalAccountByUrl(caseData.portal_url).catch(() => null)
            : null;

        const [threadResult, messagesResult, runsResult, proposalsResult, portalTasksResult, caseAgencies] = await Promise.all([
            db.query(`
                SELECT *
                FROM email_threads
                WHERE case_id = $1
                ORDER BY created_at DESC
                LIMIT 1
            `, [caseId]),
            db.query(`
                SELECT
                    id, direction, from_email, to_email, subject, body_text, body_html,
                    message_type, sendgrid_message_id, sent_at, received_at, created_at,
                    processed_at, processed_run_id, summary
                FROM messages
                WHERE case_id = $1
                ORDER BY COALESCE(received_at, sent_at, created_at) DESC
                LIMIT 300
            `, [caseId]),
            db.query(`
                SELECT
                    id, trigger_type, status, started_at, ended_at, error, autopilot_mode,
                    proposal_id, message_id, metadata
                FROM agent_runs
                WHERE case_id = $1
                ORDER BY started_at DESC
                LIMIT 100
            `, [caseId]),
            db.query(`
                SELECT
                    id, action_type, status, confidence, trigger_message_id, run_id,
                    draft_subject, draft_body_text, reasoning, created_at, updated_at, execution_key, email_job_id,
                    human_decision
                FROM proposals
                WHERE case_id = $1
                ORDER BY created_at DESC
                LIMIT 100
            `, [caseId]),
            db.query(`
                SELECT
                    id, status, portal_url, action_type, proposal_id,
                    assigned_to, completed_at, completion_notes, created_at, updated_at,
                    subject, body_text, instructions, confirmation_number
                FROM portal_tasks
                WHERE case_id = $1
                ORDER BY created_at DESC
                LIMIT 100
            `, [caseId]).catch(() => ({ rows: [] })),
            db.getCaseAgencies(caseId).catch(() => [])
        ]);

        res.json({
            success: true,
            case: caseData,
            thread: threadResult.rows[0] || null,
            messages: messagesResult.rows,
            runs: runsResult.rows,
            proposals: proposalsResult.rows,
            portal_tasks: portalTasksResult.rows,
            portal_account: portalAccount ? { email: portalAccount.email, password: portalAccount.password } : null,
            case_agencies: caseAgencies
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * POST /api/monitor/case/:id/trigger-portal
 * Force queue a portal submission job for manual live testing.
 */
router.post('/case/:id/trigger-portal', express.json(), async (req, res) => {
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

        const job = await portalQueue.add('portal-submit', {
            caseId,
            portalUrl: normalizedPortalUrl,
            provider: provider || caseData.portal_provider || null,
            instructions: appendedResearch
        });

        // Clear review flags so case leaves the queue
        await db.updateCaseStatus(caseId, 'portal_in_progress', {
            substatus: 'Monitor-triggered portal submission queued',
            requires_human: false,
            pause_reason: null,
            last_portal_status: 'Portal submission queued (monitor trigger)',
            last_portal_status_at: new Date()
        });

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
            job_id: job?.id || null
        });

        notify('info', `Portal submission queued for ${caseData.case_name}`, { case_id: caseId });
        res.json({
            success: true,
            message: 'Portal submission queued',
            case_id: caseId,
            job_id: job?.id || null,
            portal_url: normalizedPortalUrl,
            monitor_case_url: `/api/monitor/case/${caseId}`
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * POST /api/monitor/reset-state
 * Operational reset for clean slate testing.
 * Does not delete cases/messages/history; it closes active runs and dismisses pending approvals.
 */
router.post('/reset-state', express.json(), async (req, res) => {
    try {
        const resetRunsResult = await db.query(`
            UPDATE agent_runs
            SET status = 'failed',
                ended_at = COALESCE(ended_at, NOW()),
                error = COALESCE(error, 'Manual reset from monitor')
            WHERE status IN ('queued', 'running', 'paused')
            RETURNING id
        `);

        const dismissProposalsResult = await db.query(`
            UPDATE proposals
            SET status = 'DISMISSED',
                human_decision = COALESCE(
                    human_decision,
                    jsonb_build_object(
                        'action', 'DISMISS',
                        'reason', 'Manual reset from monitor',
                        'decidedAt', to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"'),
                        'decidedBy', 'monitor-reset'
                    )
                ),
                updated_at = NOW()
            WHERE status IN ('PENDING_APPROVAL', 'DECISION_RECEIVED')
            RETURNING id
        `);

        await db.logActivity('monitor_reset_state', 'Monitor reset operational state', {
            runs_reset: resetRunsResult.rowCount,
            proposals_dismissed: dismissProposalsResult.rowCount
        });

        res.json({
            success: true,
            message: 'Operational state reset',
            runs_reset: resetRunsResult.rowCount,
            proposals_dismissed: dismissProposalsResult.rowCount
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * GET /api/monitor/message/:id/proposals
 * Return proposals tied to this message (trigger_message_id)
 */
router.get('/message/:id/proposals', async (req, res) => {
    try {
        const messageId = parseInt(req.params.id);
        const result = await db.query(`
            SELECT
                p.*,
                c.agency_email,
                c.portal_url,
                latest_exec.id AS execution_id,
                latest_exec.status AS execution_status,
                latest_exec.provider_message_id AS execution_provider_message_id,
                latest_exec.completed_at AS execution_completed_at,
                outbound.id AS outbound_message_id,
                outbound.sendgrid_message_id AS outbound_sendgrid_message_id,
                outbound.sent_at AS outbound_sent_at
            FROM proposals p
            LEFT JOIN cases c ON c.id = p.case_id
            LEFT JOIN LATERAL (
                SELECT
                    e.id,
                    e.status,
                    e.provider_message_id,
                    e.completed_at
                FROM executions e
                WHERE e.proposal_id = p.id
                ORDER BY e.created_at DESC
                LIMIT 1
            ) latest_exec ON true
            LEFT JOIN LATERAL (
                SELECT
                    m.id,
                    m.sendgrid_message_id,
                    m.sent_at
                FROM messages m
                WHERE m.case_id = p.case_id
                  AND m.direction = 'outbound'
                  AND (
                        (latest_exec.provider_message_id IS NOT NULL AND m.sendgrid_message_id = latest_exec.provider_message_id)
                        OR (p.executed_at IS NOT NULL AND m.created_at >= p.executed_at - INTERVAL '60 seconds')
                     )
                ORDER BY m.created_at DESC
                LIMIT 1
            ) outbound ON true
            WHERE p.trigger_message_id = $1
            ORDER BY p.created_at DESC
        `, [messageId]);

        res.json({ success: true, proposals: result.rows });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * POST /api/monitor/proposals/:id/approve
 * Convenience wrapper to approve a proposal
 */
router.post('/proposals/:id/approve', express.json(), async (req, res) => {
    try {
        const proposalId = parseInt(req.params.id);
        const userId = req.headers['x-user-id'] || null;
        const result = await processProposalDecision(proposalId, 'APPROVE', { userId });
        res.status(202).json(result);
    } catch (error) {
        const status = error.status || 500;
        res.status(status).json({ success: false, error: error.message, ...(error.payload || {}) });
    }
});

/**
 * POST /api/monitor/proposals/:id/decision
 * Unified proposal decisions from monitor (APPROVE|ADJUST|DISMISS)
 */
router.post('/proposals/:id/decision', express.json(), async (req, res) => {
    try {
        const proposalId = parseInt(req.params.id);
        const { action, instruction = null, reason = null, dismiss_reason = null, route_mode = null } = req.body || {};
        const userId = req.headers['x-user-id'] || null;
        const result = await processProposalDecision(proposalId, action, { instruction, reason: reason || dismiss_reason, route_mode, userId });
        res.status(action === 'DISMISS' ? 200 : 202).json(result);
    } catch (error) {
        const status = error.status || 500;
        res.status(status).json({ success: false, error: error.message, ...(error.payload || {}) });
    }
});

/**
 * POST /api/monitor/simulate-inbound
 * Create deterministic inbound message for testing
 */
router.post('/simulate-inbound', express.json(), async (req, res) => {
    try {
        const {
            case_id,
            subject,
            body_text,
            from_email,
            attach_to_thread = true,
            mark_processed = false
        } = req.body || {};

        if (!case_id || !body_text || !from_email) {
            return res.status(400).json({
                success: false,
                error: 'case_id, body_text, and from_email are required'
            });
        }

        const caseData = await db.getCaseById(parseInt(case_id));
        if (!caseData) {
            return res.status(404).json({ success: false, error: `Case ${case_id} not found` });
        }

        let thread = null;
        if (attach_to_thread) {
            thread = await db.getThreadByCaseId(caseData.id);
            if (!thread) {
                thread = await db.createEmailThread({
                    case_id: caseData.id,
                    thread_id: `sim:${caseData.id}:${Date.now()}`,
                    subject: subject || `Re: ${caseData.case_name || 'Public Records Request'}`,
                    agency_email: caseData.agency_email,
                    initial_message_id: null,
                    status: 'active'
                });
            }
        }

        const syntheticId = `sim:${caseData.id}:${Date.now()}:${crypto.randomBytes(3).toString('hex')}`;
        const message = await db.createMessage({
            thread_id: thread?.id || null,
            case_id: caseData.id,
            message_id: syntheticId,
            sendgrid_message_id: null,
            direction: 'inbound',
            from_email,
            to_email: 'requests@foib-request.com',
            subject: subject || `Re: ${caseData.case_name || 'Public Records Request'}`,
            body_text,
            body_html: `<p>${String(body_text).replace(/\n/g, '<br>')}</p>`,
            message_type: 'simulated_inbound',
            received_at: new Date()
        });

        if (mark_processed) {
            await db.query(`
                UPDATE messages
                SET processed_at = NOW()
                WHERE id = $1
            `, [message.id]);
        }

        await db.logActivity('simulated_inbound_created', `Simulated inbound created for case ${caseData.id}`, {
            case_id: caseData.id,
            message_id: message.id
        });

        res.status(201).json({
            success: true,
            message_id: message.id,
            case_id: caseData.id,
            thread_id: thread?.id || null,
            created_at: message.created_at
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * POST /api/monitor/trigger-inbound-run
 * Trigger run-engine inbound flow by message id
 */
router.post('/trigger-inbound-run', express.json(), async (req, res) => {
    try {
        const { message_id, force_new_run = false } = req.body || {};
        const autopilotMode = 'SUPERVISED';
        if (!message_id) {
            return res.status(400).json({ success: false, error: 'message_id is required' });
        }

        const message = await db.getMessageById(parseInt(message_id));
        if (!message) {
            return res.status(404).json({ success: false, error: `Message ${message_id} not found` });
        }
        if (message.direction !== 'inbound') {
            return res.status(400).json({ success: false, error: 'Only inbound messages can be processed' });
        }

        const { run, job } = await queueInboundRunForMessage(message, { autopilotMode, force_new_run });

        await db.logActivity('manual_ai_trigger', `AI triggered for inbound message ${message.id}`, {
            case_id: message.case_id,
            message_id: message.id,
            autopilotMode,
            force_new_run
        });

        res.json({
            success: true,
            approval_required: true,
            autopilot_mode: autopilotMode,
            run: {
                id: run.id,
                status: run.status,
                message_id: message.id,
                thread_id: run.langgraph_thread_id
            },
            job_id: job?.id || null
        });
    } catch (error) {
        const status = error.status || 500;
        res.status(status).json({ success: false, error: error.message, ...(error.payload || {}) });
    }
});

/**
 * GET /api/monitor/message/:id
 * Get full message details for drawer view
 */
router.get('/message/:id', async (req, res) => {
    try {
        const messageId = parseInt(req.params.id);
        const message = await db.getMessageById(messageId);

        if (!message) {
            return res.status(404).json({ success: false, error: 'Message not found' });
        }

        let caseData = null;
        let latestInitialRouteMode = null;
        if (message.case_id) {
            caseData = await db.getCaseById(message.case_id);
        } else if (message.thread_id) {
            const thread = await db.getThreadById(message.thread_id);
            if (thread?.case_id) {
                caseData = await db.getCaseById(thread.case_id);
            }
        }

        if (caseData?.id) {
            const routeResult = await db.query(`
                SELECT metadata
                FROM agent_runs
                WHERE case_id = $1
                  AND trigger_type = 'initial_request'
                ORDER BY started_at DESC
                LIMIT 1
            `, [caseData.id]);
            latestInitialRouteMode = routeResult.rows[0]?.metadata?.route_mode || null;
        }

        res.json({
            success: true,
            message,
            source: deriveMessageSource(message),
            case: caseData ? {
                id: caseData.id,
                case_name: caseData.case_name,
                agency_name: caseData.agency_name,
                agency_email: caseData.agency_email,
                portal_url: caseData.portal_url,
                status: caseData.status,
                latest_initial_route_mode: latestInitialRouteMode
            } : null
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * POST /api/monitor/message/:id/reply
 * Send a reply to an inbound message
 */
router.post('/message/:id/reply', express.json(), async (req, res) => {
    try {
        const messageId = parseInt(req.params.id);
        const { subject, body } = req.body || {};

        if (!body) {
            return res.status(400).json({ success: false, error: 'body is required' });
        }

        const message = await db.getMessageById(messageId);
        if (!message) {
            return res.status(404).json({ success: false, error: 'Message not found' });
        }

        if (message.direction !== 'inbound') {
            return res.status(400).json({ success: false, error: 'Can only reply to inbound messages' });
        }

        const caseData = message.case_id ? await db.getCaseById(message.case_id) : null;
        if (!caseData) {
            return res.status(400).json({ success: false, error: 'Message is not associated with a case' });
        }

        const replySubject = subject || `Re: ${message.subject || ''}`.trim();
        const emailBody = body;

        const msg = {
            to: message.from_email,
            from: { email: 'requests@foib-request.com', name: 'FOIA Request Team' },
            replyTo: 'requests@foib-request.com',
            subject: replySubject,
            text: emailBody,
            html: `<p>${emailBody.replace(/\n/g, '<br>')}</p>`,
            headers: {
                'In-Reply-To': message.message_id || undefined,
                'References': message.message_id || undefined
            }
        };

        const [response] = await sgMail.send(msg);
        const sendgridMessageId = response?.headers?.['x-message-id'] || null;

        const messageResult = await db.query(`
            INSERT INTO messages (direction, from_email, to_email, subject, body_text, body_html, sent_at, sendgrid_message_id, created_at, thread_id, case_id, message_type)
            VALUES ('outbound', $1, $2, $3, $4, $5, NOW(), $6, NOW(), $7, $8, 'manual_reply')
            RETURNING id
        `, ['requests@foib-request.com', message.from_email, replySubject, emailBody, msg.html, sendgridMessageId, message.thread_id, caseData.id]);

        const newMessageId = messageResult.rows[0]?.id;

        await db.logActivity('manual_reply_sent', `Manual reply sent to ${message.from_email}`, {
            message_id: newMessageId,
            case_id: caseData.id,
            in_reply_to: messageId
        });

        res.json({
            success: true,
            message: 'Reply sent',
            message_id: newMessageId,
            sendgrid_message_id: sendgridMessageId
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * POST /api/monitor/message/:id/match-case
 * Manually attach an unmatched inbound message to a case/thread.
 */
router.post('/message/:id/match-case', express.json(), async (req, res) => {
    try {
        const messageId = parseInt(req.params.id);
        const { case_id } = req.body || {};
        const caseId = parseInt(case_id);

        if (!caseId) {
            return res.status(400).json({ success: false, error: 'case_id is required' });
        }

        const message = await db.getMessageById(messageId);
        if (!message) {
            return res.status(404).json({ success: false, error: 'Message not found' });
        }

        if (message.direction !== 'inbound') {
            return res.status(400).json({ success: false, error: 'Only inbound messages can be matched' });
        }

        const caseData = await db.getCaseById(caseId);
        if (!caseData) {
            return res.status(404).json({ success: false, error: `Case ${caseId} not found` });
        }

        let thread = await db.getThreadByCaseId(caseId);
        if (!thread) {
            thread = await db.createEmailThread({
                case_id: caseId,
                thread_id: message.message_id || `monitor-match:${caseId}:${Date.now()}`,
                subject: message.subject || `Case ${caseId} correspondence`,
                agency_email: caseData.agency_email || message.from_email || '',
                initial_message_id: null,
                status: 'active'
            });
        }

        await db.query(`
            UPDATE messages
            SET case_id = $2,
                thread_id = $3
            WHERE id = $1
            RETURNING id
        `, [messageId, caseId, thread.id]);

        await db.logActivity('monitor_message_matched', `Monitor matched message ${messageId} to case ${caseId}`, {
            message_id: messageId,
            case_id: caseId,
            thread_id: thread.id
        });

        res.json({
            success: true,
            message: 'Message matched to case',
            message_id: messageId,
            case_id: caseId,
            thread_id: thread.id
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * POST /api/monitor/message/:id/dismiss
 * Dismiss (delete) an unmatched message (spam cleanup)
 */
router.post('/message/:id/dismiss', async (req, res) => {
    try {
        const id = parseInt(req.params.id);
        await db.dismissMessage(id);
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * POST /api/monitor/message/:id/trigger-ai
 * Trigger AI processing for the selected inbound message
 */
router.post('/message/:id/trigger-ai', express.json(), async (req, res) => {
    try {
        const messageId = parseInt(req.params.id);
        const {
            force_new_run = false,
            override_mode = false,
            body_text_override,
            subject_override
        } = req.body || {};
        const autopilotMode = 'SUPERVISED';

        const message = await db.getMessageById(messageId);
        if (!message) {
            return res.status(404).json({ success: false, error: 'Message not found' });
        }

        if (message.direction !== 'inbound') {
            return res.status(400).json({ success: false, error: 'Only inbound messages can be processed' });
        }

        const caseData = message.case_id ? await db.getCaseById(message.case_id) : null;
        if (!caseData) {
            return res.status(400).json({ success: false, error: 'Message is not associated with a case' });
        }

        let inboundMessage = message;

        const normalizedBodyOverride = typeof body_text_override === 'string' ? body_text_override.trim() : '';
        const normalizedSubjectOverride = typeof subject_override === 'string' ? subject_override.trim() : '';
        const normalizedMessageBody = (message.body_text || '').trim();
        const normalizedMessageSubject = (message.subject || '').trim();
        const shouldCloneForOverride =
            override_mode && (
                (normalizedBodyOverride && normalizedBodyOverride !== normalizedMessageBody) ||
                (normalizedSubjectOverride && normalizedSubjectOverride !== normalizedMessageSubject)
            );

        // Clone only when override content is different from stored message
        if (shouldCloneForOverride) {
            const newMessageId = `monitor:${message.id}:${Date.now()}:${crypto.randomBytes(4).toString('hex')}`;
            inboundMessage = await db.createMessage({
                thread_id: message.thread_id,
                case_id: caseData.id,
                message_id: newMessageId,
                sendgrid_message_id: null,
                direction: 'inbound',
                from_email: message.from_email,
                to_email: message.to_email,
                subject: normalizedSubjectOverride || message.subject,
                body_text: normalizedBodyOverride || message.body_text || '(empty body)',
                body_html: message.body_html || null,
                message_type: 'manual_trigger',
                received_at: new Date()
            });
        }

        const { run, job } = await queueInboundRunForMessage(inboundMessage, { autopilotMode, force_new_run });

        await db.logActivity('manual_ai_trigger', `AI triggered for inbound message ${messageId}`, {
            case_id: caseData.id,
            message_id: messageId,
            autopilotMode,
            force_new_run
        });

        res.json({
            success: true,
            approval_required: true,
            autopilot_mode: autopilotMode,
            run: {
                id: run.id,
                status: run.status,
                message_id: inboundMessage.id,
                thread_id: run.langgraph_thread_id
            },
            job_id: job?.id || null,
            note: inboundMessage.id === message.id ? 'Triggered on existing message' : 'Triggered on cloned message'
        });
    } catch (error) {
        const status = error.status || 500;
        res.status(status).json({ success: false, error: error.message, ...(error.payload || {}) });
    }
});

/**
 * POST /api/monitor/proposals/:id/generate-draft
 * Generate draft content for a proposal that has no draft (e.g., from reprocessing)
 */
router.post('/proposals/:id/generate-draft', express.json(), async (req, res) => {
    try {
        const proposalId = parseInt(req.params.id);
        const proposal = await db.query('SELECT * FROM proposals WHERE id = $1', [proposalId]);
        if (!proposal.rows[0]) {
            return res.status(404).json({ success: false, error: 'Proposal not found' });
        }
        const p = proposal.rows[0];

        if (p.draft_body_text) {
            return res.status(400).json({ success: false, error: 'Proposal already has draft content' });
        }

        const { draftResponseNode } = require('../langgraph/nodes/draft-response');

        // Build minimal state for the draft node
        const state = {
            caseId: p.case_id,
            proposalActionType: p.action_type,
            constraints: p.metadata?.constraints || [],
            scopeItems: p.metadata?.scope_items || [],
            extractedFeeAmount: p.metadata?.fee_amount || null,
            latestInboundMessageId: p.trigger_message_id || null,
            adjustmentInstruction: null,
            llmStubs: null
        };

        const result = await draftResponseNode(state);

        if (result.errors && result.errors.length > 0) {
            return res.status(500).json({ success: false, error: result.errors.join('; ') });
        }

        if (!result.draftBodyText && !result.draftSubject) {
            return res.status(500).json({ success: false, error: 'Draft generation returned empty content' });
        }

        // Update the proposal with the generated draft
        await db.query(`
            UPDATE proposals
            SET draft_subject = $1, draft_body_text = $2, draft_body_html = $3, updated_at = NOW()
            WHERE id = $4
        `, [result.draftSubject || null, result.draftBodyText || null, result.draftBodyHtml || null, proposalId]);

        res.json({
            success: true,
            draft: {
                subject: result.draftSubject,
                body_text: result.draftBodyText,
                body_html: result.draftBodyHtml
            }
        });
    } catch (error) {
        logger.error('Generate draft error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * GET /api/monitor/events
 * Server-Sent Events stream for real-time notifications
 */
router.get('/events', (req, res) => {
    const userIdParam = req.query.user_id;
    const userId = userIdParam && userIdParam !== 'unowned' ? parseInt(userIdParam, 10) || null : null;
    const unownedOnly = userIdParam === 'unowned';

    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive'
    });
    res.write(':\n\n'); // initial comment to flush headers

    const heartbeat = setInterval(() => res.write(':\n\n'), 30000);

    const onNotification = async (data) => {
        // If no user filter (All Users), send everything
        if (!userId && !unownedOnly) {
            res.write(`data: ${JSON.stringify(data)}\n\n`);
            return;
        }

        // If the event has a case_id, check ownership
        const caseId = data.case_id || data.metadata?.case_id;
        if (caseId) {
            try {
                const c = await db.getCaseById(caseId);
                if (userId && c?.user_id !== userId) return; // skip — wrong user
                if (unownedOnly && c?.user_id != null) return; // skip — owned
            } catch (_) {
                return; // skip on error
            }
        } else {
            // System-level events (no case_id) — only send for "All Users"
            return;
        }
        res.write(`data: ${JSON.stringify(data)}\n\n`);
    };
    eventBus.on('notification', onNotification);

    // Data update events — push incremental changes for dashboard
    const onDataUpdate = async (data) => {
        // Apply same user filtering as notifications
        const caseId = data.case_id || data.caseId;
        if (caseId && (userId || unownedOnly)) {
            try {
                const c = await db.getCaseById(caseId);
                if (userId && c?.user_id !== userId) return;
                if (unownedOnly && c?.user_id != null) return;
            } catch (_) {
                return;
            }
        }
        // Send as named SSE event so client can use addEventListener
        res.write(`event: ${data.event}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    eventBus.on('data_update', onDataUpdate);

    req.on('close', () => {
        clearInterval(heartbeat);
        eventBus.off('notification', onNotification);
        eventBus.off('data_update', onDataUpdate);
    });
});

/**
 * POST /api/monitor/case/:id/lookup-contact
 * Trigger a pd-contact lookup in the background. Returns immediately.
 */
router.post('/case/:id/lookup-contact', express.json(), async (req, res) => {
    const caseId = parseInt(req.params.id, 10);
    if (!caseId) return res.status(400).json({ success: false, error: 'Invalid case id' });
    const forceSearch = req.body?.forceSearch === true;

    const caseData = await db.getCaseById(caseId);
    if (!caseData) return res.status(404).json({ success: false, error: 'Case not found' });

    res.json({ success: true, message: 'Contact lookup started' });

    // Run in background
    (async () => {
        try {
            notify('info', forceSearch
                ? `Web-searching contacts for ${caseData.agency_name || caseData.case_name}...`
                : `Looking up contacts for ${caseData.agency_name || caseData.case_name}...`,
                { case_id: caseId });

            let result;
            try {
                result = await pdContactService.lookupContact(
                    caseData.agency_name,
                    caseData.state || caseData.incident_location,
                    { forceSearch }
                );
            } catch (lookupErr) {
                if (lookupErr.code === 'SERVICE_UNAVAILABLE') {
                    notify('error', `PD Contact service not reachable — is PD_CONTACT_API_URL set and the foia-researcher running?`, { case_id: caseId });
                } else {
                    notify('error', `Contact lookup failed: ${lookupErr.message}`, { case_id: caseId });
                }
                return;
            }

            if (!result || (!result.portal_url && !result.contact_email)) {
                notify('warning', `No contacts found for ${caseData.agency_name || caseData.case_name}`, { case_id: caseId });
                await db.updateCase(caseId, {
                    last_contact_research_at: new Date(),
                    contact_research_notes: 'pd-contact lookup returned no results'
                });
                return;
            }

            const updates = {
                last_contact_research_at: new Date(),
                contact_research_notes: [
                    result.notes,
                    result.records_officer ? `Records officer: ${result.records_officer}` : null,
                    `Source: ${result.source || 'pd-contact'}`,
                    `Confidence: ${result.confidence || 'unknown'}`
                ].filter(Boolean).join('. ')
            };

            if (result.contact_email && result.contact_email !== caseData.agency_email) {
                updates.alternate_agency_email = result.contact_email;
            }
            if (result.portal_url) {
                const normalized = normalizePortalUrl(result.portal_url);
                if (normalized && isSupportedPortalUrl(normalized)) {
                    updates.portal_url = normalized;
                    updates.portal_provider = result.portal_provider || detectPortalProviderByUrl(normalized)?.name || null;
                }
            }

            await db.updateCase(caseId, updates);

            // Create a case_agency row if research found an alternative email/portal
            if (result.contact_email && result.contact_email !== caseData.agency_email) {
                try {
                    await db.addCaseAgency(caseId, {
                        agency_name: result.agency_name || caseData.agency_name || 'Researched Agency',
                        agency_email: result.contact_email,
                        portal_url: updates.portal_url || null,
                        portal_provider: updates.portal_provider || null,
                        added_source: 'research',
                        notes: updates.contact_research_notes || null
                    });
                } catch (caErr) {
                    console.warn(`Failed to create case_agency from research: ${caErr.message}`);
                }
            }

            const parts = [];
            if (updates.portal_url) parts.push(`portal: ${updates.portal_url}`);
            if (updates.alternate_agency_email) parts.push(`email: ${updates.alternate_agency_email}`);
            if (result.contact_phone) parts.push(`phone: ${result.contact_phone}`);

            const fromNotion = !!result.fromNotion;
            notify('success', `Found contacts for ${caseData.agency_name || caseData.case_name}: ${parts.join(', ') || 'see research notes'}${fromNotion ? ' (from Notion cache)' : ''}`, { case_id: caseId, fromNotion });

            await db.logActivity('pd_contact_lookup', `PD contact lookup completed for case ${caseData.case_name}`, {
                case_id: caseId,
                portal_url: updates.portal_url || null,
                email: updates.alternate_agency_email || null,
                confidence: result.confidence
            });
        } catch (err) {
            console.error(`PD contact lookup failed for case ${caseId}:`, err.message);
            notify('error', `Contact lookup failed for ${caseData.agency_name || caseData.case_name}: ${err.message}`, { case_id: caseId });
        }
    })();
});

// =========================================================================
// Feature 2: Fee History
// =========================================================================

router.get('/case/:id/fee-history', async (req, res) => {
    try {
        const caseId = parseInt(req.params.id, 10);
        if (!caseId) return res.status(400).json({ success: false, error: 'Invalid case id' });
        const history = await db.getFeeHistoryByCaseId(caseId);
        res.json({ success: true, fee_history: history });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// =========================================================================
// Bulk Notion Sync
// =========================================================================

router.post('/sync-notion', express.json(), async (req, res) => {
    try {
        const notionService = require('../services/notion-service');

        // Get all active cases (non-terminal statuses)
        const activeCases = await db.query(`
            SELECT id FROM cases
            WHERE status NOT IN ('completed', 'cancelled', 'withdrawn')
              AND notion_page_id IS NOT NULL
              AND notion_page_id NOT LIKE 'test-%'
            ORDER BY id
        `);

        const caseIds = activeCases.rows.map(r => r.id);
        let synced = 0;
        let failed = 0;
        const errors = [];

        for (const caseId of caseIds) {
            try {
                await notionService.syncStatusToNotion(caseId);
                synced++;
            } catch (err) {
                failed++;
                errors.push({ caseId, error: err.message });
            }
        }

        res.json({
            success: true,
            total: caseIds.length,
            synced,
            failed,
            errors: errors.slice(0, 10)
        });
    } catch (error) {
        console.error('Bulk Notion sync error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// =========================================================================
// Feature 6: Attachment Download
// =========================================================================

router.get('/attachments/:id/download', async (req, res) => {
    try {
        const attachmentId = parseInt(req.params.id, 10);
        if (!attachmentId) return res.status(400).json({ success: false, error: 'Invalid attachment id' });

        const attachment = await db.getAttachmentById(attachmentId);
        if (!attachment) return res.status(404).json({ success: false, error: 'Attachment not found' });

        res.setHeader('Content-Disposition', `inline; filename="${attachment.filename || 'download'}"`);
        res.setHeader('Content-Type', attachment.content_type || 'application/octet-stream');

        // Tier 1: Try S3/R2 URL (permanent storage)
        if (attachment.storage_url && !attachment.storage_url.startsWith('s3://')) {
            return res.redirect(attachment.storage_url);
        }

        // Tier 1b: Try S3/R2 download (s3:// internal URLs)
        if (attachment.storage_url && attachment.storage_url.startsWith('s3://')) {
            try {
                const storageService = require('../services/storage-service');
                const key = attachment.storage_url.replace(/^s3:\/\/[^/]+\//, '');
                const buffer = await storageService.download(key);
                if (buffer) {
                    res.setHeader('Content-Length', buffer.length);
                    return res.send(buffer);
                }
            } catch (_) {}
        }

        // Tier 2: Try local disk (ephemeral)
        const fsSync = require('fs');
        if (attachment.storage_path && fsSync.existsSync(attachment.storage_path)) {
            return fsSync.createReadStream(attachment.storage_path).pipe(res);
        }

        // Tier 3: Serve from DB file_data column (BYTEA fallback)
        if (attachment.file_data) {
            res.setHeader('Content-Length', attachment.file_data.length);
            return res.send(attachment.file_data);
        }

        return res.status(404).json({ success: false, error: 'File not available (lost during deploy)' });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// =========================================================================
// Feature 6: Attachments list for a case
// =========================================================================

router.get('/case/:id/attachments', async (req, res) => {
    try {
        const caseId = parseInt(req.params.id, 10);
        if (!caseId) return res.status(400).json({ success: false, error: 'Invalid case id' });
        const attachments = await db.getAttachmentsByCaseId(caseId);
        res.json({ success: true, attachments });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

module.exports = router;
