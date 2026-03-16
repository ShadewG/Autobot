const express = require('express');
const bcrypt = require('bcryptjs');
const router = express.Router();
const db = require('../services/database');
const { PORTAL_SESSION_MAX_AGE_MS, buildPortalRedirectUrl, normalizeNextPath, verifyPortalHandoffToken } = require('../lib/portal-auth');

const COOKIE_NAME = 'autobot_uid';
const COOKIE_MAX_AGE = PORTAL_SESSION_MAX_AGE_MS;
const PORTAL_PROVIDER = 'portal';

function setAuthCookie(res, userId) {
    res.cookie(COOKIE_NAME, String(userId), {
        signed: true,
        httpOnly: true,
        sameSite: 'lax',
        maxAge: COOKIE_MAX_AGE,
        secure: process.env.NODE_ENV === 'production',
    });
}

function serializeUser(user) {
    return {
        id: user.id,
        name: user.name,
        email: user.email,
        email_handle: user.email_handle,
        is_admin: !!user.is_admin,
    };
}

function isValidHandle(handle) {
    return /^[a-z0-9][a-z0-9-]{0,48}[a-z0-9]$/.test(handle) || /^[a-z0-9]{2}$/.test(handle);
}

function sanitizePortalPayload(payload) {
    return {
        portal_user_id: payload.portalUserId || null,
        discord_id: payload.discordId || null,
        email: payload.email || null,
        username: payload.username || null,
        app_user_id: payload.appUserId || null,
        suggested_handle: payload.email
            ? String(payload.email).split('@')[0].toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/^-+|-+$/g, '').slice(0, 50) || null
            : null,
    };
}

async function resolvePortalUserFromPayload(payload) {
    const linked = await db.getUserIdentityLink(PORTAL_PROVIDER, String(payload.portalUserId));
    if (linked?.user_id) {
        const user = await db.getUserById(linked.user_id);
        if (user?.active) {
            return { user, link: linked, source: 'identity_link' };
        }
    }

    const discordLinked = await db.getUserIdentityLinkByDiscord(PORTAL_PROVIDER, String(payload.discordId));
    if (discordLinked?.user_id) {
        const user = await db.getUserById(discordLinked.user_id);
        if (user?.active) {
            return { user, link: discordLinked, source: 'discord_link' };
        }
    }

    if (payload.appUserId) {
        const user = await db.getUserById(parseInt(payload.appUserId, 10));
        if (user?.active) {
            return { user, link: null, source: 'app_user_id' };
        }
    }

    return { user: null, link: null, source: null };
}

async function attachPortalIdentityToUser(user, payload) {
    return db.upsertUserIdentityLink({
        user_id: user.id,
        provider: PORTAL_PROVIDER,
        provider_user_id: String(payload.portalUserId),
        provider_email: payload.email || null,
        provider_username: payload.username || null,
        discord_id: payload.discordId || null,
    });
}

async function authenticateByNameAndPassword(name, password) {
    const result = await db.query(
        'SELECT id, name, email, email_handle, password_hash, is_admin, active FROM users WHERE LOWER(name) = LOWER($1) AND active = true',
        [name.trim()]
    );
    const user = result.rows[0];
    if (!user || !user.password_hash) return null;
    const valid = await bcrypt.compare(password, user.password_hash);
    return valid ? user : null;
}

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
        setAuthCookie(res, user.id);

        res.json({ success: true, user: serializeUser(user) });
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

        res.json({ success: true, user: serializeUser(user) });
    } catch (error) {
        console.error('Auth check error:', error);
        res.status(500).json({ success: false, error: 'Auth check failed' });
    }
});

router.get('/portal/pending', async (req, res) => {
    try {
        const portalToken = req.query.portal_token;
        if (!portalToken || typeof portalToken !== 'string') {
            return res.status(400).json({ success: false, error: 'Missing portal_token' });
        }

        const payload = await verifyPortalHandoffToken(portalToken);
        const portal = sanitizePortalPayload(payload);
        const resolved = await resolvePortalUserFromPayload(payload);

        const emailMatchedUser = !resolved.user && payload.email
            ? await db.getUserByEmail(String(payload.email).toLowerCase())
            : null;

        return res.json({
            success: true,
            linked: !!resolved.user,
            linkRequired: !resolved.user,
            portal,
            user: resolved.user ? serializeUser(resolved.user) : null,
            suggested_existing_user: emailMatchedUser?.active ? serializeUser(emailMatchedUser) : null,
        });
    } catch (error) {
        console.error('Portal pending auth error:', error);
        return res.status(401).json({ success: false, error: 'Invalid portal token' });
    }
});


router.get('/portal', async (req, res) => {
    try {
        const portalToken = req.query.portal_token;
        if (!portalToken || typeof portalToken !== 'string') {
            return res.status(400).json({ success: false, error: 'Missing portal_token' });
        }

        const payload = await verifyPortalHandoffToken(portalToken);
        const resolved = await resolvePortalUserFromPayload(payload);
        let user = resolved.user;

        if (!user || !user.active) {
            // Redirect to frontend link page instead of returning JSON
            const next = normalizeNextPath(req.query.next);
            return res.redirect(302, `/portal-link?portal_token=${encodeURIComponent(portalToken)}&next=${encodeURIComponent(next)}`);
        }

        await attachPortalIdentityToUser(user, payload);
        setAuthCookie(res, user.id);

        return res.redirect(302, normalizeNextPath(req.query.next));
    } catch (error) {
        console.error('Portal auth error:', error);
        return res.status(401).json({ success: false, error: 'Invalid portal token' });
    }
});

router.post('/portal/link-existing', express.json(), async (req, res) => {
    try {
        const { portal_token: portalToken, name, password } = req.body || {};
        if (!portalToken || typeof portalToken !== 'string') {
            return res.status(400).json({ success: false, error: 'Missing portal_token' });
        }

        const payload = await verifyPortalHandoffToken(portalToken);

        let user = null;
        const currentUserId = req.signedCookies?.[COOKIE_NAME];
        if (currentUserId) {
            user = await db.getUserById(parseInt(currentUserId, 10));
        }

        if (!user) {
            if (!name || !password) {
                return res.status(400).json({ success: false, error: 'Name and password are required' });
            }
            user = await authenticateByNameAndPassword(name, password);
        }

        if (!user || !user.active) {
            return res.status(401).json({ success: false, error: 'Invalid credentials' });
        }

        await attachPortalIdentityToUser(user, payload);
        setAuthCookie(res, user.id);

        return res.json({ success: true, user: serializeUser(user), linked: true });
    } catch (error) {
        console.error('Portal link-existing error:', error);
        return res.status(401).json({ success: false, error: 'Invalid portal token' });
    }
});

router.post('/portal/create-account', express.json(), async (req, res) => {
    try {
        const { portal_token: portalToken, name, email_handle: emailHandle, password, ...profile } = req.body || {};
        if (!portalToken || typeof portalToken !== 'string') {
            return res.status(400).json({ success: false, error: 'Missing portal_token' });
        }
        if (!name?.trim()) {
            return res.status(400).json({ success: false, error: 'Name required' });
        }
        if (!emailHandle?.trim()) {
            return res.status(400).json({ success: false, error: 'Email handle required' });
        }
        if (!password || String(password).length < 4) {
            return res.status(400).json({ success: false, error: 'Password must be at least 4 characters' });
        }

        const handle = String(emailHandle).toLowerCase().trim();
        if (!isValidHandle(handle)) {
            return res.status(400).json({ success: false, error: 'Invalid handle format' });
        }

        const existing = await db.getUserByHandle(handle);
        if (existing) {
            return res.status(409).json({ success: false, error: `Handle "${handle}" taken` });
        }

        const payload = await verifyPortalHandoffToken(portalToken);
        const user = await db.createUser({
            name: name.trim(),
            email_handle: handle,
        });

        const hash = await bcrypt.hash(password, 10);
        await db.query('UPDATE users SET password_hash = $1 WHERE id = $2', [hash, user.id]);

        const profileUpdates = {};
        for (const field of [
            'signature_name', 'signature_title', 'signature_phone', 'signature_organization',
            'address_street', 'address_street2', 'address_city', 'address_state', 'address_zip',
            'notion_name', 'default_autopilot_mode'
        ]) {
            if (profile[field] !== undefined) {
                profileUpdates[field] = profile[field];
            }
        }
        if (Object.keys(profileUpdates).length > 0) {
            await db.updateUser(user.id, profileUpdates);
        }

        const createdUser = await db.getUserById(user.id);
        await attachPortalIdentityToUser(createdUser, payload);
        setAuthCookie(res, createdUser.id);

        return res.status(201).json({ success: true, user: serializeUser(createdUser), linked: true, created: true });
    } catch (error) {
        console.error('Portal create-account error:', error);
        if (error.code === '23505') {
            return res.status(409).json({ success: false, error: 'Identity or handle already exists' });
        }
        if (error.message === 'Invalid handle format' || error.message === 'Portal token app mismatch' || error.message === 'Portal token missing required claims' || error.name === 'JWSSignatureVerificationFailed') {
            return res.status(401).json({ success: false, error: 'Invalid portal token' });
        }
        return res.status(500).json({ success: false, error: error.message || 'Failed to create account' });
    }
});

/**
 * POST /logout — Clear auth cookie
 */
router.post('/logout', (req, res) => {
    res.clearCookie(COOKIE_NAME);
    res.json({ success: true });
});

/**
 * GET /test-login — Playwright / automated test login
 * Gated by TEST_AUTH_SECRET env var. Sets auth cookie for user id=3 (Sam)
 * and redirects to ?next= path.
 *
 * Usage: /api/auth/test-login?secret=<TEST_AUTH_SECRET>&next=/requests/detail-v2?id=25206
 */
router.get('/test-login', async (req, res) => {
    const secret = process.env.TEST_AUTH_SECRET;
    if (!secret || req.query.secret !== secret) {
        return res.status(403).json({ success: false, error: 'Forbidden' });
    }
    const userId = parseInt(req.query.user_id, 10) || 3;
    const user = await db.getUserById(userId);
    if (!user?.active) {
        return res.status(404).json({ success: false, error: 'User not found' });
    }
    setAuthCookie(res, user.id);
    const next = normalizeNextPath(req.query.next);
    return res.redirect(302, next);
});

module.exports = router;
