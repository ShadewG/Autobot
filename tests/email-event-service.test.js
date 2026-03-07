const assert = require('assert');
const sinon = require('sinon');

const { parseEventTimestamp, processSendgridEvent } = require('../services/email-event-service');

describe('email event service', function () {
  afterEach(function () {
    sinon.restore();
  });

  it('parses SendGrid epoch-second timestamps', function () {
    const parsed = parseEventTimestamp({ timestamp: 1700000000 });
    assert.strictEqual(parsed.toISOString(), '2023-11-14T22:13:20.000Z');
  });

  it('records delivered events and updates delivered_at', async function () {
    const db = {
      getMessageBySendgridMessageId: sinon.stub().resolves({ id: 10, case_id: 20 }),
      createEmailEvent: sinon.stub().resolves({ id: 1 }),
      updateMessageDeliveryStatus: sinon.stub().resolves({ id: 10 }),
      logActivity: sinon.stub().resolves(),
    };
    const transitionCaseRuntime = sinon.stub().resolves();

    const result = await processSendgridEvent({
      db,
      transitionCaseRuntime,
      event: {
        event: 'delivered',
        sg_message_id: 'sg-123',
        timestamp: 1700000000,
      },
      logger: { log() {}, error() {} },
    });

    assert.strictEqual(result.status, 'recorded');
    sinon.assert.calledOnce(db.createEmailEvent);
    sinon.assert.calledWithMatch(db.createEmailEvent, {
      message_id: 10,
      provider_message_id: 'sg-123',
      event_type: 'delivered',
    });
    sinon.assert.calledOnce(db.updateMessageDeliveryStatus);
    sinon.assert.calledWithMatch(db.updateMessageDeliveryStatus, 10, {
      delivered_at: sinon.match.instanceOf(Date),
    });
    sinon.assert.notCalled(transitionCaseRuntime);
    sinon.assert.notCalled(db.logActivity);
  });

  it('records bounce events, updates bounced_at, and escalates the case', async function () {
    const db = {
      getMessageBySendgridMessageId: sinon.stub().resolves({ id: 11, case_id: 21 }),
      createEmailEvent: sinon.stub().resolves({ id: 2 }),
      updateMessageDeliveryStatus: sinon.stub().resolves({ id: 11 }),
      logActivity: sinon.stub().resolves(),
    };
    const transitionCaseRuntime = sinon.stub().resolves();

    const result = await processSendgridEvent({
      db,
      transitionCaseRuntime,
      event: {
        event: 'bounce',
        sg_message_id: 'sg-456',
        timestamp: 1700000001,
        reason: 'Mailbox unavailable',
        type: 'blocked',
        status: '550',
      },
      logger: { log() {}, error() {} },
    });

    assert.strictEqual(result.status, 'failed');
    sinon.assert.calledOnce(db.createEmailEvent);
    sinon.assert.calledOnce(db.updateMessageDeliveryStatus);
    sinon.assert.calledWithMatch(db.updateMessageDeliveryStatus, 11, {
      bounced_at: sinon.match.instanceOf(Date),
    });
    sinon.assert.calledOnce(db.logActivity);
    sinon.assert.calledWithMatch(db.logActivity, 'email_bounced', sinon.match.string, {
      case_id: 21,
      message_id: 11,
      sendgrid_message_id: 'sg-456',
      reason: 'Mailbox unavailable',
      status_code: '550',
    });
    sinon.assert.calledOnce(transitionCaseRuntime);
    sinon.assert.calledWithMatch(transitionCaseRuntime, 21, 'CASE_ESCALATED', {
      pauseReason: 'EMAIL_FAILED',
    });
  });
});
