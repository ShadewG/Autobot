const express = require('express');
const bcrypt = require('bcryptjs');
const router = express.Router();
const db = require('../services/database');
const { PORTAL_SESSION_MAX_AGE_MS, buildPortalRedirectUrl, normalizeNextPath, verifyPortalHandoffToken } = require('../lib/portal-auth');

const COOKIE_NAME = 'autobot_uid';
const COOKIE_MAX_AGE = PORTAL_SESSION_MAX_AGE_MS;

/**
 * POST /login — Verify password and set signed cookie
 */
router.post('/login', async (req, res) => {
    try {
        const { name, password } = req.body || {};

        if (!name || !password) {
            return res.status(400).json({ success: false, error: 'Name and password are required' });
        }

        // Match by name (case-insensitive) — small team, names are unique
        const result = await db.query(
            'SELECT id, name, email, password_hash, is_admin FROM users WHERE LOWER(name) = LOWER($1) AND active = true',
            [name.trim()]
        );
        const user = result.rows[0];

        if (!user || !user.password_hash) {
            return res.status(401).json({ success: false, error: 'Invalid credentials' });
        }

        const valid = await bcrypt.compare(password, user.password_hash);
        if (!valid) {
            return res.status(401).json({ success: false, error: 'Invalid credentials' });
        }

        // Set signed HttpOnly cookie
        res.cookie(COOKIE_NAME, String(user.id), {
            signed: true,
            httpOnly: true,
            sameSite: 'lax',
            maxAge: COOKIE_MAX_AGE,
            secure: process.env.NODE_ENV === 'production',
        });

        res.json({ success: true, user: { id: user.id, name: user.name, email: user.email, is_admin: !!user.is_admin } });
    } catch (error) {
        console.error('Login error:', error);
        res.status(500).json({ success: false, error: 'Login failed' });
    }
});

/**
 * GET /me — Return current user from cookie
 */
router.get('/me', async (req, res) => {
    try {
        const userId = req.signedCookies?.[COOKIE_NAME];
        if (!userId) {
            return res.status(401).json({ success: false, error: 'Not authenticated', redirectTo: buildPortalRedirectUrl(req, '/gated') });
        }

        const user = await db.getUserById(parseInt(userId));
        if (!user || !user.active) {
            res.clearCookie(COOKIE_NAME);
            return res.status(401).json({ success: false, error: 'Not authenticated', redirectTo: buildPortalRedirectUrl(req, '/gated') });
        }

        res.json({ success: true, user: { id: user.id, name: user.name, email: user.email, is_admin: !!user.is_admin } });
    } catch (error) {
        console.error('Auth check error:', error);
        res.status(500).json({ success: false, error: 'Auth check failed' });
    }
});


router.get('/portal', async (req, res) => {
    try {
        const portalToken = req.query.portal_token;
        if (!portalToken || typeof portalToken !== 'string') {
            return res.status(400).json({ success: false, error: 'Missing portal_token' });
        }

        const payload = await verifyPortalHandoffToken(portalToken);

        let user = null;
        if (payload.appUserId) {
            user = await db.getUserById(parseInt(payload.appUserId, 10));
        }

        if (!user && payload.email) {
            const result = await db.query(
                'SELECT id, name, email, password_hash, is_admin, active FROM users WHERE LOWER(email) = LOWER($1) AND active = true',
                [payload.email]
            );
            if (result.rows.length === 1) {
                user = result.rows[0];
            }
        }

        if (!user || !user.active) {
            return res.status(409).json({
                success: false,
                linkRequired: true,
                email: payload.email || null,
                username: payload.username || null,
            });
        }

        res.cookie(COOKIE_NAME, String(user.id), {
            signed: true,
            httpOnly: true,
            sameSite: 'lax',
            maxAge: COOKIE_MAX_AGE,
            secure: process.env.NODE_ENV === 'production',
        });

        return res.redirect(302, normalizeNextPath(req.query.next));
    } catch (error) {
        console.error('Portal auth error:', error);
        return res.status(401).json({ success: false, error: 'Invalid portal token' });
    }
});

/**
 * POST /logout — Clear auth cookie
 */
router.post('/logout', (req, res) => {
    res.clearCookie(COOKIE_NAME);
    res.json({ success: true });
});

module.exports = router;
