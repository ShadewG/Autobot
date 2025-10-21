const express = require('express');
const router = express.Router();
const db = require('../services/database');
const notionService = require('../services/notion-service');
const portalService = require('../services/portal-service');
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

module.exports = router;
