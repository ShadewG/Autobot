const assert = require('assert');
const path = require('path');
const sinon = require('sinon');
const express = require('express');
const supertest = require('supertest');

describe('Legacy proposal dismiss reconciliation', function () {
  function loadRunEngineRouter({ dbStub, transitionCaseRuntimeStub }) {
    const routePath = path.resolve(__dirname, '../routes/run-engine.js');
    const dbPath = path.resolve(__dirname, '../services/database.js');
    const triggerSdkPath = require.resolve('@trigger.dev/sdk');
    const triggerDispatchPath = path.resolve(__dirname, '../services/trigger-dispatch-service.js');
    const loggerPath = path.resolve(__dirname, '../services/logger.js');
    const executorPath = path.resolve(__dirname, '../services/executor-adapter.js');
    const caseRuntimePath = path.resolve(__dirname, '../services/case-runtime.js');
    const caseTruthPath = path.resolve(__dirname, '../lib/case-truth.js');

    const originals = {
      route: require.cache[routePath],
      db: require.cache[dbPath],
      triggerSdk: require.cache[triggerSdkPath],
      triggerDispatch: require.cache[triggerDispatchPath],
      logger: require.cache[loggerPath],
      executor: require.cache[executorPath],
      caseRuntime: require.cache[caseRuntimePath],
      caseTruth: require.cache[caseTruthPath],
    };

    require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: dbStub };
    require.cache[triggerSdkPath] = {
      id: triggerSdkPath,
      filename: triggerSdkPath,
      loaded: true,
      exports: { wait: { createToken: sinon.stub(), completeToken: sinon.stub() } },
    };
    require.cache[triggerDispatchPath] = {
      id: triggerDispatchPath,
      filename: triggerDispatchPath,
      loaded: true,
      exports: {},
    };
    require.cache[loggerPath] = {
      id: loggerPath,
      filename: loggerPath,
      loaded: true,
      exports: {
        info: sinon.stub(),
        warn: sinon.stub(),
        error: sinon.stub(),
      },
    };
    require.cache[executorPath] = {
      id: executorPath,
      filename: executorPath,
      loaded: true,
      exports: { emailExecutor: { sendEmail: sinon.stub() } },
    };
    require.cache[caseRuntimePath] = {
      id: caseRuntimePath,
      filename: caseRuntimePath,
      loaded: true,
      exports: { transitionCaseRuntime: transitionCaseRuntimeStub },
    };
    require.cache[caseTruthPath] = {
      id: caseTruthPath,
      filename: caseTruthPath,
      loaded: true,
      exports: {
        HUMAN_REVIEW_PROPOSAL_STATUSES: [],
        buildCaseTruth: sinon.stub(),
      },
    };
    delete require.cache[routePath];

    const router = require(routePath);

    return {
      router,
      restore() {
        if (originals.route) require.cache[routePath] = originals.route;
        else delete require.cache[routePath];
        if (originals.db) require.cache[dbPath] = originals.db;
        else delete require.cache[dbPath];
        if (originals.triggerSdk) require.cache[triggerSdkPath] = originals.triggerSdk;
        else delete require.cache[triggerSdkPath];
        if (originals.triggerDispatch) require.cache[triggerDispatchPath] = originals.triggerDispatch;
        else delete require.cache[triggerDispatchPath];
        if (originals.logger) require.cache[loggerPath] = originals.logger;
        else delete require.cache[loggerPath];
        if (originals.executor) require.cache[executorPath] = originals.executor;
        else delete require.cache[executorPath];
        if (originals.caseRuntime) require.cache[caseRuntimePath] = originals.caseRuntime;
        else delete require.cache[caseRuntimePath];
        if (originals.caseTruth) require.cache[caseTruthPath] = originals.caseTruth;
        else delete require.cache[caseTruthPath];
      },
    };
  }

  it('reconciles a stale review-status case on DISMISS even when requires_human is already false', async function () {
    const updateProposalStub = sinon.stub().resolves();
    const updateCaseStub = sinon.stub().resolves();
    const transitionCaseRuntimeStub = sinon.stub().resolves();
    const dbStub = {
      getProposalById: sinon.stub().resolves({
        id: 951,
        case_id: 25261,
        status: 'PENDING_APPROVAL',
        waitpoint_token: null,
        action_type: 'SEND_CLARIFICATION',
      }),
      getActiveRunForCase: sinon.stub().resolves(null),
      updateProposal: updateProposalStub,
      getCaseById: sinon.stub().resolves({
        id: 25261,
        status: 'needs_human_review',
        requires_human: false,
      }),
      updateCase: updateCaseStub,
      query: sinon.stub(),
      createAgentRunFull: sinon.stub(),
      updateAgentRun: sinon.stub(),
      logActivity: sinon.stub(),
    };

    dbStub.query
      .onCall(0).resolves({ rows: [] }) // auto-captured eval insert for DISMISS
      .onCall(1).resolves({ rows: [] }) // remaining active proposals
      .onCall(2).resolves({ rows: [] }); // inbound messages

    const { router, restore } = loadRunEngineRouter({ dbStub, transitionCaseRuntimeStub });

    try {
      const app = express();
      app.use(express.json());
      app.use('/api', router);

      const response = await supertest(app)
        .post('/api/proposals/951/decision')
        .send({ action: 'DISMISS', reason: 'Synthetic QA dismissal' });

      assert.strictEqual(response.status, 200);
      assert.strictEqual(response.body.success, true);
      sinon.assert.calledWithExactly(
        updateProposalStub,
        951,
        sinon.match({
          status: 'DISMISSED',
          human_decision: sinon.match.has('action', 'DISMISS'),
        })
      );
      sinon.assert.calledWithExactly(
        transitionCaseRuntimeStub,
        25261,
        'CASE_ESCALATED',
        {
          targetStatus: 'needs_human_review',
          pauseReason: 'EXECUTION_BLOCKED',
          substatus: 'Proposal dismissed — manual action required',
          escalationReason: 'proposal_dismissed_manual_takeover',
        }
      );
      sinon.assert.calledWithExactly(
        updateCaseStub,
        25261,
        {
          status: 'needs_human_review',
          requires_human: true,
          pause_reason: 'EXECUTION_BLOCKED',
          substatus: 'Proposal dismissed — manual action required',
        }
      );
    } finally {
      restore();
    }
  });

  it('reconciles a waitpoint-backed dismiss immediately without leaving a stale decision state', async function () {
    const updateProposalStub = sinon.stub().resolves();
    const updateCaseStub = sinon.stub().resolves();
    const transitionCaseRuntimeStub = sinon.stub().resolves();
    const updateAgentRunStub = sinon.stub().resolves();
    const dbStub = {
      getProposalById: sinon.stub().resolves({
        id: 1004,
        case_id: 25280,
        status: 'PENDING_APPROVAL',
        waitpoint_token: 'waitpoint_test_dismiss',
        action_type: 'SEND_INITIAL_REQUEST',
      }),
      getActiveRunForCase: sinon.stub().resolves({
        id: 1424,
        status: 'waiting',
        trigger_run_id: 'run_test_waitpoint',
        metadata: { triggerRunId: 'run_test_waitpoint' },
      }),
      updateProposal: updateProposalStub,
      getCaseById: sinon.stub().resolves({
        id: 25280,
        status: 'needs_human_review',
        requires_human: false,
      }),
      updateCase: updateCaseStub,
      query: sinon.stub(),
      createAgentRunFull: sinon.stub(),
      updateAgentRun: updateAgentRunStub,
      logActivity: sinon.stub(),
    };

    dbStub.query
      .onCall(0).resolves({ rows: [] }) // auto-captured eval insert for DISMISS
      .onCall(1).resolves({ rows: [] }) // remaining active proposals
      .onCall(2).resolves({ rows: [] }); // inbound messages

    const fetchStub = sinon.stub().resolves({
      ok: true,
      text: async () => '',
    });
    const originalFetch = global.fetch;
    global.fetch = fetchStub;

    const { router, restore } = loadRunEngineRouter({ dbStub, transitionCaseRuntimeStub });

    try {
      const app = express();
      app.use(express.json());
      app.use('/api', router);

      const response = await supertest(app)
        .post('/api/proposals/1004/decision')
        .send({ action: 'DISMISS', reason: 'Synthetic QA waitpoint dismissal' });

      assert.strictEqual(response.status, 200);
      assert.strictEqual(response.body.success, true);
      assert.strictEqual(response.body.message, 'Proposal dismissed');
      sinon.assert.calledWithExactly(
        updateProposalStub,
        1004,
        sinon.match({
          status: 'DISMISSED',
          human_decision: sinon.match.has('action', 'DISMISS'),
        })
      );
      sinon.assert.calledWithExactly(
        transitionCaseRuntimeStub,
        25280,
        'CASE_ESCALATED',
        {
          targetStatus: 'needs_human_review',
          pauseReason: 'EXECUTION_BLOCKED',
          substatus: 'Proposal dismissed — manual action required',
          escalationReason: 'proposal_dismissed_manual_takeover',
        }
      );
      sinon.assert.calledWithExactly(
        updateCaseStub,
        25280,
        {
          status: 'needs_human_review',
          requires_human: true,
          pause_reason: 'EXECUTION_BLOCKED',
          substatus: 'Proposal dismissed — manual action required',
        }
      );
      sinon.assert.calledWithExactly(
        updateAgentRunStub,
        1424,
        sinon.match({
          status: 'completed',
          error: 'waitpoint_dismiss_resolved_locally',
        })
      );
      sinon.assert.calledOnce(fetchStub);
    } finally {
      global.fetch = originalFetch;
      restore();
    }
  });
});
