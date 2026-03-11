const assert = require('assert');
const express = require('express');
const sinon = require('sinon');
const supertest = require('supertest');

const router = require('../routes/api');
const db = require('../services/database');
const notionService = require('../services/notion-service');

describe('notion sync route', function () {
  afterEach(function () {
    sinon.restore();
  });

  it('clears stale active work when a synced page requires review', async function () {
    sinon.stub(notionService, 'processSinglePage').resolves({
      id: 26687,
      case_name: 'Edrick Faust sentenced for cold case murder of UGA student Tara Baker',
      agency_name: null,
      status: 'needs_human_review',
    });

    const dismissStub = sinon.stub(db, 'dismissPendingProposals').resolves({ rowCount: 1, rows: [] });
    let proposalCalls = 0;
    let runCalls = 0;
    const queryStub = sinon.stub(db, 'query').callsFake(async (sql) => {
      const text = typeof sql === 'string' ? sql : sql.text;

      if (text.includes('FROM proposals')) {
        proposalCalls += 1;
        return proposalCalls === 1
          ? { rows: [{ id: 1993, action_type: 'SUBMIT_PORTAL', status: 'PENDING_APPROVAL' }], rowCount: 1 }
          : { rows: [], rowCount: 0 };
      }

      if (text.includes('FROM agent_runs')) {
        runCalls += 1;
        return runCalls === 1
          ? { rows: [{ id: 2799, trigger_type: 'initial_request', status: 'waiting' }], rowCount: 1 }
          : { rows: [], rowCount: 0 };
      }

      if (text.includes('UPDATE agent_runs')) {
        return { rows: [], rowCount: 1 };
      }

      throw new Error(`Unexpected query in test: ${text}`);
    });

    const app = express();
    app.use(express.json());
    app.use('/api', router);

    const response = await supertest(app)
      .post('/api/notion/sync')
      .send({ pageId: '31f87c20070a819287c3d14bd6307f4c' });

    assert.strictEqual(response.status, 200);
    assert.strictEqual(response.body.success, true);
    assert.strictEqual(response.body.queued, false);
    assert.strictEqual(response.body.message, 'Case imported without auto-queue because it requires review');
    assert.strictEqual(response.body.active_proposal, null);
    assert.strictEqual(response.body.active_run, null);
    assert.strictEqual(dismissStub.calledOnceWithExactly(26687, 'Notion sync blocked auto-dispatch: import requires review'), true);
    assert.strictEqual(queryStub.callCount, 5);
  });
});
