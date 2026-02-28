const express = require('express');
const router = express.Router();
const {
    db, notionService, safeJsonParse, normalizePortalEvents,
    buildNotionUrl, resolvePoliceDeptPageId, detectPortalProviderByUrl,
    PORTAL_ACTIVITY_EVENTS
} = require('./_helpers');

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
