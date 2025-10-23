const express = require('express');
const router = express.Router();
const sgMail = require('@sendgrid/mail');
const { v4: uuidv4 } = require('uuid');
const db = require('../services/database');

sgMail.setApiKey(process.env.SENDGRID_API_KEY);

/**
 * Test endpoint: Send email and enable instant auto-reply
 * POST /api/test/send-and-reply
 */
router.post('/send-and-reply', async (req, res) => {
    try {
        console.log('🧪 Test: Sending email to overlord1pvp@gmail.com for instant auto-reply test');

        // Create a test case in the database
        const testCase = await db.query(`
            INSERT INTO cases (
                case_name, subject_name, agency_name, agency_email,
                state, status, created_at
            ) VALUES (
                $1, $2, $3, $4, $5, $6, NOW()
            ) RETURNING *
        `, [
            'Auto-Reply Test Case',
            'Test Subject',
            'Test Agency',
            'overlord1pvp@gmail.com',
            'CA',
            'ready_to_send'
        ]);

        const caseId = testCase.rows[0].id;

        // Generate a unique Message-ID
        const messageId = `<test-${Date.now()}-${uuidv4()}@foib-request.com>`;
        const threadId = `<thread-${caseId}-${Date.now()}@foib-request.com>`;

        // Send test email
        const msg = {
            to: 'overlord1pvp@gmail.com',
            from: {
                email: process.env.SENDGRID_FROM_EMAIL || 'requests@em7571.foib-request.com',
                name: 'FOIA Request Team - TEST MODE'
            },
            replyTo: 'requests@foia.foib-request.com',
            subject: `[TEST] Public Records Request - Auto-Reply Test`,
            text: `Hello,

This is a TEST email to verify the instant auto-reply system.

**PLEASE REPLY TO THIS EMAIL** with any message such as:
- "Request denied due to ongoing investigation"
- "We need more information"
- "Records will be provided in 30 days"

The bot will analyze your response and send an instant auto-reply (no delay).

This is a test - your actual FOIA system will use human-like delays (2-10 hours).

Case ID: ${caseId}
Message ID: ${messageId}

Best regards,
FOIA Request Team (Test Mode)`,
            html: `<html>
<body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333;">
    <h2>🧪 AUTO-REPLY TEST</h2>

    <p>This is a TEST email to verify the instant auto-reply system.</p>

    <p><strong style="color: #d9534f;">PLEASE REPLY TO THIS EMAIL</strong> with any message such as:</p>
    <ul>
        <li>"Request denied due to ongoing investigation"</li>
        <li>"We need more information"</li>
        <li>"Records will be provided in 30 days"</li>
    </ul>

    <p>The bot will analyze your response and send an <strong>instant auto-reply</strong> (no delay).</p>

    <p><em>This is a test - your actual FOIA system will use human-like delays (2-10 hours).</em></p>

    <hr>
    <p style="font-size: 0.9em; color: #666;">
        Case ID: ${caseId}<br>
        Message ID: ${messageId}
    </p>

    <p>Best regards,<br>
    FOIA Request Team (Test Mode)</p>
</body>
</html>`,
            customArgs: {
                test_mode: 'true',
                case_id: caseId.toString(),
                instant_reply: 'true'
            },
            headers: {
                'Message-ID': messageId,
                'X-Test-Mode': 'true'
            }
        };

        const response = await sgMail.send(msg);

        // Create email thread
        await db.createEmailThread({
            case_id: caseId,
            thread_id: threadId,
            subject: msg.subject,
            agency_email: 'overlord1pvp@gmail.com',
            initial_message_id: messageId,
            status: 'active'
        });

        // Store sent message
        await db.createMessage({
            thread_id: (await db.getThreadByCaseId(caseId)).id,
            case_id: caseId,
            message_id: messageId,
            sendgrid_message_id: response[0].headers['x-message-id'],
            direction: 'outbound',
            from_email: msg.from.email,
            to_email: msg.to,
            subject: msg.subject,
            body_text: msg.text,
            body_html: msg.html,
            message_type: 'initial_request',
            sent_at: new Date()
        });

        // Update case status
        await db.updateCaseStatus(caseId, 'sent', {
            send_date: new Date()
        });

        await db.logActivity('test_email_sent', `Test email sent for instant auto-reply testing`, {
            case_id: caseId
        });

        res.json({
            success: true,
            message: 'Test email sent! Reply to it at overlord1pvp@gmail.com to trigger instant auto-reply.',
            case_id: caseId,
            message_id: messageId,
            sent_to: 'overlord1pvp@gmail.com',
            instructions: [
                '1. Check overlord1pvp@gmail.com for the test email',
                '2. Reply with any message (e.g., "Request denied")',
                '3. The bot will instantly analyze and auto-reply',
                '4. Check for the auto-reply in your inbox!'
            ],
            note: 'This test uses INSTANT replies (no delay). Production uses 2-10 hour delays to seem human.'
        });

    } catch (error) {
        console.error('Error in test endpoint:', error);
        res.status(500).json({
            success: false,
            error: error.message,
            details: error.response?.body
        });
    }
});

/**
 * Get status of test case
 * GET /api/test/status/:caseId
 */
router.get('/status/:caseId', async (req, res) => {
    try {
        const { caseId } = req.params;

        const caseData = await db.getCaseById(caseId);
        const thread = await db.getThreadByCaseId(caseId);
        const messages = await db.query(
            'SELECT * FROM messages WHERE case_id = $1 ORDER BY created_at ASC',
            [caseId]
        );

        res.json({
            success: true,
            case: caseData,
            thread: thread,
            messages: messages.rows,
            summary: {
                total_messages: messages.rows.length,
                outbound: messages.rows.filter(m => m.direction === 'outbound').length,
                inbound: messages.rows.filter(m => m.direction === 'inbound').length,
                auto_replies: messages.rows.filter(m => m.message_type === 'auto_reply').length
            }
        });
    } catch (error) {
        console.error('Error getting test status:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

module.exports = router;
