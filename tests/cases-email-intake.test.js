const assert = require('assert');
const express = require('express');
const supertest = require('supertest');

const casesRouter = require('../routes/cases');
const db = require('../services/database');

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/cases', casesRouter);
  return app;
}

describe('Cases route email intake', function () {
  let originalGetCaseByNotionId;
  let originalCreateCase;
  let originalLogActivity;
  let originalServiceKey;

  beforeEach(function () {
    originalGetCaseByNotionId = db.getCaseByNotionId;
    originalCreateCase = db.createCase;
    originalLogActivity = db.logActivity;
    originalServiceKey = process.env.FOIA_SERVICE_KEY;
    process.env.FOIA_SERVICE_KEY = 'test-service-key';
  });

  afterEach(function () {
    db.getCaseByNotionId = originalGetCaseByNotionId;
    db.createCase = originalCreateCase;
    db.logActivity = originalLogActivity;
    process.env.FOIA_SERVICE_KEY = originalServiceKey;
  });

  it('creates a human-review case from a forwarded email body URL', async function () {
    let createdPayload = null;
    let activityCall = null;

    db.getCaseByNotionId = async () => null;
    db.createCase = async (payload) => {
      createdPayload = payload;
      return {
        id: 771,
        notion_page_id: payload.notion_page_id,
        case_name: payload.case_name,
        subject_name: payload.subject_name,
        agency_name: payload.agency_name,
        state: payload.state,
        status: payload.status,
      };
    };
    db.logActivity = async (type, message, metadata) => {
      activityCall = { type, message, metadata };
      return { id: 1 };
    };

    const response = await supertest(createApp())
      .post('/api/cases/email-intake')
      .set('X-Service-Key', 'test-service-key')
      .send({
        forwarded_subject: 'Fwd: Officer-involved shooting article',
        forwarded_body_text: 'Please review this story: https://example.com/news/story-123',
        forwarded_from: 'reporter@example.com',
        agency_name: 'Example Police Department, Texas',
        tags: ['qa'],
        priority: 2,
        user_id: 42,
      });

    assert.strictEqual(response.status, 201);
    assert.strictEqual(response.body.success, true);
    assert.strictEqual(response.body.case_id, 771);
    assert.strictEqual(response.body.case.case_name, 'Officer-involved shooting article');
    assert.strictEqual(response.body.case.subject_name, 'Officer-involved shooting article');
    assert.strictEqual(response.body.case.agency_name, 'Example Police Department, Texas');
    assert.strictEqual(response.body.case.state, 'TX');
    assert.strictEqual(response.body.case.status, 'needs_human_review');

    assert.ok(createdPayload);
    assert.match(createdPayload.notion_page_id, /^[a-f0-9]{32}$/);
    assert.deepStrictEqual(createdPayload.requested_records, ['Review forwarded article and create request strategy']);
    assert.strictEqual(createdPayload.status, 'needs_human_review');
    assert.deepStrictEqual(createdPayload.tags.sort(), ['qa', 'source:email_intake']);
    assert.match(createdPayload.additional_details, /Source article: https:\/\/example.com\/news\/story-123/);
    assert.match(createdPayload.additional_details, /Forwarded from: reporter@example.com/);
    assert.match(createdPayload.additional_details, /Forwarded subject: Officer-involved shooting article/);

    assert.deepStrictEqual(activityCall, {
      type: 'case_created_email_intake',
      message: 'Created case "Officer-involved shooting article" from forwarded article email',
      metadata: {
        case_id: 771,
        actor_type: 'system',
        source_service: 'email_intake',
        source_article_url: 'https://example.com/news/story-123',
        forwarded_from: 'reporter@example.com',
      },
    });
  });

  it('deduplicates by source article id or URL', async function () {
    db.getCaseByNotionId = async () => ({
      id: 882,
      notion_page_id: 'abc123abc123abc123abc123abc123ab',
      case_name: 'Existing Intake Case',
      subject_name: 'Existing Subject',
      agency_name: 'Unknown agency',
      state: 'GA',
      status: 'needs_human_review',
    });

    let createCalled = false;
    db.createCase = async () => {
      createCalled = true;
      throw new Error('should not create duplicate');
    };
    db.logActivity = async () => ({ id: 1 });

    const response = await supertest(createApp())
      .post('/api/cases/email-intake')
      .set('X-Service-Key', 'test-service-key')
      .send({
        forwarded_subject: 'FW: Existing story',
        forwarded_body_text: 'Story link https://example.com/already-seen',
      });

    assert.strictEqual(response.status, 200);
    assert.strictEqual(response.body.success, true);
    assert.strictEqual(response.body.message, 'Case already exists (dedup)');
    assert.strictEqual(response.body.case_id, 882);
    assert.strictEqual(createCalled, false);
  });

  it('rejects email intake without a source article URL', async function () {
    db.getCaseByNotionId = async () => null;
    db.createCase = async () => {
      throw new Error('should not create without URL');
    };
    db.logActivity = async () => ({ id: 1 });

    const response = await supertest(createApp())
      .post('/api/cases/email-intake')
      .set('X-Service-Key', 'test-service-key')
      .send({
        forwarded_subject: 'Fwd: Missing URL example',
        forwarded_body_text: 'No link included here',
      });

    assert.strictEqual(response.status, 400);
    assert.strictEqual(response.body.success, false);
    assert.match(response.body.error, /source article URL/i);
  });

  it('rejects email intake requests without a valid service key', async function () {
    const response = await supertest(createApp())
      .post('/api/cases/email-intake')
      .send({
        forwarded_subject: 'Fwd: Story',
        forwarded_body_text: 'https://example.com/story',
      });

    assert.strictEqual(response.status, 401);
    assert.strictEqual(response.body.success, false);
  });
});
