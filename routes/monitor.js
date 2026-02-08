const express = require('express');
const router = express.Router();
const db = require('../services/database');
const sgMail = require('@sendgrid/mail');
const { enqueueInboundMessageJob, enqueueResumeRunJob } = require('../queues/agent-queue');
const crypto = require('crypto');

// Initialize SendGrid
if (process.env.SENDGRID_API_KEY) {
    sgMail.setApiKey(process.env.SENDGRID_API_KEY);
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

    const job = await enqueueInboundMessageJob(run.id, caseData.id, message.id, {
        autopilotMode,
        threadId: run.langgraph_thread_id
    });

    return {
        caseData,
        run,
        job
    };
}

async function processProposalDecision(proposalId, action, { instruction = null, reason = null, decidedBy = 'monitor' } = {}) {
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
        reason,
        decidedAt: new Date().toISOString(),
        decidedBy
    };

    if (action === 'DISMISS') {
        await db.updateProposal(proposalId, {
            human_decision: humanDecision,
            status: 'DISMISSED'
        });

        return {
            success: true,
            message: 'Proposal dismissed',
            proposal_id: proposalId,
            action
        };
    }

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

    const job = await enqueueResumeRunJob(run.id, caseId, humanDecision, {
        isInitialRequest: proposal.action_type === 'SEND_INITIAL_REQUEST',
        originalProposalId: proposalId
    });

    return {
        success: true,
        message: 'Decision received, resume queued',
        run: { id: run.id, status: run.status },
        proposal_id: proposalId,
        action,
        job_id: job.id
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
                COUNT(*) FILTER (WHERE direction = 'inbound') as inbound_total,
                COUNT(*) FILTER (WHERE direction = 'outbound') as outbound_total
            FROM messages
        `);
        const counts = countsResult.rows[0];

        // Get recent activity logs
        const activityResult = await db.query(`
            SELECT
                id,
                event_type,
                case_id,
                message_id,
                description,
                metadata,
                created_at
            FROM activity_log
            ORDER BY created_at DESC
            LIMIT $1
        `, [limit]);

        // Get recent webhook events (if table exists)
        let webhookLogs = [];
        try {
            const webhookResult = await db.query(`
                SELECT * FROM webhook_logs
                ORDER BY created_at DESC
                LIMIT $1
            `, [limit]);
            webhookLogs = webhookResult.rows;
        } catch (e) {
            // Table might not exist
        }

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
        const statsResult = await db.query(`
            SELECT
                status,
                COUNT(*) as count
            FROM cases
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
            activity: activityResult.rows,
            webhook_logs: webhookLogs
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
                ra.suggested_action
            FROM messages m
            LEFT JOIN email_threads t ON m.thread_id = t.id
            LEFT JOIN cases c ON t.case_id = c.id
            LEFT JOIN response_analysis ra ON ra.message_id = m.id
            WHERE m.direction = 'inbound'
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

        let query = `
            SELECT
                id,
                event_type,
                case_id,
                message_id,
                description,
                metadata,
                created_at
            FROM activity_log
        `;
        const params = [];

        if (eventType) {
            query += ` WHERE event_type = $1`;
            params.push(eventType);
            query += ` ORDER BY created_at DESC LIMIT $2`;
            params.push(limit);
        } else {
            query += ` ORDER BY created_at DESC LIMIT $1`;
            params.push(limit);
        }

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
            ORDER BY m.created_at DESC
            LIMIT $1
        `, [limit]);

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

        const summaryResult = await db.query(`
            SELECT
                COUNT(*) FILTER (
                    WHERE direction = 'inbound'
                      AND COALESCE(received_at, created_at) >= NOW() - INTERVAL '24 hours'
                ) AS inbound_24h,
                COUNT(*) FILTER (
                    WHERE direction = 'inbound'
                      AND (thread_id IS NULL OR case_id IS NULL)
                ) AS unmatched_inbound_total,
                COUNT(*) FILTER (
                    WHERE direction = 'inbound'
                      AND processed_at IS NULL
                ) AS unprocessed_inbound_total
            FROM messages
        `);

        const pendingApprovalsResult = await db.query(`
            SELECT
                p.id,
                p.case_id,
                p.action_type,
                p.confidence,
                p.created_at,
                p.trigger_message_id,
                c.case_name
            FROM proposals p
            LEFT JOIN cases c ON c.id = p.case_id
            WHERE p.status = 'PENDING_APPROVAL'
            ORDER BY p.created_at DESC
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
            ORDER BY r.started_at DESC
            LIMIT $1
        `, [limit]);

        const unmatchedInboundResult = await db.query(`
            SELECT
                m.id,
                m.from_email,
                m.subject,
                m.received_at,
                m.created_at
            FROM messages m
            WHERE m.direction = 'inbound'
              AND (m.thread_id IS NULL OR m.case_id IS NULL)
            ORDER BY COALESCE(m.received_at, m.created_at) DESC
            LIMIT $1
        `, [limit]);

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
            ORDER BY COALESCE(m.received_at, m.created_at) DESC
            LIMIT $1
        `, [limit]);

        const stuckRunsResult = await db.query(`
            SELECT
                id,
                case_id,
                trigger_type,
                status,
                started_at,
                metadata
            FROM agent_runs
            WHERE status = 'running'
              AND started_at < NOW() - INTERVAL '2 minutes'
            ORDER BY started_at ASC
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
                stuck_runs_total: stuckRunsResult.rows.length
            },
            pending_approvals: pendingApprovalsResult.rows,
            active_runs: activeRunsResult.rows,
            unmatched_inbound: unmatchedInboundResult.rows,
            unprocessed_inbound: unprocessedInboundResult.rows,
            stuck_runs: stuckRunsResult.rows
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
                latest_exec.id AS execution_id,
                latest_exec.status AS execution_status,
                latest_exec.provider_message_id AS execution_provider_message_id,
                latest_exec.completed_at AS execution_completed_at,
                outbound.id AS outbound_message_id,
                outbound.sendgrid_message_id AS outbound_sendgrid_message_id,
                outbound.sent_at AS outbound_sent_at
            FROM proposals p
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
        const result = await processProposalDecision(proposalId, 'APPROVE');
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
        const { action, instruction = null, reason = null } = req.body || {};
        const result = await processProposalDecision(proposalId, action, { instruction, reason });
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

module.exports = router;
