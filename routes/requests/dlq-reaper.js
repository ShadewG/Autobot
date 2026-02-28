const express = require('express');
const router = express.Router();

/**
 * GET /api/dlq
 * Get DLQ items with optional filters
 */
router.get('/dlq', async (req, res) => {
    try {
        const { getDLQItems } = require('../../queues/queue-config');
        const { queue_name, resolution, limit, offset } = req.query;
        const parsedLimit = Number.parseInt(String(limit ?? ''), 10);
        const parsedOffset = Number.parseInt(String(offset ?? ''), 10);
        const safeLimit = Number.isFinite(parsedLimit) ? Math.min(Math.max(parsedLimit, 1), 500) : 50;
        const safeOffset = Number.isFinite(parsedOffset) ? Math.max(parsedOffset, 0) : 0;

        const items = await getDLQItems({
            queueName: queue_name,
            resolution: resolution || 'pending',
            limit: safeLimit,
            offset: safeOffset
        });

        res.json({
            success: true,
            count: items.length,
            items: items
        });
    } catch (error) {
        console.error('Error fetching DLQ items:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

/**
 * POST /api/dlq/:id/retry
 * Retry a DLQ item
 */
router.post('/dlq/:id/retry', async (req, res) => {
    try {
        const dlqId = Number.parseInt(String(req.params.id), 10);
        if (!Number.isFinite(dlqId)) {
            return res.status(400).json({ success: false, error: 'Invalid DLQ item id' });
        }
        const { retryDLQItem } = require('../../queues/queue-config');

        const result = await retryDLQItem(dlqId);

        res.json({
            success: true,
            message: 'DLQ item retried',
            new_job_id: result.newJobId
        });
    } catch (error) {
        console.error('Error retrying DLQ item:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

/**
 * POST /api/dlq/:id/discard
 * Discard a DLQ item
 */
router.post('/dlq/:id/discard', async (req, res) => {
    try {
        const dlqId = Number.parseInt(String(req.params.id), 10);
        if (!Number.isFinite(dlqId)) {
            return res.status(400).json({ success: false, error: 'Invalid DLQ item id' });
        }
        const { reason } = req.body;
        const { discardDLQItem } = require('../../queues/queue-config');

        await discardDLQItem(dlqId, reason || 'Manually discarded');

        res.json({
            success: true,
            message: 'DLQ item discarded'
        });
    } catch (error) {
        console.error('Error discarding DLQ item:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// =========================================================================
// Reaper Status Endpoint
// =========================================================================

/**
 * GET /api/reaper/status
 * Get reaper status and recent audit log
 */
router.get('/reaper/status', async (req, res) => {
    try {
        const reaperService = require('../../services/reaper-service');
        const status = await reaperService.getReaperStatus(parseInt(req.query.limit) || 20);

        res.json({
            success: true,
            ...status
        });
    } catch (error) {
        console.error('Error fetching reaper status:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

/**
 * POST /api/reaper/run
 * Manually trigger the reapers
 */
router.post('/reaper/run', async (req, res) => {
    try {
        const reaperService = require('../../services/reaper-service');
        const results = await reaperService.runReapers();

        res.json({
            success: true,
            message: 'Reapers executed',
            results
        });
    } catch (error) {
        console.error('Error running reapers:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

module.exports = router;
