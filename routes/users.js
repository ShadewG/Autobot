const express = require('express');
const router = express.Router();
const db = require('../services/database');

// Validation: lowercase alphanumeric + hyphens, 2-50 chars
function isValidHandle(handle) {
    return /^[a-z0-9][a-z0-9-]{0,48}[a-z0-9]$/.test(handle) || /^[a-z0-9]{2}$/.test(handle);
}

/**
 * GET / — List all users
 */
router.get('/', async (req, res) => {
    try {
        const activeOnly = req.query.active !== 'false';
        const users = await db.listUsers(activeOnly);

        // Attach case counts
        const counts = await db.query(`
            SELECT user_id, COUNT(*)::int AS case_count
            FROM cases
            WHERE user_id IS NOT NULL
            GROUP BY user_id
        `);
        const countMap = {};
        for (const row of counts.rows) {
            countMap[row.user_id] = row.case_count;
        }

        const enriched = users.map(u => ({
            ...u,
            case_count: countMap[u.id] || 0
        }));

        res.json({ success: true, users: enriched });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * POST / — Create user
 */
router.post('/', express.json(), async (req, res) => {
    try {
        const { name, email_handle } = req.body || {};

        if (!name || !name.trim()) {
            return res.status(400).json({ success: false, error: 'name is required' });
        }

        const handle = (email_handle || '').toLowerCase().trim();
        if (!isValidHandle(handle)) {
            return res.status(400).json({
                success: false,
                error: 'email_handle must be 2-50 lowercase alphanumeric characters or hyphens'
            });
        }

        // Check uniqueness
        const existing = await db.getUserByHandle(handle);
        if (existing) {
            return res.status(409).json({ success: false, error: `Handle "${handle}" is already taken` });
        }

        const user = await db.createUser({ name: name.trim(), email_handle: handle });
        res.status(201).json({ success: true, user });
    } catch (error) {
        if (error.code === '23505') {
            return res.status(409).json({ success: false, error: 'Handle already exists' });
        }
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * GET /:id — Get user by ID (with case count)
 */
router.get('/:id', async (req, res) => {
    try {
        const user = await db.getUserById(parseInt(req.params.id));
        if (!user) {
            return res.status(404).json({ success: false, error: 'User not found' });
        }

        const countResult = await db.query(
            'SELECT COUNT(*)::int AS case_count FROM cases WHERE user_id = $1',
            [user.id]
        );

        res.json({
            success: true,
            user: {
                ...user,
                case_count: countResult.rows[0]?.case_count || 0
            }
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * PATCH /:id — Update user
 */
router.patch('/:id', express.json(), async (req, res) => {
    try {
        const id = parseInt(req.params.id);
        const user = await db.getUserById(id);
        if (!user) {
            return res.status(404).json({ success: false, error: 'User not found' });
        }

        const updates = {};
        if (req.body.name !== undefined) {
            if (!req.body.name.trim()) {
                return res.status(400).json({ success: false, error: 'name cannot be empty' });
            }
            updates.name = req.body.name.trim();
        }
        if (req.body.email_handle !== undefined) {
            const handle = req.body.email_handle.toLowerCase().trim();
            if (!isValidHandle(handle)) {
                return res.status(400).json({
                    success: false,
                    error: 'email_handle must be 2-50 lowercase alphanumeric characters or hyphens'
                });
            }
            const existing = await db.getUserByHandle(handle);
            if (existing && existing.id !== id) {
                return res.status(409).json({ success: false, error: `Handle "${handle}" is already taken` });
            }
            updates.email_handle = handle;
        }
        if (req.body.active !== undefined) {
            updates.active = !!req.body.active;
        }
        if (req.body.signature_name !== undefined) {
            updates.signature_name = req.body.signature_name.trim() || null;
        }
        if (req.body.signature_title !== undefined) {
            updates.signature_title = req.body.signature_title.trim() || null;
        }
        if (req.body.signature_phone !== undefined) {
            updates.signature_phone = req.body.signature_phone.trim() || null;
        }

        const updated = await db.updateUser(id, updates);
        res.json({ success: true, user: updated });
    } catch (error) {
        if (error.code === '23505') {
            return res.status(409).json({ success: false, error: 'Handle already exists' });
        }
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * DELETE /:id — Soft delete (deactivate)
 */
router.delete('/:id', async (req, res) => {
    try {
        const id = parseInt(req.params.id);
        const user = await db.getUserById(id);
        if (!user) {
            return res.status(404).json({ success: false, error: 'User not found' });
        }

        // Check for active cases
        const activeResult = await db.query(
            `SELECT COUNT(*)::int AS count FROM cases
             WHERE user_id = $1 AND status NOT IN ('completed', 'closed', 'records_received')`,
            [id]
        );
        if (activeResult.rows[0]?.count > 0) {
            return res.status(409).json({
                success: false,
                error: `Cannot deactivate user with ${activeResult.rows[0].count} active case(s)`
            });
        }

        const deactivated = await db.deactivateUser(id);
        res.json({ success: true, user: deactivated });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

module.exports = router;
