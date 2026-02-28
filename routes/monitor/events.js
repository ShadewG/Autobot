const express = require('express');
const router = express.Router();
const {
    db,
    eventBus
} = require('./_helpers');

/**
 * GET /api/monitor/events
 * Server-Sent Events stream for real-time notifications
 */
router.get('/events', (req, res) => {
    const userIdParam = req.query.user_id;
    const userId = userIdParam && userIdParam !== 'unowned' ? parseInt(userIdParam, 10) || null : null;
    const unownedOnly = userIdParam === 'unowned';

    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive'
    });
    res.write(':\n\n'); // initial comment to flush headers

    let closed = false;
    const safeSend = (msg) => {
        if (closed || res.writableEnded || res.destroyed) return;
        try { res.write(msg); } catch (_) { /* connection gone */ }
    };

    const heartbeat = setInterval(() => safeSend(':\n\n'), 30000);

    const onNotification = async (data) => {
        // If no user filter (All Users), send everything
        if (!userId && !unownedOnly) {
            safeSend(`data: ${JSON.stringify(data)}\n\n`);
            return;
        }

        // If the event has a case_id, check ownership
        const caseId = data.case_id || data.metadata?.case_id;
        if (caseId) {
            try {
                const c = await db.getCaseById(caseId);
                if (userId && c?.user_id !== userId) return; // skip — wrong user
                if (unownedOnly && c?.user_id != null) return; // skip — owned
            } catch (_) {
                return; // skip on error
            }
        } else {
            // System-level events (no case_id) — only send for "All Users"
            return;
        }
        safeSend(`data: ${JSON.stringify(data)}\n\n`);
    };
    eventBus.on('notification', onNotification);

    // Data update events — push incremental changes for dashboard
    const onDataUpdate = async (data) => {
        // Apply same user filtering as notifications
        const caseId = data.case_id || data.caseId;
        if (caseId && (userId || unownedOnly)) {
            try {
                const c = await db.getCaseById(caseId);
                if (userId && c?.user_id !== userId) return;
                if (unownedOnly && c?.user_id != null) return;
            } catch (_) {
                return;
            }
        }
        // Send as named SSE event so client can use addEventListener
        safeSend(`event: ${data.event}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    eventBus.on('data_update', onDataUpdate);

    req.on('close', () => {
        closed = true;
        clearInterval(heartbeat);
        eventBus.off('notification', onNotification);
        eventBus.off('data_update', onDataUpdate);
    });
});

/**
 * POST /api/monitor/sync-notion
 * Bulk sync all active cases to Notion
 */
router.post('/sync-notion', express.json(), async (req, res) => {
    try {
        const notionService = require('../../services/notion-service');

        // Get all active cases (non-terminal statuses)
        const activeCases = await db.query(`
            SELECT id FROM cases
            WHERE status NOT IN ('completed', 'cancelled', 'withdrawn')
              AND notion_page_id IS NOT NULL
              AND notion_page_id NOT LIKE 'test-%'
            ORDER BY id
        `);

        const caseIds = activeCases.rows.map(r => r.id);
        let synced = 0;
        let failed = 0;
        const errors = [];

        for (const caseId of caseIds) {
            try {
                await notionService.syncStatusToNotion(caseId);
                synced++;
            } catch (err) {
                failed++;
                errors.push({ caseId, error: err.message });
            }
        }

        res.json({
            success: true,
            total: caseIds.length,
            synced,
            failed,
            errors: errors.slice(0, 10)
        });
    } catch (error) {
        console.error('Bulk Notion sync error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * GET /api/monitor/attachments/:id/download
 * Download an attachment by ID
 */
router.get('/attachments/:id/download', async (req, res) => {
    try {
        const attachmentId = parseInt(req.params.id, 10);
        if (!attachmentId) return res.status(400).json({ success: false, error: 'Invalid attachment id' });

        const attachment = await db.getAttachmentById(attachmentId);
        if (!attachment) return res.status(404).json({ success: false, error: 'Attachment not found' });

        res.setHeader('Content-Disposition', `inline; filename="${attachment.filename || 'download'}"`);
        res.setHeader('Content-Type', attachment.content_type || 'application/octet-stream');

        // Tier 1: Try S3/R2 URL (permanent storage)
        if (attachment.storage_url && !attachment.storage_url.startsWith('s3://')) {
            return res.redirect(attachment.storage_url);
        }

        // Tier 1b: Try S3/R2 download (s3:// internal URLs)
        if (attachment.storage_url && attachment.storage_url.startsWith('s3://')) {
            try {
                const storageService = require('../../services/storage-service');
                const key = attachment.storage_url.replace(/^s3:\/\/[^/]+\//, '');
                const buffer = await storageService.download(key);
                if (buffer) {
                    res.setHeader('Content-Length', buffer.length);
                    return res.send(buffer);
                }
            } catch (_) {}
        }

        // Tier 2: Try local disk (ephemeral)
        const fsSync = require('fs');
        if (attachment.storage_path && fsSync.existsSync(attachment.storage_path)) {
            return fsSync.createReadStream(attachment.storage_path).pipe(res);
        }

        // Tier 3: Serve from DB file_data column (BYTEA fallback)
        if (attachment.file_data) {
            res.setHeader('Content-Length', attachment.file_data.length);
            return res.send(attachment.file_data);
        }

        return res.status(404).json({ success: false, error: 'File not available (lost during deploy)' });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

module.exports = router;
