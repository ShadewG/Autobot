const assert = require('assert');
const sinon = require('sinon');

const db = require('../services/database');

describe('email event database helpers', function () {
  afterEach(function () {
    sinon.restore();
  });

  it('inserts email event rows with provider ids and payloads', async function () {
    const queryStub = sinon.stub(db, 'query').resolves({ rows: [{ id: 5 }] });

    await db.createEmailEvent({
      message_id: 7,
      provider_message_id: 'sg-123',
      event_type: 'delivered',
      event_timestamp: new Date('2026-03-07T10:00:00Z'),
      raw_payload: { event: 'delivered' },
    });

    const [sql, params] = queryStub.getCall(0).args;
    assert.match(sql, /INSERT INTO email_events/);
    assert.strictEqual(params[0], 7);
    assert.strictEqual(params[1], 'sg-123');
    assert.strictEqual(params[2], 'delivered');
    assert.deepStrictEqual(params[4], { event: 'delivered' });
  });

  it('updates delivered and bounced timestamps on messages', async function () {
    const queryStub = sinon.stub(db, 'query').resolves({ rows: [{ id: 8 }] });

    await db.updateMessageDeliveryStatus(8, {
      delivered_at: new Date('2026-03-07T10:00:00Z'),
      bounced_at: new Date('2026-03-07T11:00:00Z'),
    });

    const [sql, params] = queryStub.getCall(0).args;
    assert.match(sql, /UPDATE messages SET delivered_at = \$2, bounced_at = \$3/);
    assert.strictEqual(params[0], 8);
    assert.ok(params[1] instanceof Date);
    assert.ok(params[2] instanceof Date);
  });
});
