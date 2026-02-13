const express = require('express');
const router = express.Router();
const db = require('../services/database');
const sgMail = require('@sendgrid/mail');
const { enqueueInboundMessageJob, enqueueResumeRunJob } = require('../queues/agent-queue');
const { portalQueue } = require('../queues/email-queue');
const crypto = require('crypto');
const { normalizePortalUrl, isSupportedPortalUrl, detectPortalProviderByUrl } = require('../utils/portal-utils');
const { eventBus, notify } = require('../services/event-bus');
const pdContactService = require('../services/pd-contact-service');

// Initialize SendGrid
if (process.env.SENDGRID_API_KEY) {
    sgMail.setApiKey(process.env.SENDGRID_API_KEY);
}

function deriveMessageSource(message) {
    if (!message) return 'unknown';
    if (message.message_type === 'manual_trigger') return 'manual trigger clone';
    if (message.message_type === 'simulated_inbound') return 'simulated inbound';
    if ((message.message_id || '').startsWith('monitor:')) return 'manual trigger clone';
    return 'webhook inbound';
}

async function queueInboundRunForMessage(message, { autopilotMode = 'SUPERVISED', force_new_run = false } = {}) {
    const caseData = message.case_id ? await db.getCaseById(message.case_id) : null;
    if (!caseData) {
        throw new Error('Message is not associated with a case');
    }

    const existingRun = await db.getActiveRunForCase(caseData.id);
    if (existingRun) {
        if (!force_new_run) {
            const err = new Error('Case already has an active agent run');
            err.status = 409;
            err.payload = {
                activeRun: {
                    id: existingRun.id,
                    status: existingRun.status,
                    trigger_type: existingRun.trigger_type,
                    started_at: existingRun.started_at
                }
            };
            throw err;
        }

        await db.query(`
            UPDATE agent_runs
            SET status = 'failed',
                ended_at = NOW(),
                error = 'Cancelled by monitor trigger force_new_run'
            WHERE id = $1
        `, [existingRun.id]);
    }

    const run = await db.createAgentRunFull({
        case_id: caseData.id,
        trigger_type: 'inbound_message',
        status: 'queued',
        message_id: message.id,
        autopilot_mode: autopilotMode,
        langgraph_thread_id: `case:${caseData.id}:msg-${message.id}`
    });

    const job = await enqueueInboundMessageJob(run.id, caseData.id, message.id, {
        autopilotMode,
        threadId: run.langgraph_thread_id
    });

    return {
        caseData,
        run,
        job
    };
}

async function processProposalDecision(proposalId, action, { instruction = null, reason = null, route_mode = null, decidedBy = 'monitor' } = {}) {
    const allowedActions = ['APPROVE', 'ADJUST', 'DISMISS'];
    if (!allowedActions.includes(action)) {
        const err = new Error(`action must be one of: ${allowedActions.join(', ')}`);
        err.status = 400;
        throw err;
    }

    const proposal = await db.getProposalById(proposalId);
    if (!proposal) {
        const err = new Error(`Proposal ${proposalId} not found`);
        err.status = 404;
        throw err;
    }

    if (proposal.status !== 'PENDING_APPROVAL') {
        const err = new Error(`Proposal is not pending approval`);
        err.status = 409;
        err.payload = { current_status: proposal.status };
        throw err;
    }

    const caseId = proposal.case_id;
    const existingRun = await db.getActiveRunForCase(caseId);
    if (existingRun) {
        if (existingRun.status === 'paused') {
            await db.updateAgentRun(existingRun.id, {
                status: 'completed',
                ended_at: new Date()
            });
        } else {
            const err = new Error('Case already has an active agent run');
            err.status = 409;
            err.payload = {
                activeRun: {
                    id: existingRun.id,
                    status: existingRun.status,
                    trigger_type: existingRun.trigger_type
                }
            };
            throw err;
        }
    }

    const humanDecision = {
        action,
        proposalId,
        instruction,
        route_mode,
        reason,
        decidedAt: new Date().toISOString(),
        decidedBy
    };

    if (action === 'DISMISS') {
        await db.updateProposal(proposalId, {
            human_decision: humanDecision,
            status: 'DISMISSED'
        });

        // Auto-learn from dismissal so AI doesn't repeat the same mistake
        try {
            const decisionMemory = require('../services/decision-memory-service');
            const caseData = await db.getCaseById(caseId);
            await decisionMemory.learnFromOutcome({
                category: 'general',
                triggerPattern: `dismissed ${proposal.action_type} for ${caseData?.agency_name || 'unknown agency'}`,
                lesson: `Do not propose ${proposal.action_type} for case #${caseId} (${caseData?.case_name || 'unknown'}) — it was dismissed by human reviewer.${reason ? ' Reason: ' + reason : ''}`,
                sourceCaseId: caseId,
                priority: 6
            });
        } catch (_) {}

        notify('info', `Proposal dismissed for case ${caseId}`, { case_id: caseId });
        return {
            success: true,
            message: 'Proposal dismissed',
            proposal_id: proposalId,
            action
        };
    }

    await db.updateProposal(proposalId, {
        human_decision: humanDecision,
        status: 'DECISION_RECEIVED'
    });

    const run = await db.createAgentRunFull({
        case_id: caseId,
        trigger_type: 'resume',
        status: 'queued',
        autopilot_mode: proposal.autopilot_mode || 'SUPERVISED',
        langgraph_thread_id: `resume:${caseId}:proposal-${proposalId}`
    });

    const job = await enqueueResumeRunJob(run.id, caseId, humanDecision, {
        isInitialRequest: proposal.action_type === 'SEND_INITIAL_REQUEST',
        originalProposalId: proposalId
    });

    notify('info', `Proposal ${action.toLowerCase()} — resume queued for case ${caseId}`, { case_id: caseId });
    return {
        success: true,
        message: 'Decision received, resume queued',
        run: { id: run.id, status: run.status },
        proposal_id: proposalId,
        action,
        job_id: job.id
    };
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
        const userIdParam = req.query.user_id;
        const userId = userIdParam && userIdParam !== 'unowned' ? parseInt(userIdParam, 10) || null : null;
        const unownedOnly = userIdParam === 'unowned';

        // Build user filter clause for messages (via cases)
        const userJoin = (userId || unownedOnly)
            ? 'INNER JOIN email_threads t2 ON m.thread_id = t2.id INNER JOIN cases c2 ON t2.case_id = c2.id'
            : '';
        const userWhere = userId ? `AND c2.user_id = ${userId}`
            : unownedOnly ? 'AND c2.user_id IS NULL' : '';

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
                c.agency_email,
                c.portal_url,
                c.status as case_status
            FROM messages m
            LEFT JOIN email_threads t ON m.thread_id = t.id
            LEFT JOIN cases c ON t.case_id = c.id
            ${userId || unownedOnly ? `WHERE EXISTS (SELECT 1 FROM email_threads t2 JOIN cases c2 ON t2.case_id = c2.id WHERE t2.id = m.thread_id ${userWhere})` : ''}
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
                COUNT(*) FILTER (WHERE m.direction = 'inbound') as inbound_total,
                COUNT(*) FILTER (WHERE m.direction = 'outbound') as outbound_total
            FROM messages m
            ${userId || unownedOnly ? `WHERE EXISTS (SELECT 1 FROM email_threads t2 JOIN cases c2 ON t2.case_id = c2.id WHERE t2.id = m.thread_id ${userWhere})` : ''}
        `);
        const counts = countsResult.rows[0];

        // Get recent activity logs
        const activityResult = await db.query(`
            SELECT
                al.id,
                al.event_type,
                al.case_id,
                al.message_id,
                al.description,
                al.metadata,
                al.created_at
            FROM activity_log al
            ${userId || unownedOnly ? `LEFT JOIN cases c3 ON al.case_id = c3.id WHERE (al.case_id IS NULL OR ${userId ? `c3.user_id = ${userId}` : 'c3.user_id IS NULL'})` : ''}
            ORDER BY al.created_at DESC
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
        const caseUserWhere = userId ? `WHERE user_id = ${userId}` : unownedOnly ? 'WHERE user_id IS NULL' : '';
        const statsResult = await db.query(`
            SELECT
                status,
                COUNT(*) as count
            FROM cases
            ${caseUserWhere}
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
                m.received_at,
                m.created_at,
                c.id as case_id,
                c.case_name,
                c.agency_name,
                c.agency_email,
                c.portal_url,
                ra.intent,
                ra.sentiment,
                ra.suggested_action
            FROM messages m
            LEFT JOIN email_threads t ON m.thread_id = t.id
            LEFT JOIN cases c ON t.case_id = c.id
            LEFT JOIN response_analysis ra ON ra.message_id = m.id
            WHERE m.direction = 'inbound'
            ${userFilter}
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
                c.agency_name,
                c.agency_email,
                c.portal_url
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
// =========================================================================
// AI Decision Lessons (experience memory)
// =========================================================================

router.get('/lessons', async (req, res) => {
    try {
        const decisionMemory = require('../services/decision-memory-service');
        const lessons = await decisionMemory.listLessons({ activeOnly: req.query.active !== 'false' });
        res.json({ success: true, lessons });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

router.post('/lessons', async (req, res) => {
    try {
        const decisionMemory = require('../services/decision-memory-service');
        const { category, trigger_pattern, lesson, priority } = req.body;
        if (!category || !trigger_pattern || !lesson) {
            return res.status(400).json({ success: false, error: 'category, trigger_pattern, and lesson are required' });
        }
        const created = await decisionMemory.addManualLesson({
            category, triggerPattern: trigger_pattern, lesson, priority: priority || 7
        });
        res.json({ success: true, lesson: created });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

router.put('/lessons/:id', async (req, res) => {
    try {
        const decisionMemory = require('../services/decision-memory-service');
        const updated = await decisionMemory.updateLesson(parseInt(req.params.id), req.body);
        res.json({ success: true, lesson: updated });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * POST /api/monitor/lessons/parse
 * AI-powered: translate natural language into a structured lesson
 */
router.post('/lessons/parse', express.json(), async (req, res) => {
    try {
        const { text } = req.body;
        if (!text || !text.trim()) {
            return res.status(400).json({ success: false, error: 'text is required' });
        }

        const Anthropic = require('@anthropic-ai/sdk');
        const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

        const response = await anthropic.messages.create({
            model: process.env.CLAUDE_MODEL || 'claude-sonnet-4-20250514',
            max_tokens: 1000,
            system: `You translate natural language instructions into structured AI decision lessons for a FOIA (Freedom of Information Act) case management system.

The system processes agency responses and decides actions. Lessons teach the AI how to handle specific situations.

Available action types (use the CODE, not the label):
- SEND_INITIAL_REQUEST — Send the first FOIA request to an agency
- SEND_FOLLOWUP — Send a follow-up when no response received
- SEND_REBUTTAL — Challenge a denial with legal arguments
- SEND_CLARIFICATION — Respond to agency asking for more info
- RESPOND_PARTIAL_APPROVAL — Accept released records + challenge withheld ones
- ACCEPT_FEE — Agree to pay a quoted fee
- NEGOTIATE_FEE — Counter-offer or request fee waiver
- DECLINE_FEE — Reject fee and explain why
- ESCALATE — Flag for human review
- RESEARCH_AGENCY — Find the correct agency/contact info
- REFORMULATE_REQUEST — Rewrite the request differently
- SUBMIT_PORTAL — Submit via an online portal instead of email
- CLOSE_CASE — Mark case as done
- WITHDRAW — Cancel/withdraw the request
- NONE — No action needed

Available categories: denial, portal, fee, followup, agency, general

Available denial subtypes: no_records, ongoing_investigation, privacy_exemption, overly_broad, excessive_fees, wrong_agency, retention_expired, format_issue

Respond with ONLY a JSON object:
{
  "category": "one of: denial, portal, fee, followup, agency, general",
  "trigger_pattern": "space-separated keywords that would match this scenario",
  "lesson": "Precise instruction for the AI, referencing the action type code. e.g. 'When agency cites ongoing investigation exemption, propose SEND_REBUTTAL requesting segregable non-exempt portions under state FOIA law.'",
  "priority": 1-10 (10 = highest, default 7),
  "recommended_action": "the primary ACTION_TYPE code this lesson recommends"
}`,
            messages: [{ role: 'user', content: text.trim() }]
        });

        const raw = response.content[0].text.trim();
        // Extract JSON from response (handle markdown code blocks)
        const jsonMatch = raw.match(/\{[\s\S]*\}/);
        if (!jsonMatch) {
            return res.status(422).json({ success: false, error: 'AI could not parse the lesson', raw });
        }

        const parsed = JSON.parse(jsonMatch[0]);
        res.json({ success: true, parsed });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

router.delete('/lessons/:id', async (req, res) => {
    try {
        const decisionMemory = require('../services/decision-memory-service');
        await decisionMemory.deleteLesson(parseInt(req.params.id));
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

router.get('/config', async (req, res) => {
    let queue = { generation: {}, email: {} };
    try {
        const { generateQueue, emailQueue } = require('../queues/email-queue');
        if (generateQueue) {
            const [active, waiting, delayed] = await Promise.all([
                generateQueue.getActiveCount(),
                generateQueue.getWaitingCount(),
                generateQueue.getDelayedCount()
            ]);
            queue.generation = { active, waiting, delayed };
        }
        if (emailQueue) {
            const [active, waiting, delayed] = await Promise.all([
                emailQueue.getActiveCount(),
                emailQueue.getWaitingCount(),
                emailQueue.getDelayedCount()
            ]);
            queue.email = { active, waiting, delayed };
        }
    } catch (e) {
        // Ignore queue fetch errors for UI config
    }

    res.json({
        from_email: 'requests@foib-request.com',
        from_name: 'FOIA Request Team',
        sendgrid_configured: !!process.env.SENDGRID_API_KEY,
        inbound_webhook: '/webhooks/inbound',
        inbound_domains: ['foib-request.com', 'foia.foib-request.com', 'c.foib-request.com'],
        execution_mode: 'LIVE',
        shadow_mode: false,
        default_autopilot_mode: 'SUPERVISED',
        require_human_approval: true,
        queue
    });
});

/**
 * GET /api/monitor/live-overview
 * Operational summary focused on missed routing / missed response paths.
 */
router.get('/live-overview', async (req, res) => {
    try {
        const limit = Math.min(parseInt(req.query.limit, 10) || 25, 100);
        const userIdParam = req.query.user_id;
        const userId = userIdParam && userIdParam !== 'unowned' ? parseInt(userIdParam, 10) || null : null;
        const unownedOnly = userIdParam === 'unowned';

        const msgUserFilter = userId
            ? `AND EXISTS (SELECT 1 FROM email_threads t2 JOIN cases c2 ON t2.case_id = c2.id WHERE t2.id = m.thread_id AND c2.user_id = ${userId})`
            : unownedOnly
                ? `AND EXISTS (SELECT 1 FROM email_threads t2 JOIN cases c2 ON t2.case_id = c2.id WHERE t2.id = m.thread_id AND c2.user_id IS NULL)`
                : '';
        const caseUserFilter = userId ? `AND c.user_id = ${userId}` : unownedOnly ? 'AND c.user_id IS NULL' : '';

        const summaryResult = await db.query(`
            SELECT
                COUNT(*) FILTER (
                    WHERE m.direction = 'inbound'
                      AND COALESCE(m.received_at, m.created_at) >= NOW() - INTERVAL '24 hours'
                ) AS inbound_24h,
                COUNT(*) FILTER (
                    WHERE m.direction = 'inbound'
                      AND (m.thread_id IS NULL OR m.case_id IS NULL)
                ) AS unmatched_inbound_total,
                COUNT(*) FILTER (
                    WHERE m.direction = 'inbound'
                      AND m.processed_at IS NULL
                ) AS unprocessed_inbound_total
            FROM messages m
            ${userId || unownedOnly ? `WHERE EXISTS (SELECT 1 FROM email_threads t2 JOIN cases c2 ON t2.case_id = c2.id WHERE t2.id = m.thread_id ${userId ? `AND c2.user_id = ${userId}` : 'AND c2.user_id IS NULL'})` : ''}
        `);

        const pendingApprovalsResult = await db.query(`
            SELECT
                p.id,
                p.case_id,
                p.action_type,
                p.confidence,
                p.created_at,
                p.trigger_message_id,
                p.reasoning,
                c.case_name,
                c.agency_name,
                c.status AS case_status,
                c.portal_url,
                (SELECT COUNT(*) FROM messages m WHERE m.case_id = c.id) AS message_count,
                (SELECT COUNT(*) FROM messages m WHERE m.case_id = c.id AND m.direction = 'inbound') AS inbound_count,
                (SELECT LEFT(m2.body_text, 150) FROM messages m2 WHERE m2.case_id = c.id AND m2.direction = 'inbound' ORDER BY COALESCE(m2.received_at, m2.created_at) DESC LIMIT 1) AS last_inbound_preview,
                (SELECT m3.subject FROM messages m3 WHERE m3.case_id = c.id AND m3.direction = 'inbound' ORDER BY COALESCE(m3.received_at, m3.created_at) DESC LIMIT 1) AS last_inbound_subject,
                (SELECT COALESCE(m4.received_at, m4.created_at) FROM messages m4 WHERE m4.case_id = c.id AND m4.direction = 'inbound' ORDER BY COALESCE(m4.received_at, m4.created_at) DESC LIMIT 1) AS last_inbound_date
            FROM proposals p
            LEFT JOIN cases c ON c.id = p.case_id
            WHERE p.status = 'PENDING_APPROVAL'
            ${caseUserFilter}
            ORDER BY p.created_at DESC
            LIMIT $1
        `, [limit]);

        const activeRunsResult = await db.query(`
            SELECT
                r.id,
                r.case_id,
                r.status,
                r.trigger_type,
                r.started_at,
                r.metadata,
                c.case_name
            FROM agent_runs r
            LEFT JOIN cases c ON c.id = r.case_id
            WHERE r.status IN ('queued', 'running', 'paused')
            ${caseUserFilter}
            ORDER BY r.started_at DESC
            LIMIT $1
        `, [limit]);

        const unmatchedInboundResult = await db.query(`
            SELECT
                m.id,
                m.from_email,
                m.subject,
                m.received_at,
                m.created_at,
                LEFT(m.body_text, 200) AS body_preview,
                (
                    SELECT json_agg(json_build_object('id', c.id, 'case_name', c.case_name, 'agency_name', c.agency_name))
                    FROM (
                        SELECT DISTINCT c2.id, c2.case_name, c2.agency_name
                        FROM cases c2
                        WHERE c2.agency_email IS NOT NULL
                          AND split_part(c2.agency_email, '@', 2) = split_part(m.from_email, '@', 2)
                        LIMIT 3
                    ) c
                ) AS suggested_cases
            FROM messages m
            WHERE m.direction = 'inbound'
              AND (m.thread_id IS NULL OR m.case_id IS NULL)
            ORDER BY COALESCE(m.received_at, m.created_at) DESC
            LIMIT $1
        `, [limit]);

        const unprocessedInboundResult = await db.query(`
            SELECT
                m.id,
                m.case_id,
                m.from_email,
                m.subject,
                m.received_at,
                m.created_at,
                c.case_name
            FROM messages m
            LEFT JOIN cases c ON c.id = m.case_id
            WHERE m.direction = 'inbound'
              AND m.processed_at IS NULL
              ${caseUserFilter}
            ORDER BY COALESCE(m.received_at, m.created_at) DESC
            LIMIT $1
        `, [limit]);

        const stuckRunsResult = await db.query(`
            SELECT
                r.id,
                r.case_id,
                r.trigger_type,
                r.status,
                r.started_at,
                r.metadata
            FROM agent_runs r
            ${userId || unownedOnly ? 'LEFT JOIN cases c ON c.id = r.case_id' : ''}
            WHERE r.status = 'running'
              AND r.started_at < NOW() - INTERVAL '2 minutes'
              ${userId || unownedOnly ? (userId ? `AND c.user_id = ${userId}` : 'AND c.user_id IS NULL') : ''}
            ORDER BY r.started_at ASC
            LIMIT $1
        `, [limit]);

        res.json({
            success: true,
            summary: {
                inbound_24h: parseInt(summaryResult.rows[0]?.inbound_24h || 0, 10),
                unmatched_inbound_total: parseInt(summaryResult.rows[0]?.unmatched_inbound_total || 0, 10),
                unprocessed_inbound_total: parseInt(summaryResult.rows[0]?.unprocessed_inbound_total || 0, 10),
                pending_approvals_total: pendingApprovalsResult.rows.length,
                active_runs_total: activeRunsResult.rows.length,
                stuck_runs_total: stuckRunsResult.rows.length
            },
            pending_approvals: pendingApprovalsResult.rows,
            active_runs: activeRunsResult.rows,
            unmatched_inbound: unmatchedInboundResult.rows,
            unprocessed_inbound: unprocessedInboundResult.rows,
            stuck_runs: stuckRunsResult.rows
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * GET /api/monitor/daily-stats
 * Today's activity summary for the daily stats bar.
 */
router.get('/daily-stats', async (req, res) => {
    try {
        const userIdParam = req.query.user_id;
        const userId = userIdParam && userIdParam !== 'unowned' ? parseInt(userIdParam, 10) || null : null;
        const unownedOnly = userIdParam === 'unowned';

        const userFilter = userId
            ? `WHERE EXISTS (SELECT 1 FROM cases c WHERE c.id = al.case_id AND c.user_id = ${userId})`
            : unownedOnly
                ? 'WHERE EXISTS (SELECT 1 FROM cases c WHERE c.id = al.case_id AND c.user_id IS NULL)'
                : '';

        const result = await db.query(`
            SELECT
                COUNT(*) FILTER (WHERE event_type = 'proposal_approved' AND al.created_at >= CURRENT_DATE) AS approved_today,
                COUNT(*) FILTER (WHERE event_type = 'proposal_dismissed' AND al.created_at >= CURRENT_DATE) AS dismissed_today,
                COUNT(*) FILTER (WHERE event_type IN ('status_change') AND al.created_at >= CURRENT_DATE AND al.metadata->>'new_status' IN ('completed', 'records_received', 'closed')) AS completed_today,
                COUNT(*) FILTER (WHERE event_type = 'inbound_received' AND al.created_at >= CURRENT_DATE) AS inbound_today,
                COUNT(*) FILTER (WHERE event_type = 'outbound_sent' AND al.created_at >= CURRENT_DATE) AS sent_today
            FROM activity_log al
            ${userFilter}
        `);
        const row = result.rows[0] || {};
        res.json({
            success: true,
            stats: {
                approved_today: parseInt(row.approved_today || 0, 10),
                dismissed_today: parseInt(row.dismissed_today || 0, 10),
                completed_today: parseInt(row.completed_today || 0, 10),
                inbound_today: parseInt(row.inbound_today || 0, 10),
                sent_today: parseInt(row.sent_today || 0, 10)
            }
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * GET /api/monitor/cases
 * Case-centric monitoring list with progress signals.
 */
router.get('/cases', async (req, res) => {
    try {
        const limit = Math.min(parseInt(req.query.limit, 10) || 200, 500);
        const status = req.query.status || null;
        const userIdParam = req.query.user_id;
        const params = [];
        const whereParts = [];

        if (status) {
            params.push(status);
            whereParts.push(`c.status = $${params.length}`);
        }

        if (userIdParam === 'unowned') {
            whereParts.push('c.user_id IS NULL');
        } else if (userIdParam && !isNaN(parseInt(userIdParam))) {
            params.push(parseInt(userIdParam));
            whereParts.push(`c.user_id = $${params.length}`);
        }

        const whereClause = whereParts.length > 0 ? 'WHERE ' + whereParts.join(' AND ') : '';

        params.push(limit);
        const limitParam = `$${params.length}`;

        const result = await db.query(`
            SELECT
                c.id,
                c.case_name,
                c.agency_name,
                c.subject_name,
                c.status,
                c.substatus,
                c.agency_email,
                c.portal_url,
                c.created_at,
                c.updated_at,
                c.user_id,
                u.name AS user_name,
                u.email_handle AS user_handle,
                msg_counts.total_messages,
                msg_counts.inbound_messages,
                msg_counts.outbound_messages,
                last_msg.last_message_at,
                last_msg.last_message_subject,
                proposal_counts.pending_approvals,
                active_run.id AS active_run_id,
                active_run.status AS active_run_status,
                active_run.trigger_type AS active_run_trigger_type
            FROM cases c
            LEFT JOIN users u ON c.user_id = u.id
            LEFT JOIN LATERAL (
                SELECT
                    COUNT(*)::int AS total_messages,
                    COUNT(*) FILTER (WHERE m.direction = 'inbound')::int AS inbound_messages,
                    COUNT(*) FILTER (WHERE m.direction = 'outbound')::int AS outbound_messages
                FROM messages m
                WHERE m.case_id = c.id
            ) msg_counts ON true
            LEFT JOIN LATERAL (
                SELECT
                    COALESCE(m.received_at, m.sent_at, m.created_at) AS last_message_at,
                    m.subject AS last_message_subject
                FROM messages m
                WHERE m.case_id = c.id
                ORDER BY COALESCE(m.received_at, m.sent_at, m.created_at) DESC
                LIMIT 1
            ) last_msg ON true
            LEFT JOIN LATERAL (
                SELECT
                    COUNT(*) FILTER (WHERE p.status = 'PENDING_APPROVAL')::int AS pending_approvals
                FROM proposals p
                WHERE p.case_id = c.id
            ) proposal_counts ON true
            LEFT JOIN LATERAL (
                SELECT
                    r.id,
                    r.status,
                    r.trigger_type
                FROM agent_runs r
                WHERE r.case_id = c.id
                  AND r.status IN ('created', 'queued', 'running', 'paused')
                ORDER BY r.started_at DESC
                LIMIT 1
            ) active_run ON true
            ${whereClause}
            ORDER BY c.updated_at DESC
            LIMIT ${limitParam}
        `, params);

        res.json({ success: true, cases: result.rows, count: result.rows.length });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * GET /api/monitor/case/:id
 * Full case inspection view with correspondence and progress.
 */
router.get('/case/:id', async (req, res) => {
    try {
        const caseId = parseInt(req.params.id, 10);
        if (!caseId) {
            return res.status(400).json({ success: false, error: 'Invalid case id' });
        }

        const caseData = await db.getCaseById(caseId);
        if (!caseData) {
            return res.status(404).json({ success: false, error: `Case ${caseId} not found` });
        }

        const portalAccount = caseData.portal_url
            ? await db.getPortalAccountByUrl(caseData.portal_url).catch(() => null)
            : null;

        const [threadResult, messagesResult, runsResult, proposalsResult, portalTasksResult, caseAgencies] = await Promise.all([
            db.query(`
                SELECT *
                FROM email_threads
                WHERE case_id = $1
                ORDER BY created_at DESC
                LIMIT 1
            `, [caseId]),
            db.query(`
                SELECT
                    id, direction, from_email, to_email, subject, body_text, body_html,
                    message_type, sendgrid_message_id, sent_at, received_at, created_at,
                    processed_at, processed_run_id
                FROM messages
                WHERE case_id = $1
                ORDER BY COALESCE(received_at, sent_at, created_at) DESC
                LIMIT 300
            `, [caseId]),
            db.query(`
                SELECT
                    id, trigger_type, status, started_at, ended_at, error, autopilot_mode,
                    proposal_id, message_id, metadata
                FROM agent_runs
                WHERE case_id = $1
                ORDER BY started_at DESC
                LIMIT 100
            `, [caseId]),
            db.query(`
                SELECT
                    id, action_type, status, confidence, trigger_message_id, run_id,
                    draft_subject, draft_body_text, created_at, updated_at, execution_key, email_job_id
                FROM proposals
                WHERE case_id = $1
                ORDER BY created_at DESC
                LIMIT 100
            `, [caseId]),
            db.query(`
                SELECT
                    id, status, portal_url, action_type, proposal_id,
                    assigned_to, completed_at, completion_notes, created_at, updated_at,
                    subject, body_text, instructions, confirmation_number
                FROM portal_tasks
                WHERE case_id = $1
                ORDER BY created_at DESC
                LIMIT 100
            `, [caseId]).catch(() => ({ rows: [] })),
            db.getCaseAgencies(caseId).catch(() => [])
        ]);

        res.json({
            success: true,
            case: caseData,
            thread: threadResult.rows[0] || null,
            messages: messagesResult.rows,
            runs: runsResult.rows,
            proposals: proposalsResult.rows,
            portal_tasks: portalTasksResult.rows,
            portal_account: portalAccount ? { email: portalAccount.email, password: portalAccount.password } : null,
            case_agencies: caseAgencies
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * POST /api/monitor/case/:id/trigger-portal
 * Force queue a portal submission job for manual live testing.
 */
router.post('/case/:id/trigger-portal', express.json(), async (req, res) => {
    try {
        const caseId = parseInt(req.params.id);
        const { instructions = null, provider = null, portal_url = null, research_context = null } = req.body || {};

        const caseData = await db.getCaseById(caseId);
        if (!caseData) {
            return res.status(404).json({ success: false, error: `Case ${caseId} not found` });
        }

        const normalizedPortalUrl = portal_url
            ? normalizePortalUrl(String(portal_url).trim())
            : normalizePortalUrl(caseData.portal_url || '');

        if (!normalizedPortalUrl || !isSupportedPortalUrl(normalizedPortalUrl)) {
            return res.status(400).json({ success: false, error: 'Valid portal URL is required' });
        }

        if (!caseData.portal_url || caseData.portal_url !== normalizedPortalUrl || (provider && provider !== caseData.portal_provider)) {
            await db.updateCase(caseId, {
                portal_url: normalizedPortalUrl,
                portal_provider: provider || caseData.portal_provider || null
            });
        }

        if (!normalizedPortalUrl) {
            return res.status(400).json({ success: false, error: 'Case has no portal_url' });
        }

        if (!portalQueue) {
            return res.status(503).json({ success: false, error: 'Portal queue unavailable' });
        }

        const baseInstructions = instructions || `Monitor-triggered portal submission for case ${caseId}`;
        const appendedResearch = research_context
            ? `${baseInstructions}\n\nCase research context:\n${research_context}`
            : baseInstructions;

        const job = await portalQueue.add('portal-submit', {
            caseId,
            portalUrl: normalizedPortalUrl,
            provider: provider || caseData.portal_provider || null,
            instructions: appendedResearch
        });

        await db.updateCaseStatus(caseId, 'portal_in_progress', {
            substatus: 'Monitor-triggered portal submission queued',
            last_portal_status: 'Portal submission queued (monitor trigger)',
            last_portal_status_at: new Date()
        });

        await db.logActivity('monitor_portal_trigger', `Portal submission queued from monitor for case ${caseId}`, {
            case_id: caseId,
            portal_url: normalizedPortalUrl,
            provider: provider || caseData.portal_provider || null,
            job_id: job?.id || null
        });

        notify('info', `Portal submission queued for ${caseData.case_name}`, { case_id: caseId });
        res.json({
            success: true,
            message: 'Portal submission queued',
            case_id: caseId,
            job_id: job?.id || null,
            portal_url: normalizedPortalUrl,
            monitor_case_url: `/api/monitor/case/${caseId}`
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * POST /api/monitor/reset-state
 * Operational reset for clean slate testing.
 * Does not delete cases/messages/history; it closes active runs and dismisses pending approvals.
 */
router.post('/reset-state', express.json(), async (req, res) => {
    try {
        const resetRunsResult = await db.query(`
            UPDATE agent_runs
            SET status = 'failed',
                ended_at = COALESCE(ended_at, NOW()),
                error = COALESCE(error, 'Manual reset from monitor')
            WHERE status IN ('queued', 'running', 'paused')
            RETURNING id
        `);

        const dismissProposalsResult = await db.query(`
            UPDATE proposals
            SET status = 'DISMISSED',
                human_decision = COALESCE(
                    human_decision,
                    jsonb_build_object(
                        'action', 'DISMISS',
                        'reason', 'Manual reset from monitor',
                        'decidedAt', to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"'),
                        'decidedBy', 'monitor-reset'
                    )
                ),
                updated_at = NOW()
            WHERE status IN ('PENDING_APPROVAL', 'DECISION_RECEIVED')
            RETURNING id
        `);

        await db.logActivity('monitor_reset_state', 'Monitor reset operational state', {
            runs_reset: resetRunsResult.rowCount,
            proposals_dismissed: dismissProposalsResult.rowCount
        });

        res.json({
            success: true,
            message: 'Operational state reset',
            runs_reset: resetRunsResult.rowCount,
            proposals_dismissed: dismissProposalsResult.rowCount
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * GET /api/monitor/message/:id/proposals
 * Return proposals tied to this message (trigger_message_id)
 */
router.get('/message/:id/proposals', async (req, res) => {
    try {
        const messageId = parseInt(req.params.id);
        const result = await db.query(`
            SELECT
                p.*,
                c.agency_email,
                c.portal_url,
                latest_exec.id AS execution_id,
                latest_exec.status AS execution_status,
                latest_exec.provider_message_id AS execution_provider_message_id,
                latest_exec.completed_at AS execution_completed_at,
                outbound.id AS outbound_message_id,
                outbound.sendgrid_message_id AS outbound_sendgrid_message_id,
                outbound.sent_at AS outbound_sent_at
            FROM proposals p
            LEFT JOIN cases c ON c.id = p.case_id
            LEFT JOIN LATERAL (
                SELECT
                    e.id,
                    e.status,
                    e.provider_message_id,
                    e.completed_at
                FROM executions e
                WHERE e.proposal_id = p.id
                ORDER BY e.created_at DESC
                LIMIT 1
            ) latest_exec ON true
            LEFT JOIN LATERAL (
                SELECT
                    m.id,
                    m.sendgrid_message_id,
                    m.sent_at
                FROM messages m
                WHERE m.case_id = p.case_id
                  AND m.direction = 'outbound'
                  AND (
                        (latest_exec.provider_message_id IS NOT NULL AND m.sendgrid_message_id = latest_exec.provider_message_id)
                        OR (p.executed_at IS NOT NULL AND m.created_at >= p.executed_at - INTERVAL '60 seconds')
                     )
                ORDER BY m.created_at DESC
                LIMIT 1
            ) outbound ON true
            WHERE p.trigger_message_id = $1
            ORDER BY p.created_at DESC
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
        const result = await processProposalDecision(proposalId, 'APPROVE');
        res.status(202).json(result);
    } catch (error) {
        const status = error.status || 500;
        res.status(status).json({ success: false, error: error.message, ...(error.payload || {}) });
    }
});

/**
 * POST /api/monitor/proposals/:id/decision
 * Unified proposal decisions from monitor (APPROVE|ADJUST|DISMISS)
 */
router.post('/proposals/:id/decision', express.json(), async (req, res) => {
    try {
        const proposalId = parseInt(req.params.id);
        const { action, instruction = null, reason = null, dismiss_reason = null, route_mode = null } = req.body || {};
        const result = await processProposalDecision(proposalId, action, { instruction, reason: reason || dismiss_reason, route_mode });
        res.status(action === 'DISMISS' ? 200 : 202).json(result);
    } catch (error) {
        const status = error.status || 500;
        res.status(status).json({ success: false, error: error.message, ...(error.payload || {}) });
    }
});

/**
 * POST /api/monitor/simulate-inbound
 * Create deterministic inbound message for testing
 */
router.post('/simulate-inbound', express.json(), async (req, res) => {
    try {
        const {
            case_id,
            subject,
            body_text,
            from_email,
            attach_to_thread = true,
            mark_processed = false
        } = req.body || {};

        if (!case_id || !body_text || !from_email) {
            return res.status(400).json({
                success: false,
                error: 'case_id, body_text, and from_email are required'
            });
        }

        const caseData = await db.getCaseById(parseInt(case_id));
        if (!caseData) {
            return res.status(404).json({ success: false, error: `Case ${case_id} not found` });
        }

        let thread = null;
        if (attach_to_thread) {
            thread = await db.getThreadByCaseId(caseData.id);
            if (!thread) {
                thread = await db.createEmailThread({
                    case_id: caseData.id,
                    thread_id: `sim:${caseData.id}:${Date.now()}`,
                    subject: subject || `Re: ${caseData.case_name || 'Public Records Request'}`,
                    agency_email: caseData.agency_email,
                    initial_message_id: null,
                    status: 'active'
                });
            }
        }

        const syntheticId = `sim:${caseData.id}:${Date.now()}:${crypto.randomBytes(3).toString('hex')}`;
        const message = await db.createMessage({
            thread_id: thread?.id || null,
            case_id: caseData.id,
            message_id: syntheticId,
            sendgrid_message_id: null,
            direction: 'inbound',
            from_email,
            to_email: 'requests@foib-request.com',
            subject: subject || `Re: ${caseData.case_name || 'Public Records Request'}`,
            body_text,
            body_html: `<p>${String(body_text).replace(/\n/g, '<br>')}</p>`,
            message_type: 'simulated_inbound',
            received_at: new Date()
        });

        if (mark_processed) {
            await db.query(`
                UPDATE messages
                SET processed_at = NOW()
                WHERE id = $1
            `, [message.id]);
        }

        await db.logActivity('simulated_inbound_created', `Simulated inbound created for case ${caseData.id}`, {
            case_id: caseData.id,
            message_id: message.id
        });

        res.status(201).json({
            success: true,
            message_id: message.id,
            case_id: caseData.id,
            thread_id: thread?.id || null,
            created_at: message.created_at
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * POST /api/monitor/trigger-inbound-run
 * Trigger run-engine inbound flow by message id
 */
router.post('/trigger-inbound-run', express.json(), async (req, res) => {
    try {
        const { message_id, force_new_run = false } = req.body || {};
        const autopilotMode = 'SUPERVISED';
        if (!message_id) {
            return res.status(400).json({ success: false, error: 'message_id is required' });
        }

        const message = await db.getMessageById(parseInt(message_id));
        if (!message) {
            return res.status(404).json({ success: false, error: `Message ${message_id} not found` });
        }
        if (message.direction !== 'inbound') {
            return res.status(400).json({ success: false, error: 'Only inbound messages can be processed' });
        }

        const { run, job } = await queueInboundRunForMessage(message, { autopilotMode, force_new_run });

        await db.logActivity('manual_ai_trigger', `AI triggered for inbound message ${message.id}`, {
            case_id: message.case_id,
            message_id: message.id,
            autopilotMode,
            force_new_run
        });

        res.json({
            success: true,
            approval_required: true,
            autopilot_mode: autopilotMode,
            run: {
                id: run.id,
                status: run.status,
                message_id: message.id,
                thread_id: run.langgraph_thread_id
            },
            job_id: job?.id || null
        });
    } catch (error) {
        const status = error.status || 500;
        res.status(status).json({ success: false, error: error.message, ...(error.payload || {}) });
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
        let latestInitialRouteMode = null;
        if (message.case_id) {
            caseData = await db.getCaseById(message.case_id);
        } else if (message.thread_id) {
            const thread = await db.getThreadById(message.thread_id);
            if (thread?.case_id) {
                caseData = await db.getCaseById(thread.case_id);
            }
        }

        if (caseData?.id) {
            const routeResult = await db.query(`
                SELECT metadata
                FROM agent_runs
                WHERE case_id = $1
                  AND trigger_type = 'initial_request'
                ORDER BY started_at DESC
                LIMIT 1
            `, [caseData.id]);
            latestInitialRouteMode = routeResult.rows[0]?.metadata?.route_mode || null;
        }

        res.json({
            success: true,
            message,
            source: deriveMessageSource(message),
            case: caseData ? {
                id: caseData.id,
                case_name: caseData.case_name,
                agency_name: caseData.agency_name,
                agency_email: caseData.agency_email,
                portal_url: caseData.portal_url,
                status: caseData.status,
                latest_initial_route_mode: latestInitialRouteMode
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
 * POST /api/monitor/message/:id/match-case
 * Manually attach an unmatched inbound message to a case/thread.
 */
router.post('/message/:id/match-case', express.json(), async (req, res) => {
    try {
        const messageId = parseInt(req.params.id);
        const { case_id } = req.body || {};
        const caseId = parseInt(case_id);

        if (!caseId) {
            return res.status(400).json({ success: false, error: 'case_id is required' });
        }

        const message = await db.getMessageById(messageId);
        if (!message) {
            return res.status(404).json({ success: false, error: 'Message not found' });
        }

        if (message.direction !== 'inbound') {
            return res.status(400).json({ success: false, error: 'Only inbound messages can be matched' });
        }

        const caseData = await db.getCaseById(caseId);
        if (!caseData) {
            return res.status(404).json({ success: false, error: `Case ${caseId} not found` });
        }

        let thread = await db.getThreadByCaseId(caseId);
        if (!thread) {
            thread = await db.createEmailThread({
                case_id: caseId,
                thread_id: message.message_id || `monitor-match:${caseId}:${Date.now()}`,
                subject: message.subject || `Case ${caseId} correspondence`,
                agency_email: caseData.agency_email || message.from_email || '',
                initial_message_id: null,
                status: 'active'
            });
        }

        await db.query(`
            UPDATE messages
            SET case_id = $2,
                thread_id = $3
            WHERE id = $1
            RETURNING id
        `, [messageId, caseId, thread.id]);

        await db.logActivity('monitor_message_matched', `Monitor matched message ${messageId} to case ${caseId}`, {
            message_id: messageId,
            case_id: caseId,
            thread_id: thread.id
        });

        res.json({
            success: true,
            message: 'Message matched to case',
            message_id: messageId,
            case_id: caseId,
            thread_id: thread.id
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
        const {
            force_new_run = false,
            override_mode = false,
            body_text_override,
            subject_override
        } = req.body || {};
        const autopilotMode = 'SUPERVISED';

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

        let inboundMessage = message;

        const normalizedBodyOverride = typeof body_text_override === 'string' ? body_text_override.trim() : '';
        const normalizedSubjectOverride = typeof subject_override === 'string' ? subject_override.trim() : '';
        const normalizedMessageBody = (message.body_text || '').trim();
        const normalizedMessageSubject = (message.subject || '').trim();
        const shouldCloneForOverride =
            override_mode && (
                (normalizedBodyOverride && normalizedBodyOverride !== normalizedMessageBody) ||
                (normalizedSubjectOverride && normalizedSubjectOverride !== normalizedMessageSubject)
            );

        // Clone only when override content is different from stored message
        if (shouldCloneForOverride) {
            const newMessageId = `monitor:${message.id}:${Date.now()}:${crypto.randomBytes(4).toString('hex')}`;
            inboundMessage = await db.createMessage({
                thread_id: message.thread_id,
                case_id: caseData.id,
                message_id: newMessageId,
                sendgrid_message_id: null,
                direction: 'inbound',
                from_email: message.from_email,
                to_email: message.to_email,
                subject: normalizedSubjectOverride || message.subject,
                body_text: normalizedBodyOverride || message.body_text || '(empty body)',
                body_html: message.body_html || null,
                message_type: 'manual_trigger',
                received_at: new Date()
            });
        }

        const { run, job } = await queueInboundRunForMessage(inboundMessage, { autopilotMode, force_new_run });

        await db.logActivity('manual_ai_trigger', `AI triggered for inbound message ${messageId}`, {
            case_id: caseData.id,
            message_id: messageId,
            autopilotMode,
            force_new_run
        });

        res.json({
            success: true,
            approval_required: true,
            autopilot_mode: autopilotMode,
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
        const status = error.status || 500;
        res.status(status).json({ success: false, error: error.message, ...(error.payload || {}) });
    }
});

/**
 * POST /api/monitor/proposals/:id/generate-draft
 * Generate draft content for a proposal that has no draft (e.g., from reprocessing)
 */
router.post('/proposals/:id/generate-draft', express.json(), async (req, res) => {
    try {
        const proposalId = parseInt(req.params.id);
        const proposal = await db.query('SELECT * FROM proposals WHERE id = $1', [proposalId]);
        if (!proposal.rows[0]) {
            return res.status(404).json({ success: false, error: 'Proposal not found' });
        }
        const p = proposal.rows[0];

        if (p.draft_body_text) {
            return res.status(400).json({ success: false, error: 'Proposal already has draft content' });
        }

        const { draftResponseNode } = require('../langgraph/nodes/draft-response');

        // Build minimal state for the draft node
        const state = {
            caseId: p.case_id,
            proposalActionType: p.action_type,
            constraints: p.metadata?.constraints || [],
            scopeItems: p.metadata?.scope_items || [],
            extractedFeeAmount: p.metadata?.fee_amount || null,
            latestInboundMessageId: p.trigger_message_id || null,
            adjustmentInstruction: null,
            llmStubs: null
        };

        const result = await draftResponseNode(state);

        if (result.errors && result.errors.length > 0) {
            return res.status(500).json({ success: false, error: result.errors.join('; ') });
        }

        if (!result.draftBodyText && !result.draftSubject) {
            return res.status(500).json({ success: false, error: 'Draft generation returned empty content' });
        }

        // Update the proposal with the generated draft
        await db.query(`
            UPDATE proposals
            SET draft_subject = $1, draft_body_text = $2, draft_body_html = $3, updated_at = NOW()
            WHERE id = $4
        `, [result.draftSubject || null, result.draftBodyText || null, result.draftBodyHtml || null, proposalId]);

        res.json({
            success: true,
            draft: {
                subject: result.draftSubject,
                body_text: result.draftBodyText,
                body_html: result.draftBodyHtml
            }
        });
    } catch (error) {
        logger.error('Generate draft error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * GET /api/monitor/events
 * Server-Sent Events stream for real-time notifications
 */
router.get('/events', (req, res) => {
    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive'
    });
    res.write(':\n\n'); // initial comment to flush headers

    const heartbeat = setInterval(() => res.write(':\n\n'), 30000);

    const onNotification = (data) => {
        res.write(`data: ${JSON.stringify(data)}\n\n`);
    };
    eventBus.on('notification', onNotification);

    req.on('close', () => {
        clearInterval(heartbeat);
        eventBus.off('notification', onNotification);
    });
});

/**
 * POST /api/monitor/case/:id/lookup-contact
 * Trigger a pd-contact lookup in the background. Returns immediately.
 */
router.post('/case/:id/lookup-contact', express.json(), async (req, res) => {
    const caseId = parseInt(req.params.id, 10);
    if (!caseId) return res.status(400).json({ success: false, error: 'Invalid case id' });

    const caseData = await db.getCaseById(caseId);
    if (!caseData) return res.status(404).json({ success: false, error: 'Case not found' });

    res.json({ success: true, message: 'Contact lookup started' });

    // Run in background
    (async () => {
        try {
            notify('info', `Looking up contacts for ${caseData.agency_name || caseData.case_name}...`, { case_id: caseId });

            let result;
            try {
                result = await pdContactService.lookupContact(
                    caseData.agency_name,
                    caseData.state || caseData.incident_location
                );
            } catch (lookupErr) {
                if (lookupErr.code === 'SERVICE_UNAVAILABLE') {
                    notify('error', `PD Contact service not reachable — is PD_CONTACT_API_URL set and the foia-researcher running?`, { case_id: caseId });
                } else {
                    notify('error', `Contact lookup failed: ${lookupErr.message}`, { case_id: caseId });
                }
                return;
            }

            if (!result || (!result.portal_url && !result.contact_email)) {
                notify('warning', `No contacts found for ${caseData.agency_name || caseData.case_name}`, { case_id: caseId });
                await db.updateCase(caseId, {
                    last_contact_research_at: new Date(),
                    contact_research_notes: 'pd-contact lookup returned no results'
                });
                return;
            }

            const updates = {
                last_contact_research_at: new Date(),
                contact_research_notes: [
                    result.notes,
                    result.records_officer ? `Records officer: ${result.records_officer}` : null,
                    `Source: ${result.source || 'pd-contact'}`,
                    `Confidence: ${result.confidence || 'unknown'}`
                ].filter(Boolean).join('. ')
            };

            if (result.contact_email && result.contact_email !== caseData.agency_email) {
                updates.alternate_agency_email = result.contact_email;
            }
            if (result.portal_url) {
                const normalized = normalizePortalUrl(result.portal_url);
                if (normalized && isSupportedPortalUrl(normalized)) {
                    updates.portal_url = normalized;
                    updates.portal_provider = result.portal_provider || detectPortalProviderByUrl(normalized)?.name || null;
                }
            }

            await db.updateCase(caseId, updates);

            // Create a case_agency row if research found an alternative email/portal
            if (result.contact_email && result.contact_email !== caseData.agency_email) {
                try {
                    await db.addCaseAgency(caseId, {
                        agency_name: result.agency_name || caseData.agency_name || 'Researched Agency',
                        agency_email: result.contact_email,
                        portal_url: updates.portal_url || null,
                        portal_provider: updates.portal_provider || null,
                        added_source: 'research',
                        notes: updates.contact_research_notes || null
                    });
                } catch (caErr) {
                    console.warn(`Failed to create case_agency from research: ${caErr.message}`);
                }
            }

            const parts = [];
            if (updates.portal_url) parts.push(`portal: ${updates.portal_url}`);
            if (updates.alternate_agency_email) parts.push(`email: ${updates.alternate_agency_email}`);
            if (result.contact_phone) parts.push(`phone: ${result.contact_phone}`);

            notify('success', `Found contacts for ${caseData.agency_name || caseData.case_name}: ${parts.join(', ') || 'see research notes'}`, { case_id: caseId });

            await db.logActivity('pd_contact_lookup', `PD contact lookup completed for case ${caseData.case_name}`, {
                case_id: caseId,
                portal_url: updates.portal_url || null,
                email: updates.alternate_agency_email || null,
                confidence: result.confidence
            });
        } catch (err) {
            console.error(`PD contact lookup failed for case ${caseId}:`, err.message);
            notify('error', `Contact lookup failed for ${caseData.agency_name || caseData.case_name}: ${err.message}`, { case_id: caseId });
        }
    })();
});

module.exports = router;
