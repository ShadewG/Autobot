const assert = require('assert');
const express = require('express');
const supertest = require('supertest');
const sinon = require('sinon');

const requestHelpers = require('../routes/requests/_helpers');
const requestCaseManagementRouter = require('../routes/requests/case-management');
const notionService = require('../services/notion-service');

describe('resolve-review active-run recovery', function () {
  let app;
  let queryStub;
  let getCaseByIdStub;
  let updateCaseStub;
  let logActivityStub;
  let createAgentRunFullStub;
  let updateAgentRunStub;
  let triggerTaskStub;
  let loggerStub;
  let notionSyncStub;

  beforeEach(function () {
    app = express();
    app.use(express.json());
    app.use('/api/requests', requestCaseManagementRouter);

    getCaseByIdStub = sinon.stub(requestHelpers.db, 'getCaseById').resolves({
      id: 25210,
      status: 'needs_human_review',
      substatus: 'Portal account locked',
    });
    updateCaseStub = sinon.stub(requestHelpers.db, 'updateCase').resolves();
    logActivityStub = sinon.stub(requestHelpers.db, 'logActivity').resolves();
    createAgentRunFullStub = sinon.stub(requestHelpers.db, 'createAgentRunFull').resolves({ id: 2001 });
    updateAgentRunStub = sinon.stub(requestHelpers.db, 'updateAgentRun').resolves();
    triggerTaskStub = sinon.stub(requestHelpers.triggerDispatch, 'triggerTask').resolves({
      handle: { id: 'run_test123' },
    });
    notionSyncStub = sinon.stub(notionService, 'syncStatusToNotion').resolves();
    loggerStub = sinon.stub(requestHelpers.logger, 'forCase').returns({
      info: () => {},
      warn: () => {},
      error: () => {},
    });

    queryStub = sinon.stub(requestHelpers.db, 'query').callsFake(async (sql) => {
      if (sql.includes('SELECT id, waitpoint_token FROM proposals')) {
        return { rows: [{ id: 975, waitpoint_token: 'waitpoint_old' }] };
      }

      if (sql.includes("UPDATE proposals SET status = 'DISMISSED'")) {
        return { rows: [] };
      }

      if (sql.includes('UPDATE agent_runs') && sql.includes("SET status = 'failed'")) {
        return { rows: [{ id: 1374 }] };
      }

      if (sql.includes("SELECT id FROM messages WHERE case_id = $1 AND direction = 'inbound'")) {
        return { rows: [{ id: 770 }] };
      }

      if (sql.includes('UPDATE cases SET requires_human = false')) {
        return { rows: [] };
      }

      if (sql.includes("SELECT id, action_type, executed_at FROM proposals")
        || sql.includes("SELECT id, executed_at FROM proposals")) {
        return { rows: [] };
      }

      throw new Error(`Unexpected query in resolve-review test: ${sql}`);
    });
  });

  afterEach(function () {
    sinon.restore();
  });

  it('supersedes active runs before creating a new human-review-resolution run', async function () {
    const response = await supertest(app)
      .post('/api/requests/25210/resolve-review')
      .send({
        action: 'custom',
        instruction: 'Research the correct Georgia agency instead of rebutting Lubbock.',
      });

    assert.strictEqual(response.status, 200);
    assert.strictEqual(response.body.success, true);
    sinon.assert.calledOnce(createAgentRunFullStub);
    sinon.assert.calledOnce(triggerTaskStub);
    sinon.assert.calledOnce(updateCaseStub);
    sinon.assert.calledOnce(logActivityStub);
    sinon.assert.calledOnce(notionSyncStub);
    sinon.assert.calledOnce(loggerStub);

    const supersedeQuery = queryStub.getCalls().find((call) =>
      String(call.args[0]).includes('UPDATE agent_runs')
      && String(call.args[0]).includes("SET status = 'failed'")
    );
    assert.ok(supersedeQuery, 'expected active-run supersede query to run before dispatch');
  });
});
