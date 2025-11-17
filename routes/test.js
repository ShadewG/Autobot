const express = require('express');
const router = express.Router();
const sgMail = require('@sendgrid/mail');
const { v4: uuidv4 } = require('uuid');
const db = require('../services/database');
const notionService = require('../services/notion-service');
const discordService = require('../services/discord-service');
const aiService = require('../services/ai-service');
const { emailQueue, generateQueue, portalQueue } = require('../queues/email-queue');
const { extractUrls } = require('../utils/contact-utils');
const { normalizePortalUrl, isSupportedPortalUrl, detectPortalProviderByUrl } = require('../utils/portal-utils');
const PORTAL_ACTIVITY_EVENTS = require('../utils/portal-activity-events');

function safeJsonParse(value, defaultValue = null) {
    if (!value) {
        return defaultValue;
    }

    if (typeof value === 'object') {
        return value;
    }

    try {
        return JSON.parse(value);
    } catch (error) {
        console.warn('Failed to parse JSON field:', error.message);
        return defaultValue;
    }
}

function normalizePortalEvents(rawEvents) {
    const parsed = safeJsonParse(rawEvents, rawEvents);
    if (!parsed) {
        return [];
    }

    const list = Array.isArray(parsed) ? parsed : [parsed];
    return list
        .filter(Boolean)
        .map((event) => {
            const metadata = safeJsonParse(event.metadata, event.metadata || {});
            return {
                event_type: event.event_type || event.eventType || 'unknown',
                description: event.description || '',
                created_at: event.created_at || event.createdAt || null,
                metadata
            };
        });
}

sgMail.setApiKey(process.env.SENDGRID_API_KEY);

const POLICE_DEPT_CACHE_TTL = 5 * 60 * 1000; // 5 minutes
const policeDeptLinkCache = new Map();

function buildNotionUrl(pageId) {
    if (!pageId) {
        return null;
    }
    const cleanId = pageId.replace(/-/g, '');
    return `https://www.notion.so/${cleanId}`;
}

async function resolvePoliceDeptPageId(notionPageId) {
    if (!notionPageId || !notionService?.notion) {
        return null;
    }

    const cacheEntry = policeDeptLinkCache.get(notionPageId);
    const now = Date.now();
    if (cacheEntry && (now - cacheEntry.timestamp) < POLICE_DEPT_CACHE_TTL) {
        return cacheEntry.value;
    }

    try {
        const page = await notionService.notion.pages.retrieve({
            page_id: notionPageId.replace(/-/g, '')
        });

        const properties = page.properties || {};
        const preferredKeys = [
            'Police Department',
            'Police Dept',
            'Police Departments',
            'Police Department ',
            'PD',
            'Agency',
            'Department'
        ];

        let relationProperty = null;
        for (const key of preferredKeys) {
            if (properties[key]?.type === 'relation') {
                relationProperty = properties[key];
                break;
            }
        }

        if (!relationProperty) {
            const fallbackEntry = Object.entries(properties).find(([name, prop]) => (
                prop?.type === 'relation' && /police|dept|agency/i.test(name)
            ));
            if (fallbackEntry) {
                relationProperty = fallbackEntry[1];
            }
        }

        const policeDeptPageId = relationProperty?.relation?.[0]?.id || null;
        policeDeptLinkCache.set(notionPageId, { value: policeDeptPageId, timestamp: now });
        return policeDeptPageId;
    } catch (error) {
        console.error('Failed to fetch police department relation from Notion:', error.message);
        throw error;
    }
}

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
 * Get recent portal runs (activity log)
 * GET /api/test/portal-runs
 */
router.get('/portal-runs', async (req, res) => {
    try {
        const result = await db.query(
            `
            SELECT id, event_type, description, metadata, created_at
            FROM activity_log
            WHERE event_type = ANY($1::text[])
            ORDER BY created_at DESC
            LIMIT 50
            `,
            [PORTAL_ACTIVITY_EVENTS]
        );

        const runs = result.rows.map((row) => ({
            ...row,
            metadata: safeJsonParse(row.metadata, row.metadata || {})
        }));

        res.json({
            success: true,
            runs
        });
    } catch (error) {
        console.error('Error fetching portal runs:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * Get recent activity log entries (test dashboard)
 */
router.get('/activity', async (req, res) => {
    try {
        const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
        const activity = await db.getRecentActivity(limit);
        res.json({
            success: true,
            activity
        });
    } catch (error) {
        console.error('Error fetching activity log:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

/**
 * Human review queue
 */
router.get('/human-reviews', async (req, res) => {
    try {
        const reviews = await db.getHumanReviewCases(100);
        const enriched = reviews.map((item) => ({
            ...item,
            last_portal_details: safeJsonParse(item.last_portal_details),
            portal_events: normalizePortalEvents(item.portal_events)
        }));
        res.json({
            success: true,
            cases: enriched
        });
    } catch (error) {
        console.error('Error fetching human review cases:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

router.post('/human-reviews/:caseId/decision', async (req, res) => {
    try {
        const caseId = parseInt(req.params.caseId, 10);
        const { action, note, next_status } = req.body || {};

        if (!['approve', 'reject', 'change'].includes(action)) {
            return res.status(400).json({
                success: false,
                error: 'action must be approve, reject, or change'
            });
        }

        const caseData = await db.getCaseById(caseId);
        if (!caseData) {
            return res.status(404).json({
                success: false,
                error: 'Case not found'
            });
        }

        const urlsFromNote = note ? extractUrls(note) : [];
        let portalUrlFromNote = null;
        let portalProviderFromNote = null;

        for (const rawUrl of urlsFromNote || []) {
            const normalized = normalizePortalUrl(rawUrl);
            if (normalized && isSupportedPortalUrl(normalized)) {
                portalUrlFromNote = normalized;
                const provider = detectPortalProviderByUrl(normalized);
                portalProviderFromNote = provider?.name || 'Manual Portal';
                break;
            }
        }

        let newStatus = caseData.status;
        let substatus = caseData.substatus || '';

        const priorPortalFlag = (caseData.substatus || '').toLowerCase().includes('portal_submission');
        const portalNeeded = priorPortalFlag || !!portalUrlFromNote;

        if (action === 'approve') {
            if (portalNeeded) {
                newStatus = 'portal_in_progress';
                substatus = note ? `Portal submission queued: ${note}` : 'Portal submission queued';
            } else {
                newStatus = next_status || 'ready_to_send';
                substatus = note ? `Approved: ${note}` : 'Approved by human reviewer';
            }
        } else if (action === 'reject') {
            newStatus = next_status || 'needs_manual_processing';
            substatus = note ? `Rejected: ${note}` : 'Rejected by human reviewer';
        } else if (action === 'change') {
            newStatus = next_status || caseData.status;
            substatus = note ? `Change requested: ${note}` : 'Human requested changes';
        }

        if (portalUrlFromNote) {
            await db.updateCasePortalStatus(caseId, {
                portal_url: portalUrlFromNote,
                portal_provider: portalProviderFromNote
            });

            await db.logActivity('portal_link_added', 'Portal link provided via human review', {
                case_id: caseId,
                portal_url: portalUrlFromNote,
                portal_provider: portalProviderFromNote
            });
        }

        const updatedCase = await db.updateCaseStatus(caseId, newStatus, { substatus });
        await notionService.syncStatusToNotion(caseId);

        await db.logActivity('human_review_decision', `Human review ${action} for ${caseData.case_name}`, {
            case_id: caseId,
            action,
            note,
            next_status: newStatus
        });

        if (action === 'approve') {
            if (portalNeeded) {
                if (updatedCase.portal_url) {
                    console.log(`✅ Human approval -> queueing portal submission for case ${caseId}`);
                    await portalQueue.add('portal-submit', {
                        caseId
                    }, {
                        attempts: 2,
                        backoff: {
                            type: 'exponential',
                            delay: 5000
                        }
                    });
                } else {
                    console.warn(`⚠️ Portal submission approved for case ${caseId} but no portal URL is saved.`);
                }
            } else if (!updatedCase.send_date) {
                console.log(`✅ Human approval -> queueing case ${caseId} for generation`);
                await generateQueue.add('generate-foia', { caseId });
            }
        }

        res.json({
            success: true,
            case_id: caseId,
            status: newStatus
        });
    } catch (error) {
        console.error('Error recording human review decision:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
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
        const portalEventsParam = paramIndex;
        values.push(PORTAL_ACTIVITY_EVENTS);
        paramIndex++;
        const limitParam = paramIndex;
        values.push(limit);

        const result = await db.query(`
            SELECT
                c.id,
                c.notion_page_id,
                c.case_name,
                c.subject_name,
                c.agency_name,
                c.agency_email,
                c.status,
                c.substatus,
                c.portal_url,
                c.portal_provider,
                c.last_portal_status,
                c.last_portal_status_at,
                c.last_portal_engine,
                c.last_portal_run_id,
                c.last_portal_task_url,
                c.last_portal_recording_url,
                c.last_portal_account_email,
                c.last_portal_details,
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
                followup.status AS followup_status,
                portal_events.portal_events
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
            LEFT JOIN LATERAL (
                SELECT json_agg(events ORDER BY events.created_at DESC) AS portal_events
                FROM (
                    SELECT event_type, description, created_at, metadata
                    FROM activity_log
                    WHERE case_id = c.id
                      AND event_type = ANY($${portalEventsParam}::text[])
                    ORDER BY created_at DESC
                    LIMIT 10
                ) events
            ) portal_events ON true
            ${whereClause}
            ORDER BY COALESCE(last_msg.message_timestamp, c.updated_at, c.created_at) DESC
            LIMIT $${limitParam}
        `, values);

        const cases = result.rows.map((row) => ({
            ...row,
            last_portal_details: safeJsonParse(row.last_portal_details),
            portal_events: normalizePortalEvents(row.portal_events)
        }));

        res.json({ success: true, cases });
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
                SELECT
                    id,
                    case_name,
                    subject_name,
                agency_name,
                agency_email,
                status,
                substatus,
                agent_handled,
                created_at,
                updated_at,
                portal_url,
                portal_provider,
                last_portal_status,
                last_portal_status_at,
                last_portal_run_id,
                last_portal_task_url,
                last_portal_recording_url,
                last_portal_account_email,
                last_portal_details
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

        const casePayload = {
            ...caseResult.rows[0],
            last_portal_details: safeJsonParse(caseResult.rows[0].last_portal_details)
        };

        res.json({
            success: true,
            case: casePayload,
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
 * Get Notion links for a case and its related police department
 * GET /api/test/cases/:caseId/notion-links
 */
router.get('/cases/:caseId/notion-links', async (req, res) => {
    try {
        const caseId = parseInt(req.params.caseId, 10);
        if (Number.isNaN(caseId)) {
            return res.status(400).json({
                success: false,
                error: 'Invalid case ID'
            });
        }

        const caseResult = await db.query(`
            SELECT id, notion_page_id
            FROM cases
            WHERE id = $1
        `, [caseId]);

        if (caseResult.rows.length === 0) {
            return res.status(404).json({
                success: false,
                error: 'Case not found'
            });
        }

        const caseRow = caseResult.rows[0];
        const caseUrl = buildNotionUrl(caseRow.notion_page_id);

        let policeDeptPageId = null;
        let policeDeptUrl = null;

        if (caseRow.notion_page_id && notionService?.notion) {
            try {
                policeDeptPageId = await resolvePoliceDeptPageId(caseRow.notion_page_id);
                policeDeptUrl = buildNotionUrl(policeDeptPageId);
            } catch (error) {
                console.warn(`Unable to load police department relation for case ${caseId}:`, error.message);
            }
        }

        res.json({
            success: true,
            case_id: caseId,
            case_page_id: caseRow.notion_page_id,
            case_url: caseUrl,
            agency_page_id: policeDeptPageId,
            agency_url: policeDeptUrl
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
 * Pending fee responses (needs approval)
 */
router.get('/fee-responses', async (req, res) => {
    try {
        const result = await db.query(`
            SELECT
                ar.*,
                c.case_name,
                c.agency_name,
                c.agency_email,
                c.portal_url,
                c.state,
                m.subject AS message_subject,
                m.body_text AS original_message,
                m.from_email
            FROM auto_reply_queue ar
            JOIN cases c ON ar.case_id = c.id
            JOIN messages m ON ar.message_id = m.id
            WHERE ar.response_type = 'fee_negotiation'
              AND ar.status IN ('pending', 'updated')
              AND ar.requires_approval = true
            ORDER BY ar.created_at DESC
        `);

        res.json({
            success: true,
            items: result.rows
        });
    } catch (error) {
        console.error('Error fetching fee responses:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

/**
 * Approve & send a fee response
 */
router.post('/fee-responses/:id/approve', async (req, res) => {
    try {
        const entryId = parseInt(req.params.id, 10);
        const entry = await db.getAutoReplyQueueEntryById(entryId);

        if (!entry || entry.response_type !== 'fee_negotiation') {
            return res.status(404).json({
                success: false,
                error: 'Fee response not found'
            });
        }

        const caseData = await db.getCaseById(entry.case_id);
        const message = await db.getMessageById(entry.message_id);

        if (!caseData || !message) {
            return res.status(400).json({
                success: false,
                error: 'Missing case or message data for this response'
            });
        }

        await emailQueue.add('send-auto-reply', {
            type: 'auto_reply',
            caseId: entry.case_id,
            toEmail: message.from_email,
            subject: message.subject,
            content: entry.generated_reply,
            originalMessageId: message.message_id
        });

        const now = new Date();
        await db.updateAutoReplyQueueEntry(entryId, {
            status: 'sent',
            approved_at: now,
            sent_at: now,
            approved_by: req.body?.approved_by || 'dashboard'
        });

        const metadata = entry.metadata || {};
        await db.updateCaseStatus(caseData.id, 'fee_negotiation', {
            substatus: `Fee response sent (${metadata.recommended_action || 'negotiate'})`
        });
        await notionService.syncStatusToNotion(caseData.id);

        await db.logActivity('fee_response_sent', `Fee response approved and sent for case ${caseData.case_name}`, {
            case_id: caseData.id,
            auto_reply_queue_id: entryId,
            metadata
        });

        res.json({
            success: true,
            message: 'Fee response approved and queued for sending'
        });
    } catch (error) {
        console.error('Error approving fee response:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

/**
 * Regenerate a fee response with new instructions
 */
router.post('/fee-responses/:id/regenerate', async (req, res) => {
    try {
        const entryId = parseInt(req.params.id, 10);
        const { instructions, action } = req.body || {};

        const entry = await db.getAutoReplyQueueEntryById(entryId);
        if (!entry || entry.response_type !== 'fee_negotiation') {
            return res.status(404).json({
                success: false,
                error: 'Fee response not found'
            });
        }

        const caseData = await db.getCaseById(entry.case_id);
        if (!caseData) {
            return res.status(400).json({
                success: false,
                error: 'Case not found'
            });
        }

        const metadata = entry.metadata || {};
        const feeAmount = metadata.fee_amount || caseData.last_fee_quote_amount;

        if (!feeAmount) {
            return res.status(400).json({
                success: false,
                error: 'Fee amount missing from metadata'
            });
        }

        const recommendedAction = action || metadata.recommended_action || 'negotiate';
        const draft = await aiService.generateFeeResponse(caseData, {
            feeAmount,
            currency: metadata.fee_currency || 'USD',
            recommendedAction,
            instructions: instructions || metadata.instructions || null
        });

        const updatedMetadata = {
            ...metadata,
            recommended_action: recommendedAction,
            instructions: instructions || metadata.instructions || null,
            last_regenerated_at: new Date().toISOString()
        };

        await db.updateAutoReplyQueueEntry(entryId, {
            generated_reply: draft.reply_text,
            metadata: updatedMetadata,
            status: 'pending',
            last_regenerated_at: new Date()
        });

        await db.logActivity('fee_response_regenerated', `Fee response regenerated (${recommendedAction})`, {
            case_id: caseData.id,
            auto_reply_queue_id: entryId,
            metadata: updatedMetadata
        });

        res.json({
            success: true,
            message: 'Fee response regenerated',
            metadata: updatedMetadata
        });
    } catch (error) {
        console.error('Error regenerating fee response:', error);
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

        // Get migration filename from request body, default to add-agent-tables.sql
        const migrationFile = req.body.migration || 'add-agent-tables.sql';
        const migrationName = migrationFile.replace('.sql', '');

        console.log(`🔄 Running migration: ${migrationName}...`);

        // Read migration file
        const migrationPath = path.join(__dirname, '..', 'migrations', `${migrationName}.sql`);
        if (!fs.existsSync(migrationPath)) {
            return res.status(404).json({
                success: false,
                error: `Migration file not found: ${migrationName}.sql`
            });
        }

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

/**
 * Re-trigger analysis for a specific case
 * POST /api/test/retrigger-analysis
 */
router.post('/retrigger-analysis', async (req, res) => {
    try {
        const { case_id } = req.body;

        if (!case_id) {
            return res.status(400).json({
                success: false,
                error: 'case_id is required'
            });
        }

        console.log(`🔄 Re-triggering analysis for case #${case_id}...`);

        // Get the latest inbound message for this case
        const result = await db.query(
            `SELECT m.id, m.message_id, m.case_id, m.from_email, m.subject, m.created_at
             FROM messages m
             WHERE m.case_id = $1
             AND m.direction = 'inbound'
             ORDER BY m.created_at DESC
             LIMIT 1`,
            [case_id]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({
                success: false,
                error: `No inbound messages found for case #${case_id}`
            });
        }

        const message = result.rows[0];
        console.log(`✅ Found inbound message from ${message.from_email}`);

        const { analysisQueue } = require('../queues/email-queue');

        // Queue for analysis with instant reply
        await analysisQueue.add('analyze-response', {
            messageId: message.id,
            caseId: message.case_id,
            instantReply: true
        }, {
            delay: 0,
            attempts: 3,
            backoff: {
                type: 'exponential',
                delay: 3000
            }
        });

        console.log(`✅ Message re-queued for analysis!`);

        res.json({
            success: true,
            message: `Case #${case_id} re-queued for analysis`,
            message_id: message.id,
            from_email: message.from_email,
            subject: message.subject,
            note: 'Analysis worker will process this and send auto-reply'
        });

    } catch (error) {
        console.error('Retrigger error:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

/**
 * Run migration 007: Add UNIQUE constraint to auto_reply_queue
 * POST /api/test/run-migration-007
 */
router.post('/run-migration-007', async (req, res) => {
    try {
        console.log('🔧 Running migration 007...');

        const migrationSQL = `
            -- Add UNIQUE constraint to auto_reply_queue.message_id
            ALTER TABLE auto_reply_queue
            ADD CONSTRAINT auto_reply_queue_message_id_unique UNIQUE (message_id);
        `;

        await db.query(migrationSQL);

        console.log('✅ Migration 007 completed!');

        res.json({
            success: true,
            message: 'Migration 007 completed: Added UNIQUE constraint to auto_reply_queue.message_id'
        });

    } catch (error) {
        console.error('Migration 007 error:', error);

        // If constraint already exists, that's fine
        if (error.message.includes('already exists')) {
            return res.json({
                success: true,
                message: 'Constraint already exists (skipped)',
                note: 'This is expected if migration was already run'
            });
        }

        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

/**
 * Delete test cases up to a specific ID
 * POST /api/test/delete-test-cases
 */
router.post('/delete-test-cases', async (req, res) => {
    try {
        const { max_case_id } = req.body;

        if (!max_case_id || max_case_id < 1) {
            return res.status(400).json({
                success: false,
                error: 'max_case_id is required and must be > 0'
            });
        }

        console.log(`🗑️  Deleting test cases with ID <= ${max_case_id}...`);

        // Get the cases first
        const casesResult = await db.query(
            'SELECT id, case_name, agency_name, status FROM cases WHERE id <= $1 ORDER BY id',
            [max_case_id]
        );

        if (casesResult.rows.length === 0) {
            return res.json({
                success: true,
                message: 'No cases found to delete',
                deleted_count: 0
            });
        }

        const casesList = casesResult.rows.map(c => ({
            id: c.id,
            name: c.case_name,
            agency: c.agency_name,
            status: c.status
        }));

        // Delete cases (CASCADE will handle related records)
        const deleteResult = await db.query(
            'DELETE FROM cases WHERE id <= $1',
            [max_case_id]
        );

        console.log(`✅ Deleted ${deleteResult.rowCount} test cases`);

        // Log the activity
        await db.logActivity(
            'bulk_delete_test_cases',
            `Deleted test cases with IDs 1-${max_case_id} (${deleteResult.rowCount} cases)`,
            {
                deleted_count: deleteResult.rowCount,
                max_case_id: max_case_id,
                cases: casesList
            }
        );

        res.json({
            success: true,
            message: `Deleted ${deleteResult.rowCount} test cases (IDs 1-${max_case_id})`,
            deleted_count: deleteResult.rowCount,
            deleted_cases: casesList
        });

    } catch (error) {
        console.error('Delete test cases error:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

/**
 * Force sync from Notion and process all "Ready to Send" cases
 * POST /api/test/force-notion-sync
 */
router.post('/force-notion-sync', async (req, res) => {
    try {
        console.log('🔄 Force syncing cases from Notion...');

        // Sync cases with "Ready To Send" status (exact match from Notion)
        const cases = await notionService.syncCasesFromNotion('Ready To Send');

        if (cases.length === 0) {
            return res.json({
                success: true,
                message: 'No new "Ready to Send" cases found in Notion',
                synced_count: 0,
                queued_count: 0
            });
        }

        console.log(`✅ Synced ${cases.length} cases from Notion`);

        let queuedCount = 0;
        let reviewCount = 0;
        const results = [];

        // Process each case
        for (const caseData of cases) {
            const result = {
                id: caseData.id,
                case_name: caseData.case_name,
                status: null,
                message: null
            };

            // Check if case has contact info (portal URL or email)
            const hasPortal = caseData.portal_url && caseData.portal_url.trim().length > 0;
            const hasEmail = caseData.agency_email && caseData.agency_email.trim().length > 0;

            if (!hasPortal && !hasEmail) {
                // No contact info - flag for contact info needed
                await db.updateCaseStatus(caseData.id, 'needs_contact_info', {
                    substatus: 'Missing contact information (no portal URL or email)'
                });
                await notionService.syncStatusToNotion(caseData.id);
                await db.logActivity('contact_missing', `Case ${caseData.id} flagged - missing contact info`, {
                    case_id: caseData.id
                });

                result.status = 'needs_contact_info';
                result.message = 'Missing contact info - needs portal URL or email';
                reviewCount++;
            } else {
                // Has contact info - queue for processing
                await generateQueue.add('generate-and-send', {
                    caseId: caseData.id,
                    instantMode: true
                });

                result.status = 'queued';
                result.message = hasPortal ? 'Queued for portal submission' : 'Queued for email';
                queuedCount++;
            }

            results.push(result);
            console.log(`  ${result.status === 'queued' ? '✅' : '⚠️'} Case ${caseData.id}: ${result.message}`);
        }

        await db.logActivity('notion_force_sync', `Force synced ${cases.length} cases from Notion`, {
            synced_count: cases.length,
            queued_count: queuedCount,
            review_count: reviewCount
        });

        // Notify Discord about bulk sync
        await discordService.notifyBulkSync(cases.length, queuedCount, reviewCount);

        res.json({
            success: true,
            message: `Synced ${cases.length} cases from Notion`,
            synced_count: cases.length,
            queued_count: queuedCount,
            review_count: reviewCount,
            results: results
        });

    } catch (error) {
        console.error('Force Notion sync error:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

/**
 * Clear all pending jobs from generate queue
 * POST /api/test/clear-generate-queue
 */
router.post('/clear-generate-queue', async (req, res) => {
    try {
        console.log('🗑️ Clearing all pending jobs from generate queue...');

        // Get all waiting and delayed jobs
        const waitingJobs = await generateQueue.getWaiting();
        const delayedJobs = await generateQueue.getDelayed();

        let clearedCount = 0;

        // Remove waiting jobs
        for (const job of waitingJobs) {
            await job.remove();
            clearedCount++;
        }

        // Remove delayed jobs
        for (const job of delayedJobs) {
            await job.remove();
            clearedCount++;
        }

        console.log(`✅ Cleared ${clearedCount} pending jobs from generate queue`);

        res.json({
            success: true,
            message: `Cleared ${clearedCount} pending jobs`,
            cleared_count: clearedCount
        });

    } catch (error) {
        console.error('Clear queue error:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

/**
 * Generate a sample FOIA request for a case
 * POST /api/test/generate-sample
 */
router.post('/generate-sample', async (req, res) => {
    try {
        const { case_id } = req.body;

        if (!case_id) {
            return res.status(400).json({
                success: false,
                error: 'case_id is required'
            });
        }

        console.log(`📝 Generating sample FOIA request for case ${case_id}...`);

        const caseData = await db.getCaseById(case_id);
        if (!caseData) {
            return res.status(404).json({
                success: false,
                error: `Case ${case_id} not found`
            });
        }

        // Generate FOIA request
        const generated = await aiService.generateFOIARequest(caseData);

        // Create simple subject line
        const simpleName = (caseData.subject_name || 'Information Request')
            .split(' - ')[0]
            .split('(')[0]
            .trim();
        const subject = `Public Records Request - ${simpleName}`;

        res.json({
            success: true,
            case_id: case_id,
            case_name: caseData.case_name,
            subject: subject,
            request_text: generated.request_text,
            agency_name: caseData.agency_name,
            agency_email: caseData.agency_email,
            portal_url: caseData.portal_url
        });

    } catch (error) {
        console.error('Generate sample error:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

/**
 * COMPLETE RESET: Clear database, reset Notion statuses, and resync
 * POST /api/test/complete-reset
 */
router.post('/complete-reset', async (req, res) => {
    try {
        console.log('🚨 COMPLETE RESET INITIATED');

        const { Client } = require('@notionhq/client');
        const notion = new Client({ auth: process.env.NOTION_API_KEY });

        // Clear all queues
        const { generateQueue } = require('../queues/email-queue');
        const waitingJobs = await generateQueue.getWaiting();
        const delayedJobs = await generateQueue.getDelayed();
        const activeJobs = await generateQueue.getActive();

        let clearedCount = 0;
        for (const job of [...waitingJobs, ...delayedJobs, ...activeJobs]) {
            try {
                await job.remove();
                clearedCount++;
            } catch (e) {
                console.log(`   ⚠️  Could not remove job ${job.id}: ${e.message}`);
            }
        }

        // Delete all database records (ignore errors if table doesn't exist)
        const tablesToClear = [
            'auto_reply_queue',
            'analysis',
            'messages',
            'threads',
            'generated_requests',
            'cases',
            'activity_log'
        ];

        for (const table of tablesToClear) {
            try {
                await db.query(`DELETE FROM ${table}`);
            } catch (e) {
                console.log(`   ⚠️  Table ${table} doesn't exist or error: ${e.message}`);
            }
        }

        // Respond immediately, then continue in background
        res.json({
            success: true,
            message: 'Database cleared, Notion sync and queueing started in background',
            cleared_jobs: clearedCount
        });

        // Continue in background (no await on client)
        (async () => {
            try {
                console.log('📋 Querying all Notion pages...');
                // Reset ALL Notion statuses to "Ready to Send"
                const databaseId = process.env.NOTION_CASES_DATABASE_ID;
                let allPages = [];
                let hasMore = true;
                let startCursor = undefined;

                while (hasMore) {
                    const response = await notion.databases.query({
                        database_id: databaseId,
                        start_cursor: startCursor
                    });
                    allPages = allPages.concat(response.results);
                    hasMore = response.has_more;
                    startCursor = response.next_cursor;
                }

                console.log(`📄 Found ${allPages.length} pages, updating statuses...`);
                let updatedCount = 0;
                for (const page of allPages) {
                    try {
                        await notion.pages.update({
                            page_id: page.id,
                            properties: {
                                Status: { status: { name: 'Ready to Send' } }
                            }
                        });
                        updatedCount++;
                    } catch (e) {
                        // Skip pages that can't be updated
                    }
                }

                console.log(`✅ Updated ${updatedCount} pages to "Ready to Send"`);
                console.log('🔄 Syncing from Notion with AI extraction...');

                // Sync from Notion
                const cases = await notionService.syncCasesFromNotion('Ready to Send');
                console.log(`✅ Synced ${cases.length} cases`);

                // Process and queue cases
                let queuedCount = 0;
                let reviewCount = 0;

                for (const caseData of cases) {
                    const hasPortal = caseData.portal_url && caseData.portal_url.trim().length > 0;
                    const hasEmail = caseData.agency_email && caseData.agency_email.trim().length > 0;

                    if (!hasPortal && !hasEmail) {
                        await db.query(
                            'UPDATE cases SET status = $1, substatus = $2 WHERE id = $3',
                            ['needs_human_review', 'Missing contact information', caseData.id]
                        );
                        reviewCount++;
                        console.log(`⚠️  Case #${caseData.id} flagged for review (no contact info)`);
                    } else {
                        await generateQueue.add('generate-and-send', {
                            caseId: caseData.id,
                            instantMode: false
                        }, {
                            delay: queuedCount * 15000
                        });
                        queuedCount++;
                        console.log(`✅ Case #${caseData.id} queued: ${caseData.case_name}`);
                    }
                }

                console.log('\n' + '='.repeat(80));
                console.log('🎉 COMPLETE RESET FINISHED');
                console.log('='.repeat(80));
                console.log(`✅ Queued for sending: ${queuedCount} cases`);
                console.log(`⚠️  Flagged for review: ${reviewCount} cases`);
                console.log('='.repeat(80));

            } catch (bgError) {
                console.error('❌ Background reset error:', bgError);
            }
        })();

    } catch (error) {
        console.error('Complete reset error:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

/**
 * NUCLEAR RESET: Delete all cases and resync from Notion
 * POST /api/test/nuclear-reset
 */
router.post('/nuclear-reset', async (req, res) => {
    try {
        console.log('🚨 NUCLEAR RESET INITIATED');

        // Clear all queues
        const { generateQueue } = require('../queues/email-queue');
        const waitingJobs = await generateQueue.getWaiting();
        const delayedJobs = await generateQueue.getDelayed();
        const activeJobs = await generateQueue.getActive();

        let clearedCount = 0;
        for (const job of [...waitingJobs, ...delayedJobs, ...activeJobs]) {
            try {
                await job.remove();
                clearedCount++;
            } catch (e) {
                console.log(`   ⚠️  Could not remove job ${job.id}: ${e.message}`);
            }
        }

        // Delete all database records (ignore errors if table doesn't exist)
        const tablesToClear = [
            'auto_reply_queue',
            'analysis',
            'messages',
            'threads',
            'generated_requests',
            'cases',
            'activity_log'
        ];

        for (const table of tablesToClear) {
            try {
                await db.query(`DELETE FROM ${table}`);
            } catch (e) {
                console.log(`   ⚠️  Table ${table} doesn't exist or error: ${e.message}`);
            }
        }

        // Sync from Notion
        const cases = await notionService.syncCasesFromNotion('Ready to Send');

        // Process and queue cases
        let queuedCount = 0;
        let reviewCount = 0;
        const results = [];

        for (const caseData of cases) {
            const hasPortal = caseData.portal_url && caseData.portal_url.trim().length > 0;
            const hasEmail = caseData.agency_email && caseData.agency_email.trim().length > 0;

            if (!hasPortal && !hasEmail) {
                await db.query(
                    'UPDATE cases SET status = $1, substatus = $2 WHERE id = $3',
                    ['needs_human_review', 'Missing contact information', caseData.id]
                );
                reviewCount++;
                results.push({ id: caseData.id, status: 'needs_review', reason: 'No contact info' });
            } else if (!caseData.state) {
                await db.query(
                    'UPDATE cases SET status = $1, substatus = $2 WHERE id = $3',
                    ['needs_human_review', 'Missing state field', caseData.id]
                );
                reviewCount++;
                results.push({ id: caseData.id, status: 'needs_review', reason: 'Missing state' });
            } else {
                await generateQueue.add('generate-and-send', {
                    caseId: caseData.id,
                    instantMode: true
                }, {
                    delay: queuedCount * 10000 // Stagger by 10 seconds
                });
                queuedCount++;
                results.push({ id: caseData.id, status: 'queued', case_name: caseData.case_name });
            }
        }

        res.json({
            success: true,
            message: 'Nuclear reset complete',
            cleared_jobs: clearedCount,
            synced_count: cases.length,
            queued_count: queuedCount,
            review_count: reviewCount,
            results: results
        });

    } catch (error) {
        console.error('Nuclear reset error:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

/**
 * Test AI contact extraction for cases 34, 35, 36
 * GET /api/test/contact-extraction
 */
router.get('/contact-extraction', async (req, res) => {
    try {
        const caseIds = [34, 35, 36];
        const results = [];

        for (const caseId of caseIds) {
            const caseData = await db.getCaseById(caseId);

            if (!caseData) {
                results.push({ case_id: caseId, error: 'Case not found' });
                continue;
            }

            // Fetch from Notion to trigger AI extraction
            try {
                const enrichedData = await notionService.fetchPageById(caseData.notion_page_id);

                results.push({
                    case_id: caseId,
                    case_name: caseData.case_name,
                    agency_name: enrichedData.agency_name,
                    state: enrichedData.state,
                    portal_url: enrichedData.portal_url || null,
                    email: enrichedData.agency_email || null,
                    contact_method: enrichedData.portal_url ? 'Portal' : (enrichedData.agency_email ? 'Email' : 'None - Needs Human Review')
                });
            } catch (error) {
                results.push({
                    case_id: caseId,
                    case_name: caseData.case_name,
                    error: error.message
                });
            }
        }

        res.json({
            success: true,
            results: results
        });

    } catch (error) {
        console.error('Contact extraction test error:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

/**
 * Fix state fields for cases 34, 35, 36
 * POST /api/test/fix-states
 */
router.post('/fix-states', async (req, res) => {
    try {
        console.log('🔧 Fixing state fields...');

        // Case 35: Austin PD = Texas
        await db.query('UPDATE cases SET state = $1 WHERE id = $2', ['TX', 35]);

        // Case 36: Springhill PD = Louisiana
        await db.query('UPDATE cases SET state = $1 WHERE id = $2', ['LA', 36]);

        // Case 34: Fayette Police Department, Iowa = Iowa
        await db.query('UPDATE cases SET state = $1 WHERE id = $2', ['IA', 34]);

        res.json({
            success: true,
            message: 'Updated states for cases 34, 35, 36',
            updates: [
                { case_id: 35, agency: 'Austin PD', state: 'TX' },
                { case_id: 36, agency: 'Springhill PD', state: 'LA' },
                { case_id: 34, agency: 'Fayette PD Iowa', state: 'IA' }
            ]
        });

    } catch (error) {
        console.error('Fix states error:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

/**
 * Regenerate samples for last 3 sent cases
 * GET /api/test/regen-last-3
 */
router.get('/regen-last-3', async (req, res) => {
    try {
        console.log('📝 Regenerating last 3 sent cases...');

        // Get last 3 sent cases
        const result = await db.query(`
            SELECT id, case_name, subject_name, agency_name, state, incident_date,
                   incident_location, additional_details, send_date
            FROM cases
            WHERE status = 'sent'
            ORDER BY send_date DESC
            LIMIT 3
        `);

        if (result.rows.length === 0) {
            return res.json({
                success: false,
                message: 'No sent cases found'
            });
        }

        const samples = [];

        for (const caseRow of result.rows) {
            try {
                const caseData = await db.getCaseById(caseRow.id);
                const generated = await aiService.generateFOIARequest(caseData);

                const simpleName = (caseData.subject_name || 'Information Request')
                    .split(' - ')[0]
                    .split('(')[0]
                    .trim();
                const subject = `Public Records Request - ${simpleName}`;

                samples.push({
                    case_id: caseRow.id,
                    case_name: caseRow.case_name,
                    subject_name: caseRow.subject_name,
                    agency_name: caseRow.agency_name,
                    state: caseRow.state,
                    subject: subject,
                    request_text: generated.request_text,
                    send_date: caseRow.send_date
                });

                // Small delay between generations
                await new Promise(resolve => setTimeout(resolve, 1000));

            } catch (genError) {
                console.error(`Failed to generate for case ${caseRow.id}:`, genError);
                samples.push({
                    case_id: caseRow.id,
                    case_name: caseRow.case_name,
                    error: genError.message
                });
            }
        }

        res.json({
            success: true,
            count: samples.length,
            samples: samples
        });

    } catch (error) {
        console.error('Regen last 3 error:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

/**
 * CHECK ALL NOTION CASES: Query all cases in Notion regardless of status
 * GET /api/test/check-all-notion
 */
router.get('/check-all-notion', async (req, res) => {
    try {
        const { Client } = require('@notionhq/client');
        const notion = new Client({ auth: process.env.NOTION_API_KEY });
        const databaseId = process.env.NOTION_CASES_DATABASE_ID;

        console.log('Querying ALL cases in Notion...');

        let allPages = [];
        let hasMore = true;
        let startCursor = undefined;

        while (hasMore) {
            const response = await notion.databases.query({
                database_id: databaseId,
                start_cursor: startCursor
            });
            allPages = allPages.concat(response.results);
            hasMore = response.has_more;
            startCursor = response.next_cursor;
        }

        console.log(`Total cases found: ${allPages.length}`);

        // Count by status
        const statusCounts = {};
        const caseList = [];

        for (const page of allPages) {
            const name = page.properties.Name?.title?.[0]?.plain_text || 'Untitled';
            const status = page.properties.Status?.status?.name || 'No Status';

            statusCounts[status] = (statusCounts[status] || 0) + 1;

            caseList.push({
                name: name.substring(0, 80),
                status: status,
                page_id: page.id
            });
        }

        res.json({
            success: true,
            total_count: allPages.length,
            status_breakdown: statusCounts,
            cases: caseList
        });

    } catch (error) {
        console.error('Check all Notion error:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

/**
 * Test stuck response detector
 * GET /api/test/stuck-responses
 */
router.get('/stuck-responses', async (req, res) => {
    try {
        console.log('🔍 Running stuck response detector...');

        const stuckResponseDetector = require('../services/stuck-response-detector');
        const result = await stuckResponseDetector.detectAndFlagStuckResponses();

        res.json({
            success: true,
            message: result.flagged === 0
                ? 'No stuck responses found'
                : `Flagged ${result.flagged} stuck response(s) for human review`,
            flagged_count: result.flagged,
            case_ids: result.cases || []
        });

    } catch (error) {
        console.error('Stuck response detector error:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

/**
 * Fix case 42: Extract portal URL and queue for submission
 * POST /api/test/fix-case-42
 */
router.post('/fix-case-42', async (req, res) => {
    try {
        console.log('🔧 Fixing case 42...');

        // Get message 85
        const messageResult = await db.query(
            'SELECT * FROM messages WHERE id = $1',
            [85]
        );

        if (messageResult.rows.length === 0) {
            return res.status(404).json({
                success: false,
                error: 'Message 85 not found'
            });
        }

        const message = messageResult.rows[0];
        console.log(`✅ Found message 85 from ${message.from_email}`);

        // Extract portal URL from message body
        const bodyText = message.body_text || '';
        const urlMatch = bodyText.match(/https?:\/\/[^\s<>"{}|\\^`\[\]]+/gi);

        if (!urlMatch || urlMatch.length === 0) {
            return res.status(400).json({
                success: false,
                error: 'No URL found in message body'
            });
        }

        const portalUrl = urlMatch[0].trim();
        console.log(`✅ Extracted portal URL: ${portalUrl}`);

        // Update case 42 with portal URL
        await db.query(
            'UPDATE cases SET portal_url = $1, portal_provider = $2 WHERE id = $3',
            [portalUrl, 'GovQA', 42]
        );
        console.log('✅ Updated case 42 with portal URL');

        // Queue for portal submission
        const { portalQueue } = require('../queues/email-queue');
        await portalQueue.add('portal-submit', {
            caseId: 42
        }, {
            attempts: 2,
            backoff: {
                type: 'exponential',
                delay: 5000
            }
        });

        console.log('✅ Queued case 42 for portal submission');

        await db.logActivity('case_42_manual_fix', 'Manually extracted portal URL and queued for submission', {
            case_id: 42,
            portal_url: portalUrl,
            message_id: 85
        });

        res.json({
            success: true,
            message: 'Case 42 fixed and queued for portal submission',
            portal_url: portalUrl,
            case_id: 42,
            queued: true
        });

    } catch (error) {
        console.error('Fix case 42 error:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

/**
 * Force submit a case via portal
 * POST /api/test/force-portal-submit
 */
router.post('/force-portal-submit', async (req, res) => {
    try {
        const { case_id } = req.body;

        if (!case_id) {
            return res.status(400).json({
                success: false,
                error: 'case_id is required'
            });
        }

        console.log(`🚀 Force queueing case ${case_id} for portal submission...`);

        // Get case data
        const caseData = await db.getCaseById(case_id);
        if (!caseData) {
            return res.status(404).json({
                success: false,
                error: `Case ${case_id} not found`
            });
        }

        // Check if portal URL exists
        if (!caseData.portal_url) {
            return res.status(400).json({
                success: false,
                error: `Case ${case_id} has no portal URL`,
                case_name: caseData.case_name
            });
        }

        console.log(`✅ Case has portal URL: ${caseData.portal_url}`);

        // Queue for portal submission
        const { portalQueue } = require('../queues/email-queue');
        await portalQueue.add('portal-submit', {
            caseId: case_id
        }, {
            attempts: 2,
            backoff: {
                type: 'exponential',
                delay: 5000
            }
        });

        console.log(`✅ Queued case ${case_id} for portal submission`);

        await db.logActivity('force_portal_submit', `Manually queued case for portal submission`, {
            case_id: case_id,
            portal_url: caseData.portal_url
        });

        res.json({
            success: true,
            message: `Case ${case_id} queued for portal submission`,
            case_id: case_id,
            case_name: caseData.case_name,
            portal_url: caseData.portal_url,
            portal_provider: caseData.portal_provider,
            queued: true
        });

    } catch (error) {
        console.error('Force portal submit error:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

/**
 * Set portal URL and queue for submission
 * POST /api/test/set-portal-url
 */
router.post('/set-portal-url', async (req, res) => {
    try {
        const { case_id, portal_url, portal_provider } = req.body;

        if (!case_id || !portal_url) {
            return res.status(400).json({
                success: false,
                error: 'case_id and portal_url are required'
            });
        }

        console.log(`🌐 Setting portal URL for case ${case_id}: ${portal_url}`);

        // Get case data
        const caseData = await db.getCaseById(case_id);
        if (!caseData) {
            return res.status(404).json({
                success: false,
                error: `Case ${case_id} not found`
            });
        }

        // Update case with portal URL
        await db.updateCasePortalStatus(case_id, {
            portal_url: portal_url,
            portal_provider: portal_provider || 'NextRequest'
        });

        // Update status to portal_in_progress
        await db.updateCaseStatus(case_id, 'portal_in_progress', {
            substatus: 'Portal URL set - queued for submission'
        });

        console.log(`✅ Updated case ${case_id} with portal URL`);

        // Queue for portal submission
        const { portalQueue } = require('../queues/email-queue');
        await portalQueue.add('portal-submit', {
            caseId: case_id
        }, {
            attempts: 2,
            backoff: {
                type: 'exponential',
                delay: 5000
            }
        });

        console.log(`✅ Queued case ${case_id} for portal submission`);

        await db.logActivity('set_portal_url', `Set portal URL and queued for submission`, {
            case_id: case_id,
            portal_url: portal_url,
            portal_provider: portal_provider || 'NextRequest'
        });

        res.json({
            success: true,
            message: `Portal URL set and case queued for submission`,
            case_id: case_id,
            case_name: caseData.case_name,
            portal_url: portal_url,
            portal_provider: portal_provider || 'NextRequest',
            status: 'portal_in_progress',
            queued: true
        });

    } catch (error) {
        console.error('Set portal URL error:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

/**
 * Approve case for portal submission (from human review)
 * POST /api/test/approve-for-portal
 */
router.post('/approve-for-portal', async (req, res) => {
    try {
        const { case_id } = req.body;

        if (!case_id) {
            return res.status(400).json({
                success: false,
                error: 'case_id is required'
            });
        }

        console.log(`✅ Approving case ${case_id} for portal submission...`);

        // Get case data
        const caseData = await db.getCaseById(case_id);
        if (!caseData) {
            return res.status(404).json({
                success: false,
                error: `Case ${case_id} not found`
            });
        }

        // Check if portal URL exists
        if (!caseData.portal_url) {
            return res.status(400).json({
                success: false,
                error: `Case ${case_id} has no portal URL - cannot approve for portal`,
                case_name: caseData.case_name
            });
        }

        // Update status to awaiting_response with portal_submission_needed
        await db.updateCaseStatus(case_id, 'awaiting_response', {
            substatus: 'Approved - queued for portal submission'
        });

        // Sync to Notion
        await notionService.syncStatusToNotion(case_id);

        // Queue for portal submission
        const { portalQueue } = require('../queues/email-queue');
        await portalQueue.add('portal-submit', {
            caseId: case_id
        }, {
            attempts: 2,
            backoff: {
                type: 'exponential',
                delay: 5000
            }
        });

        console.log(`✅ Case ${case_id} approved and queued for portal submission`);

        await db.logActivity('approve_for_portal', `Approved case for portal submission from human review`, {
            case_id: case_id,
            portal_url: caseData.portal_url
        });

        res.json({
            success: true,
            message: `Case ${case_id} approved and queued for portal submission`,
            case_id: case_id,
            case_name: caseData.case_name,
            portal_url: caseData.portal_url,
            new_status: 'awaiting_response',
            new_substatus: 'Approved - queued for portal submission',
            queued: true
        });

    } catch (error) {
        console.error('Approve for portal error:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

/**
 * Resync case from Notion (re-extract contact info with AI)
 * POST /api/test/resync-case
 */
router.post('/resync-case', async (req, res) => {
    try {
        const { case_id } = req.body;

        if (!case_id) {
            return res.status(400).json({
                success: false,
                error: 'case_id is required'
            });
        }

        console.log(`🔄 Resyncing case ${case_id} from Notion...`);

        // Get current case data
        const caseData = await db.getCaseById(case_id);
        if (!caseData) {
            return res.status(404).json({
                success: false,
                error: `Case ${case_id} not found`
            });
        }

        if (!caseData.notion_page_id) {
            return res.status(400).json({
                success: false,
                error: `Case ${case_id} has no Notion page ID`
            });
        }

        console.log(`✅ Fetching Notion page: ${caseData.notion_page_id}`);

        // Fetch fresh data from Notion (this triggers AI extraction)
        const freshData = await notionService.fetchPageById(caseData.notion_page_id);

        console.log(`✅ Extracted data from Notion:`);
        console.log(`   Portal URL: ${freshData.portal_url || 'none'}`);
        console.log(`   Email: ${freshData.agency_email || 'none'}`);
        console.log(`   State: ${freshData.state || 'none'}`);

        // Update case with fresh data
        await db.query(`
            UPDATE cases
            SET portal_url = $1,
                portal_provider = $2,
                agency_email = $3,
                agency_name = $4,
                state = $5,
                updated_at = NOW()
            WHERE id = $6
        `, [
            freshData.portal_url || null,
            freshData.portal_provider || null,
            freshData.agency_email || null,
            freshData.agency_name || caseData.agency_name,
            freshData.state || caseData.state,
            case_id
        ]);

        console.log(`✅ Updated case ${case_id} with fresh Notion data`);

        await db.logActivity('resync_case_from_notion', `Manually resynced case from Notion`, {
            case_id: case_id,
            portal_url: freshData.portal_url,
            agency_email: freshData.agency_email
        });

        res.json({
            success: true,
            message: `Case ${case_id} resynced from Notion`,
            case_id: case_id,
            case_name: caseData.case_name,
            before: {
                portal_url: caseData.portal_url,
                agency_email: caseData.agency_email,
                state: caseData.state
            },
            after: {
                portal_url: freshData.portal_url || null,
                agency_email: freshData.agency_email || null,
                state: freshData.state || caseData.state
            }
        });

    } catch (error) {
        console.error('Resync case error:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

/**
 * Test Discord notification
 * POST /api/test/discord
 */
router.post('/discord', async (req, res) => {
    try {
        const { message } = req.body;

        await discordService.notify({
            title: '🧪 Discord Test Message',
            description: message || 'This is a test message from the Autobot API to verify Discord notifications are working!',
            color: 0x667eea,
            fields: [
                { name: 'Status', value: '✅ Connected', inline: true },
                { name: 'Time', value: new Date().toLocaleString(), inline: true },
                { name: 'Message', value: 'If you see this, Discord notifications are working correctly!', inline: false }
            ]
        });

        res.json({
            success: true,
            message: 'Discord test notification sent'
        });
    } catch (error) {
        console.error('Discord test error:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

module.exports = router;
