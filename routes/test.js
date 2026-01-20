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
 * Re-import police department info for cases (primarily portal/email)
 * POST /api/test/cases/reimport-pd-info
 */
router.post('/cases/reimport-pd-info', async (req, res) => {
    try {
        const { case_id, limit = 25, missing_portal_only = true } = req.body || {};
        let cases = [];

        if (case_id) {
            const caseData = await db.getCaseById(case_id);
            if (!caseData) {
                return res.status(404).json({
                    success: false,
                    error: 'Case not found'
                });
            }
            cases = [caseData];
        } else {
            const conditions = [];
            if (missing_portal_only !== false) {
                conditions.push('(portal_url IS NULL OR LENGTH(TRIM(portal_url)) = 0)');
            }
            const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
            const result = await db.query(`
                SELECT
                    id,
                    case_name,
                    notion_page_id,
                    portal_url,
                    portal_provider,
                    agency_email,
                    alternate_agency_email
                FROM cases
                ${whereClause}
                ORDER BY updated_at DESC
                LIMIT $1
            `, [limit]);
            cases = result.rows;
        }

        const summary = { processed: cases.length, updated: 0, results: [] };

        if (!cases.length) {
            return res.json({
                success: true,
                ...summary,
                message: 'No cases matched criteria'
            });
        }

        for (const caseRow of cases) {
            if (!caseRow.notion_page_id) {
                summary.results.push({
                    case_id: caseRow.id,
                    case_name: caseRow.case_name,
                    status: 'skipped',
                    reason: 'Missing notion_page_id'
                });
                continue;
            }

            try {
                const notionCase = await notionService.fetchPageById(caseRow.notion_page_id);
                const updates = {};

                if (notionCase.portal_url && notionCase.portal_url !== caseRow.portal_url) {
                    updates.portal_url = notionCase.portal_url;
                    const provider = detectPortalProviderByUrl(notionCase.portal_url);
                    if (provider?.label) {
                        updates.portal_provider = provider.label;
                    }
                }
                if (notionCase.agency_email && notionCase.agency_email !== caseRow.agency_email) {
                    updates.agency_email = notionCase.agency_email;
                }
                if (notionCase.alternate_agency_email && notionCase.alternate_agency_email !== caseRow.alternate_agency_email) {
                    updates.alternate_agency_email = notionCase.alternate_agency_email;
                }

                if (Object.keys(updates).length) {
                    await db.updateCase(caseRow.id, updates);
                    summary.updated += 1;
                    summary.results.push({
                        case_id: caseRow.id,
                        case_name: caseRow.case_name,
                        status: 'updated',
                        updates
                    });
                } else {
                    summary.results.push({
                        case_id: caseRow.id,
                        case_name: caseRow.case_name,
                        status: 'no_change'
                    });
                }
            } catch (error) {
                console.error(`Failed to refresh PD info for case ${caseRow.id}:`, error);
                summary.results.push({
                    case_id: caseRow.id,
                    case_name: caseRow.case_name,
                    status: 'error',
                    error: error.message
                });
            }
        }

        res.json({ success: true, ...summary });
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
 * Utility endpoint to update contact info status
 * POST /api/test/fix-contact-status
 */
router.post('/fix-contact-status', async (req, res) => {
    try {
        const result = await db.query(`
            UPDATE cases
            SET status = 'needs_contact_info', updated_at = CURRENT_TIMESTAMP
            WHERE status = 'needs_human_review'
              AND substatus = 'No valid portal or email contact detected'
            RETURNING id, case_name, status, substatus
        `);

        res.json({
            success: true,
            updated: result.rowCount,
            cases: result.rows
        });
    } catch (error) {
        console.error('Error updating contact status:', error);
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

/**
 * Check queue status and worker health
 * GET /api/test/queue-status
 */
router.get('/queue-status', async (req, res) => {
    try {
        const generateCounts = await generateQueue.getJobCounts('wait', 'active', 'completed', 'failed', 'delayed');
        const emailCounts = await emailQueue.getJobCounts('wait', 'active', 'completed', 'failed', 'delayed');
        const portalCounts = await portalQueue.getJobCounts('wait', 'active', 'completed', 'failed', 'delayed');

        // Get some waiting jobs to see what's queued
        const waitingGenerate = await generateQueue.getJobs(['waiting'], 0, 5);
        const waitingEmail = await emailQueue.getJobs(['waiting'], 0, 5);
        const waitingPortal = await portalQueue.getJobs(['waiting'], 0, 5);

        res.json({
            success: true,
            timestamp: new Date().toISOString(),
            queues: {
                generate: {
                    counts: generateCounts,
                    waiting_jobs: waitingGenerate.map(j => ({ id: j.id, data: j.data, addedAt: j.timestamp }))
                },
                email: {
                    counts: emailCounts,
                    waiting_jobs: waitingEmail.map(j => ({ id: j.id, data: j.data, addedAt: j.timestamp }))
                },
                portal: {
                    counts: portalCounts,
                    waiting_jobs: waitingPortal.map(j => ({ id: j.id, data: j.data, addedAt: j.timestamp }))
                }
            },
            redis_url: process.env.REDIS_URL ? 'Configured' : 'NOT CONFIGURED'
        });
    } catch (error) {
        console.error('Queue status error:', error);
        res.status(500).json({
            success: false,
            error: error.message,
            stack: error.stack
        });
    }
});

// =========================================================================
// LangGraph Test Endpoints
// =========================================================================

const langgraph = require('../langgraph');
const { enqueueAgentJob, enqueueResumeJob, getQueueStats } = require('../queues/agent-queue');

/**
 * GET /api/test/langgraph/status
 * Get LangGraph system status
 */
router.get('/langgraph/status', async (req, res) => {
    try {
        const queueStats = await getQueueStats();
        const dryRun = process.env.LANGGRAPH_DRY_RUN !== 'false';

        res.json({
            success: true,
            langgraph_enabled: true,
            dry_run: dryRun,
            dry_run_reason: dryRun ? 'LANGGRAPH_DRY_RUN not set to false' : 'Disabled by LANGGRAPH_DRY_RUN=false',
            checkpointer_type: process.env.LANGGRAPH_CHECKPOINTER || 'redis',
            queue_stats: queueStats,
            available_nodes: Object.keys(langgraph.nodes),
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

/**
 * POST /api/test/langgraph/invoke/:caseId
 * Invoke the LangGraph agent for a specific case
 */
router.post('/langgraph/invoke/:caseId', async (req, res) => {
    try {
        const caseId = parseInt(req.params.caseId);
        const { trigger_type, sync } = req.body;

        const caseData = await db.getCaseById(caseId);
        if (!caseData) {
            return res.status(404).json({
                success: false,
                error: 'Case not found'
            });
        }

        // If sync mode, invoke directly (for testing)
        if (sync) {
            console.log(`[LangGraph Test] Invoking synchronously for case ${caseId}`);
            const result = await langgraph.invokeFOIACaseGraph(
                caseId,
                trigger_type || 'MANUAL',
                {}
            );

            return res.json({
                success: true,
                mode: 'sync',
                result
            });
        }

        // Otherwise queue the job
        const job = await enqueueAgentJob(caseId, trigger_type || 'MANUAL', {});

        res.json({
            success: true,
            mode: 'async',
            job_id: job.id,
            message: `Agent job queued for case ${caseId}`
        });
    } catch (error) {
        console.error('LangGraph invoke error:', error);
        res.status(500).json({
            success: false,
            error: error.message,
            stack: error.stack
        });
    }
});

/**
 * POST /api/test/langgraph/resume/:caseId
 * Resume a paused graph with a human decision
 */
router.post('/langgraph/resume/:caseId', async (req, res) => {
    try {
        const caseId = parseInt(req.params.caseId);
        const { action, instruction, sync } = req.body;

        if (!action) {
            return res.status(400).json({
                success: false,
                error: 'action is required (APPROVE, ADJUST, DISMISS, WITHDRAW)'
            });
        }

        const decision = {
            action,
            instruction: instruction || null
        };

        // If sync mode, invoke directly (for testing)
        if (sync) {
            console.log(`[LangGraph Test] Resuming synchronously for case ${caseId}`);
            const result = await langgraph.resumeFOIACaseGraph(caseId, decision);

            return res.json({
                success: true,
                mode: 'sync',
                result
            });
        }

        // Otherwise queue the job
        const job = await enqueueResumeJob(caseId, decision);

        res.json({
            success: true,
            mode: 'async',
            job_id: job.id,
            message: `Resume job queued for case ${caseId}`
        });
    } catch (error) {
        console.error('LangGraph resume error:', error);
        res.status(500).json({
            success: false,
            error: error.message,
            stack: error.stack
        });
    }
});

/**
 * Node name mapping: graph node names (snake_case) to export names (camelCase)
 */
const GRAPH_NODE_MAPPING = {
    'load_context': 'loadContextNode',
    'classify_inbound': 'classifyInboundNode',
    'update_constraints': 'updateConstraintsNode',
    'decide_next_action': 'decideNextActionNode',
    'draft_response': 'draftResponseNode',
    'safety_check': 'safetyCheckNode',
    'gate_or_execute': 'gateOrExecuteNode',
    'execute_action': 'executeActionNode',
    'commit_state': 'commitStateNode'
};

/**
 * Get the node that runs BEFORE the target node in the graph
 * Used for updateState's asNode parameter
 */
const NODE_PREDECESSORS = {
    'load_context': null,  // First node, no predecessor
    'classify_inbound': 'load_context',
    'update_constraints': 'classify_inbound',
    'decide_next_action': 'update_constraints',
    'draft_response': 'decide_next_action',
    'safety_check': 'draft_response',
    'gate_or_execute': 'safety_check',
    'execute_action': 'gate_or_execute',
    'commit_state': 'execute_action'
};

/**
 * POST /api/test/langgraph/node/:nodeName
 * Test a specific node with two modes:
 * - mode: 'unit' (default) - Direct node call, fast but bypasses graph runtime
 * - mode: 'graph' - Real execution with checkpointing, reducers, and routing
 */
router.post('/langgraph/node/:nodeName', async (req, res) => {
    try {
        const { nodeName } = req.params;
        const { state, mode = 'unit', caseId } = req.body;

        // Normalize node name (accept both snake_case and camelCase)
        const graphNodeName = GRAPH_NODE_MAPPING[nodeName] ? nodeName :
            Object.keys(GRAPH_NODE_MAPPING).find(k => GRAPH_NODE_MAPPING[k] === nodeName);
        const exportedNodeName = GRAPH_NODE_MAPPING[graphNodeName];

        if (!exportedNodeName) {
            return res.status(404).json({
                success: false,
                error: `Node '${nodeName}' not found`,
                available_nodes: Object.keys(GRAPH_NODE_MAPPING),
                hint: 'Use snake_case names like "load_context" or "draft_response"'
            });
        }

        const node = langgraph.nodes[exportedNodeName];
        if (!node) {
            return res.status(500).json({
                success: false,
                error: `Node function '${exportedNodeName}' not exported from langgraph module`
            });
        }

        console.log(`[LangGraph Test] Testing node: ${graphNodeName} (mode: ${mode})`);

        // === UNIT MODE: DEPRECATED - returns error directing to use graph mode or E2E runner ===
        if (mode === 'unit') {
            console.log(`[LangGraph Test] Unit mode DEPRECATED - rejecting request`);

            return res.status(400).json({
                success: false,
                error: 'Unit mode is deprecated',
                reason: 'Direct node calls bypass graph runtime (reducers, checkpointing, edges, interrupts). Results are not representative of production behavior.',
                recommendation: 'Use mode="graph" for realistic node testing, or use the E2E Scenario Runner at /test-e2e.html for full workflow testing.',
                alternatives: [
                    { mode: 'graph', description: 'Runs node within graph context with checkpointing' },
                    { url: '/test-e2e.html', description: 'E2E Scenario Runner for full workflow testing' }
                ]
            });
        }

        // === GRAPH MODE: Real execution with checkpointing ===
        if (mode === 'graph') {
            console.log(`[LangGraph Test] Graph mode - real execution with checkpointing`);

            // Require caseId for graph mode (needed for proper state)
            if (!caseId && !state?.caseId) {
                return res.status(400).json({
                    success: false,
                    error: 'caseId is required for graph mode',
                    hint: 'Provide caseId in request body or in state.caseId'
                });
            }

            const effectiveCaseId = caseId || state.caseId;
            const graph = await langgraph.getCompiledGraph();
            const threadId = `test:node:${graphNodeName}:${effectiveCaseId}:${Date.now()}`;
            const config = { configurable: { thread_id: threadId } };

            const startTime = Date.now();

            // Get predecessor node for updateState
            const predecessorNode = NODE_PREDECESSORS[graphNodeName];

            // Merge provided state with required fields
            const seedState = {
                caseId: effectiveCaseId,
                triggerType: state?.triggerType || 'NODE_TEST',
                ...state
            };

            let preState = null;
            let postState = null;
            let nodeUpdates = [];

            try {
                if (predecessorNode) {
                    // Seed state "as if" predecessor node just completed
                    console.log(`[LangGraph Test] Seeding state as if '${predecessorNode}' completed`);
                    await graph.updateState(config, seedState, predecessorNode);

                    // Get pre-state (before target node runs)
                    const preStateSnapshot = await graph.getState(config);
                    preState = preStateSnapshot?.values || null;
                } else {
                    // First node - just set initial state
                    preState = seedState;
                }

                // Run graph with interruptAfter to stop right after target node
                console.log(`[LangGraph Test] Invoking with interruptAfter: ['${graphNodeName}']`);

                // Use stream to capture node updates
                const stream = await graph.stream(
                    predecessorNode ? null : seedState,
                    {
                        ...config,
                        streamMode: 'updates',
                        interruptAfter: [graphNodeName]
                    }
                );

                // Collect stream updates
                for await (const update of stream) {
                    nodeUpdates.push(update);
                    console.log(`[LangGraph Test] Stream update:`, JSON.stringify(update, null, 2));
                }

                // Get post-state (after target node ran)
                const postStateSnapshot = await graph.getState(config);
                postState = postStateSnapshot?.values || null;

                const duration = Date.now() - startTime;

                // Extract just the target node's output from updates
                const targetNodeOutput = nodeUpdates.find(u => u[graphNodeName])?.[graphNodeName] || null;

                return res.json({
                    success: true,
                    mode: 'graph',
                    node: graphNodeName,
                    thread_id: threadId,
                    duration_ms: duration,
                    pre_state: preState,
                    post_state: postState,
                    node_output: targetNodeOutput,
                    all_updates: nodeUpdates,
                    checkpoint_info: {
                        thread_id: threadId,
                        checkpoint_id: postStateSnapshot?.config?.configurable?.checkpoint_id
                    }
                });

            } catch (graphError) {
                // Check if it's an interrupt (expected for gate_or_execute)
                if (graphError.message?.includes('interrupt') || graphError.name === 'GraphInterrupt') {
                    const postStateSnapshot = await graph.getState(config);
                    postState = postStateSnapshot?.values || null;
                    const duration = Date.now() - startTime;

                    return res.json({
                        success: true,
                        mode: 'graph',
                        node: graphNodeName,
                        thread_id: threadId,
                        duration_ms: duration,
                        interrupted: true,
                        interrupt_data: postStateSnapshot?.tasks?.[0]?.interrupts?.[0] || null,
                        pre_state: preState,
                        post_state: postState,
                        all_updates: nodeUpdates
                    });
                }
                throw graphError;
            }
        }

        return res.status(400).json({
            success: false,
            error: `Invalid mode: '${mode}'`,
            valid_modes: ['unit', 'graph']
        });

    } catch (error) {
        console.error(`LangGraph node test error (${req.params.nodeName}):`, error);
        res.status(500).json({
            success: false,
            error: error.message,
            stack: error.stack
        });
    }
});

/**
 * GET /api/test/langgraph/cases
 * Get cases available for testing
 */
router.get('/langgraph/cases', async (req, res) => {
    try {
        const result = await db.query(`
            SELECT id, case_name, agency_name, status, requires_human, pause_reason,
                   langgraph_thread_id, updated_at
            FROM cases
            ORDER BY updated_at DESC
            LIMIT 50
        `);

        res.json({
            success: true,
            count: result.rows.length,
            cases: result.rows
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

/**
 * GET /api/test/langgraph/proposals/:caseId
 * Get proposals for a case
 */
router.get('/langgraph/proposals/:caseId', async (req, res) => {
    try {
        const caseId = parseInt(req.params.caseId);

        const result = await db.query(`
            SELECT * FROM proposals
            WHERE case_id = $1
            ORDER BY created_at DESC
            LIMIT 20
        `, [caseId]);

        res.json({
            success: true,
            case_id: caseId,
            count: result.rows.length,
            proposals: result.rows
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

/**
 * GET /api/test/langgraph/queue
 * Get agent queue status
 */
router.get('/langgraph/queue', async (req, res) => {
    try {
        const stats = await getQueueStats();
        const { agentQueue } = require('../queues/agent-queue');

        const waiting = await agentQueue.getJobs(['waiting'], 0, 10);
        const active = await agentQueue.getJobs(['active'], 0, 10);
        const completed = await agentQueue.getJobs(['completed'], 0, 10);
        const failed = await agentQueue.getJobs(['failed'], 0, 10);

        res.json({
            success: true,
            stats,
            jobs: {
                waiting: waiting.map(j => ({ id: j.id, name: j.name, data: j.data })),
                active: active.map(j => ({ id: j.id, name: j.name, data: j.data })),
                completed: completed.map(j => ({ id: j.id, name: j.name, data: j.data, returnValue: j.returnvalue })),
                failed: failed.map(j => ({ id: j.id, name: j.name, data: j.data, failedReason: j.failedReason }))
            }
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

/**
 * GET /api/test/langgraph/state/:caseId
 * Get full state for a case including proposals, jobs, locks
 */
router.get('/langgraph/state/:caseId', async (req, res) => {
    try {
        const caseId = parseInt(req.params.caseId);

        // Get case data
        const caseData = await db.getCaseById(caseId);
        if (!caseData) {
            return res.status(404).json({ success: false, error: 'Case not found' });
        }

        // Get proposals
        const proposalsResult = await db.query(
            `SELECT * FROM proposals WHERE case_id = $1 ORDER BY created_at DESC LIMIT 10`,
            [caseId]
        );

        // Get latest inbound message
        const latestInbound = await db.getLatestInboundMessage(caseId);

        // Get email jobs for this case
        const { emailQueue } = require('../queues/email-queue');
        const allEmailJobs = await emailQueue.getJobs(['waiting', 'active', 'delayed', 'completed', 'failed']);
        const caseEmailJobs = allEmailJobs.filter(j => j.data?.caseId === caseId || j.data?.case_id === caseId);

        // Get agent jobs
        const { agentQueue } = require('../queues/agent-queue');
        const allAgentJobs = await agentQueue.getJobs(['waiting', 'active', 'completed', 'failed']);
        const caseAgentJobs = allAgentJobs.filter(j => j.data?.caseId === caseId);

        // Check lock status (advisory lock)
        const lockKey = Math.abs(hashCodeSimple(`case:${caseId}`)) % 2147483647;
        const lockCheck = await db.query(
            `SELECT pg_try_advisory_lock($1) as available`,
            [lockKey]
        );
        const lockAvailable = lockCheck.rows[0]?.available;
        if (lockAvailable) {
            // Release the test lock immediately
            await db.query(`SELECT pg_advisory_unlock($1)`, [lockKey]);
        }

        // Get thread/checkpoint info
        let threadInfo = null;
        try {
            threadInfo = await langgraph.getThreadInfo(caseId);
        } catch (e) {
            threadInfo = { error: e.message };
        }

        // DRY_RUN status
        const dryRun = process.env.LANGGRAPH_DRY_RUN !== 'false';

        res.json({
            success: true,
            case_id: caseId,
            case: {
                id: caseData.id,
                case_name: caseData.case_name,
                agency_name: caseData.agency_name,
                status: caseData.status,
                requires_human: caseData.requires_human,
                pause_reason: caseData.pause_reason,
                autopilot_mode: caseData.autopilot_mode,
                portal_url: caseData.portal_url,
                langgraph_thread_id: caseData.langgraph_thread_id,
                updated_at: caseData.updated_at
            },
            latest_inbound: latestInbound ? {
                id: latestInbound.id,
                subject: latestInbound.subject,
                received_at: latestInbound.received_at
            } : null,
            proposals: proposalsResult.rows.map(p => ({
                id: p.id,
                proposal_key: p.proposal_key,
                action_type: p.action_type,
                status: p.status,
                execution_key: p.execution_key,
                email_job_id: p.email_job_id,
                human_decision: p.human_decision,
                requires_human: p.requires_human,
                can_auto_execute: p.can_auto_execute,
                created_at: p.created_at,
                executed_at: p.executed_at
            })),
            email_jobs: caseEmailJobs.slice(0, 5).map(j => ({
                id: j.id,
                name: j.name,
                state: j.getState ? 'pending' : 'unknown',
                data: { proposalId: j.data?.proposalId, executionKey: j.data?.executionKey },
                timestamp: j.timestamp
            })),
            agent_jobs: caseAgentJobs.slice(0, 5).map(j => ({
                id: j.id,
                name: j.name,
                data: j.data
            })),
            lock: {
                key: lockKey,
                available: lockAvailable,
                thread_id: `case:${caseId}`
            },
            thread: threadInfo,
            dry_run: dryRun
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Simple hash function for lock key
function hashCodeSimple(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
        const char = str.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash = hash & hash;
    }
    return hash;
}

/**
 * POST /api/test/langgraph/create-message/:caseId
 * Create a fake inbound message for testing
 */
router.post('/langgraph/create-message/:caseId', async (req, res) => {
    try {
        const caseId = parseInt(req.params.caseId);
        const { subject, body, intent, fee_amount } = req.body;

        const caseData = await db.getCaseById(caseId);
        if (!caseData) {
            return res.status(404).json({ success: false, error: 'Case not found' });
        }

        // Get or create thread
        let thread = await db.getThreadByCaseId(caseId);
        if (!thread) {
            const { v4: uuidv4 } = require('uuid');
            thread = await db.createEmailThread({
                case_id: caseId,
                thread_id: `test-thread-${uuidv4()}`,
                subject: subject || `Test thread for case ${caseId}`,
                agency_email: caseData.agency_email || 'test@agency.gov',
                initial_message_id: `initial-${Date.now()}@test.local`,
                status: 'active'
            });
        }

        // Create message
        const message = await db.query(`
            INSERT INTO messages (
                thread_id, case_id, direction, from_email, to_email,
                subject, body_text, received_at, message_id
            ) VALUES ($1, $2, 'inbound', $3, $4, $5, $6, NOW(), $7)
            RETURNING *
        `, [
            thread.id,
            caseId,
            caseData.agency_email || 'test@agency.gov',
            process.env.SENDGRID_FROM_EMAIL || 'test@foia.com',
            subject || `Test message for case ${caseId}`,
            body || 'This is a test inbound message.',
            `test-${Date.now()}@test.local`
        ]);

        // Create analysis if intent provided
        if (intent) {
            await db.query(`
                INSERT INTO response_analysis (
                    message_id, intent, confidence_score, extracted_fee_amount,
                    key_points, requires_action, suggested_action
                ) VALUES ($1, $2, 0.9, $3, $4, true, $5)
            `, [
                message.rows[0].id,
                intent,
                fee_amount || null,
                JSON.stringify(['Test analysis key point']),
                intent === 'fee_request' ? 'approve_fee' : 'respond'
            ]);
        }

        // Update case
        await db.updateCase(caseId, {
            status: 'responded',
            last_response_date: new Date()
        });

        res.json({
            success: true,
            message: message.rows[0],
            thread_id: thread.id
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

/**
 * POST /api/test/langgraph/scenario/:caseId
 * Set up a specific test scenario
 */
router.post('/langgraph/scenario/:caseId', async (req, res) => {
    try {
        const caseId = parseInt(req.params.caseId);
        const { scenario } = req.body;

        const caseData = await db.getCaseById(caseId);
        if (!caseData) {
            return res.status(404).json({ success: false, error: 'Case not found' });
        }

        const scenarios = {
            fee_low: {
                intent: 'fee_request',
                fee_amount: 25,
                subject: 'Fee Quote - $25.00',
                body: 'The estimated fee for your request is $25.00. Please confirm if you wish to proceed.',
                updates: { autopilot_mode: 'AUTO' }
            },
            fee_high: {
                intent: 'fee_request',
                fee_amount: 250,
                subject: 'Fee Quote - $250.00',
                body: 'The estimated fee for your request is $250.00. Please confirm if you wish to proceed.',
                updates: { autopilot_mode: 'SUPERVISED' }
            },
            denial: {
                intent: 'denial',
                subject: 'Records Request Denied',
                body: 'Your request has been denied pursuant to exemption 7(A) - law enforcement investigation.',
                updates: {}
            },
            clarification: {
                intent: 'more_info_needed',
                subject: 'Additional Information Needed',
                body: 'Please provide more specific dates for the incident you are requesting records about.',
                updates: {}
            },
            portal_send: {
                intent: 'acknowledgment',
                subject: 'Request Acknowledged',
                body: 'Your request has been received via our portal.',
                updates: { portal_url: 'https://test-portal.gov/requests', portal_provider: 'Test Portal' }
            },
            hostile: {
                intent: 'denial',
                subject: 'FINAL NOTICE - Request Denied',
                body: 'This is your FINAL notice. Your frivolous request is DENIED. Do not contact us again.',
                updates: {}
            }
        };

        const config = scenarios[scenario];
        if (!config) {
            return res.status(400).json({
                success: false,
                error: `Unknown scenario: ${scenario}`,
                available: Object.keys(scenarios)
            });
        }

        // Apply case updates
        if (Object.keys(config.updates).length > 0) {
            await db.updateCase(caseId, config.updates);
        }

        // Create the message
        const createRes = await fetch(`http://localhost:${process.env.PORT || 3000}/api/test/langgraph/create-message/${caseId}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                subject: config.subject,
                body: config.body,
                intent: config.intent,
                fee_amount: config.fee_amount
            })
        });

        const createData = await createRes.json();

        res.json({
            success: true,
            scenario,
            config,
            message: createData.message
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

/**
 * POST /api/test/langgraph/force-unlock/:caseId
 * Force release advisory lock (dev only)
 */
router.post('/langgraph/force-unlock/:caseId', async (req, res) => {
    try {
        const caseId = parseInt(req.params.caseId);
        const lockKey = Math.abs(hashCodeSimple(`case:${caseId}`)) % 2147483647;

        // Try to unlock
        await db.query(`SELECT pg_advisory_unlock_all()`);

        res.json({
            success: true,
            message: 'All advisory locks released',
            lock_key: lockKey
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

/**
 * POST /api/test/langgraph/reset-thread/:caseId
 * Reset LangGraph thread/checkpoint (dev only)
 */
router.post('/langgraph/reset-thread/:caseId', async (req, res) => {
    try {
        const caseId = parseInt(req.params.caseId);

        // Clear proposals
        const proposalsResult = await db.query(`DELETE FROM proposals WHERE case_id = $1 RETURNING id`, [caseId]);
        const proposalsDeleted = proposalsResult.rows?.length || 0;

        // Clear langgraph thread reference
        await db.updateCase(caseId, {
            langgraph_thread_id: null,
            requires_human: false,
            pause_reason: null
        });

        // Clear Redis checkpoint using langgraph module
        let checkpointsDeleted = 0;
        try {
            const result = await langgraph.resetThread(caseId);
            checkpointsDeleted = result.deletedCount;
        } catch (e) {
            console.warn('Could not clear Redis checkpoint:', e.message);
        }

        res.json({
            success: true,
            message: `Thread reset for case ${caseId}`,
            deleted: {
                proposals: proposalsDeleted,
                checkpoints: checkpointsDeleted
            },
            thread_id: `case:${caseId}`
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

/**
 * POST /api/test/langgraph/chaos/double-invoke/:caseId
 * Fire two invocations concurrently to test locking
 */
router.post('/langgraph/chaos/double-invoke/:caseId', async (req, res) => {
    try {
        const caseId = parseInt(req.params.caseId);

        console.log(`[CHAOS] Double-invoke test for case ${caseId}`);

        // Fire both invocations concurrently
        const [result1, result2] = await Promise.allSettled([
            langgraph.invokeFOIACaseGraph(caseId, 'CHAOS_TEST_1', {}),
            langgraph.invokeFOIACaseGraph(caseId, 'CHAOS_TEST_2', {})
        ]);

        res.json({
            success: true,
            test: 'double_invoke',
            results: [
                {
                    trigger: 'CHAOS_TEST_1',
                    status: result1.status,
                    value: result1.status === 'fulfilled' ? result1.value : null,
                    error: result1.status === 'rejected' ? result1.reason?.message : null
                },
                {
                    trigger: 'CHAOS_TEST_2',
                    status: result2.status,
                    value: result2.status === 'fulfilled' ? result2.value : null,
                    error: result2.status === 'rejected' ? result2.reason?.message : null
                }
            ],
            expected: 'One should succeed, one should fail or no-op due to lock'
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

/**
 * POST /api/test/langgraph/chaos/double-approve/:caseId/:proposalId
 * Fire two approvals concurrently to test idempotency
 */
router.post('/langgraph/chaos/double-approve/:caseId/:proposalId', async (req, res) => {
    try {
        const caseId = parseInt(req.params.caseId);
        const proposalId = parseInt(req.params.proposalId);

        console.log(`[CHAOS] Double-approve test for proposal ${proposalId}`);

        // Fire both approvals concurrently
        const [result1, result2] = await Promise.allSettled([
            fetch(`http://localhost:${process.env.PORT || 3000}/api/requests/${caseId}/proposals/${proposalId}/approve`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' }
            }).then(r => r.json()),
            fetch(`http://localhost:${process.env.PORT || 3000}/api/requests/${caseId}/proposals/${proposalId}/approve`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' }
            }).then(r => r.json())
        ]);

        res.json({
            success: true,
            test: 'double_approve',
            results: [
                { attempt: 1, ...result1 },
                { attempt: 2, ...result2 }
            ],
            expected: 'One should succeed, one should return 409 (already executed)'
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

/**
 * GET /api/test/langgraph/assertions/:caseId
 * Run assertions on case state
 */
router.get('/langgraph/assertions/:caseId', async (req, res) => {
    try {
        const caseId = parseInt(req.params.caseId);

        const caseData = await db.getCaseById(caseId);
        if (!caseData) {
            return res.status(404).json({ success: false, error: 'Case not found' });
        }

        // Get proposals
        const proposals = await db.query(
            `SELECT * FROM proposals WHERE case_id = $1 ORDER BY created_at DESC`,
            [caseId]
        );

        // Get executed proposals
        const executedProposals = proposals.rows.filter(p => p.status === 'EXECUTED');

        // Get email jobs
        const { emailQueue } = require('../queues/email-queue');
        const allJobs = await emailQueue.getJobs(['completed']);
        const caseJobs = allJobs.filter(j => j.data?.caseId === caseId);

        // Run assertions
        const assertions = [];

        // A1: No duplicate proposals with same key
        const proposalKeys = proposals.rows.map(p => p.proposal_key);
        const uniqueKeys = new Set(proposalKeys);
        assertions.push({
            name: 'no_duplicate_proposal_keys',
            passed: proposalKeys.length === uniqueKeys.size,
            expected: 'All proposal keys unique',
            actual: `${proposalKeys.length} proposals, ${uniqueKeys.size} unique keys`
        });

        // A2: Executed proposals have execution_key
        const executedWithoutKey = executedProposals.filter(p => !p.execution_key);
        assertions.push({
            name: 'executed_have_execution_key',
            passed: executedWithoutKey.length === 0,
            expected: 'All executed proposals have execution_key',
            actual: `${executedWithoutKey.length} executed without key`
        });

        // A3: If requires_human, must have pause_reason
        assertions.push({
            name: 'requires_human_has_reason',
            passed: !caseData.requires_human || caseData.pause_reason,
            expected: 'If requires_human=true, pause_reason must be set',
            actual: `requires_human=${caseData.requires_human}, pause_reason=${caseData.pause_reason}`
        });

        // A4: Portal cases should not have SEND actions executed
        if (caseData.portal_url) {
            const sendActions = executedProposals.filter(p =>
                p.action_type?.startsWith('SEND_')
            );
            assertions.push({
                name: 'portal_no_send_actions',
                passed: sendActions.length === 0,
                expected: 'Portal cases should not execute SEND actions',
                actual: `${sendActions.length} SEND actions executed`
            });
        }

        // A5: Email jobs match executed proposals
        const proposalEmailJobs = executedProposals.filter(p => p.email_job_id);
        assertions.push({
            name: 'email_jobs_match_proposals',
            passed: true, // Informational
            expected: 'Each executed proposal with email should have job',
            actual: `${proposalEmailJobs.length} proposals with email_job_id`
        });

        const passed = assertions.filter(a => a.passed).length;
        const failed = assertions.filter(a => !a.passed).length;

        res.json({
            success: true,
            case_id: caseId,
            summary: {
                total: assertions.length,
                passed,
                failed
            },
            assertions
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// =========================================================================
// E2E SCENARIO RUNNER
// =========================================================================

/**
 * E2E Scenario Templates
 * Each scenario includes:
 * - Inbound message configurations
 * - Expected classifications/outcomes
 * - Stubbed LLM responses for determinism
 */
const E2E_SCENARIOS = {
    fee_low_auto: {
        name: 'Fee Quote (Low) - Auto Approve',
        description: 'Low fee under threshold, should auto-approve in AUTO mode',
        phases: ['setup', 'inject_inbound', 'process', 'verify'],
        inbound: {
            subject: 'Re: Records Request - Fee Quote',
            body: 'The estimated cost for your request is $15.00. Please confirm if you wish to proceed with payment.',
            channel: 'EMAIL'
        },
        case_setup: { autopilot_mode: 'AUTO' },
        expected: {
            classification: 'FEE_QUOTE',
            fee_amount: 15,
            action_type: 'APPROVE_FEE',
            auto_execute: true,
            requires_human: false
        },
        llm_stubs: {
            classify: { classification: 'FEE_QUOTE', confidence: 0.95, sentiment: 'neutral', fee_amount: 15 },
            draft: { subject: 'Re: Fee Approval', body: 'I agree to pay the $15.00 fee. Please proceed with processing my request.' }
        }
    },
    fee_high_gate: {
        name: 'Fee Quote (High) - Human Gate',
        description: 'High fee requires human approval',
        phases: ['setup', 'inject_inbound', 'process', 'human_gate', 'execute', 'verify'],
        inbound: {
            subject: 'Re: Records Request - Fee Quote',
            body: 'The estimated cost for your request is $350.00 with a required $75 deposit. Note: Body-worn camera footage is exempt from disclosure under state law.',
            channel: 'EMAIL'
        },
        case_setup: { autopilot_mode: 'SUPERVISED' },
        expected: {
            classification: 'FEE_QUOTE',
            fee_amount: 350,
            action_type: 'APPROVE_FEE',
            auto_execute: false,
            requires_human: true,
            pause_reason: 'FEE_QUOTE'
        },
        llm_stubs: {
            classify: { classification: 'FEE_QUOTE', confidence: 0.92, sentiment: 'neutral', fee_amount: 350, key_points: ['BWC exempt'] },
            draft: { subject: 'Re: Fee Approval', body: 'I agree to pay the $350.00 fee and the $75 deposit. Please proceed.' }
        }
    },
    denial_weak: {
        name: 'Denial (Weak) - Auto Rebuttal',
        description: 'Weak denial without strong exemption, auto-rebuttable',
        phases: ['setup', 'inject_inbound', 'process', 'verify'],
        inbound: {
            subject: 'Re: Records Request - Denied',
            body: 'Your request has been denied. We do not have records matching your description.',
            channel: 'EMAIL'
        },
        case_setup: { autopilot_mode: 'AUTO' },
        expected: {
            classification: 'DENIAL',
            action_type: 'SEND_REBUTTAL',
            auto_execute: true
        },
        llm_stubs: {
            classify: { classification: 'DENIAL', confidence: 0.88, sentiment: 'neutral', key_points: ['no records found'] },
            draft: { subject: 'Re: Appeal of Denial', body: 'I am appealing this denial. Please conduct a more thorough search...' }
        }
    },
    denial_strong: {
        name: 'Denial (Strong) - Human Gate',
        description: 'Strong denial with exemption requires human review',
        phases: ['setup', 'inject_inbound', 'process', 'human_gate', 'execute', 'verify'],
        inbound: {
            subject: 'Re: Records Request - DENIED',
            body: 'Your request is DENIED pursuant to Exemption 7(A) - records compiled for law enforcement purposes, disclosure would interfere with ongoing investigation. This matter involves sealed court proceedings.',
            channel: 'EMAIL'
        },
        case_setup: { autopilot_mode: 'AUTO' },
        expected: {
            classification: 'DENIAL',
            action_type: 'SEND_REBUTTAL',
            auto_execute: false,
            requires_human: true,
            pause_reason: 'DENIAL'
        },
        llm_stubs: {
            classify: { classification: 'DENIAL', confidence: 0.95, sentiment: 'negative', key_points: ['exemption 7(A)', 'ongoing investigation', 'sealed'] },
            draft: { subject: 'Re: Appeal', body: 'I respectfully appeal this denial...' }
        }
    },
    clarification: {
        name: 'Clarification Request',
        description: 'Agency needs more information',
        phases: ['setup', 'inject_inbound', 'process', 'human_gate', 'execute', 'verify'],
        inbound: {
            subject: 'Re: Records Request - Additional Information Needed',
            body: 'We need additional information to process your request. Please provide the specific date range and incident report number if available.',
            channel: 'EMAIL'
        },
        case_setup: { autopilot_mode: 'SUPERVISED' },
        expected: {
            classification: 'CLARIFICATION_REQUEST',
            action_type: 'SEND_CLARIFICATION',
            requires_human: true,
            pause_reason: 'SCOPE'
        },
        llm_stubs: {
            classify: { classification: 'CLARIFICATION_REQUEST', confidence: 0.90, sentiment: 'neutral' },
            draft: { subject: 'Re: Additional Information', body: 'The incident occurred on...' }
        }
    },
    hostile: {
        name: 'Hostile Response',
        description: 'Hostile sentiment triggers escalation',
        phases: ['setup', 'inject_inbound', 'process', 'human_gate', 'verify'],
        inbound: {
            subject: 'FINAL WARNING - DO NOT CONTACT AGAIN',
            body: 'This is your FINAL notice. Your frivolous and harassing requests are DENIED. Any further contact will be reported to law enforcement. DO NOT CONTACT THIS OFFICE AGAIN.',
            channel: 'EMAIL'
        },
        case_setup: { autopilot_mode: 'AUTO' },
        expected: {
            classification: 'DENIAL',
            sentiment: 'hostile',
            action_type: 'ESCALATE',
            requires_human: true,
            pause_reason: 'SENSITIVE'
        },
        llm_stubs: {
            classify: { classification: 'DENIAL', confidence: 0.85, sentiment: 'hostile', key_points: ['final notice', 'harassment allegation'] }
        }
    },
    portal_case: {
        name: 'Portal Case - No Email',
        description: 'Portal case should never send email',
        phases: ['setup', 'inject_inbound', 'process', 'human_gate', 'execute', 'verify'],
        inbound: {
            subject: 'Portal Update',
            body: 'Your request status has been updated. Fee: $50.00',
            channel: 'PORTAL'
        },
        case_setup: {
            autopilot_mode: 'SUPERVISED',
            portal_url: 'https://test-portal.gov/request/123',
            portal_provider: 'TestPortal'
        },
        expected: {
            classification: 'FEE_QUOTE',
            action_type: 'APPROVE_FEE',
            email_blocked: true  // Special assertion
        },
        llm_stubs: {
            classify: { classification: 'FEE_QUOTE', confidence: 0.90, sentiment: 'neutral', fee_amount: 50 }
        }
    },
    followup_no_response: {
        name: 'No Response - Follow-up',
        description: 'Time-based trigger for follow-up',
        phases: ['setup', 'trigger_followup', 'process', 'verify'],
        inbound: null,  // No inbound, time-triggered
        case_setup: { autopilot_mode: 'AUTO', status: 'awaiting_response' },
        expected: {
            classification: 'NO_RESPONSE',
            action_type: 'SEND_FOLLOWUP',
            auto_execute: true
        },
        llm_stubs: {
            draft: { subject: 'Follow-up: Records Request', body: 'I am following up on my records request submitted on...' }
        }
    }
};

/**
 * Active E2E runs storage (in-memory for dev, would be Redis in prod)
 */
const activeE2ERuns = new Map();

/**
 * Create a new E2E run
 */
function createE2ERun(caseId, scenarioKey, options = {}) {
    const runId = `e2e_${caseId}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const scenario = E2E_SCENARIOS[scenarioKey];

    if (!scenario) {
        throw new Error(`Unknown scenario: ${scenarioKey}`);
    }

    const run = {
        id: runId,
        case_id: caseId,
        scenario_key: scenarioKey,
        scenario_name: scenario.name,
        phases: scenario.phases,
        current_phase_index: 0,
        current_phase: scenario.phases[0],
        status: 'initialized',
        use_worker: options.use_worker !== false,
        dry_run: options.dry_run !== false,
        deterministic: options.deterministic !== false,
        created_at: new Date().toISOString(),
        state_snapshots: [],
        artifacts: {
            inbound_message_id: null,
            proposal_id: null,
            proposal_key: null,
            job_ids: [],
            thread_id: null
        },
        logs: [`Run created for scenario: ${scenario.name}`],
        assertions: [],
        human_decision: null
    };

    activeE2ERuns.set(runId, run);
    return run;
}

/**
 * POST /api/test/e2e/runs
 * Create a new E2E test run
 */
router.post('/e2e/runs', async (req, res) => {
    try {
        const { case_id, scenario, use_worker = true, dry_run = true, deterministic = true } = req.body;

        if (!case_id) {
            return res.status(400).json({ success: false, error: 'case_id is required' });
        }

        if (!scenario || !E2E_SCENARIOS[scenario]) {
            return res.status(400).json({
                success: false,
                error: `Invalid scenario: ${scenario}`,
                available: Object.keys(E2E_SCENARIOS).map(k => ({
                    key: k,
                    name: E2E_SCENARIOS[k].name,
                    description: E2E_SCENARIOS[k].description
                }))
            });
        }

        const caseData = await db.getCaseById(case_id);
        if (!caseData) {
            return res.status(404).json({ success: false, error: 'Case not found' });
        }

        const run = createE2ERun(case_id, scenario, { use_worker, dry_run, deterministic });

        // Store deterministic mode flag for LLM stubs
        if (deterministic) {
            global.__E2E_DETERMINISTIC_RUN__ = run.id;
            global.__E2E_LLM_STUBS__ = E2E_SCENARIOS[scenario].llm_stubs;
        }

        res.json({
            success: true,
            run
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * GET /api/test/e2e/runs/:runId
 * Get E2E run status
 */
router.get('/e2e/runs/:runId', (req, res) => {
    const run = activeE2ERuns.get(req.params.runId);
    if (!run) {
        return res.status(404).json({ success: false, error: 'Run not found' });
    }
    res.json({ success: true, run });
});

/**
 * GET /api/test/e2e/scenarios
 * List available scenarios
 */
router.get('/e2e/scenarios', (req, res) => {
    const scenarios = Object.entries(E2E_SCENARIOS).map(([key, s]) => ({
        key,
        name: s.name,
        description: s.description,
        phases: s.phases,
        expected: s.expected
    }));
    res.json({ success: true, scenarios });
});

/**
 * POST /api/test/e2e/runs/:runId/reset
 * Reset a run to start fresh
 */
router.post('/e2e/runs/:runId/reset', async (req, res) => {
    try {
        const run = activeE2ERuns.get(req.params.runId);
        if (!run) {
            return res.status(404).json({ success: false, error: 'Run not found' });
        }

        // Reset the case state
        await db.updateCase(run.case_id, {
            status: 'ready_to_send',
            requires_human: false,
            pause_reason: null,
            langgraph_thread_id: null
        });

        // Clear proposals for this case
        await db.query('DELETE FROM proposals WHERE case_id = $1', [run.case_id]);

        // Reset run state
        run.current_phase_index = 0;
        run.current_phase = run.phases[0];
        run.status = 'initialized';
        run.state_snapshots = [];
        run.artifacts = {
            inbound_message_id: null,
            proposal_id: null,
            proposal_key: null,
            job_ids: [],
            thread_id: null
        };
        run.logs = [...run.logs, `Run reset at ${new Date().toISOString()}`];
        run.assertions = [];
        run.human_decision = null;

        res.json({ success: true, run });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * Capture state snapshot for a run
 */
async function captureStateSnapshot(run, label) {
    const caseData = await db.getCaseById(run.case_id);
    const proposals = await db.query(
        'SELECT * FROM proposals WHERE case_id = $1 ORDER BY created_at DESC LIMIT 5',
        [run.case_id]
    );

    const snapshot = {
        label,
        timestamp: new Date().toISOString(),
        case: {
            status: caseData?.status,
            requires_human: caseData?.requires_human,
            pause_reason: caseData?.pause_reason,
            langgraph_thread_id: caseData?.langgraph_thread_id,
            autopilot_mode: caseData?.autopilot_mode
        },
        proposals: proposals.rows.map(p => ({
            id: p.id,
            proposal_key: p.proposal_key,
            action_type: p.action_type,
            status: p.status,
            execution_key: p.execution_key,
            human_decision: p.human_decision
        })),
        artifacts: { ...run.artifacts }
    };

    run.state_snapshots.push(snapshot);
    return snapshot;
}

/**
 * Execute a single phase of an E2E run
 */
async function executePhase(run) {
    const scenario = E2E_SCENARIOS[run.scenario_key];
    const phase = run.current_phase;

    run.logs.push(`Executing phase: ${phase}`);

    try {
        switch (phase) {
            case 'setup': {
                // Generate thread_id for LangGraph
                const langgraphThreadId = `case:${run.case_id}`;
                run.artifacts.thread_id = langgraphThreadId;

                // Apply case setup AND set langgraph_thread_id in the same update
                const caseUpdate = {
                    ...(scenario.case_setup || {}),
                    langgraph_thread_id: langgraphThreadId
                };
                await db.updateCase(run.case_id, caseUpdate);
                run.logs.push(`Applied case setup: ${JSON.stringify(caseUpdate)}`);

                await captureStateSnapshot(run, 'after_setup');
                break;
            }

            case 'inject_inbound': {
                if (!scenario.inbound) {
                    run.logs.push('No inbound to inject (time-triggered scenario)');
                    break;
                }

                // Create inbound message
                const thread = await ensureEmailThread(run.case_id);
                const message = await createInboundMessage(run.case_id, thread.id, {
                    subject: scenario.inbound.subject,
                    body: scenario.inbound.body,
                    channel: scenario.inbound.channel || 'EMAIL'
                });

                run.artifacts.inbound_message_id = message.id;
                run.logs.push(`Injected inbound message: ${message.id}`);
                await captureStateSnapshot(run, 'after_inject');
                break;
            }

            case 'trigger_followup': {
                // For no-response scenarios, just update case to trigger followup
                await db.updateCase(run.case_id, { status: 'awaiting_response' });
                run.logs.push('Triggered followup scenario');
                await captureStateSnapshot(run, 'after_trigger');
                break;
            }

            case 'process': {
                // Invoke the graph (via worker or direct)
                const triggerType = scenario.inbound ? 'agency_reply' : 'time_based_followup';

                // Pass llm_stubs for deterministic mode
                const invokeOptions = {
                    e2e_run_id: run.id,
                    llmStubs: run.deterministic ? scenario.llm_stubs : null
                };

                if (run.use_worker) {
                    const job = await enqueueAgentJob(run.case_id, triggerType, {
                        e2e_run_id: run.id,
                        deterministic: run.deterministic,
                        llm_stubs: run.deterministic ? scenario.llm_stubs : null
                    });
                    run.artifacts.job_ids.push(job.id);
                    run.logs.push(`Enqueued agent job: ${job.id}`);

                    // Wait for job completion (with timeout)
                    const result = await waitForJob(job, 30000);
                    run.logs.push(`Job completed: ${result.status}`);
                } else {
                    const result = await langgraph.invokeFOIACaseGraph(
                        run.case_id,
                        triggerType,
                        invokeOptions
                    );
                    run.logs.push(`Direct invoke result: ${result.status}`);

                    if (result.status === 'interrupted') {
                        run.status = 'awaiting_human';
                    }
                }

                await captureStateSnapshot(run, 'after_process');

                // Check if we hit an interrupt
                const caseAfter = await db.getCaseById(run.case_id);
                if (caseAfter.requires_human) {
                    run.status = 'awaiting_human';
                    run.logs.push('Hit human gate - awaiting decision');
                }
                break;
            }

            case 'human_gate': {
                // This phase waits for human input
                if (!run.human_decision) {
                    run.status = 'awaiting_human';
                    run.logs.push('Waiting for human decision');
                    return { needs_human: true };
                }

                // Process the human decision
                const decision = run.human_decision;
                run.logs.push(`Processing human decision: ${decision.action}`);

                if (run.use_worker) {
                    const job = await enqueueResumeJob(run.case_id, decision);
                    run.artifacts.job_ids.push(job.id);
                    run.logs.push(`Enqueued resume job: ${job.id}`);

                    const result = await waitForJob(job, 30000);
                    run.logs.push(`Resume job completed: ${result.status}`);
                } else {
                    const result = await langgraph.resumeFOIACaseGraph(run.case_id, decision);
                    run.logs.push(`Direct resume result: ${result.status}`);
                }

                run.human_decision = null;
                await captureStateSnapshot(run, 'after_human_gate');
                break;
            }

            case 'execute': {
                // Execution happens as part of process/human_gate
                // This phase just verifies execution occurred
                await captureStateSnapshot(run, 'after_execute');
                break;
            }

            case 'verify': {
                // Run assertions
                run.assertions = await runE2EAssertions(run);
                await captureStateSnapshot(run, 'final');
                run.status = 'completed';
                run.logs.push('Verification complete');
                break;
            }

            default:
                run.logs.push(`Unknown phase: ${phase}`);
        }

        return { success: true };
    } catch (error) {
        run.logs.push(`Phase error: ${error.message}`);
        run.status = 'error';
        return { success: false, error: error.message };
    }
}

/**
 * Wait for a BullMQ job to complete
 */
async function waitForJob(job, timeoutMs = 30000) {
    const startTime = Date.now();

    while (Date.now() - startTime < timeoutMs) {
        const state = await job.getState();
        if (state === 'completed') {
            return { status: 'completed', result: await job.returnvalue };
        }
        if (state === 'failed') {
            return { status: 'failed', error: job.failedReason };
        }
        await new Promise(r => setTimeout(r, 500));
    }

    return { status: 'timeout' };
}

/**
 * Ensure email thread exists for case
 */
async function ensureEmailThread(caseId) {
    const caseData = await db.getCaseById(caseId);
    let thread = await db.getThreadByCaseId(caseId);

    if (!thread) {
        thread = await db.createEmailThread({
            case_id: caseId,
            thread_id: `e2e-thread-${caseId}-${Date.now()}`,
            subject: `Records Request - Case ${caseId}`,
            agency_email: caseData.agency_email || 'test@agency.gov',
            initial_message_id: `initial-${Date.now()}@test.local`,
            status: 'active'
        });
    }

    return thread;
}

/**
 * Create an inbound message for testing
 */
async function createInboundMessage(caseId, threadId, config) {
    const messageId = `inbound-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@test.local`;

    const result = await db.query(`
        INSERT INTO email_messages (
            thread_id, message_id, direction, from_address, to_address,
            subject, body_text, body_html, received_at, processed
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        RETURNING *
    `, [
        threadId,
        messageId,
        'inbound',
        'records@agency.gov',
        'user@example.com',
        config.subject,
        config.body,
        `<p>${config.body}</p>`,
        new Date(),
        false
    ]);

    const message = result.rows[0];

    // Update case with latest inbound
    await db.updateCase(caseId, {
        latest_inbound_message_id: message.id,
        status: 'needs_review'
    });

    return message;
}

/**
 * Run E2E assertions for a run
 */
async function runE2EAssertions(run) {
    const scenario = E2E_SCENARIOS[run.scenario_key];
    const expected = scenario.expected;
    const assertions = [];

    const caseData = await db.getCaseById(run.case_id);
    const proposals = await db.query(
        'SELECT * FROM proposals WHERE case_id = $1 ORDER BY created_at DESC',
        [run.case_id]
    );
    const latestProposal = proposals.rows[0];

    // A1: Action type matches expected
    if (expected.action_type) {
        assertions.push({
            name: 'action_type_matches',
            passed: latestProposal?.action_type === expected.action_type,
            expected: expected.action_type,
            actual: latestProposal?.action_type
        });
    }

    // A2: Proposal has non-null action_type
    assertions.push({
        name: 'action_type_not_null',
        passed: latestProposal?.action_type != null,
        expected: 'non-null',
        actual: latestProposal?.action_type
    });

    // A3: Proposal key is stable (unique)
    const keyCount = proposals.rows.filter(p => p.proposal_key === latestProposal?.proposal_key).length;
    assertions.push({
        name: 'proposal_key_stable',
        passed: keyCount === 1,
        expected: '1 proposal per key',
        actual: `${keyCount} proposals with key`
    });

    // A4: requires_human matches expected
    if (expected.requires_human !== undefined) {
        assertions.push({
            name: 'requires_human_matches',
            passed: caseData.requires_human === expected.requires_human,
            expected: expected.requires_human,
            actual: caseData.requires_human
        });
    }

    // A5: pause_reason matches expected
    if (expected.pause_reason) {
        assertions.push({
            name: 'pause_reason_matches',
            passed: caseData.pause_reason === expected.pause_reason,
            expected: expected.pause_reason,
            actual: caseData.pause_reason
        });
    }

    // A6: If requires_human, must have pause_reason
    if (caseData.requires_human) {
        assertions.push({
            name: 'requires_human_has_reason',
            passed: caseData.pause_reason != null,
            expected: 'pause_reason when requires_human',
            actual: caseData.pause_reason
        });
    }

    // A7: Exactly-once execution check
    const executedProposals = proposals.rows.filter(p => p.status === 'EXECUTED');
    const executionKeys = executedProposals.map(p => p.execution_key).filter(Boolean);
    const uniqueExecutionKeys = new Set(executionKeys);
    assertions.push({
        name: 'exactly_once_execution',
        passed: executionKeys.length === uniqueExecutionKeys.size,
        expected: 'unique execution keys',
        actual: `${executionKeys.length} executions, ${uniqueExecutionKeys.size} unique keys`
    });

    // A8: Portal case should not send email
    if (expected.email_blocked && caseData.portal_url) {
        const emailSends = executedProposals.filter(p =>
            p.action_type?.startsWith('SEND_') && !p.execution_result?.dry_run
        );
        assertions.push({
            name: 'portal_no_email_send',
            passed: emailSends.length === 0,
            expected: 'no email sends for portal case',
            actual: `${emailSends.length} email sends`
        });
    }

    return assertions;
}

/**
 * POST /api/test/e2e/runs/:runId/step
 * Execute one phase of the E2E run
 */
router.post('/e2e/runs/:runId/step', async (req, res) => {
    try {
        const run = activeE2ERuns.get(req.params.runId);
        if (!run) {
            return res.status(404).json({ success: false, error: 'Run not found' });
        }

        if (run.status === 'completed') {
            return res.json({ success: true, message: 'Run already completed', run });
        }

        if (run.status === 'error') {
            return res.json({ success: false, message: 'Run in error state', run });
        }

        const result = await executePhase(run);

        if (result.needs_human) {
            return res.json({
                success: true,
                needs_human: true,
                phase: run.current_phase,
                run
            });
        }

        // Advance to next phase if not waiting for human
        if (run.status !== 'awaiting_human' && run.status !== 'error' && run.status !== 'completed') {
            run.current_phase_index++;
            if (run.current_phase_index < run.phases.length) {
                run.current_phase = run.phases[run.current_phase_index];
                run.status = 'running';
            } else {
                run.status = 'completed';
            }
        }

        res.json({ success: true, result, run });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * POST /api/test/e2e/runs/:runId/run-until-interrupt
 * Run phases until hitting a human gate or completion
 */
router.post('/e2e/runs/:runId/run-until-interrupt', async (req, res) => {
    try {
        const run = activeE2ERuns.get(req.params.runId);
        if (!run) {
            return res.status(404).json({ success: false, error: 'Run not found' });
        }

        const maxIterations = 20;
        let iterations = 0;

        while (iterations < maxIterations) {
            iterations++;

            if (run.status === 'completed' || run.status === 'error') {
                break;
            }

            if (run.status === 'awaiting_human') {
                break;
            }

            const result = await executePhase(run);

            if (result.needs_human) {
                break;
            }

            // Advance to next phase
            if (run.status !== 'awaiting_human' && run.status !== 'error') {
                run.current_phase_index++;
                if (run.current_phase_index < run.phases.length) {
                    run.current_phase = run.phases[run.current_phase_index];
                    run.status = 'running';
                } else {
                    run.status = 'completed';
                    break;
                }
            }
        }

        res.json({
            success: true,
            iterations,
            run
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * POST /api/test/e2e/runs/:runId/run-to-completion
 * Run all phases, auto-approving at human gates
 */
router.post('/e2e/runs/:runId/run-to-completion', async (req, res) => {
    try {
        const run = activeE2ERuns.get(req.params.runId);
        if (!run) {
            return res.status(404).json({ success: false, error: 'Run not found' });
        }

        const { auto_decision = 'APPROVE' } = req.body;
        const maxIterations = 30;
        let iterations = 0;

        while (iterations < maxIterations && run.status !== 'completed' && run.status !== 'error') {
            iterations++;

            if (run.status === 'awaiting_human') {
                run.human_decision = { action: auto_decision };
                run.logs.push(`Auto-decision: ${auto_decision}`);
                run.status = 'running';
            }

            const result = await executePhase(run);

            // Advance to next phase
            if (run.status !== 'awaiting_human' && run.status !== 'error') {
                run.current_phase_index++;
                if (run.current_phase_index < run.phases.length) {
                    run.current_phase = run.phases[run.current_phase_index];
                } else {
                    run.status = 'completed';
                }
            }
        }

        res.json({
            success: true,
            iterations,
            run
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * POST /api/test/e2e/runs/:runId/human-decision
 * Submit a human decision for an interrupted run
 */
router.post('/e2e/runs/:runId/human-decision', async (req, res) => {
    try {
        const run = activeE2ERuns.get(req.params.runId);
        if (!run) {
            return res.status(404).json({ success: false, error: 'Run not found' });
        }

        const { action, instruction } = req.body;

        if (!['APPROVE', 'ADJUST', 'DISMISS', 'WITHDRAW'].includes(action)) {
            return res.status(400).json({
                success: false,
                error: 'Invalid action',
                valid: ['APPROVE', 'ADJUST', 'DISMISS', 'WITHDRAW']
            });
        }

        run.human_decision = { action, instruction };
        run.status = 'running';
        run.logs.push(`Human decision received: ${action}${instruction ? ` (${instruction})` : ''}`);

        res.json({ success: true, run });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * POST /api/test/e2e/inject-inbound
 * Inject an inbound message (standalone endpoint)
 */
router.post('/e2e/inject-inbound', async (req, res) => {
    try {
        const { case_id, subject, body, channel = 'EMAIL' } = req.body;

        if (!case_id || !subject || !body) {
            return res.status(400).json({
                success: false,
                error: 'case_id, subject, and body are required'
            });
        }

        const thread = await ensureEmailThread(case_id);
        const message = await createInboundMessage(case_id, thread.id, { subject, body, channel });

        res.json({
            success: true,
            message_id: message.id,
            thread_id: thread.id,
            message
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * GET /api/test/e2e/inbound-presets
 * Get inbound message presets
 */
router.get('/e2e/inbound-presets', (req, res) => {
    const presets = {
        ack: {
            name: 'Acknowledgment',
            subject: 'Re: Records Request Received',
            body: 'Your records request has been received and assigned tracking number RR-2024-1234. We will respond within 10 business days.'
        },
        fee_low: {
            name: 'Fee Quote (Low)',
            subject: 'Re: Records Request - Fee Estimate',
            body: 'The estimated cost for your request is $15.00. Please confirm if you wish to proceed with payment.'
        },
        fee_high: {
            name: 'Fee Quote (High)',
            subject: 'Re: Records Request - Fee Estimate',
            body: 'The estimated cost for your request is $350.00 with a required $75.00 deposit. Note: Body-worn camera footage is exempt from disclosure under state law due to ongoing investigation.'
        },
        denial_exemption: {
            name: 'Denial with Exemption',
            subject: 'Re: Records Request - DENIED',
            body: 'Your request is DENIED pursuant to Exemption 7(A) - records compiled for law enforcement purposes. Disclosure would interfere with an ongoing criminal investigation.'
        },
        clarification: {
            name: 'Clarification Needed',
            subject: 'Re: Records Request - Additional Information Needed',
            body: 'We need additional information to process your request. Please provide: 1) Specific date range of incident 2) Incident report number if known 3) Names of officers involved'
        },
        portal_update: {
            name: 'Portal Instructions',
            subject: 'Portal Access Information',
            body: 'Your request has been transferred to our online portal. Please visit https://records.agency.gov/request/12345 to view status and download documents when available.'
        },
        hostile: {
            name: 'Hostile Response',
            subject: 'FINAL WARNING - CEASE AND DESIST',
            body: 'This is your FINAL notice regarding your frivolous and harassing records requests. Your request is DENIED. Any further communication will be forwarded to our legal department and reported as harassment. DO NOT CONTACT THIS OFFICE AGAIN.'
        },
        partial: {
            name: 'Partial Production',
            subject: 'Re: Records Request - Partial Response',
            body: 'We are providing a partial response to your request. Attached are the incident reports (15 pages). Note: Video footage is exempt from disclosure. Audio recordings are still being reviewed.'
        }
    };

    res.json({ success: true, presets });
});

/**
 * GET /api/test/e2e/runs/:runId/proposal
 * Get the current proposal for human gate display
 */
router.get('/e2e/runs/:runId/proposal', async (req, res) => {
    try {
        const run = activeE2ERuns.get(req.params.runId);
        if (!run) {
            return res.status(404).json({ success: false, error: 'Run not found' });
        }

        const proposals = await db.query(
            `SELECT * FROM proposals WHERE case_id = $1 AND status = 'PENDING_APPROVAL' ORDER BY created_at DESC LIMIT 1`,
            [run.case_id]
        );

        const proposal = proposals.rows[0];
        if (!proposal) {
            return res.json({ success: true, proposal: null, message: 'No pending proposal' });
        }

        res.json({
            success: true,
            proposal: {
                id: proposal.id,
                proposal_key: proposal.proposal_key,
                action_type: proposal.action_type,
                status: proposal.status,
                draft_subject: proposal.draft_subject,
                draft_body_text: proposal.draft_body_text,
                reasoning: proposal.reasoning,
                risk_flags: proposal.risk_flags,
                warnings: proposal.warnings,
                created_at: proposal.created_at
            }
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * DELETE /api/test/e2e/runs/:runId
 * Delete an E2E run
 */
router.delete('/e2e/runs/:runId', (req, res) => {
    const deleted = activeE2ERuns.delete(req.params.runId);
    res.json({ success: true, deleted });
});

/**
 * GET /api/test/e2e/runs
 * List all active E2E runs
 */
router.get('/e2e/runs', (req, res) => {
    const runs = Array.from(activeE2ERuns.values()).map(r => ({
        id: r.id,
        case_id: r.case_id,
        scenario_key: r.scenario_key,
        scenario_name: r.scenario_name,
        status: r.status,
        current_phase: r.current_phase,
        created_at: r.created_at
    }));
    res.json({ success: true, runs });
});

module.exports = router;
