const express = require('express');
const router = express.Router();
const db = require('../services/database');
const logger = require('../services/logger');

/**
 * GET /api/feedback
 * List feedback items (bug reports + feature requests)
 */
router.get('/', async (req, res) => {
    try {
        const { type, status, case_id, limit = 50, offset = 0 } = req.query;
        const clauses = [];
        const values = [];

        if (type) {
            values.push(type);
            clauses.push(`type = $${values.length}`);
        }
        if (status) {
            values.push(status);
            clauses.push(`status = $${values.length}`);
        }
        if (case_id) {
            values.push(parseInt(case_id));
            clauses.push(`case_id = $${values.length}`);
        }

        const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
        values.push(Math.min(parseInt(limit) || 50, 200));
        values.push(parseInt(offset) || 0);

        const result = await db.query(
            `SELECT f.*, u.email as creator_email_from_user
             FROM user_feedback f
             LEFT JOIN users u ON u.id = f.created_by
             ${where}
             ORDER BY f.created_at DESC
             LIMIT $${values.length - 1} OFFSET $${values.length}`,
            values
        );

        const countResult = await db.query(
            `SELECT COUNT(*)::int as total FROM user_feedback ${where}`,
            values.slice(0, -2)
        );

        res.json({
            success: true,
            items: result.rows,
            total: countResult.rows[0]?.total || 0,
        });
    } catch (err) {
        logger.error('Failed to list feedback', { error: err.message });
        res.status(500).json({ success: false, error: err.message });
    }
});

/**
 * POST /api/feedback
 * Submit a bug report or feature request
 */
router.post('/', async (req, res) => {
    try {
        const { type, title, description, priority, case_id } = req.body;

        if (!type || !['bug_report', 'feature_request'].includes(type)) {
            return res.status(400).json({ success: false, error: 'type must be bug_report or feature_request' });
        }
        if (!title || !title.trim()) {
            return res.status(400).json({ success: false, error: 'title is required' });
        }
        if (!description || !description.trim()) {
            return res.status(400).json({ success: false, error: 'description is required' });
        }

        const userId = req.user?.id || null;
        const userEmail = req.user?.email || null;

        const result = await db.query(
            `INSERT INTO user_feedback (type, title, description, priority, case_id, created_by, created_by_email, metadata)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
             RETURNING *`,
            [
                type,
                title.trim().slice(0, 200),
                description.trim(),
                ['low', 'medium', 'high', 'critical'].includes(priority) ? priority : 'medium',
                case_id ? parseInt(case_id) : null,
                userId,
                userEmail,
                JSON.stringify({ user_agent: req.headers['user-agent'] || null }),
            ]
        );

        await db.logActivity(
            type === 'bug_report' ? 'bug_report_submitted' : 'feature_request_submitted',
            `${type === 'bug_report' ? 'Bug report' : 'Feature request'}: ${title.trim().slice(0, 100)}`,
            {
                case_id: case_id ? parseInt(case_id) : null,
                feedback_id: result.rows[0].id,
                actor_type: 'human',
                actor_id: userId,
                source_service: 'dashboard',
            }
        );

        res.status(201).json({ success: true, feedback: result.rows[0] });
    } catch (err) {
        logger.error('Failed to submit feedback', { error: err.message });
        res.status(500).json({ success: false, error: err.message });
    }
});

/**
 * PATCH /api/feedback/:id
 * Update feedback status (admin)
 */
router.patch('/:id', async (req, res) => {
    try {
        const feedbackId = parseInt(req.params.id);
        const { status, resolved_notes } = req.body;

        const sets = ['updated_at = NOW()'];
        const values = [];

        if (status) {
            if (!['open', 'in_progress', 'resolved', 'closed', 'wont_fix'].includes(status)) {
                return res.status(400).json({ success: false, error: 'Invalid status' });
            }
            values.push(status);
            sets.push(`status = $${values.length}`);
            if (['resolved', 'closed', 'wont_fix'].includes(status)) {
                sets.push('resolved_at = NOW()');
            }
        }
        if (resolved_notes !== undefined) {
            values.push(resolved_notes);
            sets.push(`resolved_notes = $${values.length}`);
        }

        values.push(feedbackId);
        const result = await db.query(
            `UPDATE user_feedback SET ${sets.join(', ')} WHERE id = $${values.length} RETURNING *`,
            values
        );

        if (!result.rows.length) {
            return res.status(404).json({ success: false, error: 'Feedback not found' });
        }

        res.json({ success: true, feedback: result.rows[0] });
    } catch (err) {
        logger.error('Failed to update feedback', { error: err.message });
        res.status(500).json({ success: false, error: err.message });
    }
});

/**
 * GET /api/changelog
 * List changelog entries
 */
router.get('/changelog', async (req, res) => {
    try {
        const { limit = 50 } = req.query;
        const result = await db.query(
            `SELECT * FROM changelog_entries ORDER BY created_at DESC LIMIT $1`,
            [Math.min(parseInt(limit) || 50, 200)]
        );
        res.json({ success: true, entries: result.rows });
    } catch (err) {
        logger.error('Failed to list changelog', { error: err.message });
        res.status(500).json({ success: false, error: err.message });
    }
});

/**
 * POST /api/changelog
 * Add a changelog entry (admin)
 */
router.post('/changelog', async (req, res) => {
    try {
        const { version, title, description, category } = req.body;
        if (!title || !description) {
            return res.status(400).json({ success: false, error: 'title and description are required' });
        }

        const result = await db.query(
            `INSERT INTO changelog_entries (version, title, description, category)
             VALUES ($1, $2, $3, $4)
             RETURNING *`,
            [
                version || null,
                title.trim().slice(0, 200),
                description.trim(),
                ['feature', 'fix', 'improvement', 'breaking'].includes(category) ? category : 'improvement',
            ]
        );

        res.status(201).json({ success: true, entry: result.rows[0] });
    } catch (err) {
        logger.error('Failed to add changelog entry', { error: err.message });
        res.status(500).json({ success: false, error: err.message });
    }
});

module.exports = router;
