const assert = require('assert');
const sinon = require('sinon');

const db = require('../services/database');
const sendgridService = require('../services/sendgrid-service');

describe('Provider payload capture', function () {
  afterEach(function () {
    sinon.restore();
  });

  it('builds sanitized inbound provider payloads', function () {
    const payload = sendgridService.buildInboundProviderPayload({
      from: 'agency@example.gov',
      to: 'requests@foib-request.com',
      subject: 'Records request update',
      text: 'Hello there',
      html: '<p>Hello there</p>',
      attachments: [
        {
          filename: 'letter.pdf',
          content_type: 'application/pdf',
          size: 4096,
          contentId: 'cid-1',
        },
      ],
      spam_report: 'x'.repeat(25000),
    });

    assert.strictEqual(payload.provider, 'sendgrid');
    assert.strictEqual(payload.direction, 'inbound');
    assert.strictEqual(payload.envelope.from, 'agency@example.gov');
    assert.strictEqual(payload.attachments.length, 1);
    assert.strictEqual(payload.attachments[0].filename, 'letter.pdf');
    assert.strictEqual(payload.attachments[0].size_bytes, 4096);
    assert.ok(payload.sendgrid_fields.spam_report.length <= 20020);
  });

  it('persists provider_payload on message writes', async function () {
    const queryStub = sinon.stub(db, 'query').resolves({
      rows: [{ id: 77, case_id: 10, direction: 'inbound', subject: 'Subj' }],
    });

    await db.createMessage({
      thread_id: 'thread-1',
      case_id: 10,
      message_id: 'msg-1',
      direction: 'inbound',
      from_email: 'agency@example.gov',
      to_email: 'requests@foib-request.com',
      subject: 'Subj',
      body_text: 'Body',
      body_html: '<p>Body</p>',
      message_type: 'email',
      metadata: { channel: 'test' },
      provider_payload: { provider: 'sendgrid', direction: 'inbound' },
    });

    const sql = queryStub.firstCall.args[0];
    const values = queryStub.firstCall.args[1];

    assert.match(sql, /provider_payload/);
    assert.deepStrictEqual(values[21], { provider: 'sendgrid', direction: 'inbound' });
  });
});
