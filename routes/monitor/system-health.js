const express = require('express');
const router = express.Router();
const { db } = require('./_helpers');

/**
 * GET /api/monitor/system-health
 * Consolidated system health metrics for dashboard card
 */
router.get('/system-health', async (req, res) => {
    try {
        const [stuckCases, orphanedRuns, staleProposals, overdueDeadlines, bouncedEmails, portalFailures] = await Promise.all([
            // Stuck cases: needs_human_* status with no active proposal or running agent
            db.query(`
                SELECT COUNT(*)::int AS count FROM cases c
                WHERE c.status IN ('needs_human_review', 'needs_phone_call', 'needs_contact_info', 'needs_human_fee_approval')
                  AND NOT EXISTS (
                      SELECT 1 FROM proposals p WHERE p.case_id = c.id
                      AND p.status IN ('PENDING_APPROVAL', 'BLOCKED', 'DECISION_RECEIVED')
                  )
                  AND NOT EXISTS (
                      SELECT 1 FROM agent_runs ar WHERE ar.case_id = c.id
                      AND ar.status IN ('created', 'queued', 'processing', 'running', 'waiting')
                  )
                  AND (c.notion_page_id IS NULL OR c.notion_page_id NOT LIKE 'test-%')
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
                  AND status NOT IN ('completed', 'cancelled')
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

        const metrics = {
            stuck_cases: stuckCases.rows[0]?.count || 0,
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

module.exports = router;
