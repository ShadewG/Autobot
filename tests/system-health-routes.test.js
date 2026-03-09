const assert = require('assert');
const express = require('express');
const sinon = require('sinon');
const supertest = require('supertest');

const router = require('../routes/monitor/system-health');
const db = require('../services/database');

describe('System health routes', function () {
  afterEach(function () {
    sinon.restore();
  });

  it('returns inbound integrity metrics in system health', async function () {
    const queryStub = sinon.stub(db, 'query');
    queryStub.onCall(0).resolves({ rows: [] });
    queryStub.onCall(1).resolves({ rows: [{ count: 1 }] });
    queryStub.onCall(2).resolves({ rows: [{ count: 2 }] });
    queryStub.onCall(3).resolves({ rows: [{ count: 3 }] });
    queryStub.onCall(4).resolves({ rows: [{ count: 4 }] });
    queryStub.onCall(5).resolves({ rows: [{ count: 5 }] });
    queryStub.onCall(6).resolves({ rows: [{ count: 6 }] });
    queryStub.onCall(7).resolves({ rows: [{ count: 7 }] });
    queryStub.onCall(8).resolves({ rows: [{ count: 8 }] });

    const app = express();
    app.use('/api/monitor', router);

    const response = await supertest(app).get('/api/monitor/system-health');

    assert.strictEqual(response.status, 200);
    assert.strictEqual(response.body.success, true);
    assert.strictEqual(response.body.metrics.inbound_linkage_gaps, 6);
    assert.strictEqual(response.body.metrics.empty_normalized_inbound, 7);
    assert.strictEqual(response.body.metrics.proposal_message_mismatches, 8);
    assert.strictEqual(response.body.total_issues, 36);
  });

  it('returns drill-down details for inbound linkage gaps', async function () {
    sinon.stub(db, 'query').resolves({
      rows: [
        {
          message_id: 9001,
          from_email: 'records@example.gov',
          subject: 'Unmatched inbound',
          thread_id: null,
          case_id: null,
          received_at: '2026-03-09T01:00:00.000Z',
        },
      ],
    });

    const app = express();
    app.use('/api/monitor', router);

    const response = await supertest(app).get('/api/monitor/system-health/details?metric=inbound_linkage_gaps');

    assert.strictEqual(response.status, 200);
    assert.strictEqual(response.body.success, true);
    assert.strictEqual(response.body.metric, 'inbound_linkage_gaps');
    assert.strictEqual(response.body.count, 1);
    assert.strictEqual(response.body.items[0].message_id, 9001);
  });
});
