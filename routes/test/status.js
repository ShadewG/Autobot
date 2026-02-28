const express = require('express');
const router = express.Router();
const { db, safeJsonParse, emailQueue, generateQueue, portalQueue, PORTAL_ACTIVITY_EVENTS } = require('./_helpers');

/**
 * Get environment variables (for dashboard)
 * GET /api/test/env
 */
router.get('/env', async (req, res) => {
    try {
        res.json({
            ENABLE_AGENT: 'true', // Agent always enabled for complex cases
            ENABLE_NOTIFICATIONS: process.env.ENABLE_NOTIFICATIONS || 'false',
            ENABLE_AUTO_REPLY: process.env.ENABLE_AUTO_REPLY !== 'false'
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * Get statistics (for dashboard)
 * GET /api/test/stats
 */
router.get('/stats', async (req, res) => {
    try {
        const casesResult = await db.query('SELECT COUNT(*) as count FROM cases');
        const decisionsResult = await db.query('SELECT COUNT(*) as count FROM agent_decisions');
        const escalationsResult = await db.query('SELECT COUNT(*) as count FROM escalations WHERE status = $1', ['pending']);

        res.json({
            success: true,
            total_cases: parseInt(casesResult.rows[0].count),
            agent_decisions: parseInt(decisionsResult.rows[0].count),
            escalations: parseInt(escalationsResult.rows[0].count)
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * Get recent portal runs (activity log)
 * GET /api/test/portal-runs
 */
router.get('/portal-runs', async (req, res) => {
    try {
        const result = await db.query(
            `
            SELECT id, event_type, description, metadata, created_at
            FROM activity_log
            WHERE event_type = ANY($1::text[])
            ORDER BY created_at DESC
            LIMIT 50
            `,
            [PORTAL_ACTIVITY_EVENTS]
        );

        const runs = result.rows.map((row) => ({
            ...row,
            metadata: safeJsonParse(row.metadata, row.metadata || {})
        }));

        res.json({
            success: true,
            runs
        });
    } catch (error) {
        console.error('Error fetching portal runs:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * Get recent activity log entries (test dashboard)
 */
router.get('/activity', async (req, res) => {
    try {
        const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
        const activity = await db.getRecentActivity(limit);
        res.json({
            success: true,
            activity
        });
    } catch (error) {
        console.error('Error fetching activity log:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

/**
 * Check queue status and worker health
 * GET /api/test/queue-status
 */
router.get('/queue-status', async (req, res) => {
    try {
        const generateCounts = await generateQueue.getJobCounts('wait', 'active', 'completed', 'failed', 'delayed');
        const emailCounts = await emailQueue.getJobCounts('wait', 'active', 'completed', 'failed', 'delayed');
        const portalCounts = await portalQueue.getJobCounts('wait', 'active', 'completed', 'failed', 'delayed');

        // Get some waiting jobs to see what's queued
        const waitingGenerate = await generateQueue.getJobs(['waiting'], 0, 5);
        const waitingEmail = await emailQueue.getJobs(['waiting'], 0, 5);
        const waitingPortal = await portalQueue.getJobs(['waiting'], 0, 5);

        res.json({
            success: true,
            timestamp: new Date().toISOString(),
            queues: {
                generate: {
                    counts: generateCounts,
                    waiting_jobs: waitingGenerate.map(j => ({ id: j.id, data: j.data, addedAt: j.timestamp }))
                },
                email: {
                    counts: emailCounts,
                    waiting_jobs: waitingEmail.map(j => ({ id: j.id, data: j.data, addedAt: j.timestamp }))
                },
                portal: {
                    counts: portalCounts,
                    waiting_jobs: waitingPortal.map(j => ({ id: j.id, data: j.data, addedAt: j.timestamp }))
                }
            },
            redis_url: process.env.REDIS_URL ? 'Configured' : 'NOT CONFIGURED'
        });
    } catch (error) {
        console.error('Queue status error:', error);
        res.status(500).json({
            success: false,
            error: error.message,
            stack: error.stack
        });
    }
});

module.exports = router;
