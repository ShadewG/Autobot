const express = require('express');
const router = express.Router();
const { db } = require('./_helpers');

/**
 * GET /api/monitor/system-health
 * Consolidated system health metrics for dashboard card
 */
router.get('/system-health', async (req, res) => {
    try {
        const [stuckCasesGrouped, orphanedRuns, staleProposals, overdueDeadlines, bouncedEmails, portalFailures] = await Promise.all([
            // Stuck cases grouped by status and pause_reason
            db.query(`
                SELECT c.status, COALESCE(c.pause_reason, 'none') AS pause_reason, COUNT(*)::int AS count
                FROM cases c
                WHERE c.status IN ('needs_human_review', 'needs_phone_call', 'needs_contact_info', 'needs_human_fee_approval')
                  AND NOT EXISTS (
                      SELECT 1 FROM proposals p WHERE p.case_id = c.id
                      AND p.status IN ('PENDING_APPROVAL', 'BLOCKED', 'DECISION_RECEIVED')
                  )
                  AND NOT EXISTS (
                      SELECT 1 FROM agent_runs ar WHERE ar.case_id = c.id
                      AND ar.status IN ('created', 'queued', 'processing', 'running', 'waiting')
                  )
                  AND NOT EXISTS (
                      SELECT 1 FROM phone_call_queue pcq WHERE pcq.case_id = c.id
                      AND pcq.status IN ('pending', 'claimed')
                  )
                  AND NOT EXISTS (
                      SELECT 1 FROM portal_tasks pt WHERE pt.case_id = c.id
                      AND pt.status IN ('PENDING', 'IN_PROGRESS')
                  )
                  AND (c.notion_page_id IS NULL OR c.notion_page_id NOT LIKE 'test-%')
                  AND c.agency_name NOT LIKE 'Synthetic %'
                GROUP BY c.status, c.pause_reason
            `),

            // Orphaned runs: running for > 2h
            db.query(`
                SELECT COUNT(*)::int AS count FROM agent_runs
                WHERE status IN ('processing', 'running')
                  AND started_at < NOW() - INTERVAL '2 hours'
            `),

            // Stale proposals: pending approval for > 48h
            db.query(`
                SELECT COUNT(*)::int AS count FROM proposals p
                JOIN cases c ON c.id = p.case_id
                WHERE p.status IN ('PENDING_APPROVAL', 'BLOCKED')
                  AND p.created_at < NOW() - INTERVAL '48 hours'
                  AND (c.notion_page_id IS NULL OR c.notion_page_id NOT LIKE 'test-%')
            `),

            // Overdue deadlines: cases past their statutory deadline
            db.query(`
                SELECT COUNT(*)::int AS count FROM cases
                WHERE deadline_date IS NOT NULL
                  AND deadline_date < CURRENT_DATE
                  AND status NOT IN ('completed', 'cancelled', 'closed')
                  AND (notion_page_id IS NULL OR notion_page_id NOT LIKE 'test-%')
            `),

            // Bounced emails in last 24h
            db.query(`
                SELECT COUNT(*)::int AS count FROM messages
                WHERE bounced_at IS NOT NULL
                  AND bounced_at > NOW() - INTERVAL '24 hours'
            `),

            // Portal failures in last 24h
            db.query(`
                SELECT COUNT(*)::int AS count FROM portal_tasks
                WHERE status = 'FAILED'
                  AND updated_at > NOW() - INTERVAL '24 hours'
            `),
        ]);

        // Build stuck cases breakdown from grouped query
        const stuckBreakdown = {
            needs_human_review: 0,
            needs_phone_call: 0,
            needs_contact_info: 0,
            needs_human_fee_approval: 0,
            research_handoff: 0,
        };
        let stuckTotal = 0;
        for (const row of stuckCasesGrouped.rows) {
            stuckTotal += row.count;
            if (stuckBreakdown[row.status] !== undefined) {
                stuckBreakdown[row.status] += row.count;
            }
            if (row.pause_reason === 'RESEARCH_HANDOFF') {
                stuckBreakdown.research_handoff += row.count;
            }
        }

        const metrics = {
            stuck_cases: stuckTotal,
            stuck_breakdown: stuckBreakdown,
            orphaned_runs: orphanedRuns.rows[0]?.count || 0,
            stale_proposals: staleProposals.rows[0]?.count || 0,
            overdue_deadlines: overdueDeadlines.rows[0]?.count || 0,
            bounced_emails: bouncedEmails.rows[0]?.count || 0,
            portal_failures: portalFailures.rows[0]?.count || 0,
        };

        const issues = Object.values(metrics).reduce((sum, v) => sum + v, 0);

        res.json({
            success: true,
            status: issues === 0 ? 'healthy' : 'issues',
            total_issues: issues,
            metrics,
        });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

/**
 * GET /api/monitor/system-health/details?metric=stuck_cases|stale_proposals|overdue_deadlines|portal_failures
 * Returns the actual records behind each health metric
 */
router.get('/system-health/details', async (req, res) => {
    const { metric } = req.query;
    const queries = {
        stuck_cases: `
            SELECT c.id, c.agency_name, c.state, c.status, c.pause_reason, c.updated_at
            FROM cases c
            WHERE c.status IN ('needs_human_review', 'needs_phone_call', 'needs_contact_info', 'needs_human_fee_approval')
              AND NOT EXISTS (
                  SELECT 1 FROM proposals p WHERE p.case_id = c.id
                  AND p.status IN ('PENDING_APPROVAL', 'BLOCKED', 'DECISION_RECEIVED')
              )
              AND NOT EXISTS (
                  SELECT 1 FROM agent_runs ar WHERE ar.case_id = c.id
                  AND ar.status IN ('created', 'queued', 'processing', 'running', 'waiting')
              )
              AND NOT EXISTS (
                  SELECT 1 FROM phone_call_queue pcq WHERE pcq.case_id = c.id
                  AND pcq.status IN ('pending', 'claimed')
              )
              AND NOT EXISTS (
                  SELECT 1 FROM portal_tasks pt WHERE pt.case_id = c.id
                  AND pt.status IN ('PENDING', 'IN_PROGRESS')
              )
              AND (c.notion_page_id IS NULL OR c.notion_page_id NOT LIKE 'test-%')
              AND c.agency_name NOT LIKE 'Synthetic %'
            ORDER BY c.updated_at DESC LIMIT 100`,
        stale_proposals: `
            SELECT p.id as proposal_id, p.case_id, p.action_type, p.status as proposal_status, p.created_at,
                   c.agency_name, c.state, c.status as case_status, c.pause_reason
            FROM proposals p
            JOIN cases c ON c.id = p.case_id
            WHERE p.status IN ('PENDING_APPROVAL', 'BLOCKED')
              AND p.created_at < NOW() - INTERVAL '48 hours'
              AND (c.notion_page_id IS NULL OR c.notion_page_id NOT LIKE 'test-%')
            ORDER BY p.created_at ASC LIMIT 100`,
        overdue_deadlines: `
            SELECT c.id, c.agency_name, c.state, c.status, c.pause_reason,
                   c.deadline_date, (CURRENT_DATE - c.deadline_date) as days_overdue
            FROM cases c
            WHERE c.deadline_date IS NOT NULL
              AND c.deadline_date < CURRENT_DATE
              AND c.status NOT IN ('completed', 'cancelled', 'closed')
              AND (c.notion_page_id IS NULL OR c.notion_page_id NOT LIKE 'test-%')
            ORDER BY c.deadline_date ASC LIMIT 100`,
        portal_failures: `
            SELECT pt.id as task_id, pt.case_id, pt.action_type, pt.status, pt.portal_url,
                   pt.completion_notes, pt.updated_at,
                   c.agency_name, c.state
            FROM portal_tasks pt
            JOIN cases c ON c.id = pt.case_id
            WHERE pt.status = 'FAILED'
              AND pt.updated_at > NOW() - INTERVAL '24 hours'
            ORDER BY pt.updated_at DESC LIMIT 100`,
        orphaned_runs: `
            SELECT ar.id as run_id, ar.case_id, ar.trigger_type, ar.status, ar.started_at,
                   c.agency_name, c.state
            FROM agent_runs ar
            LEFT JOIN cases c ON c.id = ar.case_id
            WHERE ar.status IN ('processing', 'running')
              AND ar.started_at < NOW() - INTERVAL '2 hours'
            ORDER BY ar.started_at ASC LIMIT 100`,
        bounced_emails: `
            SELECT m.id as message_id, m.case_id, m.direction, m.from_address, m.to_address,
                   m.bounced_at,
                   c.agency_name, c.state
            FROM messages m
            LEFT JOIN cases c ON c.id = m.case_id
            WHERE m.bounced_at IS NOT NULL
              AND m.bounced_at > NOW() - INTERVAL '24 hours'
            ORDER BY m.bounced_at DESC LIMIT 100`,
    };

    if (!metric || !queries[metric]) {
        return res.status(400).json({
            success: false,
            error: `Invalid metric. Use one of: ${Object.keys(queries).join(', ')}`,
        });
    }

    try {
        const result = await db.query(queries[metric]);
        res.json({ success: true, metric, count: result.rows.length, items: result.rows });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

module.exports = router;
