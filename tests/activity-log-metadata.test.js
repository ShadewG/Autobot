const assert = require('assert');
const sinon = require('sinon');

const db = require('../services/database');

describe('Activity log metadata defaults', function () {
  afterEach(function () {
    sinon.restore();
  });

  it('defaults system actor type and inferred source service', async function () {
    const queryStub = sinon.stub(db, 'query').resolves({
      rows: [{
        id: 1,
        event_type: 'weekly_quality_report',
        case_id: 42,
        description: 'Generated weekly quality report',
        metadata: {},
        created_at: new Date().toISOString(),
      }],
    });
    sinon.stub(db, '_inferSourceServiceFromStack').returns('cron-service');

    await db.logActivity('weekly_quality_report', 'Generated weekly quality report', { case_id: 42 });

    const [, params] = queryStub.firstCall.args;
    assert.strictEqual(params[6], 'system');
    assert.strictEqual(params[8], 'cron-service');
  });

  it('preserves explicit human actor metadata', async function () {
    const queryStub = sinon.stub(db, 'query').resolves({
      rows: [{
        id: 2,
        event_type: 'human_decision',
        case_id: 99,
        description: 'Review resolved',
        metadata: {},
        created_at: new Date().toISOString(),
      }],
    });
    sinon.stub(db, '_inferSourceServiceFromStack').returns('database');

    await db.logActivity('human_decision', 'Review resolved', {
      case_id: 99,
      actor_type: 'human',
      actor_id: 'user-7',
      source_service: 'dashboard',
    });

    const [, params] = queryStub.firstCall.args;
    assert.strictEqual(params[6], 'human');
    assert.strictEqual(params[7], 'user-7');
    assert.strictEqual(params[8], 'dashboard');
  });
});
