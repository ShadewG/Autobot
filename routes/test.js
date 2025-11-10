const express = require('express');
const router = express.Router();
const sgMail = require('@sendgrid/mail');
const { v4: uuidv4 } = require('uuid');
const db = require('../services/database');
const notionService = require('../services/notion-service');
const { emailQueue, generateQueue } = require('../queues/email-queue');

sgMail.setApiKey(process.env.SENDGRID_API_KEY);

/**
 * Test endpoint: Process a Notion page with instant mode
 * POST /api/test/process-notion
 */
router.post('/process-notion', async (req, res) => {
    try {
        const { notion_page_id, test_email, instant_mode } = req.body;

        if (!notion_page_id) {
            return res.status(400).json({
                success: false,
                error: 'notion_page_id is required'
            });
        }

        console.log(`🧪 Test: Processing Notion page ${notion_page_id} with instant mode`);

        // Fetch the page from Notion
        const notionPage = await notionService.fetchPageById(notion_page_id);

        if (!notionPage) {
            return res.status(404).json({
                success: false,
                error: 'Notion page not found or could not be accessed'
            });
        }

        // Check if case already exists
        const existing = await db.query(
            'SELECT * FROM cases WHERE notion_page_id = $1',
            [notion_page_id]
        );

        let caseId;
        let caseData;

        if (existing.rows.length > 0) {
            // Update existing case
            caseId = existing.rows[0].id;
            caseData = existing.rows[0];

            // If test_email is provided, update it
            if (test_email) {
                await db.query(
                    'UPDATE cases SET agency_email = $1, status = $2 WHERE id = $3',
                    [test_email, 'ready_to_send', caseId]
                );
                caseData.agency_email = test_email;
            }

            console.log(`Using existing case ${caseId}, updated for testing`);
        } else {
            // Create new case from Notion data
            const newCase = await db.createCase({
                ...notionPage,
                agency_email: test_email || notionPage.agency_email
            });
            caseId = newCase.id;
            caseData = newCase;
            console.log(`Created new case ${caseId} from Notion`);
        }

        // Queue for generation and sending with instant mode
        await generateQueue.add('generate-foia', {
            caseId: caseId,
            instantMode: instant_mode || true
        });

        console.log(`Queued case ${caseId} for instant processing`);

        res.json({
            success: true,
            message: 'Case queued for instant processing',
            case_id: caseId,
            case_name: caseData.case_name,
            email: caseData.agency_email,
            instant_mode: instant_mode || true
        });

    } catch (error) {
        console.error('Error processing Notion page:', error);
        res.status(500).json({
            success: false,
            error: error.message,
            details: error.response?.body
        });
    }
});

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
                state, status, notion_page_id, created_at
            ) VALUES (
                $1, $2, $3, $4, $5, $6, $7, NOW()
            ) RETURNING *
        `, [
            'Auto-Reply Test Case',
            'Test Subject',
            'Test Agency',
            'overlord1pvp@gmail.com',
            'CA',
            'ready_to_send',
            'test-' + Date.now() // Unique test notion page ID
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

/**
 * Manual Notion sync trigger
 * POST /api/test/sync-notion
 */
router.post('/sync-notion', async (req, res) => {
    try {
        console.log('🔄 Manual Notion sync triggered');

        // Fetch cases with status "Ready to Send"
        const notionCases = await notionService.fetchCasesWithStatus('Ready to Send');
        console.log(`Found ${notionCases.length} cases in Notion with status "Ready to Send"`);

        let imported = 0;
        let queued = 0;
        let skipped = 0;
        const results = [];

        for (const notionCase of notionCases) {
            // Check if case already exists in database
            const existing = await db.query(
                'SELECT * FROM cases WHERE notion_page_id = $1',
                [notionCase.notion_page_id]
            );

            if (existing.rows.length > 0) {
                const existingCase = existing.rows[0];

                // If case exists but hasn't been sent yet, queue it
                // Check for both database format and Notion format
                const isReadyToSend = !existingCase.send_date &&
                                     (existingCase.status === 'ready_to_send' ||
                                      existingCase.status === 'Ready to Send');

                if (isReadyToSend) {
                    console.log(`Case exists but not sent yet, queueing: ${existingCase.case_name}`);

                    await generateQueue.add('generate-foia', {
                        caseId: existingCase.id
                    });
                    console.log(`Queued existing case ${existingCase.id} for generation and sending`);
                    queued++;

                    results.push({
                        case_id: existingCase.id,
                        case_name: existingCase.case_name,
                        agency_email: existingCase.agency_email,
                        status: 'queued',
                        reason: 'Existing case queued for sending (not sent yet)'
                    });
                } else {
                    console.log(`Case already exists and was sent: ${existingCase.case_name}`);
                    skipped++;
                    results.push({
                        case_name: existingCase.case_name,
                        status: 'skipped',
                        reason: 'Already sent'
                    });
                }
                continue;
            }

            // Import new case
            const newCase = await db.createCase(notionCase);
            console.log(`Imported new case: ${newCase.case_name} (ID: ${newCase.id})`);
            imported++;

            // Queue for email generation and sending
            await generateQueue.add('generate-foia', {
                caseId: newCase.id
            });
            console.log(`Queued case ${newCase.id} for generation and sending`);
            queued++;

            results.push({
                case_id: newCase.id,
                case_name: newCase.case_name,
                agency_email: newCase.agency_email,
                status: 'queued',
                reason: 'New case imported and queued for sending'
            });
        }

        res.json({
            success: true,
            message: `Notion sync complete`,
            summary: {
                total_found: notionCases.length,
                imported: imported,
                queued: queued,
                skipped: skipped
            },
            results: results
        });

    } catch (error) {
        console.error('Error syncing Notion:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

/**
 * Clear all cases and start fresh
 * POST /api/test/clear-all-cases
 * WARNING: This deletes ALL cases and related data!
 */
router.post('/clear-all-cases', async (req, res) => {
    try {
        const { confirm } = req.body;

        if (confirm !== 'DELETE_ALL_CASES') {
            return res.status(400).json({
                success: false,
                error: 'Must confirm with: confirm: "DELETE_ALL_CASES"'
            });
        }

        console.log('🗑️ Starting database cleanup via API...');

        // Count current data
        const casesCount = await db.query('SELECT COUNT(*) as count FROM cases');
        const messagesCount = await db.query('SELECT COUNT(*) as count FROM messages');

        const initialCounts = {
            cases: parseInt(casesCount.rows[0].count),
            messages: parseInt(messagesCount.rows[0].count)
        };

        // Delete all related records (in order of dependencies)
        await db.query('DELETE FROM auto_reply_queue');
        await db.query('DELETE FROM response_analysis');
        await db.query('DELETE FROM follow_up_schedule');
        await db.query('DELETE FROM generated_requests');
        await db.query('DELETE FROM messages');
        await db.query('DELETE FROM email_threads');
        await db.query('DELETE FROM cases');
        await db.query('DELETE FROM activity_log');

        // Reset sequences
        await db.query('ALTER SEQUENCE cases_id_seq RESTART WITH 1');
        await db.query('ALTER SEQUENCE messages_id_seq RESTART WITH 1');
        await db.query('ALTER SEQUENCE email_threads_id_seq RESTART WITH 1');
        await db.query('ALTER SEQUENCE response_analysis_id_seq RESTART WITH 1');
        await db.query('ALTER SEQUENCE follow_up_schedule_id_seq RESTART WITH 1');
        await db.query('ALTER SEQUENCE generated_requests_id_seq RESTART WITH 1');
        await db.query('ALTER SEQUENCE activity_log_id_seq RESTART WITH 1');
        await db.query('ALTER SEQUENCE auto_reply_queue_id_seq RESTART WITH 1');

        // Verify
        const finalCount = await db.query('SELECT COUNT(*) as count FROM cases');

        res.json({
            success: true,
            message: 'All cases cleared successfully',
            deleted: initialCounts,
            remaining: parseInt(finalCount.rows[0].count),
            note: 'Database is now empty and ready for fresh cases'
        });

    } catch (error) {
        console.error('Error clearing cases:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

/**
 * Test portal agent with autonomous form filling
 * POST /api/test/portal-agent
 */
router.post('/portal-agent', async (req, res) => {
    try {
        const { portal_url, case_id, max_steps, dry_run } = req.body;

        if (!portal_url) {
            return res.status(400).json({
                success: false,
                error: 'portal_url is required'
            });
        }

        console.log(`🤖 Testing portal agent on: ${portal_url}`);

        // Get case data or use test data
        let caseData;
        if (case_id) {
            caseData = await db.getCaseById(case_id);
            if (!caseData) {
                return res.status(404).json({
                    success: false,
                    error: `Case ${case_id} not found`
                });
            }
        } else {
            // Use test data
            caseData = {
                id: 999,
                case_name: 'Test Case',
                subject_name: 'John Doe',
                agency_name: 'Test Agency',
                state: 'CA',
                incident_date: '2024-01-15',
                incident_location: '123 Main St',
                requested_records: 'Body camera footage, incident reports',
                additional_details: 'Test request'
            };
        }

        // Import portal agent service
        const portalAgentService = require('../services/portal-agent-service');

        // Run the agent
        const result = await portalAgentService.submitToPortal(caseData, portal_url, {
            maxSteps: max_steps || 30,
            dryRun: dry_run !== false // Default to dry run
        });

        // Close browser
        await portalAgentService.closeBrowser();

        res.json({
            success: result.success,
            ...result,
            note: 'Portal agent uses Anthropic Claude with vision to autonomously navigate and fill forms'
        });

    } catch (error) {
        console.error('Error in portal agent test:', error);
        res.status(500).json({
            success: false,
            error: error.message,
            stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
        });
    }
});

/**
 * Get environment variables (for dashboard)
 * GET /api/test/env
 */
router.get('/env', async (req, res) => {
    try {
        res.json({
            ENABLE_AGENT: 'true', // Agent always enabled for complex cases
            ENABLE_NOTIFICATIONS: process.env.ENABLE_NOTIFICATIONS || 'false',
            ENABLE_AUTO_REPLY: process.env.ENABLE_AUTO_REPLY !== 'false'
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * Get statistics (for dashboard)
 * GET /api/test/stats
 */
router.get('/stats', async (req, res) => {
    try {
        const casesResult = await db.query('SELECT COUNT(*) as count FROM cases');
        const decisionsResult = await db.query('SELECT COUNT(*) as count FROM agent_decisions');
        const escalationsResult = await db.query('SELECT COUNT(*) as count FROM escalations WHERE status = $1', ['pending']);

        res.json({
            success: true,
            total_cases: parseInt(casesResult.rows[0].count),
            agent_decisions: parseInt(decisionsResult.rows[0].count),
            escalations: parseInt(escalationsResult.rows[0].count)
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * Get all cases (for dashboard)
 * GET /api/test/cases
 */
router.get('/cases', async (req, res) => {
    try {
        const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
        const search = req.query.search ? `%${req.query.search.trim()}%` : null;
        const statusFilter = req.query.status && req.query.status !== 'all'
            ? req.query.status.trim()
            : null;

        const conditions = [];
        const values = [];
        let paramIndex = 1;

        if (search) {
            conditions.push(`(
                c.case_name ILIKE $${paramIndex} OR
                c.agency_name ILIKE $${paramIndex} OR
                c.agency_email ILIKE $${paramIndex}
            )`);
            values.push(search);
            paramIndex++;
        }

        if (statusFilter) {
            conditions.push(`c.status = $${paramIndex}`);
            values.push(statusFilter);
            paramIndex++;
        }

        const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
        values.push(limit);

        const result = await db.query(`
            SELECT
                c.id,
                c.case_name,
                c.agency_name,
                c.agency_email,
                c.status,
                c.substatus,
                c.agent_handled,
                c.created_at,
                c.updated_at,
                COALESCE(last_msg.message_timestamp, c.updated_at, c.created_at) AS last_activity_at,
                COALESCE(stats.total_messages, 0) AS total_messages,
                stats.last_inbound_at,
                stats.last_outbound_at,
                last_msg.direction AS last_message_direction,
                last_msg.subject AS last_message_subject,
                last_msg.preview_text AS last_message_preview,
                last_msg.message_timestamp AS last_message_at,
                followup.next_followup_date,
                followup.status AS followup_status
            FROM cases c
            LEFT JOIN LATERAL (
                SELECT
                    COUNT(*) AS total_messages,
                    MAX(CASE WHEN direction = 'inbound' THEN COALESCE(received_at, created_at) END) AS last_inbound_at,
                    MAX(CASE WHEN direction = 'outbound' THEN COALESCE(sent_at, created_at) END) AS last_outbound_at
                FROM messages m
                WHERE m.case_id = c.id
            ) stats ON true
            LEFT JOIN LATERAL (
                SELECT
                    m.id,
                    m.direction,
                    m.subject,
                    LEFT(
                        COALESCE(
                            NULLIF(TRIM(m.body_text), ''),
                            REGEXP_REPLACE(COALESCE(m.body_html, ''), '<[^>]+>', ' ', 'g')
                        ),
                        280
                    ) AS preview_text,
                    COALESCE(m.sent_at, m.received_at, m.created_at) AS message_timestamp
                FROM messages m
                WHERE m.case_id = c.id
                ORDER BY message_timestamp DESC
                LIMIT 1
            ) last_msg ON true
            LEFT JOIN LATERAL (
                SELECT next_followup_date, status
                FROM follow_up_schedule f
                WHERE f.case_id = c.id
                ORDER BY next_followup_date ASC
                LIMIT 1
            ) followup ON true
            ${whereClause}
            ORDER BY COALESCE(last_msg.message_timestamp, c.updated_at, c.created_at) DESC
            LIMIT $${paramIndex}
        `, values);

        res.json({ success: true, cases: result.rows });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * Get full message history for a case (dashboard)
 * GET /api/test/cases/:caseId/messages
 */
router.get('/cases/:caseId/messages', async (req, res) => {
    try {
        const caseId = parseInt(req.params.caseId, 10);
        if (Number.isNaN(caseId)) {
            return res.status(400).json({
                success: false,
                error: 'Invalid case ID'
            });
        }

        const caseResult = await db.query(`
            SELECT id, case_name, agency_name, agency_email, status, substatus, agent_handled, created_at, updated_at
            FROM cases
            WHERE id = $1
        `, [caseId]);

        if (caseResult.rows.length === 0) {
            return res.status(404).json({
                success: false,
                error: 'Case not found'
            });
        }

        const messagesResult = await db.query(`
            SELECT
                id,
                direction,
                from_email,
                to_email,
                subject,
                body_text,
                body_html,
                message_type,
                sendgrid_message_id,
                COALESCE(sent_at, received_at, created_at) AS message_timestamp
            FROM messages
            WHERE case_id = $1
            ORDER BY message_timestamp ASC
        `, [caseId]);

        const stats = await db.query(`
            SELECT
                COUNT(*) AS total_messages,
                MAX(CASE WHEN direction = 'inbound' THEN COALESCE(received_at, created_at) END) AS last_inbound_at,
                MAX(CASE WHEN direction = 'outbound' THEN COALESCE(sent_at, created_at) END) AS last_outbound_at
            FROM messages
            WHERE case_id = $1
        `, [caseId]);

        res.json({
            success: true,
            case: caseResult.rows[0],
            messages: messagesResult.rows,
            stats: {
                total_messages: parseInt(stats.rows[0].total_messages || 0, 10),
                last_inbound_at: stats.rows[0].last_inbound_at,
                last_outbound_at: stats.rows[0].last_outbound_at
            }
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * Simulate agency reply (for dashboard testing)
 * POST /api/test/simulate-reply
 */
router.post('/simulate-reply', async (req, res) => {
    try {
        const { case_id, reply_text, reply_type } = req.body;

        if (!case_id || !reply_text) {
            return res.status(400).json({
                success: false,
                error: 'case_id and reply_text are required'
            });
        }

        console.log(`📬 Simulating ${reply_type} reply for case ${case_id}`);

        // Get case data
        const caseData = await db.getCaseById(case_id);
        if (!caseData) {
            return res.status(404).json({
                success: false,
                error: 'Case not found'
            });
        }

        // Get thread
        const thread = await db.getThreadByCaseId(case_id);
        if (!thread) {
            return res.status(404).json({
                success: false,
                error: 'Email thread not found'
            });
        }

        // Create fake message ID
        const { v4: uuidv4 } = require('uuid');
        const messageId = `<sim-${Date.now()}-${uuidv4()}@test.com>`;

        // Store inbound message
        const message = await db.createMessage({
            thread_id: thread.id,
            case_id: case_id,
            message_id: messageId,
            sendgrid_message_id: `sg-test-${Date.now()}`,
            direction: 'inbound',
            from_email: caseData.agency_email || 'test-agency@example.com',
            to_email: 'requests@foia.foib-request.com',
            subject: `Re: ${caseData.case_name}`,
            body_text: reply_text,
            body_html: `<p>${reply_text}</p>`,
            message_type: 'agency_response',
            received_at: new Date()
        });

        console.log(`✅ Simulated message stored: ${message.id}`);

        // Analyze response
        const aiService = require('../services/ai-service');
        const analysis = await aiService.analyzeResponse(message, caseData);

        console.log(`📊 Analysis complete: ${analysis.intent}`);

        // Check if agent should handle this (complex cases only)
        const isComplexCase = (
            analysis.intent === 'denial' ||
            analysis.intent === 'request_info' ||
            (analysis.intent === 'fee_notice' && analysis.extracted_fee_amount > 100) ||
            analysis.sentiment === 'hostile'
        );

        let agentResult = null;
        if (isComplexCase) {
            console.log(`🤖 Triggering agent for complex case...`);
            const foiaCaseAgent = require('../services/foia-case-agent');
            agentResult = await foiaCaseAgent.handleCase(case_id, {
                type: 'agency_reply',
                messageId: message.id
            });

            // Mark as agent-handled
            await db.query('UPDATE cases SET agent_handled = true WHERE id = $1', [case_id]);
        }

        res.json({
            success: true,
            message_id: message.id,
            analysis: {
                intent: analysis.intent,
                sentiment: analysis.sentiment,
                requires_action: analysis.requires_action
            },
            agent_handled: isComplexCase,
            agent_iterations: agentResult?.iterations || 0
        });
    } catch (error) {
        console.error('Error simulating reply:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

/**
 * Get agent decisions (for dashboard)
 * GET /api/test/agent/decisions
 */
router.get('/agent/decisions', async (req, res) => {
    try {
        const result = await db.query(`
            SELECT
                ad.id,
                ad.case_id,
                c.case_name,
                ad.reasoning,
                ad.action_taken,
                ad.confidence,
                ad.created_at
            FROM agent_decisions ad
            LEFT JOIN cases c ON ad.case_id = c.id
            ORDER BY ad.created_at DESC
            LIMIT 20
        `);

        res.json({
            success: true,
            decisions: result.rows
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * Get escalations (for dashboard)
 * GET /api/test/agent/escalations
 */
router.get('/agent/escalations', async (req, res) => {
    try {
        const result = await db.query(`
            SELECT
                e.id,
                e.case_id,
                c.case_name,
                e.reason,
                e.urgency,
                e.suggested_action,
                e.status,
                e.created_at
            FROM escalations e
            LEFT JOIN cases c ON e.case_id = c.id
            WHERE e.status = 'pending'
            ORDER BY
                CASE e.urgency
                    WHEN 'high' THEN 1
                    WHEN 'medium' THEN 2
                    WHEN 'low' THEN 3
                END,
                e.created_at DESC
            LIMIT 20
        `);

        res.json({
            success: true,
            escalations: result.rows
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * Run database migration (for dashboard)
 * POST /api/test/run-migration
 */
router.post('/run-migration', async (req, res) => {
    try {
        const fs = require('fs');
        const path = require('path');

        console.log('🔄 Running agent tables migration...');

        // Read migration file
        const migrationPath = path.join(__dirname, '..', 'migrations', 'add-agent-tables.sql');
        const sql = fs.readFileSync(migrationPath, 'utf8');

        // Execute migration
        await db.query(sql);

        console.log('✅ Migration completed');

        // Verify tables exist
        const tables = await db.query(`
            SELECT table_name
            FROM information_schema.tables
            WHERE table_schema = 'public'
            AND table_name IN ('agent_decisions', 'escalations')
            ORDER BY table_name
        `);

        const views = await db.query(`
            SELECT table_name
            FROM information_schema.views
            WHERE table_schema = 'public'
            AND table_name IN ('pending_escalations', 'agent_performance')
            ORDER BY table_name
        `);

        res.json({
            success: true,
            message: 'Migration completed successfully',
            tables: tables.rows.map(r => r.table_name),
            views: views.rows.map(r => r.table_name)
        });
    } catch (error) {
        console.error('Migration error:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

/**
 * Chat endpoint for testing AI responses
 * POST /api/test/chat
 */
router.post('/chat', async (req, res) => {
    try {
        const { scenario, systemPrompt, conversationHistory } = req.body;

        if (!conversationHistory || !Array.isArray(conversationHistory)) {
            return res.status(400).json({
                success: false,
                error: 'conversationHistory is required'
            });
        }

        // Use OpenAI for chat testing
        const OpenAI = require('openai');
        const openai = new OpenAI({
            apiKey: process.env.OPENAI_API_KEY
        });

        const response = await openai.chat.completions.create({
            model: 'gpt-4o',
            messages: [
                { role: 'system', content: systemPrompt || 'You are a helpful FOIA assistant.' },
                ...conversationHistory
            ],
            temperature: 0.7,
            max_tokens: 500
        });

        const aiResponse = response.choices[0]?.message?.content;

        if (!aiResponse) {
            throw new Error('No response from AI');
        }

        res.json({
            success: true,
            response: aiResponse,
            scenario: scenario
        });

    } catch (error) {
        console.error('Chat error:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

module.exports = router;
