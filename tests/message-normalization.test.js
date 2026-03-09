const assert = require('assert');
const sinon = require('sinon');

const db = require('../services/database');
const {
  normalizeMessageBody,
  getCanonicalMessageText,
  isSubstantiveMessage,
} = require('../lib/message-normalization');

describe('message normalization', function () {
  afterEach(function () {
    sinon.restore();
  });

  it('prefers cleaned body_text when present', function () {
    const normalized = normalizeMessageBody({
      body_text: 'Agency response.\n\n-----Original Message-----\nOlder thread',
      body_html: '<p>Ignored HTML</p>',
    });

    assert.strictEqual(normalized.normalized_body_source, 'body_text');
    assert.strictEqual(normalized.normalized_body_text, 'Agency response.');
  });

  it('falls back to cleaned html when plain text is empty', function () {
    const normalized = normalizeMessageBody({
      body_text: '',
      body_html: '<div>Hello&nbsp;there</div><div>Denied under 119.07.</div>',
    });

    assert.strictEqual(normalized.normalized_body_source, 'body_html');
    assert.strictEqual(normalized.normalized_body_text, 'Hello there\nDenied under 119.07.');
  });

  it('marks portal password notices as non-substantive', function () {
    const message = {
      direction: 'inbound',
      portal_notification: true,
      subject: 'Password Assistance',
      body_html: '<p>Your temporary password is 123456.</p><p>Track and monitor the status of your request.</p>',
    };

    assert.strictEqual(isSubstantiveMessage(message), false);
  });

  it('exposes canonical text from stored normalized content', function () {
    assert.strictEqual(
      getCanonicalMessageText({ normalized_body_text: 'Stored normalized body', body_text: 'ignored' }),
      'Stored normalized body'
    );
  });

  it('writes normalized fields through createMessage', async function () {
    sinon.stub(db, 'getThreadById').resolves({ id: 53, case_id: 25157 });
    const queryStub = sinon.stub(db, 'query').resolves({
      rows: [{
        id: 2615,
        case_id: 25157,
        thread_id: 53,
        normalized_body_text: 'Denied under section 119.07.',
        normalized_body_source: 'body_html',
        is_substantive: true,
      }],
    });

    await db.createMessage({
      thread_id: 53,
      case_id: null,
      message_id: 'govqa-2615@example.test',
      direction: 'inbound',
      from_email: 'sjso@govqa.us',
      to_email: 'requests@foib-request.com',
      subject: 'Your Request Has Been Updated',
      body_text: '',
      body_html: '<p>Denied under section 119.07.</p>',
      has_attachments: false,
      attachment_count: 0,
      message_type: 'response',
      portal_notification: false,
      received_at: new Date(),
      metadata: { source: 'test' },
    });

    const values = queryStub.firstCall.args[1];
    assert.strictEqual(values[1], 25157);
    assert.deepStrictEqual(values.slice(-3), ['Denied under section 119.07.', 'body_html', true]);
  });

  it('returns canonical body text through shared message getters while preserving raw text', async function () {
    sinon.stub(db, 'query').resolves({
      rows: [{
        id: 2615,
        thread_id: 53,
        case_id: 25157,
        raw_body_text: '',
        body_text: 'Denied under section 119.07.',
        normalized_body_text: 'Denied under section 119.07.',
        normalized_body_source: 'body_html',
      }],
    });

    const message = await db.getMessageById(2615);

    assert.strictEqual(message.body_text, 'Denied under section 119.07.');
    assert.strictEqual(message.raw_body_text, '');
    assert.strictEqual(message.normalized_body_source, 'body_html');
  });
});
