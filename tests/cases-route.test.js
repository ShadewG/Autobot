const assert = require('assert');
const express = require('express');
const supertest = require('supertest');

const casesRouter = require('../routes/cases');
const db = require('../services/database');

describe('Cases route programmatic creation', function () {
  let originalCreateCase;
  let originalLogActivity;
  let originalServiceKey;

  beforeEach(function () {
    originalCreateCase = db.createCase;
    originalLogActivity = db.logActivity;
    originalServiceKey = process.env.FOIA_SERVICE_KEY;
    process.env.FOIA_SERVICE_KEY = 'test-service-key';
  });

  afterEach(function () {
    db.createCase = originalCreateCase;
    db.logActivity = originalLogActivity;
    process.env.FOIA_SERVICE_KEY = originalServiceKey;
  });

  it('creates a case via POST /api/cases with a valid service key', async function () {
    db.createCase = async (payload) => ({
      id: 991,
      notion_page_id: payload.notion_page_id,
      case_name: payload.case_name,
      subject_name: payload.subject_name,
      agency_name: payload.agency_name,
      agency_email: payload.agency_email,
      portal_url: payload.portal_url,
      state: payload.state,
      status: payload.status,
    });
    db.logActivity = async () => ({ id: 1 });

    const app = express();
    app.use(express.json());
    app.use('/api/cases', casesRouter);

    const response = await supertest(app)
      .post('/api/cases')
      .set('X-Service-Key', 'test-service-key')
      .send({
        case_name: 'API Created QA Case',
        subject_name: 'Jordan Example',
        agency_name: 'Example Police Department, Texas',
        agency_email: 'records@example.gov',
        status: 'ready_to_send',
      });

    assert.strictEqual(response.status, 201);
    assert.strictEqual(response.body.success, true);
    assert.strictEqual(response.body.case.case_name, 'API Created QA Case');
    assert.match(response.body.case.notion_page_id, /^[a-f0-9]{32}$/);
    assert.strictEqual(response.body.case.state, 'TX');
  });

  it('rejects requests without a valid service key', async function () {
    const app = express();
    app.use(express.json());
    app.use('/api/cases', casesRouter);

    const response = await supertest(app)
      .post('/api/cases')
      .send({
        case_name: 'Blocked Case',
        subject_name: 'Jordan Example',
        agency_name: 'Example Police Department',
        agency_email: 'records@example.gov',
      });

    assert.strictEqual(response.status, 401);
    assert.strictEqual(response.body.success, false);
  });
});
