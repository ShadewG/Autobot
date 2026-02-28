const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const {
    db,
    sgMail,
    deriveMessageSource,
    queueInboundRunForMessage
} = require('./_helpers');

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

        const suggestedCasesUserFilter = userId ? `AND c2.user_id = ${userId}` : unownedOnly ? 'AND c2.user_id IS NULL' : '';

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
                ra.suggested_action,
                ra.key_points,
                CASE WHEN c.id IS NULL THEN (
                    SELECT json_agg(json_build_object('id', sc.id, 'case_name', sc.case_name, 'agency_name', sc.agency_name))
                    FROM (
                        SELECT DISTINCT c2.id, c2.case_name, c2.agency_name
                        FROM cases c2
                        WHERE c2.agency_email IS NOT NULL
                          AND split_part(c2.agency_email, '@', 2) = split_part(m.from_email, '@', 2)
                          ${suggestedCasesUserFilter}
                        LIMIT 5
                    ) sc
                ) ELSE NULL END AS suggested_cases
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
 * POST /api/monitor/message/:id/dismiss
 * Dismiss (delete) an unmatched message (spam cleanup)
 */
router.post('/message/:id/dismiss', async (req, res) => {
    try {
        const id = parseInt(req.params.id);
        await db.dismissMessage(id);
        res.json({ success: true });
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

module.exports = router;
