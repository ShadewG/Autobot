const express = require('express');
const router = express.Router();
const db = require('../services/database');
const notionService = require('../services/notion-service');
const portalService = require('../services/portal-service-test-only');
const dashboardService = require('../services/dashboard-service');
const { generateQueue, emailQueue } = require('../queues/email-queue');
const { buildRealCaseWhereClause } = require('../utils/analytics-test-filter');

const RETIRED_ADAPTIVE_LEARNING_MESSAGE =
    'AdaptiveLearningService has been retired. Use decision memory and successful examples instead.';
const REAL_CASES_WHERE = buildRealCaseWhereClause('c');

function formatSyncedCasesResponse(cases) {
    return {
        success: true,
        synced: cases.length,
        cases: cases.map(c => ({
            id: c.id,
            case_name: c.case_name,
            agency: c.agency_name
        }))
    };
}

async function syncNotionCasesByStatus(status = 'Ready to Send') {
    const cases = await notionService.syncCasesFromNotion(status);
    return formatSyncedCasesResponse(cases);
}

async function syncSingleNotionPage(pageId) {
    if (!pageId) {
        const error = new Error('pageId is required');
        error.status = 400;
        throw error;
    }

    const caseData = await notionService.processSinglePage(pageId);

    await generateQueue.add('generate-and-send', {
        caseId: caseData.id
    });

    return {
        success: true,
        message: 'Case imported and queued for processing',
        case: {
            id: caseData.id,
            case_name: caseData.case_name,
            agency_name: caseData.agency_name,
            status: caseData.status
        },
        delay_minutes: Math.round(Math.random() * 8) + 2
    };
}

function buildRetiredAdaptiveLearningResponse(overrides = {}) {
    return {
        success: true,
        deprecated: true,
        message: RETIRED_ADAPTIVE_LEARNING_MESSAGE,
        ...overrides,
    };
}

/**
 * Canonical Notion sync endpoint for both bulk sync and single-page "Sync Now".
 * - Send `pageId` to import one specific Notion page immediately.
 * - Omit `pageId` to run the existing bulk sync by status.
 */
router.post('/notion/sync', async (req, res) => {
    try {
        if (req.body.pageId) {
            return res.json(await syncSingleNotionPage(req.body.pageId));
        }

        return res.json(await syncNotionCasesByStatus(req.body.status || 'Ready to Send'));
    } catch (error) {
        console.error('Error syncing from Notion:', error);
        res.status(error.status || 500).json({
            success: false,
            error: error.message
        });
    }
});

/**
 * Legacy bulk Notion sync endpoint kept for compatibility.
 */
router.post('/sync/notion', async (req, res) => {
    try {
        res.json(await syncNotionCasesByStatus(req.body.status || 'Ready to Send'));
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
 * Legacy single-page Notion sync endpoint kept for compatibility.
 * IMPORTANT: This must come BEFORE the :caseId route
 */
router.post('/process/notion-page', async (req, res) => {
    try {
        res.json(await syncSingleNotionPage(req.body.pageId));
    } catch (error) {
        console.error('Error processing Notion page:', error);
        res.status(error.status || 500).json({
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
 * Get recent agent decisions feed
 */
router.get('/agent/decisions', async (req, res) => {
    try {
        const limit = Math.min(parseInt(req.query.limit) || 25, 100);
        const decisions = await db.getRecentAgentDecisions(limit);

        res.json({
            success: true,
            count: decisions.length,
            decisions
        });
    } catch (error) {
        console.error('Error fetching agent decisions:', error);
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
            const latestInbound = messages.find(m => m.direction === 'inbound') || null;
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

        // Use foib-request.com - this is where Inbound Parse is configured
        const fromEmail = 'requests@foib-request.com';
        const fromName = 'FOIA Request Team';

        // Check if env vars are set
        const config = {
            api_key_set: !!process.env.SENDGRID_API_KEY,
            from_email: fromEmail,
            from_name: fromName,
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
            from: { email: fromEmail, name: fromName },
            replyTo: fromEmail,
            subject: '[TEST] Email from Autobot - Reply to test inbound',
            text: `This is a test email sent at ${new Date().toISOString()}\n\nReply to this email to test inbound webhook detection.`,
            html: `<p>This is a test email sent at ${new Date().toISOString()}</p><p><strong>Reply to this email</strong> to test inbound webhook detection.</p>`
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
        res.json(buildRetiredAdaptiveLearningResponse({
            agency,
            state: state || null,
            insights: [],
        }));
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
        res.json(buildRetiredAdaptiveLearningResponse({
            insights: [],
        }));
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
        res.json(buildRetiredAdaptiveLearningResponse({
            stats: {
                total_cases: 0,
                approvals: 0,
                denials: 0,
                completion_rate: 0,
            },
            topStrategies: [],
        }));
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
 * Cost Tracking — AI + email costs per case
 */
router.get('/dashboard/costs', async (req, res) => {
    try {
        // Model pricing (per 1M tokens) — approximate
        const MODEL_COSTS = {
            'gpt-4o': { input: 2.5, output: 10 },
            'gpt-4o-mini': { input: 0.15, output: 0.6 },
            'gpt-4.1': { input: 2, output: 8 },
            'gpt-4.1-mini': { input: 0.4, output: 1.6 },
            'gpt-5.2': { input: 2, output: 8 },
            'o3-mini': { input: 1.1, output: 4.4 },
            'claude-3-5-sonnet': { input: 3, output: 15 },
            'claude-sonnet-4-20250514': { input: 3, output: 15 },
        };

        const [aiCosts, perCase] = await Promise.all([
            // Aggregate AI costs from proposals + response_analysis
            db.query(`
                WITH ai_usage AS (
                    SELECT model_id, prompt_tokens, completion_tokens, 'classify' as step
                    FROM response_analysis ra
                    JOIN messages m ON m.id = ra.message_id
                    JOIN cases c ON c.id = m.case_id
                    WHERE ra.model_id IS NOT NULL AND ra.prompt_tokens IS NOT NULL
                      AND ${REAL_CASES_WHERE}
                    UNION ALL
                    SELECT decision_model_id as model_id, decision_prompt_tokens as prompt_tokens,
                           decision_completion_tokens as completion_tokens, 'decide' as step
                    FROM proposals p
                    JOIN cases c ON c.id = p.case_id
                    WHERE p.decision_model_id IS NOT NULL AND p.decision_prompt_tokens IS NOT NULL
                      AND ${REAL_CASES_WHERE}
                    UNION ALL
                    SELECT draft_model_id as model_id, draft_prompt_tokens as prompt_tokens,
                           draft_completion_tokens as completion_tokens, 'draft' as step
                    FROM proposals p
                    JOIN cases c ON c.id = p.case_id
                    WHERE p.draft_model_id IS NOT NULL AND p.draft_prompt_tokens IS NOT NULL
                      AND ${REAL_CASES_WHERE}
                )
                SELECT
                    COALESCE(model_id, 'unknown') as model,
                    step,
                    COUNT(*) as calls,
                    SUM(COALESCE(prompt_tokens, 0)) as total_input_tokens,
                    SUM(COALESCE(completion_tokens, 0)) as total_output_tokens
                FROM ai_usage
                GROUP BY model_id, step
                ORDER BY total_input_tokens DESC
            `),
            // Per-case cost (top 20 most expensive)
            db.query(`
                WITH case_tokens AS (
                    SELECT c.id, c.case_name, c.agency_name,
                        COALESCE(SUM(ra.prompt_tokens), 0) + COALESCE(SUM(p.decision_prompt_tokens), 0) + COALESCE(SUM(p.draft_prompt_tokens), 0) as input_tokens,
                        COALESCE(SUM(ra.completion_tokens), 0) + COALESCE(SUM(p.decision_completion_tokens), 0) + COALESCE(SUM(p.draft_completion_tokens), 0) as output_tokens
                    FROM cases c
                    LEFT JOIN messages m ON m.case_id = c.id AND m.direction = 'inbound'
                    LEFT JOIN response_analysis ra ON ra.message_id = m.id AND ra.prompt_tokens IS NOT NULL
                    LEFT JOIN proposals p ON p.case_id = c.id AND (p.decision_prompt_tokens IS NOT NULL OR p.draft_prompt_tokens IS NOT NULL)
                    WHERE ${REAL_CASES_WHERE}
                    GROUP BY c.id, c.case_name, c.agency_name
                    HAVING COALESCE(SUM(ra.prompt_tokens), 0) + COALESCE(SUM(p.decision_prompt_tokens), 0) + COALESCE(SUM(p.draft_prompt_tokens), 0) > 0
                )
                SELECT * FROM case_tokens ORDER BY input_tokens + output_tokens DESC LIMIT 20
            `)
        ]);

        // Compute dollar costs
        function estimateCost(model, inputTokens, outputTokens) {
            // Try to find a matching model
            const key = Object.keys(MODEL_COSTS).find(k => (model || '').toLowerCase().includes(k));
            const rates = key ? MODEL_COSTS[key] : { input: 2, output: 8 }; // default to ~gpt-4 rates
            return ((inputTokens / 1e6) * rates.input) + ((outputTokens / 1e6) * rates.output);
        }

        let totalCost = 0;
        const byModel = aiCosts.rows.map(row => {
            const cost = estimateCost(row.model, Number(row.total_input_tokens), Number(row.total_output_tokens));
            totalCost += cost;
            return {
                model: row.model,
                step: row.step,
                calls: Number(row.calls),
                input_tokens: Number(row.total_input_tokens),
                output_tokens: Number(row.total_output_tokens),
                estimated_cost: Math.round(cost * 100) / 100,
            };
        });

        const topCases = perCase.rows.map(row => ({
            case_id: row.id,
            case_name: row.case_name,
            agency_name: row.agency_name,
            input_tokens: Number(row.input_tokens),
            output_tokens: Number(row.output_tokens),
            estimated_cost: Math.round(estimateCost(null, Number(row.input_tokens), Number(row.output_tokens)) * 100) / 100,
        }));

        res.json({
            success: true,
            total_estimated_cost: Math.round(totalCost * 100) / 100,
            by_model: byModel,
            top_cases: topCases,
        });
    } catch (error) {
        console.error('Error getting cost data:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * Compliance Report — correct statute, deadlines, and custodian per state
 */
router.get('/dashboard/compliance', async (req, res) => {
    try {
        const [byState, overdue, missingCustodian] = await Promise.all([
            // Per-state compliance: cases sent, deadline met rate, avg days to respond vs statutory limit
            db.query(`
                SELECT
                    COALESCE(c.state, 'Unknown') AS state,
                    sd.response_days AS statutory_days,
                    sd.statute_citation,
                    COUNT(*)::int AS total_cases,
                    COUNT(*) FILTER (WHERE c.status = 'completed')::int AS completed,
                    COUNT(*) FILTER (WHERE c.status = 'denied')::int AS denied,
                    COUNT(*) FILTER (
                        WHERE c.last_response_date IS NOT NULL
                          AND c.send_date IS NOT NULL
                          AND c.deadline_date IS NOT NULL
                          AND c.last_response_date <= c.deadline_date
                    )::int AS responded_on_time,
                    COUNT(*) FILTER (
                        WHERE c.last_response_date IS NOT NULL
                          AND c.send_date IS NOT NULL
                          AND c.deadline_date IS NOT NULL
                          AND c.last_response_date > c.deadline_date
                    )::int AS responded_late,
                    AVG(CASE WHEN c.last_response_date IS NOT NULL AND c.send_date IS NOT NULL
                        THEN EXTRACT(EPOCH FROM (c.last_response_date - c.send_date)) / 86400
                        END)::int AS avg_response_days
                FROM cases c
                LEFT JOIN state_deadlines sd ON sd.state_code = c.state
                WHERE c.state IS NOT NULL
                  AND ${REAL_CASES_WHERE}
                  AND c.status NOT IN ('draft', 'cancelled')
                GROUP BY c.state, sd.response_days, sd.statute_citation
                HAVING COUNT(*) >= 2
                ORDER BY COUNT(*) DESC
            `),
            // Currently overdue cases
            db.query(`
                SELECT COUNT(*)::int AS count
                FROM cases
                WHERE deadline_date IS NOT NULL
                  AND ${buildRealCaseWhereClause('cases')}
                  AND deadline_date < NOW()
                  AND last_response_date IS NULL
                  AND status NOT IN ('completed', 'closed', 'denied', 'cancelled', 'withdrawn', 'draft')
            `),
            // Cases missing custodian/agency info
            db.query(`
                SELECT COUNT(*)::int AS count
                FROM cases
                WHERE (agency_email IS NULL OR agency_email = '')
                  AND ${buildRealCaseWhereClause('cases')}
                  AND (portal_url IS NULL OR portal_url = '')
                  AND status NOT IN ('completed', 'closed', 'denied', 'cancelled', 'withdrawn', 'draft')
            `),
        ]);

        const states = byState.rows.map(row => {
            const total = row.responded_on_time + row.responded_late;
            return {
                state: row.state,
                statutory_days: row.statutory_days,
                statute_citation: row.statute_citation,
                total_cases: row.total_cases,
                completed: row.completed,
                denied: row.denied,
                responded_on_time: row.responded_on_time,
                responded_late: row.responded_late,
                compliance_rate: total > 0 ? Math.round((row.responded_on_time / total) * 100) : null,
                avg_response_days: row.avg_response_days,
            };
        });

        res.json({
            success: true,
            states,
            overdue_count: overdue.rows[0]?.count || 0,
            missing_custodian_count: missingCustodian.rows[0]?.count || 0,
        });
    } catch (error) {
        console.error('Error getting compliance data:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * Case Outcomes — records received rate, avg time, denial rate by state
 */
router.get('/dashboard/outcomes', async (req, res) => {
    try {
        const [overall, byState, denialReasons, statusBreakdown] = await Promise.all([
            // Overall outcome metrics
            db.query(`
                SELECT
                    COUNT(*) as total_cases,
                    COUNT(*) FILTER (WHERE status = 'completed') as completed,
                    COUNT(*) FILTER (WHERE status IN ('sent', 'responded', 'completed')) as active,
                    COUNT(*) FILTER (WHERE status = 'sent') as awaiting_response,
                    ROUND(COUNT(*) FILTER (WHERE status = 'completed')::numeric * 100 /
                        NULLIF(COUNT(*), 0), 1) as completion_rate,
                    ROUND(AVG(EXTRACT(EPOCH FROM (last_response_date - send_date)) / 86400)
                        FILTER (WHERE last_response_date IS NOT NULL AND send_date IS NOT NULL)::numeric, 1)
                        as avg_response_days,
                    ROUND(AVG(EXTRACT(EPOCH FROM (updated_at - created_at)) / 86400)
                        FILTER (WHERE status = 'completed')::numeric, 1)
                        as avg_case_duration_days
                FROM cases
                WHERE ${buildRealCaseWhereClause('cases')}
            `),
            // Outcomes by state
            db.query(`
                SELECT
                    COALESCE(c.state, 'Unknown') as state,
                    COUNT(*) as total,
                    COUNT(*) FILTER (WHERE c.status = 'completed') as completed,
                    COUNT(*) FILTER (WHERE c.status = 'sent') as awaiting,
                    ROUND(AVG(EXTRACT(EPOCH FROM (c.last_response_date - c.send_date)) / 86400)
                        FILTER (WHERE c.last_response_date IS NOT NULL AND c.send_date IS NOT NULL)::numeric, 1)
                        as avg_response_days,
                    (SELECT COUNT(*) FROM response_analysis ra
                        JOIN messages m ON ra.message_id = m.id
                        WHERE m.case_id = ANY(ARRAY_AGG(c.id)) AND LOWER(ra.intent) = 'denial') as denials
                FROM cases c
                WHERE c.state IS NOT NULL AND c.state != ''
                  AND ${REAL_CASES_WHERE}
                GROUP BY c.state
                HAVING COUNT(*) >= 2
                ORDER BY total DESC
                LIMIT 20
            `),
            // Denial reason breakdown
            db.query(`
                SELECT
                    COALESCE(full_analysis_json->>'denial_subtype', 'unspecified') as reason,
                    COUNT(*) as count
                FROM response_analysis ra
                JOIN messages m ON m.id = ra.message_id
                JOIN cases c ON c.id = m.case_id
                WHERE LOWER(ra.intent) = 'denial'
                  AND ${REAL_CASES_WHERE}
                GROUP BY full_analysis_json->>'denial_subtype'
                ORDER BY count DESC
            `),
            // Status funnel
            db.query(`
                SELECT status, COUNT(*) as count
                FROM cases
                WHERE ${buildRealCaseWhereClause('cases')}
                GROUP BY status
                ORDER BY count DESC
            `)
        ]);

        res.json({
            success: true,
            overall: overall.rows[0],
            byState: byState.rows,
            denialReasons: denialReasons.rows,
            statusBreakdown: statusBreakdown.rows,
        });
    } catch (error) {
        console.error('Error getting case outcomes:', error);
        res.status(500).json({ success: false, error: error.message });
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
 * KPI Dashboard - Get daily message volume (inbound vs outbound, last 30 days)
 */
router.get('/dashboard/message-volume', async (req, res) => {
    try {
        const volume = await dashboardService.getMessageVolumeByDay();
        res.json({ success: true, ...volume });
    } catch (error) {
        console.error('Error getting message volume:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

async function handleDepartmentAnalyticsRequest(req, res) {
    try {
        const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 10, 1), 50);
        const minCases = Math.min(
            Math.max(parseInt(req.query.minCases || req.query.min_cases, 10) || 5, 1),
            100
        );
        const minReviews = Math.min(
            Math.max(parseInt(req.query.minReviews || req.query.min_reviews, 10) || 3, 1),
            100
        );

        const analytics = await dashboardService.getDepartmentAnalytics({
            limit,
            minCases,
            minReviews,
        });

        res.json({
            success: true,
            ...analytics,
        });
    } catch (error) {
        console.error('Error getting department analytics:', error);
        res.status(500).json({ success: false, error: error.message });
    }
}

/**
 * GET /api/dashboard/departments
 * Canonical per-department analytics leaderboards for the analytics dashboard.
 */
router.get('/dashboard/departments', handleDepartmentAnalyticsRequest);

/**
 * Legacy alias kept for compatibility while the frontend migrates.
 */
router.get('/dashboard/agency-leaderboard', handleDepartmentAnalyticsRequest);

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
