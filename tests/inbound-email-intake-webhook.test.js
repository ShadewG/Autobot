const assert = require('assert');
const express = require('express');
const supertest = require('supertest');

const webhookRoutes = require('../routes/webhooks');
const db = require('../services/database');
const sendgridService = require('../services/sendgrid-service');
const emailIntakeService = require('../services/email-intake-service');

describe('Inbound email intake webhook', function () {
  let originalLogActivity;
  let originalCreateMessage;
  let originalQuery;
  let originalProcessInboundEmail;
  let originalExtractEmail;
  let originalIsEmailIntakeRecipient;
  let originalCreateEmailIntakeCase;

  beforeEach(function () {
    originalLogActivity = db.logActivity;
    originalCreateMessage = db.createMessage;
    originalQuery = db.query;
    originalProcessInboundEmail = sendgridService.processInboundEmail;
    originalExtractEmail = sendgridService.extractEmail;
    originalIsEmailIntakeRecipient = emailIntakeService.isEmailIntakeRecipient;
    originalCreateEmailIntakeCase = emailIntakeService.createEmailIntakeCase;

    db.logActivity = async () => ({ id: 1 });
    db.createMessage = async () => ({ id: 777 });
    db.query = async () => ({ rows: [] });
    sendgridService.extractEmail = (value) => {
      const match = String(value || '').match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
      return match ? match[0].toLowerCase() : String(value || '').toLowerCase();
    };
  });

  afterEach(function () {
    db.logActivity = originalLogActivity;
    db.createMessage = originalCreateMessage;
    db.query = originalQuery;
    sendgridService.processInboundEmail = originalProcessInboundEmail;
    sendgridService.extractEmail = originalExtractEmail;
    emailIntakeService.isEmailIntakeRecipient = originalIsEmailIntakeRecipient;
    emailIntakeService.createEmailIntakeCase = originalCreateEmailIntakeCase;
  });

  function createApp() {
    const app = express();
    app.use('/webhooks', webhookRoutes);
    return app;
  }

  it('short-circuits inbound intake mailbox messages into case creation', async function () {
    let intakePayload = null;
    let processCalled = false;

    emailIntakeService.isEmailIntakeRecipient = () => true;
    emailIntakeService.createEmailIntakeCase = async (payload) => {
      intakePayload = payload;
      return {
        created: true,
        case_id: 9001,
        case: {
          id: 9001,
          case_name: 'Forwarded article case',
          status: 'needs_human_review',
        },
      };
    };
    sendgridService.processInboundEmail = async () => {
      processCalled = true;
      return { matched: false };
    };

    const response = await supertest(createApp())
      .post('/webhooks/inbound')
      .field('from', 'Reporter <reporter@example.com>')
      .field('to', 'intake@example.com')
      .field('subject', 'Fwd: review this article')
      .field('text', 'Please review https://example.com/news/123');

    assert.strictEqual(response.status, 201);
    assert.strictEqual(response.body.success, true);
    assert.strictEqual(response.body.email_intake, true);
    assert.strictEqual(response.body.case_id, 9001);
    assert.strictEqual(processCalled, false);
    assert.deepStrictEqual(intakePayload, {
      forwarded_subject: 'Fwd: review this article',
      forwarded_body_text: 'Please review https://example.com/news/123',
      forwarded_from: 'reporter@example.com',
      tags: ['source:email_webhook_intake'],
    });
  });

  it('falls through to normal inbound processing for non-intake recipients', async function () {
    let inboundPayload = null;

    emailIntakeService.isEmailIntakeRecipient = () => false;
    emailIntakeService.createEmailIntakeCase = async () => {
      throw new Error('should not create email intake case');
    };
    sendgridService.processInboundEmail = async (payload) => {
      inboundPayload = payload;
      return {
        matched: true,
        case_id: 321,
        message_id: 654,
        already_processed: true,
      };
    };

    const response = await supertest(createApp())
      .post('/webhooks/inbound')
      .field('from', 'agency@example.gov')
      .field('to', 'normal-inbox@example.com')
      .field('subject', 'Normal reply')
      .field('text', 'Body text');

    assert.strictEqual(response.status, 200);
    assert.strictEqual(response.body.success, true);
    assert.strictEqual(response.body.case_id, 321);
    assert.ok(inboundPayload);
    assert.strictEqual(inboundPayload.from, 'agency@example.gov');
    assert.strictEqual(inboundPayload.to, 'normal-inbox@example.com');
    assert.strictEqual(inboundPayload.subject, 'Normal reply');
    assert.strictEqual(inboundPayload.text, 'Body text');
  });

  it('links unmatched inbound emails by explicit autobot case reference', async function () {
    const seenQueries = [];

    emailIntakeService.isEmailIntakeRecipient = () => false;
    sendgridService.processInboundEmail = async () => ({ matched: false });
    db.query = async (sql, params) => {
      seenQueries.push({ sql: String(sql), params });
      if (String(sql).includes('SELECT id FROM cases')) {
        return { rows: [{ id: 25156 }] };
      }
      if (String(sql).includes('SELECT id FROM email_threads')) {
        return { rows: [{ id: 58 }] };
      }
      if (String(sql).includes('UPDATE messages SET case_id')) {
        return { rows: [] };
      }
      return { rows: [] };
    };

    const response = await supertest(createApp())
      .post('/webhooks/inbound')
      .field('from', 'Warren County <programmers@usnx.com>')
      .field('to', 'sam@foib-request.com')
      .field('subject', 'Submission Confirmation')
      .field('text', 'Please note this submission. Case ID: 25156');

    assert.strictEqual(response.status, 200);
    assert.strictEqual(response.body.success, true);
    assert.strictEqual(response.body.case_id, 25156);
    assert.ok(seenQueries.some((q) => q.sql.includes('SELECT id FROM cases')));
    assert.ok(seenQueries.some((q) => q.sql.includes('UPDATE messages SET case_id')));
  });
});
