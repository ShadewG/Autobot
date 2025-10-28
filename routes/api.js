const express = require('express');
const router = express.Router();
const db = require('../services/database');
const notionService = require('../services/notion-service');
const portalService = require('../services/portal-service');
const adaptiveLearning = require('../services/adaptive-learning-service');
const dashboardService = require('../services/dashboard-service');
const { generateQueue, emailQueue } = require('../queues/email-queue');

/**
 * Sync cases from Notion
 */
router.post('/sync/notion', async (req, res) => {
    try {
        const status = req.body.status || 'Ready to Send';
        const cases = await notionService.syncCasesFromNotion(status);

        res.json({
            success: true,
            synced: cases.length,
            cases: cases.map(c => ({
                id: c.id,
                case_name: c.case_name,
                agency: c.agency_name
            }))
        });
    } catch (error) {
        console.error('Error syncing from Notion:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

/**
 * Process all ready cases
 */
router.post('/process/all', async (req, res) => {
    try {
        const readyCases = await db.getCasesByStatus('ready_to_send');

        let queued = 0;
        for (const caseData of readyCases) {
            await generateQueue.add('generate-and-send', {
                caseId: caseData.id
            });
            queued++;
        }

        res.json({
            success: true,
            message: `Queued ${queued} cases for processing`,
            queued_count: queued
        });
    } catch (error) {
        console.error('Error processing cases:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

/**
 * Process a single Notion page by URL/ID
 * IMPORTANT: This must come BEFORE the :caseId route
 */
router.post('/process/notion-page', async (req, res) => {
    try {
        const { pageId } = req.body;

        if (!pageId) {
            return res.status(400).json({
                success: false,
                error: 'pageId is required'
            });
        }

        // Fetch and create case from Notion page
        const caseData = await notionService.processSinglePage(pageId);

        // Queue for generation and sending
        const job = await generateQueue.add('generate-and-send', {
            caseId: caseData.id
        });

        res.json({
            success: true,
            message: 'Case imported and queued for processing',
            case: {
                id: caseData.id,
                case_name: caseData.case_name,
                agency_name: caseData.agency_name,
                status: caseData.status
            },
            delay_minutes: Math.round(Math.random() * 8) + 2 // Estimate 2-10 min
        });
    } catch (error) {
        console.error('Error processing Notion page:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

/**
 * Process a single case by ID
 */
router.post('/process/:caseId', async (req, res) => {
    try {
        const caseId = parseInt(req.params.caseId);
        const caseData = await db.getCaseById(caseId);

        if (!caseData) {
            return res.status(404).json({
                success: false,
                error: 'Case not found'
            });
        }

        await generateQueue.add('generate-and-send', {
            caseId: caseId
        });

        res.json({
            success: true,
            message: `Case ${caseId} queued for processing`,
            case_name: caseData.case_name
        });
    } catch (error) {
        console.error('Error processing case:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

/**
 * Get all cases
 */
router.get('/cases', async (req, res) => {
    try {
        const status = req.query.status;
        const limit = parseInt(req.query.limit) || 100;

        const cases = status
            ? await db.getCasesByStatus(status)
            : await db.query(`SELECT * FROM cases ORDER BY created_at DESC LIMIT ${limit}`).then(r => r.rows);

        res.json({
            success: true,
            count: cases.length,
            cases: cases
        });
    } catch (error) {
        console.error('Error fetching cases:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

/**
 * Get a single case with all details
 */
router.get('/cases/:caseId', async (req, res) => {
    try {
        const caseId = parseInt(req.params.caseId);
        const caseData = await db.getCaseById(caseId);

        if (!caseData) {
            return res.status(404).json({
                success: false,
                error: 'Case not found'
            });
        }

        // Get thread and messages
        const thread = await db.getThreadByCaseId(caseId);
        let messages = [];
        let analysis = null;

        if (thread) {
            messages = await db.getMessagesByThreadId(thread.id);

            // Get analysis for latest response
            const latestInbound = messages.filter(m => m.direction === 'inbound').pop();
            if (latestInbound) {
                analysis = await db.getAnalysisByMessageId(latestInbound.id);
            }
        }

        res.json({
            success: true,
            case: caseData,
            thread: thread,
            messages: messages,
            latest_analysis: analysis
        });
    } catch (error) {
        console.error('Error fetching case details:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

/**
 * Get email thread for a case
 */
router.get('/cases/:caseId/thread', async (req, res) => {
    try {
        const caseId = parseInt(req.params.caseId);
        const thread = await db.getThreadByCaseId(caseId);

        if (!thread) {
            return res.status(404).json({
                success: false,
                error: 'Thread not found'
            });
        }

        const messages = await db.getMessagesByThreadId(thread.id);

        res.json({
            success: true,
            thread: thread,
            messages: messages
        });
    } catch (error) {
        console.error('Error fetching thread:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

/**
 * Get pending auto-replies (for approval)
 */
router.get('/auto-replies/pending', async (req, res) => {
    try {
        const pending = await db.query(
            `SELECT ar.*, c.case_name, c.agency_name, m.subject, m.body_text as original_message
             FROM auto_reply_queue ar
             JOIN cases c ON ar.case_id = c.id
             JOIN messages m ON ar.message_id = m.id
             WHERE ar.status = 'pending' AND ar.requires_approval = true
             ORDER BY ar.created_at DESC`,
            []
        );

        res.json({
            success: true,
            count: pending.rows.length,
            pending_replies: pending.rows
        });
    } catch (error) {
        console.error('Error fetching pending auto-replies:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

/**
 * Approve an auto-reply
 */
router.post('/auto-replies/:id/approve', async (req, res) => {
    try {
        const replyId = parseInt(req.params.id);
        const reply = await db.query('SELECT * FROM auto_reply_queue WHERE id = $1', [replyId]);

        if (reply.rows.length === 0) {
            return res.status(404).json({
                success: false,
                error: 'Auto-reply not found'
            });
        }

        const replyData = reply.rows[0];
        const message = await db.getMessageById(replyData.message_id);
        const caseData = await db.getCaseById(replyData.case_id);

        // Queue the email
        await emailQueue.add('send-auto-reply', {
            type: 'auto_reply',
            caseId: replyData.case_id,
            toEmail: message.from_email,
            subject: message.subject,
            content: replyData.generated_reply,
            originalMessageId: message.message_id
        });

        // Update status
        await db.query(
            'UPDATE auto_reply_queue SET status = $1, approved_at = $2 WHERE id = $3',
            ['approved', new Date(), replyId]
        );

        res.json({
            success: true,
            message: 'Auto-reply approved and queued for sending'
        });
    } catch (error) {
        console.error('Error approving auto-reply:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

/**
 * Get recent activity
 */
router.get('/activity', async (req, res) => {
    try {
        const limit = parseInt(req.query.limit) || 50;
        const activity = await db.getRecentActivity(limit);

        res.json({
            success: true,
            count: activity.length,
            activity: activity
        });
    } catch (error) {
        console.error('Error fetching activity:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

/**
 * Test SendGrid configuration
 */
router.post('/test-sendgrid', async (req, res) => {
    try {
        const sendgridService = require('../services/sendgrid-service');

        // Check if env vars are set
        const config = {
            api_key_set: !!process.env.SENDGRID_API_KEY,
            from_email: process.env.SENDGRID_FROM_EMAIL || 'not set',
            from_name: process.env.SENDGRID_FROM_NAME || 'not set',
            test_email: process.env.DEFAULT_TEST_EMAIL || 'not set'
        };

        if (!process.env.SENDGRID_API_KEY) {
            return res.status(500).json({
                success: false,
                error: 'SENDGRID_API_KEY not set',
                config
            });
        }

        // Try sending a test email
        const sgMail = require('@sendgrid/mail');
        sgMail.setApiKey(process.env.SENDGRID_API_KEY);

        const msg = {
            to: req.body.to || process.env.DEFAULT_TEST_EMAIL || 'shadewofficial@gmail.com',
            from: process.env.SENDGRID_FROM_EMAIL || 'samuel@matcher.com',
            subject: 'Test Email from Railway - Autobot MVP',
            text: `This is a test email sent at ${new Date().toISOString()}`,
            html: `<p>This is a test email sent from Railway at ${new Date().toISOString()}</p>`
        };

        await sgMail.send(msg);

        res.json({
            success: true,
            message: 'Test email sent successfully',
            config,
            sent_to: msg.to
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message,
            details: error.response?.body || 'No details available'
        });
    }
});

/**
 * Get dashboard stats
 */
router.get('/stats', async (req, res) => {
    try {
        const stats = await db.query(`
            SELECT
                COUNT(*) FILTER (WHERE status = 'ready_to_send') as ready,
                COUNT(*) FILTER (WHERE status = 'sent') as sent,
                COUNT(*) FILTER (WHERE status = 'awaiting_response') as awaiting,
                COUNT(*) FILTER (WHERE status = 'responded') as responded,
                COUNT(*) FILTER (WHERE status = 'completed') as completed,
                COUNT(*) FILTER (WHERE days_overdue > 0) as overdue,
                COUNT(*) as total
            FROM cases
        `);

        const messageStats = await db.query(`
            SELECT
                COUNT(*) FILTER (WHERE direction = 'outbound') as sent,
                COUNT(*) FILTER (WHERE direction = 'inbound') as received
            FROM messages
            WHERE sent_at > NOW() - INTERVAL '30 days' OR received_at > NOW() - INTERVAL '30 days'
        `);

        res.json({
            success: true,
            cases: stats.rows[0],
            messages_last_30_days: messageStats.rows[0]
        });
    } catch (error) {
        console.error('Error fetching stats:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

/**
 * Test a portal (dry run - fills but doesn't submit)
 */
router.post('/test-portal', async (req, res) => {
    try {
        const { portalUrl, caseData } = req.body;

        if (!portalUrl) {
            return res.status(400).json({
                success: false,
                error: 'portalUrl is required'
            });
        }

        // Use default test case data if not provided
        const testCaseData = caseData || {
            case_name: 'Test FOIA Request',
            subject_name: 'John Doe',
            agency_name: 'Test Police Department',
            state: 'CA',
            incident_date: '2024-01-15',
            incident_location: '123 Main St, Test City',
            requested_records: ['Police report', 'Body cam footage'],
            additional_details: 'Test request for automation testing'
        };

        console.log(`Testing portal: ${portalUrl}`);
        const result = await portalService.testPortal(portalUrl, testCaseData, { dryRun: true });

        // Save screenshots to public folder and return URLs
        const fs = require('fs');
        const path = require('path');
        const screenshotUrls = {};

        if (result.screenshots) {
            const timestamp = Date.now();
            const publicDir = path.join(__dirname, '..', 'public', 'screenshots');

            // Create screenshots directory if it doesn't exist
            if (!fs.existsSync(publicDir)) {
                fs.mkdirSync(publicDir, { recursive: true });
            }

            if (result.screenshots.initial) {
                const filename = `portal-initial-${timestamp}.png`;
                const filepath = path.join(publicDir, filename);
                fs.writeFileSync(filepath, Buffer.from(result.screenshots.initial, 'base64'));
                screenshotUrls.initial = `/screenshots/${filename}`;
            }

            if (result.screenshots.filled) {
                const filename = `portal-filled-${timestamp}.png`;
                const filepath = path.join(publicDir, filename);
                fs.writeFileSync(filepath, Buffer.from(result.screenshots.filled, 'base64'));
                screenshotUrls.filled = `/screenshots/${filename}`;
            }
        }

        const responseResult = {
            url: result.url,
            success: result.success,
            fieldsFound: result.fieldsFound,
            fieldsFilled: result.fieldsFilled,
            submitButtonFound: result.submitButtonFound,
            submitButtonText: result.submitButtonText,
            fields: result.fields,
            dryRun: result.dryRun,
            screenshotUrls
        };

        res.json({
            success: result.success,
            result: responseResult
        });

    } catch (error) {
        console.error('Error testing portal:', error);
        res.status(500).json({
            success: false,
            error: error.message,
            stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
        });
    }
});

/**
 * Test portal with a case ID
 */
router.post('/test-portal/:caseId', async (req, res) => {
    try {
        const caseId = parseInt(req.params.caseId);
        const { portalUrl } = req.body;

        if (!portalUrl) {
            return res.status(400).json({
                success: false,
                error: 'portalUrl is required'
            });
        }

        const result = await portalService.submitToPortal(caseId, portalUrl, true);

        const responseResult = {
            ...result,
            screenshots: result.screenshots ? {
                hasInitial: !!result.screenshots.initial,
                hasFilled: !!result.screenshots.filled,
                note: 'Screenshots captured but not returned (too large for JSON)'
            } : null
        };

        res.json({
            success: result.success,
            result: responseResult
        });

    } catch (error) {
        console.error('Error testing portal with case:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

/**
 * Get adaptive learning insights for an agency
 */
router.get('/insights/:agency', async (req, res) => {
    try {
        const { agency } = req.params;
        const { state } = req.query;

        const insights = await adaptiveLearning.getInsightsReport(agency, state);

        res.json({
            success: true,
            insights
        });
    } catch (error) {
        console.error('Error getting insights:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

/**
 * Get all learning insights
 */
router.get('/insights', async (req, res) => {
    try {
        const result = await db.query(`
            SELECT
                agency_name,
                state,
                best_strategies,
                sample_size,
                last_updated
            FROM foia_learned_insights
            ORDER BY sample_size DESC
            LIMIT 50
        `);

        res.json({
            success: true,
            insights: result.rows
        });
    } catch (error) {
        console.error('Error getting all insights:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

/**
 * Get strategy performance dashboard
 */
router.get('/strategy-performance', async (req, res) => {
    try {
        const stats = await db.query(`
            SELECT
                COUNT(*) as total_cases,
                COUNT(CASE WHEN outcome_type = 'full_approval' THEN 1 END) as approvals,
                COUNT(CASE WHEN outcome_type = 'denial' THEN 1 END) as denials,
                AVG(CASE WHEN outcome_recorded THEN 1 ELSE 0 END) as completion_rate
            FROM cases
            WHERE strategy_used IS NOT NULL
        `);

        const topStrategies = await db.query(`
            SELECT
                strategy_config,
                outcome_type,
                COUNT(*) as count,
                AVG(outcome_score) as avg_score
            FROM foia_strategy_outcomes
            GROUP BY strategy_config, outcome_type
            ORDER BY avg_score DESC
            LIMIT 10
        `);

        res.json({
            success: true,
            stats: stats.rows[0],
            topStrategies: topStrategies.rows
        });
    } catch (error) {
        console.error('Error getting strategy performance:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

/**
 * KPI Dashboard - Get comprehensive metrics
 */
router.get('/dashboard/kpi', async (req, res) => {
    try {
        const metrics = await dashboardService.getKPIMetrics();

        res.json({
            success: true,
            metrics
        });
    } catch (error) {
        console.error('Error getting KPI metrics:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

/**
 * KPI Dashboard - Get latest bot messages
 */
router.get('/dashboard/messages', async (req, res) => {
    try {
        const limit = parseInt(req.query.limit) || 20;
        const messages = await dashboardService.getLatestBotMessages(limit);

        res.json({
            success: true,
            count: messages.length,
            messages
        });
    } catch (error) {
        console.error('Error getting latest messages:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

/**
 * KPI Dashboard - Get hourly activity
 */
router.get('/dashboard/hourly-activity', async (req, res) => {
    try {
        const activity = await dashboardService.getHourlyActivity();

        res.json({
            success: true,
            activity
        });
    } catch (error) {
        console.error('Error getting hourly activity:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

/**
 * Get queued messages (pending emails)
 * Shows what messages are waiting to be sent and when
 */
router.get('/queue/pending', async (req, res) => {
    try {
        // Import the existing queues instead of creating new connections
        const { emailQueue, generateQueue } = require('../queues/email-queue');

        if (!emailQueue || !generateQueue) {
            return res.json({
                success: true,
                total: 0,
                messages: [],
                queue_counts: {
                    generation: { active: 0, waiting: 0, delayed: 0 },
                    email: { active: 0, waiting: 0, delayed: 0 }
                },
                note: 'Queues not initialized'
            });
        }

        // Get all pending jobs from both queues
        const genActive = await generateQueue.getActive();
        const genWaiting = await generateQueue.getWaiting();
        const genDelayed = await generateQueue.getDelayed();

        const emailActive = await emailQueue.getActive();
        const emailWaiting = await emailQueue.getWaiting();
        const emailDelayed = await emailQueue.getDelayed();

        const queuedMessages = [];

        // Process generation queue jobs
        for (const job of [...genActive, ...genWaiting]) {
            const caseData = await db.getCaseById(job.data.caseId);
            queuedMessages.push({
                id: job.id,
                queue: 'generation',
                status: await job.getState(),
                type: 'Generating FOIA Request',
                case_id: job.data.caseId,
                case_name: caseData?.case_name || 'Unknown',
                to: caseData?.agency_email || 'Unknown',
                subject: `Public Records Request - ${caseData?.subject_name || 'Unknown'}`,
                scheduled_for: new Date(job.timestamp + (job.delay || 0)),
                delay_seconds: 0,
                progress: job.progress || 0
            });
        }

        // Process email queue jobs (these have delays for auto-replies)
        for (const job of [...emailActive, ...emailWaiting, ...emailDelayed]) {
            const state = await job.getState();
            const scheduledTime = new Date(job.timestamp + (job.opts?.delay || 0));
            const now = new Date();
            const delaySeconds = Math.max(0, Math.floor((scheduledTime - now) / 1000));

            // Get case data if available
            let caseData = null;
            if (job.data.caseId) {
                caseData = await db.getCaseById(job.data.caseId);
            }

            let messageType = 'Email';
            if (job.data.type === 'initial_request') messageType = 'Initial FOIA Request';
            else if (job.data.type === 'auto_reply') messageType = 'Auto-Reply';
            else if (job.data.type === 'follow_up') messageType = 'Follow-Up';

            queuedMessages.push({
                id: job.id,
                queue: 'email',
                status: state,
                type: messageType,
                case_id: job.data.caseId,
                case_name: caseData?.case_name || 'Unknown',
                to: job.data.toEmail,
                subject: job.data.subject,
                scheduled_for: scheduledTime,
                delay_seconds: delaySeconds,
                is_test_mode: job.data.subject?.includes('[TEST]') || false,
                progress: job.progress || 0
            });
        }

        // Sort by scheduled time
        queuedMessages.sort((a, b) => new Date(a.scheduled_for) - new Date(b.scheduled_for));

        res.json({
            success: true,
            total: queuedMessages.length,
            messages: queuedMessages,
            queue_counts: {
                generation: {
                    active: genActive.length,
                    waiting: genWaiting.length,
                    delayed: genDelayed.length
                },
                email: {
                    active: emailActive.length,
                    waiting: emailWaiting.length,
                    delayed: emailDelayed.length
                }
            }
        });
    } catch (error) {
        console.error('Error getting queue status:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

/**
 * Resend a case (queue it for generation and sending)
 * POST /api/cases/:caseId/resend
 */
router.post('/cases/:caseId/resend', async (req, res) => {
    try {
        const { caseId } = req.params;

        // Get the case
        const caseData = await db.getCaseById(caseId);

        if (!caseData) {
            return res.status(404).json({
                success: false,
                error: `Case ${caseId} not found`
            });
        }

        // Queue for generation and sending
        await generateQueue.add('generate-foia', {
            caseId: parseInt(caseId)
        });

        console.log(`Queued case ${caseId} (${caseData.case_name}) for resend`);

        res.json({
            success: true,
            message: `Case ${caseId} queued for resend`,
            case: {
                id: caseData.id,
                case_name: caseData.case_name,
                agency_email: caseData.agency_email
            }
        });
    } catch (error) {
        console.error('Error resending case:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

module.exports = router;
