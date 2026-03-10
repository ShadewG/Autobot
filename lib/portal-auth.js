const PORTAL_BASE_URL_FALLBACK = 'https://portal-production-fa69.up.railway.app';
const PORTAL_APP_ID = 'autobot';
const PORTAL_SESSION_MAX_AGE_MS = 365 * 24 * 60 * 60 * 1000;

function normalizeNextPath(nextPath) {
  if (!nextPath || typeof nextPath !== 'string') return '/gated';
  if (!nextPath.startsWith('/')) return '/gated';
  if (nextPath.startsWith('//')) return '/gated';
  return nextPath;
}

function getPortalSecret() {
  if (!process.env.PORTAL_JWT_SECRET) {
    throw new Error('PORTAL_JWT_SECRET is not configured');
  }
  return new TextEncoder().encode(process.env.PORTAL_JWT_SECRET);
}

function getPortalBaseUrl() {
  return (process.env.PORTAL_BASE_URL || PORTAL_BASE_URL_FALLBACK).replace(/\/$/, '');
}

function getRequestOrigin(req) {
  const forwardedProto = req.get('x-forwarded-proto');
  const forwardedHost = req.get('x-forwarded-host');
  if (forwardedProto && forwardedHost) {
    return `${forwardedProto}://${forwardedHost}`;
  }
  return `${req.protocol}://${req.get('host')}`;
}

function buildPortalRedirectUrl(req, nextPath) {
  const redirectUrl = new URL('/api/auth/redirect', getPortalBaseUrl());
  redirectUrl.searchParams.set('app', PORTAL_APP_ID);
  redirectUrl.searchParams.set('returnTo', getRequestOrigin(req));
  redirectUrl.searchParams.set('next', normalizeNextPath(nextPath || req.originalUrl || req.url));
  return redirectUrl.toString();
}

async function loadJose() {
  return import('jose');
}

async function verifyPortalHandoffToken(token) {
  const { jwtVerify } = await loadJose();
  const { payload } = await jwtVerify(token, getPortalSecret(), { algorithms: ['HS256'] });
  if (payload.appId !== PORTAL_APP_ID) throw new Error('Portal token app mismatch');
  if (!payload.portalUserId || !payload.discordId) {
    throw new Error('Portal token missing required claims');
  }
  return payload;
}

module.exports = {
  PORTAL_APP_ID,
  PORTAL_SESSION_MAX_AGE_MS,
  buildPortalRedirectUrl,
  normalizeNextPath,
  verifyPortalHandoffToken,
};
