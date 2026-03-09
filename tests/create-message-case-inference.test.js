const assert = require('assert');
const sinon = require('sinon');

const db = require('../services/database');

describe('Database createMessage case inference', function () {
  afterEach(function () {
    sinon.restore();
  });

  it('inherits case_id from thread when createMessage is called without one', async function () {
    sinon.stub(db, 'getThreadById').resolves({ id: 53, case_id: 25148 });
    const queryStub = sinon.stub(db, 'query').resolves({
      rows: [{
        id: 990,
        case_id: 25148,
        thread_id: 53,
        direction: 'inbound',
        from_email: 'records@atlanta.gov',
        to_email: 'noreply@example.com',
        subject: 'RE: Open Records Request - Denied',
        message_type: 'email',
        received_at: new Date().toISOString(),
        sent_at: null,
      }],
    });

    const message = await db.createMessage({
      thread_id: 53,
      case_id: null,
      message_id: 'manual-paste-990@example.test',
      sendgrid_message_id: null,
      direction: 'inbound',
      from_email: 'records@atlanta.gov',
      to_email: 'noreply@example.com',
      subject: 'RE: Open Records Request - Denied',
      body_text: 'Denied.',
      body_html: null,
      has_attachments: false,
      attachment_count: 0,
      message_type: 'email',
      portal_notification: false,
      portal_notification_type: null,
      portal_notification_provider: null,
      sent_at: null,
      received_at: new Date(),
      summary: null,
      metadata: { source: 'manual_paste', manual_paste: true },
      provider_payload: null,
    });

    assert.strictEqual(queryStub.firstCall.args[1][1], 25148);
    assert.strictEqual(message.case_id, 25148);
  });
});
