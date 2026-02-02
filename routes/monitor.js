const express = require('express');
const router = express.Router();
const db = require('../services/database');
const sgMail = require('@sendgrid/mail');

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

        const fromEmail = process.env.SENDGRID_FROM_EMAIL || 'samuel@matcher.com';
        const fromName = process.env.SENDGRID_FROM_NAME || 'Samuel Hylton';
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
        from_email: process.env.SENDGRID_FROM_EMAIL || 'samuel@matcher.com',
        from_name: process.env.SENDGRID_FROM_NAME || 'Samuel Hylton',
        sendgrid_configured: !!process.env.SENDGRID_API_KEY,
        inbound_webhook: '/webhooks/inbound'
    });
});

module.exports = router;
