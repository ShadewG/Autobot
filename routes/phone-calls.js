/**
 * Phone Call Queue Routes
 *
 * API for managing phone call escalation tasks.
 * Reasons include: no email response, details too complex for email,
 * portal failures, and clarification requests needing phone discussion.
 */

const express = require('express');
const router = express.Router();
const db = require('../services/database');

/**
 * GET /phone-calls
 * List phone call tasks, filterable by status
 */
router.get('/', async (req, res) => {
    try {
        const status = req.query.status;
        const limit = parseInt(req.query.limit) || 50;

        let tasks;
        if (status) {
            tasks = await db.getPhoneCallsByStatus(status, limit);
        } else {
            tasks = await db.getPendingPhoneCalls(limit);
        }

        const stats = await db.getPhoneCallQueueStats();

        res.json({
            success: true,
            count: tasks.length,
            stats,
            tasks
        });
    } catch (error) {
        console.error('Error fetching phone calls:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * GET /phone-calls/stats
 * Get queue statistics
 */
router.get('/stats', async (req, res) => {
    try {
        const stats = await db.getPhoneCallQueueStats();
        res.json({ success: true, stats });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * GET /phone-calls/:id
 * Get a single phone call task with details
 */
router.get('/:id', async (req, res) => {
    try {
        const id = parseInt(req.params.id);
        const task = await db.getPhoneCallById(id);

        if (!task) {
            return res.status(404).json({ success: false, error: 'Phone call task not found' });
        }

        res.json({ success: true, task });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * POST /phone-calls/:id/claim
 * Claim a phone call task
 * Body: { assignedTo: "name" }
 */
router.post('/:id/claim', async (req, res) => {
    try {
        const id = parseInt(req.params.id);
        const { assignedTo } = req.body;

        const task = await db.getPhoneCallById(id);
        if (!task) {
            return res.status(404).json({ success: false, error: 'Phone call task not found' });
        }

        if (task.status !== 'pending') {
            return res.status(409).json({
                success: false,
                error: `Task is already ${task.status}`,
                assigned_to: task.assigned_to
            });
        }

        const updated = await db.claimPhoneCall(id, assignedTo || 'unknown');
        if (!updated) {
            return res.status(409).json({ success: false, error: 'Task was already claimed' });
        }

        await db.logActivity('phone_call_claimed',
            `Phone call task ${id} claimed by ${assignedTo || 'unknown'}`,
            { case_id: task.case_id }
        );

        res.json({ success: true, message: 'Task claimed', task: updated });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * POST /phone-calls/:id/complete
 * Complete a phone call task
 * Body: { outcome, notes, completedBy }
 */
router.post('/:id/complete', async (req, res) => {
    try {
        const id = parseInt(req.params.id);
        const { outcome, notes, completedBy } = req.body;

        const task = await db.getPhoneCallById(id);
        if (!task) {
            return res.status(404).json({ success: false, error: 'Phone call task not found' });
        }

        if (task.status === 'completed') {
            return res.status(409).json({ success: false, error: 'Task already completed' });
        }

        const updated = await db.completePhoneCall(id, outcome, notes, completedBy || 'unknown');

        // Update case status based on outcome
        if (outcome === 'resolved') {
            await db.updateCaseStatus(task.case_id, 'responded', {
                substatus: 'Resolved via phone call'
            });
        } else if (outcome === 'connected' || outcome === 'transferred') {
            await db.updateCaseStatus(task.case_id, 'awaiting_response', {
                substatus: `Phone call: ${outcome}`
            });
        }

        await db.logActivity('phone_call_completed',
            `Phone call task ${id} completed: ${outcome}`,
            { case_id: task.case_id, outcome, notes }
        );

        // Sync to Notion
        try {
            const notionService = require('../services/notion-service');
            await notionService.syncStatusToNotion(task.case_id);
        } catch (err) {
            console.warn('Failed to sync phone call completion to Notion:', err.message);
        }

        res.json({ success: true, message: 'Task completed', task: updated });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * POST /phone-calls/:id/skip
 * Skip/defer a phone call task
 * Body: { notes }
 */
router.post('/:id/skip', async (req, res) => {
    try {
        const id = parseInt(req.params.id);
        const { notes } = req.body;

        const task = await db.getPhoneCallById(id);
        if (!task) {
            return res.status(404).json({ success: false, error: 'Phone call task not found' });
        }

        const updated = await db.skipPhoneCall(id, notes);

        await db.logActivity('phone_call_skipped',
            `Phone call task ${id} skipped: ${notes || 'no reason'}`,
            { case_id: task.case_id }
        );

        res.json({ success: true, message: 'Task skipped', task: updated });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * POST /phone-calls/:id/briefing
 * Generate or retrieve cached AI call briefing
 * Query: ?force=true to regenerate
 */
router.post('/:id/briefing', async (req, res) => {
    try {
        const id = parseInt(req.params.id);
        const force = req.query.force === 'true';

        const task = await db.getPhoneCallById(id);
        if (!task) {
            return res.status(404).json({ success: false, error: 'Phone call task not found' });
        }

        // Return cached if available and not forcing regeneration
        if (task.ai_briefing && !force) {
            return res.json({ success: true, briefing: task.ai_briefing, cached: true });
        }

        // Load case data and messages
        const caseData = await db.getCaseById(task.case_id);
        if (!caseData) {
            return res.status(404).json({ success: false, error: 'Case not found' });
        }

        const messages = await db.getMessagesByCaseId(task.case_id, 20);

        const aiService = require('../services/ai-service');
        const briefing = await aiService.generatePhoneCallBriefing(task, caseData, messages);

        // Cache the briefing
        await db.updatePhoneCallBriefing(id, briefing);

        res.json({ success: true, briefing, cached: false });
    } catch (error) {
        console.error('Error generating briefing:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

module.exports = router;
