const assert = require('assert');
const express = require('express');
const cookieParser = require('cookie-parser');
const bcrypt = require('bcryptjs');
const supertest = require('supertest');
const { SignJWT } = require('jose');

const router = require('../routes/auth');
const db = require('../services/database');

async function createPortalToken(payload) {
  process.env.PORTAL_JWT_SECRET = process.env.PORTAL_JWT_SECRET || 'test-portal-secret';
  const secret = new TextEncoder().encode(process.env.PORTAL_JWT_SECRET);
  return await new SignJWT({ ...payload, appId: 'autobot' })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(secret);
}

function createApp() {
  const app = express();
  app.use(cookieParser('test-cookie-secret'));
  app.use('/api/auth', router);
  return app;
}

describe('Portal auth onboarding', function () {
  let originals = {};

  beforeEach(function () {
    originals = {
      getUserIdentityLink: db.getUserIdentityLink,
      getUserIdentityLinkByDiscord: db.getUserIdentityLinkByDiscord,
      getUserById: db.getUserById,
      getUserByEmail: db.getUserByEmail,
      getUserByHandle: db.getUserByHandle,
      createUser: db.createUser,
      updateUser: db.updateUser,
      upsertUserIdentityLink: db.upsertUserIdentityLink,
      query: db.query,
      enableTestLoginEndpoint: process.env.ENABLE_TEST_LOGIN_ENDPOINT,
      testAuthSecret: process.env.TEST_AUTH_SECRET,
      testAuthUserId: process.env.TEST_AUTH_USER_ID,
    };

    db.getUserIdentityLink = async () => null;
    db.getUserIdentityLinkByDiscord = async () => null;
    db.getUserById = async () => null;
    db.getUserByEmail = async () => null;
    db.getUserByHandle = async () => null;
    db.createUser = async () => null;
    db.updateUser = async () => null;
    db.upsertUserIdentityLink = async () => null;
    db.query = async () => ({ rows: [] });
  });

  afterEach(function () {
    Object.assign(db, originals);
    if (originals.enableTestLoginEndpoint === undefined) delete process.env.ENABLE_TEST_LOGIN_ENDPOINT;
    else process.env.ENABLE_TEST_LOGIN_ENDPOINT = originals.enableTestLoginEndpoint;
    if (originals.testAuthSecret === undefined) delete process.env.TEST_AUTH_SECRET;
    else process.env.TEST_AUTH_SECRET = originals.testAuthSecret;
    if (originals.testAuthUserId === undefined) delete process.env.TEST_AUTH_USER_ID;
    else process.env.TEST_AUTH_USER_ID = originals.testAuthUserId;
  });

  it('returns portal onboarding context and does not auto-link by email alone', async function () {
    const token = await createPortalToken({
      portalUserId: 'portal-123',
      discordId: 'discord-123',
      email: 'sam@example.com',
      username: 'sam',
    });

    db.getUserByEmail = async () => ({
      id: 7,
      name: 'Sam',
      email: 'sam@example.com',
      email_handle: 'sam',
      is_admin: false,
      active: true,
    });

    const response = await supertest(createApp())
      .get('/api/auth/portal/pending')
      .query({ portal_token: token });

    assert.strictEqual(response.status, 200);
    assert.strictEqual(response.body.success, true);
    assert.strictEqual(response.body.linkRequired, true);
    assert.strictEqual(response.body.linked, false);
    assert.strictEqual(response.body.portal.portal_user_id, 'portal-123');
    assert.strictEqual(response.body.suggested_existing_user.id, 7);
  });

  it('redirects first-time portal auth to onboarding instead of auto-login by email', async function () {
    const token = await createPortalToken({
      portalUserId: 'portal-123',
      discordId: 'discord-123',
      email: 'sam@example.com',
      username: 'sam',
    });

    db.getUserByEmail = async () => ({
      id: 7,
      name: 'Sam',
      email: 'sam@example.com',
      email_handle: 'sam',
      is_admin: false,
      active: true,
    });

    const response = await supertest(createApp())
      .get('/api/auth/portal')
      .query({ portal_token: token, next: '/gated' });

    assert.strictEqual(response.status, 302);
    assert.ok(response.headers.location.startsWith('/portal-link?'));
    assert.ok(response.headers.location.includes('portal_token='));
  });

  it('links an existing account using credentials and sets auth cookie', async function () {
    const token = await createPortalToken({
      portalUserId: 'portal-123',
      discordId: 'discord-123',
      email: 'sam@example.com',
      username: 'sam',
    });
    const hash = await bcrypt.hash('secret123', 10);
    let linkedPayload = null;

    db.query = async (sql) => {
      if (String(sql).includes('SELECT id, name, email, email_handle, password_hash, is_admin, active FROM users')) {
        return {
          rows: [{
            id: 7,
            name: 'Sam',
            email: 'sam@example.com',
            email_handle: 'sam',
            password_hash: hash,
            is_admin: false,
            active: true,
          }],
        };
      }
      return { rows: [] };
    };
    db.upsertUserIdentityLink = async (payload) => {
      linkedPayload = payload;
      return { id: 1, ...payload };
    };

    const response = await supertest(createApp())
      .post('/api/auth/portal/link-existing')
      .send({ portal_token: token, name: 'Sam', password: 'secret123' });

    assert.strictEqual(response.status, 200);
    assert.strictEqual(response.body.success, true);
    assert.strictEqual(response.body.user.id, 7);
    assert.strictEqual(linkedPayload.provider_user_id, 'portal-123');
    assert.ok((response.headers['set-cookie'] || []).some((value) => value.includes('autobot_uid=')));
  });

  it('creates a new linked account from portal onboarding', async function () {
    const token = await createPortalToken({
      portalUserId: 'portal-999',
      discordId: 'discord-999',
      email: 'new@example.com',
      username: 'newuser',
    });
    let createdArgs = null;
    let updatedPasswordFor = null;
    let linkedPayload = null;

    db.createUser = async (payload) => {
      createdArgs = payload;
      return {
        id: 42,
        name: payload.name,
        email_handle: payload.email_handle,
        email: `${payload.email_handle}@foib-request.com`,
        is_admin: false,
        active: true,
      };
    };
    db.query = async (sql, params) => {
      if (String(sql).startsWith('UPDATE users SET password_hash')) {
        updatedPasswordFor = params[1];
      }
      return { rows: [] };
    };
    db.getUserById = async () => ({
      id: 42,
      name: 'New User',
      email: 'new@example.com',
      email_handle: 'new-user',
      is_admin: false,
      active: true,
    });
    db.upsertUserIdentityLink = async (payload) => {
      linkedPayload = payload;
      return { id: 2, ...payload };
    };

    const response = await supertest(createApp())
      .post('/api/auth/portal/create-account')
      .send({
        portal_token: token,
        name: 'New User',
        email_handle: 'new-user',
        password: 'pass1234',
        signature_name: 'New User',
      });

    assert.strictEqual(response.status, 201);
    assert.strictEqual(response.body.success, true);
    assert.strictEqual(response.body.created, true);
    assert.strictEqual(createdArgs.email_handle, 'new-user');
    assert.strictEqual(updatedPasswordFor, 42);
    assert.strictEqual(linkedPayload.provider_user_id, 'portal-999');
    assert.ok((response.headers['set-cookie'] || []).some((value) => value.includes('autobot_uid=')));
  });

  it('returns 404 when test-login endpoint is disabled', async function () {
    delete process.env.ENABLE_TEST_LOGIN_ENDPOINT;
    process.env.TEST_AUTH_SECRET = 'test-auth-secret';

    const response = await supertest(createApp())
      .get('/api/auth/test-login')
      .query({ secret: 'test-auth-secret', user_id: 999, next: '/gated' });

    assert.strictEqual(response.status, 404);
    assert.strictEqual(response.body.success, false);
  });

  it('ignores user_id and uses the fixed configured test user for test-login', async function () {
    process.env.ENABLE_TEST_LOGIN_ENDPOINT = 'true';
    process.env.TEST_AUTH_SECRET = 'test-auth-secret';
    process.env.TEST_AUTH_USER_ID = '7';

    db.getUserById = async (userId) => ({
      id: userId,
      name: 'Sam',
      email: 'sam@example.com',
      email_handle: 'sam',
      is_admin: false,
      active: true,
    });

    const response = await supertest(createApp())
      .get('/api/auth/test-login')
      .query({ secret: 'test-auth-secret', user_id: 999, next: '/gated' });

    assert.strictEqual(response.status, 302);
    assert.strictEqual(response.headers.location, '/gated');
    assert.ok((response.headers['set-cookie'] || []).some((value) => value.includes('autobot_uid=s%3A7.')));
  });
});
