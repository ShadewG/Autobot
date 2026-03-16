const express = require('express');
const bcrypt = require('bcryptjs');
const router = express.Router();
const db = require('../services/database');

const COOKIE_NAME = 'autobot_uid';

/**
 * Admin middleware — reject non-admin users
 */
async function requireAdmin(req, res, next) {
    try {
        const userId = req.signedCookies?.[COOKIE_NAME];
        if (!userId) return res.status(401).json({ success: false, error: 'Not authenticated' });

        const user = await db.getUserById(parseInt(userId));
        if (!user?.active || !user?.is_admin) {
            return res.status(403).json({ success: false, error: 'Admin access required' });
        }
        req.adminUser = user;
        next();
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
}

router.use(requireAdmin);

/**
 * GET /overview — Admin dashboard summary stats
 */
router.get('/overview', async (req, res) => {
    try {
        const [usersResult, casesResult, statusResult, recentActivity, portalMetricsResult, supersededMetricsResult] = await Promise.all([
            db.query(`
                SELECT
                    COUNT(*) FILTER (WHERE active = true)::int AS active_users,
                    COUNT(*) FILTER (WHERE active = false)::int AS inactive_users,
                    COUNT(*)::int AS total_users
                FROM users
            `),
            db.query(`
                SELECT
                    COUNT(*)::int AS total_cases,
                    COUNT(*) FILTER (WHERE status NOT IN ('completed', 'cancelled'))::int AS active_cases,
                    (
                        SELECT COUNT(*)::int FROM proposals p
                        JOIN cases c2 ON c2.id = p.case_id
                        WHERE p.status IN ('PENDING_APPROVAL', 'BLOCKED')
                          AND (c2.notion_page_id IS NULL OR c2.notion_page_id NOT LIKE 'test-%')
                    ) + (
                        SELECT COUNT(*)::int FROM cases c
                        WHERE c.status IN ('needs_human_review', 'needs_phone_call', 'needs_contact_info', 'needs_human_fee_approval')
                          AND NOT EXISTS (
                              SELECT 1 FROM proposals p WHERE p.case_id = c.id
                              AND (p.status IN ('PENDING_APPROVAL', 'BLOCKED')
                                  OR (p.status = 'DECISION_RECEIVED'
                                      AND EXISTS (SELECT 1 FROM agent_runs ar
                                                  WHERE ar.case_id = c.id
                                                  AND ar.status IN ('created','queued','processing','running','waiting'))))
                          )
                          AND (c.notion_page_id IS NULL OR c.notion_page_id NOT LIKE 'test-%')
                    ) AS needs_review,
                    COUNT(*) FILTER (WHERE status = 'id_state')::int AS id_state_cases
                FROM cases
            `),
            db.query(`
                SELECT status, COUNT(*)::int AS count
                FROM cases
                GROUP BY status
                ORDER BY count DESC
            `),
            db.query(`
                SELECT al.*, u.name AS user_name
                FROM activity_log al
                LEFT JOIN users u ON u.id::text = al.user_id
                ORDER BY al.created_at DESC
                LIMIT 10
            `),
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
                  AND error = 'superseded'
                  AND LOWER(COALESCE(trigger_type, '')) IN (
                    'inbound_message',
                    'orphan_review_reprocess',
                    'resume_retry'
                  )
                  AND COALESCE(ended_at, started_at) > NOW() - INTERVAL '1 hour'
            `),
        ]);

        const portalHardThresholdRaw = parseInt(process.env.PORTAL_HARD_TIMEOUT_ALERT_THRESHOLD || '0', 10);
        const supersededThresholdRaw = parseInt(process.env.PROCESS_INBOUND_SUPERSEDED_ALERT_THRESHOLD || '5', 10);
        const portalHardThreshold = Number.isFinite(portalHardThresholdRaw) ? portalHardThresholdRaw : 0;
        const supersededThreshold = Number.isFinite(supersededThresholdRaw) ? supersededThresholdRaw : 5;
        const portalMetrics = portalMetricsResult.rows[0] || {};
        const supersededMetrics = supersededMetricsResult.rows[0] || {};
        const portalHardTimeoutTotal1h = parseInt(portalMetrics.portal_hard_timeout_total_1h || 0, 10);
        const portalSoftTimeoutTotal1h = parseInt(portalMetrics.portal_soft_timeout_total_1h || 0, 10);
        const processInboundSupersededTotal1h = parseInt(supersededMetrics.process_inbound_superseded_total_1h || 0, 10);

        res.json({
            success: true,
            users: usersResult.rows[0],
            cases: casesResult.rows[0],
            status_breakdown: statusResult.rows,
            recent_activity: recentActivity.rows,
            operational: {
                portal_hard_timeout_total_1h: portalHardTimeoutTotal1h,
                portal_soft_timeout_total_1h: portalSoftTimeoutTotal1h,
                process_inbound_superseded_total_1h: processInboundSupersededTotal1h,
                thresholds: {
                    portal_hard_timeout_total_1h: portalHardThreshold,
                    process_inbound_superseded_total_1h: supersededThreshold,
                },
                alerts: {
                    portal_hard_timeout: portalHardTimeoutTotal1h > portalHardThreshold,
                    process_inbound_superseded: processInboundSupersededTotal1h > supersededThreshold,
                },
            },
        });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

/**
 * GET /users — All users with detailed stats
 */
router.get('/users', async (req, res) => {
    try {
        const result = await db.query(`
            SELECT
                u.id, u.name, u.email_handle, u.email, u.active, u.is_admin,
                u.created_at, u.updated_at,
                COUNT(DISTINCT c.id)::int AS total_cases,
                COUNT(DISTINCT c.id) FILTER (WHERE c.status NOT IN ('completed', 'cancelled'))::int AS active_cases,
                (
                    SELECT COUNT(*)::int FROM proposals p2
                    JOIN cases c2 ON c2.id = p2.case_id
                    WHERE c2.user_id = u.id AND p2.status IN ('PENDING_APPROVAL', 'BLOCKED')
                ) + (
                    SELECT COUNT(*)::int FROM cases c3
                    WHERE c3.user_id = u.id
                      AND c3.status IN ('needs_human_review', 'needs_phone_call', 'needs_contact_info', 'needs_human_fee_approval')
                      AND NOT EXISTS (
                          SELECT 1 FROM proposals p3 WHERE p3.case_id = c3.id
                          AND (p3.status IN ('PENDING_APPROVAL', 'BLOCKED')
                              OR (p3.status = 'DECISION_RECEIVED'
                                  AND EXISTS (SELECT 1 FROM agent_runs ar
                                              WHERE ar.case_id = c3.id
                                              AND ar.status IN ('created','queued','processing','running','waiting'))))
                      )
                ) AS needs_review,
                (
                    SELECT MAX(a2.created_at) FROM activity_log a2
                    WHERE a2.user_id = u.id::text
                       OR a2.case_id IN (SELECT c4.id FROM cases c4 WHERE c4.user_id = u.id)
                ) AS last_activity_at,
                (
                    SELECT a3.description FROM activity_log a3
                    WHERE a3.user_id = u.id::text
                       OR a3.case_id IN (SELECT c5.id FROM cases c5 WHERE c5.user_id = u.id)
                    ORDER BY a3.created_at DESC
                    LIMIT 1
                ) AS last_activity_description
            FROM users u
            LEFT JOIN cases c ON c.user_id = u.id
            GROUP BY u.id
            ORDER BY u.active DESC, u.name
        `);

        res.json({ success: true, users: result.rows });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

/**
 * POST /users — Create user with password
 */
router.post('/users', express.json(), async (req, res) => {
    try {
        const { name, email_handle, password, is_admin } = req.body || {};

        if (!name?.trim()) return res.status(400).json({ success: false, error: 'Name required' });
        if (!email_handle?.trim()) return res.status(400).json({ success: false, error: 'Email handle required' });
        if (!password || password.length < 4) return res.status(400).json({ success: false, error: 'Password must be at least 4 characters' });

        const handle = email_handle.toLowerCase().trim();
        if (!/^[a-z0-9][a-z0-9-]{0,48}[a-z0-9]$/.test(handle) && !/^[a-z0-9]{2}$/.test(handle)) {
            return res.status(400).json({ success: false, error: 'Invalid handle format' });
        }

        const existing = await db.getUserByHandle(handle);
        if (existing) return res.status(409).json({ success: false, error: `Handle "${handle}" taken` });

        const user = await db.createUser({ name: name.trim(), email_handle: handle });

        // Set password
        const hash = await bcrypt.hash(password, 10);
        await db.query('UPDATE users SET password_hash = $1 WHERE id = $2', [hash, user.id]);

        // Set admin if requested
        if (is_admin) {
            await db.query('UPDATE users SET is_admin = true WHERE id = $1', [user.id]);
        }

        res.status(201).json({ success: true, user: { ...user, is_admin: !!is_admin } });
    } catch (err) {
        if (err.code === '23505') return res.status(409).json({ success: false, error: 'Handle exists' });
        res.status(500).json({ success: false, error: err.message });
    }
});

/**
 * PATCH /users/:id — Admin update (includes password reset, admin toggle)
 */
router.patch('/users/:id', express.json(), async (req, res) => {
    try {
        const id = parseInt(req.params.id);
        const user = await db.getUserById(id);
        if (!user) return res.status(404).json({ success: false, error: 'Not found' });

        // Handle password reset
        if (req.body.password) {
            const hash = await bcrypt.hash(req.body.password, 10);
            await db.query('UPDATE users SET password_hash = $1 WHERE id = $2', [hash, id]);
        }

        // Handle admin toggle
        if (req.body.is_admin !== undefined) {
            await db.query('UPDATE users SET is_admin = $1 WHERE id = $2', [!!req.body.is_admin, id]);
        }

        // Handle active toggle
        if (req.body.active !== undefined) {
            await db.updateUser(id, { active: !!req.body.active });
        }

        const updated = await db.getUserById(id);
        res.json({ success: true, user: updated });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

/**
 * GET /activity — Global activity log with user info
 */
router.get('/activity', async (req, res) => {
    try {
        const limit = Math.min(parseInt(req.query.limit) || 100, 500);
        const userId = req.query.user_id || null;

        let query = `
            SELECT al.*, u.name AS user_name, c.agency_name, c.case_name
            FROM activity_log al
            LEFT JOIN users u ON u.id::text = al.user_id
            LEFT JOIN cases c ON c.id = al.case_id
        `;
        const params = [];

        if (userId) {
            params.push(userId);
            query += ` WHERE al.user_id = $${params.length}`;
        }

        query += ` ORDER BY al.created_at DESC LIMIT $${params.length + 1}`;
        params.push(limit);

        const result = await db.query(query, params);
        res.json({ success: true, activity: result.rows });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

/**
 * GET /health — Per-user health dashboard + bug reports
 */
router.get('/health', async (req, res) => {
    try {
        const testFilter = `(c.notion_page_id IS NULL OR c.notion_page_id NOT LIKE 'test-%')`;

        const [
            stuckResult,
            overdueResult,
            failedRunsResult,
            bouncedResult,
            bugReportsResult,
            buggedCasesResult,
        ] = await Promise.all([
            // Stuck cases: needs_human_review/etc with no active proposal, stale > 24h
            db.query(`
                SELECT c.id, c.agency_name, c.user_id, u.name AS user_name,
                       c.status, c.substatus, c.updated_at
                FROM cases c
                LEFT JOIN users u ON u.id = c.user_id
                WHERE c.status IN ('needs_human_review', 'needs_phone_call', 'needs_contact_info', 'needs_human_fee_approval')
                  AND NOT EXISTS (
                      SELECT 1 FROM proposals p WHERE p.case_id = c.id
                      AND p.status IN ('PENDING_APPROVAL', 'BLOCKED')
                  )
                  AND NOT EXISTS (
                      SELECT 1 FROM agent_runs ar WHERE ar.case_id = c.id
                      AND ar.status IN ('created','queued','processing','running','waiting')
                  )
                  AND c.updated_at < NOW() - INTERVAL '24 hours'
                  AND ${testFilter}
                ORDER BY c.updated_at ASC
            `),
            // Overdue deadlines
            db.query(`
                SELECT c.id, c.agency_name, c.user_id, u.name AS user_name,
                       c.status, c.deadline_date
                FROM cases c
                LEFT JOIN users u ON u.id = c.user_id
                WHERE c.deadline_date < CURRENT_DATE
                  AND c.status NOT IN ('completed', 'cancelled', 'bugged')
                  AND ${testFilter}
                ORDER BY c.deadline_date ASC
            `),
            // Failed runs (48h, exclude superseded/bugged)
            db.query(`
                SELECT DISTINCT ON (ar.case_id)
                       ar.case_id AS id, c.agency_name, c.user_id, u.name AS user_name,
                       ar.error, ar.ended_at, ar.trigger_type
                FROM agent_runs ar
                JOIN cases c ON c.id = ar.case_id
                LEFT JOIN users u ON u.id = c.user_id
                WHERE ar.status = 'failed'
                  AND ar.error NOT IN ('superseded', 'case_marked_bugged')
                  AND ar.ended_at > NOW() - INTERVAL '48 hours'
                  AND c.status NOT IN ('completed', 'cancelled', 'bugged')
                  AND ${testFilter}
                ORDER BY ar.case_id, ar.ended_at DESC
            `),
            // Email bounces/failures on active cases (30 days)
            db.query(`
                SELECT DISTINCT ON (al.case_id)
                       al.case_id AS id, c.agency_name, c.user_id, u.name AS user_name,
                       al.event_type, al.description, al.created_at
                FROM activity_log al
                JOIN cases c ON c.id = al.case_id
                LEFT JOIN users u ON u.id = c.user_id
                WHERE al.event_type IN ('email_bounced', 'email_send_failed')
                  AND al.created_at > NOW() - INTERVAL '30 days'
                  AND c.status NOT IN ('completed', 'cancelled')
                  AND ${testFilter}
                ORDER BY al.case_id, al.created_at DESC
            `),
            // Open bug reports from user_feedback
            db.query(`
                SELECT f.id, f.title, f.description, f.case_id, f.status, f.priority,
                       f.created_by, f.created_by_email, f.created_at,
                       u.name AS reporter_name,
                       c.agency_name, c.status AS case_status
                FROM user_feedback f
                LEFT JOIN users u ON u.id = f.created_by
                LEFT JOIN cases c ON c.id = f.case_id
                WHERE f.type = 'bug_report'
                ORDER BY
                    CASE f.status WHEN 'open' THEN 0 WHEN 'in_progress' THEN 1 ELSE 2 END,
                    f.created_at DESC
                LIMIT 30
            `),
            // Currently bugged cases
            db.query(`
                SELECT c.id, c.agency_name, c.case_name, c.user_id, u.name AS user_name,
                       c.updated_at, c.substatus,
                       al.description AS bug_description, al.created_at AS bugged_at
                FROM cases c
                LEFT JOIN users u ON u.id = c.user_id
                LEFT JOIN LATERAL (
                    SELECT description, created_at FROM activity_log
                    WHERE case_id = c.id AND event_type = 'case_marked_bugged'
                    ORDER BY created_at DESC LIMIT 1
                ) al ON true
                WHERE c.status = 'bugged'
                  AND ${testFilter}
                ORDER BY c.updated_at DESC
            `),
        ]);

        // Build per-user issue map
        const userIssues = {};

        function ensureUser(userId, userName) {
            const key = userId || 'unassigned';
            if (!userIssues[key]) {
                userIssues[key] = {
                    user_id: userId,
                    user_name: userName || 'Unassigned',
                    stuck: [],
                    overdue: [],
                    failed_runs: [],
                    bounced: [],
                };
            }
            return userIssues[key];
        }

        for (const r of stuckResult.rows) {
            ensureUser(r.user_id, r.user_name).stuck.push({
                id: r.id, agency_name: r.agency_name, status: r.status,
                substatus: r.substatus, updated_at: r.updated_at,
            });
        }
        for (const r of overdueResult.rows) {
            ensureUser(r.user_id, r.user_name).overdue.push({
                id: r.id, agency_name: r.agency_name, status: r.status,
                deadline_date: r.deadline_date,
            });
        }
        for (const r of failedRunsResult.rows) {
            ensureUser(r.user_id, r.user_name).failed_runs.push({
                id: r.id, agency_name: r.agency_name,
                error: (r.error || '').slice(0, 120), trigger_type: r.trigger_type,
                ended_at: r.ended_at,
            });
        }
        for (const r of bouncedResult.rows) {
            ensureUser(r.user_id, r.user_name).bounced.push({
                id: r.id, agency_name: r.agency_name,
                event_type: r.event_type, created_at: r.created_at,
            });
        }

        // Sort: users with most issues first, unassigned last
        const userHealthList = Object.values(userIssues)
            .map(u => ({
                ...u,
                total_issues: u.stuck.length + u.overdue.length + u.failed_runs.length + u.bounced.length,
            }))
            .sort((a, b) => {
                if (!a.user_id && b.user_id) return 1;
                if (a.user_id && !b.user_id) return -1;
                return b.total_issues - a.total_issues;
            });

        res.json({
            success: true,
            user_health: userHealthList,
            bug_reports: bugReportsResult.rows,
            bugged_cases: buggedCasesResult.rows,
        });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

/**
 * GET /cases — All cases across all users (admin view)
 */
router.get('/cases', async (req, res) => {
    try {
        const limit = Math.min(parseInt(req.query.limit) || 50, 200);
        const userId = req.query.user_id || null;

        let query = `
            SELECT c.id, c.case_name, c.agency_name, c.status, c.substatus,
                   c.requires_human, c.user_id, c.created_at, c.updated_at,
                   u.name AS user_name
            FROM cases c
            LEFT JOIN users u ON u.id = c.user_id
            WHERE c.status NOT IN ('completed', 'cancelled')
              AND (c.notion_page_id IS NULL OR c.notion_page_id NOT LIKE 'test-%')
        `;
        const params = [];

        if (userId) {
            params.push(parseInt(userId));
            query += ` AND c.user_id = $${params.length}`;
        }

        query += ` ORDER BY c.updated_at DESC LIMIT $${params.length + 1}`;
        params.push(limit);

        const result = await db.query(query, params);
        res.json({ success: true, cases: result.rows });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

module.exports = router;
