const express = require('express');
const router = express.Router();
const db = require('../services/database');
const sgMail = require('@sendgrid/mail');
const { enqueueInboundMessageJob } = require('../queues/agent-queue');
const crypto = require('crypto');

// Initialize SendGrid
if (process.env.SENDGRID_API_KEY) {
    sgMail.setApiKey(process.env.SENDGRID_API_KEY);
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
                c.agency_name
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
    res.json({
        from_email: 'requests@foib-request.com',
        from_name: 'FOIA Request Team',
        sendgrid_configured: !!process.env.SENDGRID_API_KEY,
        inbound_webhook: '/webhooks/inbound',
        inbound_domains: ['foib-request.com', 'foia.foib-request.com', 'c.foib-request.com']
    });
});

/**
 * GET /api/monitor/message/:id/proposals
 * Return proposals tied to this message (trigger_message_id)
 */
router.get('/message/:id/proposals', async (req, res) => {
    try {
        const messageId = parseInt(req.params.id);
        const result = await db.query(`
            SELECT *
            FROM proposals
            WHERE trigger_message_id = $1
            ORDER BY created_at DESC
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

        const axios = require('axios');
        const baseUrl = process.env.WEBHOOK_BASE_URL || 'http://localhost:3000';

        const response = await axios.post(`${baseUrl}/api/proposals/${proposalId}/decision`, {
            action: 'APPROVE',
            decidedBy: 'monitor'
        }, { timeout: 15000 });

        res.json({ success: true, decision: response.data });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
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
        if (message.case_id) {
            caseData = await db.getCaseById(message.case_id);
        } else if (message.thread_id) {
            const thread = await db.getThreadById(message.thread_id);
            if (thread?.case_id) {
                caseData = await db.getCaseById(thread.case_id);
            }
        }

        res.json({
            success: true,
            message,
            case: caseData ? {
                id: caseData.id,
                case_name: caseData.case_name,
                agency_name: caseData.agency_name,
                agency_email: caseData.agency_email,
                status: caseData.status
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
        const { autopilotMode = 'SUPERVISED', force_new_run = false } = req.body || {};

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

        // If there's an active run, optionally cancel it
        const existingRun = await db.getActiveRunForCase(caseData.id);
        if (existingRun) {
            if (!force_new_run) {
                return res.status(409).json({
                    success: false,
                    error: 'Case already has an active agent run',
                    hint: 'Set force_new_run: true to cancel the active run, or wait for it to complete',
                    activeRun: {
                        id: existingRun.id,
                        status: existingRun.status,
                        trigger_type: existingRun.trigger_type,
                        started_at: existingRun.started_at
                    }
                });
            }

            await db.query(`
                UPDATE agent_runs
                SET status = 'failed',
                    ended_at = NOW(),
                    error = 'Cancelled by monitor trigger force_new_run'
                WHERE id = $1
            `, [existingRun.id]);
        }

        let inboundMessage = message;

        // If the message was already processed, clone it for a fresh run
        if (message.processed_at) {
            const newMessageId = `monitor:${message.id}:${Date.now()}:${crypto.randomBytes(4).toString('hex')}`;
            inboundMessage = await db.createMessage({
                thread_id: message.thread_id,
                case_id: caseData.id,
                message_id: newMessageId,
                sendgrid_message_id: null,
                direction: 'inbound',
                from_email: message.from_email,
                to_email: message.to_email,
                subject: message.subject,
                body_text: message.body_text || '(empty body)',
                body_html: message.body_html || null,
                message_type: 'manual_trigger',
                received_at: new Date()
            });
        }

        const run = await db.createAgentRunFull({
            case_id: caseData.id,
            trigger_type: 'inbound_message',
            status: 'queued',
            message_id: inboundMessage.id,
            autopilot_mode: autopilotMode,
            langgraph_thread_id: `case:${caseData.id}:msg-${inboundMessage.id}`
        });

        const job = await enqueueInboundMessageJob(run.id, caseData.id, inboundMessage.id, {
            autopilotMode,
            threadId: run.langgraph_thread_id
        });

        await db.logActivity('manual_ai_trigger', `AI triggered for inbound message ${messageId}`, {
            case_id: caseData.id,
            message_id: messageId,
            autopilotMode,
            force_new_run
        });

        res.json({
            success: true,
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
        res.status(500).json({ success: false, error: error.message });
    }
});

module.exports = router;
