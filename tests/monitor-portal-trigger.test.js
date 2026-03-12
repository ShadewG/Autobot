const assert = require('assert');
const express = require('express');
const supertest = require('supertest');
const sinon = require('sinon');

describe('monitor portal trigger route', function () {
  let helper;
  let runtime;
  let router;
  let originals;

  beforeEach(function () {
    helper = require('../routes/monitor/_helpers');
    runtime = require('../services/case-runtime');

    originals = {
      getCaseById: helper.db.getCaseById,
      updateCase: helper.db.updateCase,
      createAgentRunFull: helper.db.createAgentRunFull,
      updateAgentRun: helper.db.updateAgentRun,
      logActivity: helper.db.logActivity,
      query: helper.db.query,
      notify: helper.notify,
      triggerTask: helper.triggerDispatch.triggerTask,
      transitionCaseRuntime: runtime.transitionCaseRuntime,
    };

    helper.db.getCaseById = sinon.stub().resolves({
      id: 26683,
      case_name: 'Grand Rapids Police Department records request',
      portal_url: 'https://grpd.justfoia.com/publicportal/home/newrequest',
      portal_provider: 'justfoia',
      autopilot_mode: 'SUPERVISED',
    });
    helper.db.updateCase = sinon.stub().resolves();
    helper.db.createAgentRunFull = sinon.stub().resolves({ id: 77 });
    helper.db.updateAgentRun = sinon.stub().resolves();
    helper.db.logActivity = sinon.stub().resolves();
    helper.notify = sinon.stub();
    helper.triggerDispatch.triggerTask = sinon.stub().resolves({ handle: { id: 'tr_123' } });
    runtime.transitionCaseRuntime = sinon.stub().resolves();

    delete require.cache[require.resolve('../routes/monitor/portal')];
    router = require('../routes/monitor/portal');
  });

  afterEach(function () {
    helper.db.getCaseById = originals.getCaseById;
    helper.db.updateCase = originals.updateCase;
    helper.db.createAgentRunFull = originals.createAgentRunFull;
    helper.db.updateAgentRun = originals.updateAgentRun;
    helper.db.logActivity = originals.logActivity;
    helper.db.query = originals.query;
    helper.notify = originals.notify;
    helper.triggerDispatch.triggerTask = originals.triggerTask;
    runtime.transitionCaseRuntime = originals.transitionCaseRuntime;
    delete require.cache[require.resolve('../routes/monitor/portal')];
  });

  it('refuses to launch a duplicate portal run when one is already active', async function () {
    helper.db.query = sinon.stub().callsFake(async (sql) => {
      if (/FROM agent_runs/i.test(sql)) {
        return { rows: [{ id: 91, status: 'running', trigger_run_id: 'tr_existing', portal_task_id: '222' }] };
      }
      if (/FROM portal_submissions/i.test(sql)) {
        return { rows: [] };
      }
      if (/FROM portal_tasks/i.test(sql)) {
        return { rows: [] };
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    });

    const app = express();
    app.use('/api/monitor', router);

    const response = await supertest(app)
      .post('/api/monitor/case/26683/trigger-portal')
      .send({});

    assert.strictEqual(response.status, 409);
    assert.strictEqual(response.body.code, 'PORTAL_ALREADY_ACTIVE');
    sinon.assert.notCalled(helper.triggerDispatch.triggerTask);
    sinon.assert.notCalled(helper.db.createAgentRunFull);
  });

  it('uses Trigger.dev dispatch and creates an active portal task for monitor-triggered submissions', async function () {
    helper.db.query = sinon.stub().callsFake(async (sql) => {
      if (/FROM agent_runs/i.test(sql)) {
        return { rows: [] };
      }
      if (/FROM portal_submissions/i.test(sql)) {
        return { rows: [] };
      }
      if (/FROM portal_tasks/i.test(sql) && /SELECT id, status, proposal_id/i.test(sql)) {
        return { rows: [] };
      }
      if (/INSERT INTO portal_tasks/i.test(sql)) {
        return { rows: [{ id: 222 }] };
      }
      if (/UPDATE proposals/i.test(sql)) {
        return { rows: [], rowCount: 0 };
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    });

    const app = express();
    app.use('/api/monitor', router);

    const response = await supertest(app)
      .post('/api/monitor/case/26683/trigger-portal')
      .send({});

    assert.strictEqual(response.status, 200);
    assert.strictEqual(response.body.portal_task_id, 222);
    assert.strictEqual(response.body.run_id, 77);
    assert.strictEqual(response.body.trigger_run_id, 'tr_123');
    sinon.assert.calledOnce(helper.db.createAgentRunFull);
    sinon.assert.calledOnce(helper.triggerDispatch.triggerTask);
    sinon.assert.calledWith(
      helper.triggerDispatch.triggerTask,
      'submit-portal',
      sinon.match({ caseId: 26683, portalTaskId: 222, agentRunId: 77 }),
      sinon.match({ idempotencyKey: 'monitor-portal:26683:222' }),
      sinon.match({ runId: 77, caseId: 26683, source: 'monitor_portal_trigger' })
    );
  });
});
