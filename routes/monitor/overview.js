const express = require('express');
const router = express.Router();
const {
    db,
    normalizeProposalReasoning,
    extractAttachmentInsights
} = require('./_helpers');

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

        // Get queue status
        let queueStatus = { generation: {}, email: {} };
        try {
            const { generateQueue, emailQueue } = require('../../queues/email-queue');
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
            activity: activityResult.rows
        });
    } catch (error) {
        console.error('Monitor error:', error);
        res.status(500).json({ error: error.message });
    }
});

router.get('/config', async (req, res) => {
    let queue = { generation: {}, email: {} };
    try {
        const { generateQueue, emailQueue } = require('../../queues/email-queue');
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

        const [portalTimeoutMetricsResult, supersededMetricsResult] = await Promise.all([
            db.query(`
                SELECT
                    COUNT(*) FILTER (WHERE event_type = 'portal_hard_timeout')::int AS portal_hard_timeout_total_1h,
                    COUNT(*) FILTER (WHERE event_type = 'portal_soft_timeout')::int AS portal_soft_timeout_total_1h
                FROM activity_log
                WHERE created_at > NOW() - INTERVAL '1 hour'
            `),
            db.query(`
                SELECT COUNT(*)::int AS process_inbound_superseded_total_1h
                FROM agent_runs
                WHERE status = 'cancelled'
                  AND (error = 'superseded' OR error LIKE 'deduped to active%')
                  AND COALESCE(ended_at, started_at) > NOW() - INTERVAL '1 hour'
            `),
        ]);
        const portalHardThresholdRaw = parseInt(process.env.PORTAL_HARD_TIMEOUT_ALERT_THRESHOLD || '0', 10);
        const supersededThresholdRaw = parseInt(process.env.PROCESS_INBOUND_SUPERSEDED_ALERT_THRESHOLD || '5', 10);
        const portalHardThreshold = Number.isFinite(portalHardThresholdRaw) ? portalHardThresholdRaw : 0;
        const supersededThreshold = Number.isFinite(supersededThresholdRaw) ? supersededThresholdRaw : 5;
        const portalMetrics = portalTimeoutMetricsResult.rows[0] || {};
        const supersededMetrics = supersededMetricsResult.rows[0] || {};
        const portalHardTimeoutTotal1h = parseInt(portalMetrics.portal_hard_timeout_total_1h || 0, 10);
        const portalSoftTimeoutTotal1h = parseInt(portalMetrics.portal_soft_timeout_total_1h || 0, 10);
        const processInboundSupersededTotal1h = parseInt(supersededMetrics.process_inbound_superseded_total_1h || 0, 10);

        const pendingApprovalsResult = await db.query(`
            SELECT
                p.id,
                p.case_id,
                p.action_type,
                p.confidence,
                p.created_at,
                p.trigger_message_id,
                p.reasoning,
                p.draft_subject,
                p.pause_reason AS proposal_pause_reason,
                p.risk_flags,
                p.warnings,
                p.gate_options,
                c.case_name,
                c.agency_name,
                c.status AS case_status,
                c.substatus AS case_substatus,
                c.portal_url,
                c.agency_email,
                c.user_id,
                c.pause_reason AS case_pause_reason,
                (c.fee_quote_jsonb->>'amount')::numeric AS last_fee_quote_amount,
                (SELECT COUNT(*) FROM messages m WHERE m.case_id = c.id) AS message_count,
                (SELECT COUNT(*) FROM messages m WHERE m.case_id = c.id AND m.direction = 'inbound') AS inbound_count,
                (SELECT m2.body_text FROM messages m2 WHERE m2.case_id = c.id AND m2.direction = 'inbound' ORDER BY COALESCE(m2.received_at, m2.created_at) DESC LIMIT 1) AS last_inbound_preview,
                (SELECT m3.subject FROM messages m3 WHERE m3.case_id = c.id AND m3.direction = 'inbound' ORDER BY COALESCE(m3.received_at, m3.created_at) DESC LIMIT 1) AS last_inbound_subject,
                (SELECT COALESCE(m4.received_at, m4.created_at) FROM messages m4 WHERE m4.case_id = c.id AND m4.direction = 'inbound' ORDER BY COALESCE(m4.received_at, m4.created_at) DESC LIMIT 1) AS last_inbound_date
            FROM proposals p
            LEFT JOIN cases c ON c.id = p.case_id
            WHERE p.status IN ('PENDING_APPROVAL', 'BLOCKED')
            AND (c.notion_page_id IS NULL OR c.notion_page_id NOT LIKE 'test-%')
            ${caseUserFilter}
            ORDER BY
                CASE WHEN p.risk_flags IS NOT NULL AND array_length(p.risk_flags, 1) > 0 THEN 0
                     WHEN p.confidence < 0.6 THEN 1 ELSE 2 END ASC,
                p.created_at DESC
            LIMIT $1
        `, [limit]);

        // Enrich pending approvals with inbound attachments + quick extracted insights.
        const pendingApprovalRows = pendingApprovalsResult.rows || [];
        const triggerMessageIds = [...new Set(
            pendingApprovalRows
                .map((r) => Number(r.trigger_message_id))
                .filter((n) => Number.isFinite(n) && n > 0)
        )];
        const caseIdsForReasoning = [...new Set(
            pendingApprovalRows
                .map((r) => Number(r.case_id))
                .filter((n) => Number.isFinite(n) && n > 0)
        )];

        let latestReviewByCase = new Map();
        if (caseIdsForReasoning.length > 0) {
            const reviewCtx = await db.query(`
                SELECT DISTINCT ON (p.case_id)
                    p.case_id,
                    p.action_type,
                    p.human_decision->>'action' AS review_action,
                    p.human_decision->>'instruction' AS review_instruction,
                    p.updated_at
                FROM proposals p
                WHERE p.case_id = ANY($1::int[])
                  AND p.human_decision IS NOT NULL
                ORDER BY p.case_id, p.updated_at DESC
            `, [caseIdsForReasoning]);
            latestReviewByCase = reviewCtx.rows.reduce((acc, row) => {
                acc.set(Number(row.case_id), row);
                return acc;
            }, new Map());
        }

        let attachmentsByMessage = new Map();
        if (triggerMessageIds.length > 0) {
            const attachmentResult = await db.query(`
                SELECT
                    a.id,
                    a.message_id,
                    a.filename,
                    a.content_type,
                    a.size_bytes,
                    a.storage_url,
                    a.extracted_text,
                    a.created_at
                FROM attachments a
                WHERE a.message_id = ANY($1::int[])
                ORDER BY a.created_at ASC
            `, [triggerMessageIds]);

            attachmentsByMessage = attachmentResult.rows.reduce((acc, row) => {
                const messageId = Number(row.message_id);
                if (!acc.has(messageId)) acc.set(messageId, []);
                acc.get(messageId).push({
                    id: row.id,
                    message_id: row.message_id,
                    filename: row.filename,
                    content_type: row.content_type,
                    size_bytes: row.size_bytes,
                    storage_url: row.storage_url,
                    extracted_text: row.extracted_text,
                    created_at: row.created_at,
                    download_url: `/api/monitor/attachments/${row.id}/download`
                });
                return acc;
            }, new Map());
        }

        const pendingApprovalsWithAttachments = pendingApprovalRows.map((row) => {
            const messageId = Number(row.trigger_message_id);
            const attachments = attachmentsByMessage.get(messageId) || [];
            const reviewCtx = latestReviewByCase.get(Number(row.case_id)) || {};
            return {
                ...row,
                reasoning: normalizeProposalReasoning(row, {
                    reviewAction: reviewCtx.review_action,
                    reviewInstruction: reviewCtx.review_instruction,
                }),
                attachments,
                attachment_insights: extractAttachmentInsights(attachments)
            };
        });

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

        // Resolve user email for TO-address filtering on unmatched messages
        let unmatchedUserEmail = null;
        if (userId) {
            const user = await db.getUserById(userId);
            unmatchedUserEmail = user?.email || null;
        }
        const unmatchedToFilter = unmatchedUserEmail
            ? `AND m.to_email ILIKE '%' || $2 || '%'`
            : unownedOnly
                ? `AND (m.to_email ILIKE '%requests@foib-request.com%' OR m.to_email IS NULL)`
                : '';
        const suggestedCasesUserFilter = userId ? `AND c2.user_id = ${userId}` : unownedOnly ? 'AND c2.user_id IS NULL' : '';
        const unmatchedParams = [limit];
        if (unmatchedUserEmail) unmatchedParams.push(unmatchedUserEmail);

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
                          ${suggestedCasesUserFilter}
                        LIMIT 3
                    ) c
                ) AS suggested_cases
            FROM messages m
            WHERE m.direction = 'inbound'
              AND (m.thread_id IS NULL OR m.case_id IS NULL)
              ${unmatchedToFilter}
            ORDER BY COALESCE(m.received_at, m.created_at) DESC
            LIMIT $1
        `, unmatchedParams);

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

        const humanReviewResult = await db.query(`
            SELECT
                c.id,
                c.case_name,
                c.agency_name,
                c.status,
                c.substatus,
                c.updated_at,
                c.portal_url,
                c.last_portal_task_url,
                c.last_portal_run_id,
                c.last_portal_status,
                c.pause_reason,
                (c.fee_quote_jsonb->>'amount')::numeric AS last_fee_quote_amount,
                c.agency_email,
                c.user_id,
                (SELECT COUNT(*) FROM messages m WHERE m.case_id = c.id AND m.direction = 'inbound') AS inbound_count,
                (SELECT m2.body_text FROM messages m2 WHERE m2.case_id = c.id AND m2.direction = 'inbound' ORDER BY COALESCE(m2.received_at, m2.created_at) DESC LIMIT 1) AS last_inbound_preview
            FROM cases c
            WHERE c.status IN ('needs_human_review', 'needs_phone_call', 'needs_contact_info', 'needs_human_fee_approval')
              AND NOT EXISTS (
                  SELECT 1 FROM proposals p WHERE p.case_id = c.id
                  AND (
                      p.status IN ('PENDING_APPROVAL', 'BLOCKED')
                      OR (p.status = 'DECISION_RECEIVED'
                          AND EXISTS (SELECT 1 FROM agent_runs ar
                                      WHERE ar.case_id = c.id
                                      AND ar.status IN ('created','queued','processing','running','waiting')))
                  )
              )
              AND (c.notion_page_id IS NULL OR c.notion_page_id NOT LIKE 'test-%')
              ${caseUserFilter}
            ORDER BY
                CASE c.pause_reason WHEN 'FEE_QUOTE' THEN 0 WHEN 'DENIAL' THEN 1
                     WHEN 'SENSITIVE' THEN 2 ELSE 3 END ASC,
                c.updated_at ASC
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
                stuck_runs_total: stuckRunsResult.rows.length,
                human_review_total: humanReviewResult.rows.length,
                portal_hard_timeout_total_1h: portalHardTimeoutTotal1h,
                portal_soft_timeout_total_1h: portalSoftTimeoutTotal1h,
                process_inbound_superseded_total_1h: processInboundSupersededTotal1h
            },
            alerts: {
                portal_hard_timeout: {
                    metric: 'portal_hard_timeout_total_1h',
                    value: portalHardTimeoutTotal1h,
                    threshold: portalHardThreshold,
                    triggered: portalHardTimeoutTotal1h > portalHardThreshold
                },
                process_inbound_superseded: {
                    metric: 'process_inbound_superseded_total_1h',
                    value: processInboundSupersededTotal1h,
                    threshold: supersededThreshold,
                    triggered: processInboundSupersededTotal1h > supersededThreshold
                }
            },
            pending_approvals: pendingApprovalsWithAttachments,
            active_runs: activeRunsResult.rows,
            unmatched_inbound: unmatchedInboundResult.rows,
            unprocessed_inbound: unprocessedInboundResult.rows,
            stuck_runs: stuckRunsResult.rows,
            human_review_cases: humanReviewResult.rows
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

module.exports = router;
