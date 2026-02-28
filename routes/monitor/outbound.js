const express = require('express');
const router = express.Router();
const {
    db,
    sgMail
} = require('./_helpers');

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

module.exports = router;
