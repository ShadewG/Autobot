const express = require('express');
const router = express.Router();
const { db } = require('./_helpers');

/**
 * GET /api/requests/:id/portal-screenshot
 * Lightweight endpoint for live portal screenshot polling
 */
router.get('/:id/portal-screenshot', async (req, res) => {
    try {
        const requestId = parseInt(req.params.id);
        if (isNaN(requestId)) {
            return res.status(400).json({ success: false, error: 'Invalid request ID' });
        }

        const result = await db.query(
            'SELECT last_portal_screenshot_url, last_portal_status, last_portal_task_url, updated_at FROM cases WHERE id = $1',
            [requestId]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ success: false, error: 'Request not found' });
        }

        const row = result.rows[0];
        res.json({
            success: true,
            screenshot_url: row.last_portal_screenshot_url || null,
            status: row.last_portal_status || null,
            portal_task_url: row.last_portal_task_url || null,
            updated_at: row.updated_at || null
        });
    } catch (error) {
        console.error('Error fetching portal screenshot:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * GET /api/requests/:id/portal-screenshots
 * Return all portal screenshots from activity_log for filmstrip/history view
 */
router.get('/:id/portal-screenshots', async (req, res) => {
    try {
        const requestId = parseInt(req.params.id);
        if (isNaN(requestId)) {
            return res.status(400).json({ success: false, error: 'Invalid request ID' });
        }

        const result = await db.query(
            `SELECT id, COALESCE(metadata->>'persistent_url', metadata->>'url') AS url,
                    metadata->>'run_id' AS run_id,
                    (metadata->>'sequence_index')::int AS sequence_index,
                    metadata->>'skyvern_status' AS skyvern_status,
                    created_at AS captured_at
             FROM activity_log
             WHERE event_type = 'portal_screenshot' AND case_id = $1
             ORDER BY created_at ASC
             LIMIT 200`,
            [requestId]
        );

        res.json({
            success: true,
            count: result.rows.length,
            screenshots: result.rows
        });
    } catch (error) {
        console.error('Error fetching portal screenshots:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

module.exports = router;
