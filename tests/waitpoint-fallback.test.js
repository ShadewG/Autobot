const assert = require('assert');
const path = require('path');
const sinon = require('sinon');
const express = require('express');
const supertest = require('supertest');

describe('Waitpoint approval fallback rollback', function () {
  function loadRunEngineRouter({
    dbStub,
    proposalLifecycleStub,
    emailSendStub,
    pdfFormServiceStub,
    transitionCaseRuntimeStub,
  }) {
    const routePath = path.resolve(__dirname, '../routes/run-engine.js');
    const dbPath = path.resolve(__dirname, '../services/database.js');
    const proposalLifecyclePath = path.resolve(__dirname, '../services/proposal-lifecycle.js');
    const triggerSdkPath = require.resolve('@trigger.dev/sdk');
    const triggerDispatchPath = path.resolve(__dirname, '../services/trigger-dispatch-service.js');
    const loggerPath = path.resolve(__dirname, '../services/logger.js');
    const executorPath = path.resolve(__dirname, '../services/executor-adapter.js');
    const caseRuntimePath = path.resolve(__dirname, '../services/case-runtime.js');
    const caseTruthPath = path.resolve(__dirname, '../lib/case-truth.js');
    const pdfFormServicePath = path.resolve(__dirname, '../services/pdf-form-service.js');

    const originals = {
      route: require.cache[routePath],
      db: require.cache[dbPath],
      proposalLifecycle: require.cache[proposalLifecyclePath],
      triggerSdk: require.cache[triggerSdkPath],
      triggerDispatch: require.cache[triggerDispatchPath],
      logger: require.cache[loggerPath],
      executor: require.cache[executorPath],
      caseRuntime: require.cache[caseRuntimePath],
      caseTruth: require.cache[caseTruthPath],
      pdfFormService: require.cache[pdfFormServicePath],
    };

    require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: dbStub };
    require.cache[proposalLifecyclePath] = {
      id: proposalLifecyclePath,
      filename: proposalLifecyclePath,
      loaded: true,
      exports: proposalLifecycleStub,
    };
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
      exports: { emailExecutor: { sendEmail: emailSendStub } },
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
    require.cache[pdfFormServicePath] = {
      id: pdfFormServicePath,
      filename: pdfFormServicePath,
      loaded: true,
      exports: pdfFormServiceStub,
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
        if (originals.proposalLifecycle) require.cache[proposalLifecyclePath] = originals.proposalLifecycle;
        else delete require.cache[proposalLifecyclePath];
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
        if (originals.pdfFormService) require.cache[pdfFormServicePath] = originals.pdfFormService;
        else delete require.cache[pdfFormServicePath];
      },
    };
  }

  function createProposalLifecycleStub() {
    return {
      ACTIVE_REVIEW_PROPOSAL_STATUSES: ['PENDING_APPROVAL', 'BLOCKED', 'DECISION_RECEIVED', 'PENDING_PORTAL'],
      buildHumanDecision(action, extras = {}) {
        return { action, decidedAt: '2026-03-07T13:00:00.000Z', decidedBy: 'human', ...extras };
      },
      applyHumanReviewDecision: sinon.stub().resolves(),
      clearHumanReviewDecision: sinon.stub().resolves(),
      conditionalUpdateProposal: sinon.stub().resolves(),
      dismissActiveCaseProposals: sinon.stub().resolves([]),
      markProposalDecisionReceived: sinon.stub().resolves({ id: 1, status: 'DECISION_RECEIVED' }),
      markProposalExecuted: sinon.stub().resolves({ id: 1, status: 'EXECUTED' }),
      markProposalPendingPortal: sinon.stub().resolves({ id: 1, status: 'PENDING_PORTAL' }),
    };
  }

  it('rolls back direct email fallback when the send fails', async function () {
    const originalNodeEnv = process.env.NODE_ENV;
    const originalFetch = global.fetch;
    process.env.NODE_ENV = 'production';
    global.fetch = sinon.stub().rejects(new Error('waitpoint unavailable'));

    const proposalLifecycleStub = createProposalLifecycleStub();
    const emailSendStub = sinon.stub().resolves({ success: false, error: 'smtp down' });
    const transitionCaseRuntimeStub = sinon.stub().resolves();
    const proposalData = {
      id: 1101,
      case_id: 3301,
      waitpoint_token: 'waitpoint_email',
      action_type: 'SEND_INITIAL_REQUEST',
      draft_subject: 'Draft subject',
      draft_body_text: 'Draft body',
      draft_body_html: '<p>Draft body</p>',
      execution_key: null,
      autopilot_mode: 'SUPERVISED',
    };
    const dbStub = {
      getProposalById: sinon.stub()
        .onFirstCall().resolves({ ...proposalData, status: 'PENDING_APPROVAL' })
        .callsFake(async () => ({ ...proposalData, status: 'DECISION_RECEIVED' })),
      getActiveRunForCase: sinon.stub().resolves({
        id: 4401,
        status: 'waiting',
        trigger_run_id: 'run_waitpoint_email',
        metadata: { triggerRunId: 'run_waitpoint_email' },
      }),
      getCaseById: sinon.stub().resolves({
        id: 3301,
        agency_email: 'qa@example.com',
      }),
      claimProposalExecution: sinon.stub().resolves(true),
      getLatestInboundMessage: sinon.stub().resolves(null),
      getLatestResponseAnalysis: sinon.stub().resolves(null),
      getThreadByCaseId: sinon.stub().resolves(null),
      getThreadByCaseAgencyId: sinon.stub().resolves(null),
      getMessagesByThreadId: sinon.stub().resolves([]),
      getCaseAgencyById: sinon.stub().resolves(null),
      updateProposal: sinon.stub().resolves(),
      query: sinon.stub().resolves({ rows: [] }),
      logActivity: sinon.stub().resolves(),
    };

    const { router, restore } = loadRunEngineRouter({
      dbStub,
      proposalLifecycleStub,
      emailSendStub,
      pdfFormServiceStub: { getLatestPreparedPdfAttachment: sinon.stub().resolves(null) },
      transitionCaseRuntimeStub,
    });

    try {
      const app = express();
      app.use(express.json());
      app.use('/api', router);

      const response = await supertest(app)
        .post('/api/proposals/1101/decision')
        .send({ action: 'APPROVE' });

      assert.strictEqual(response.status, 500);
      assert.match(response.body.error, /smtp down/i);
      sinon.assert.calledOnce(emailSendStub);
      sinon.assert.calledTwice(proposalLifecycleStub.markProposalDecisionReceived);
      sinon.assert.calledOnce(proposalLifecycleStub.clearHumanReviewDecision);
      sinon.assert.calledWithExactly(
        proposalLifecycleStub.clearHumanReviewDecision,
        1101,
        {
          status: 'PENDING_APPROVAL',
          extraUpdates: { executionKey: null },
        }
      );
      sinon.assert.notCalled(proposalLifecycleStub.markProposalExecuted);
    } finally {
      process.env.NODE_ENV = originalNodeEnv;
      global.fetch = originalFetch;
      restore();
    }
  });

  it('rolls back direct PDF email fallback when the send fails', async function () {
    const originalNodeEnv = process.env.NODE_ENV;
    const originalFetch = global.fetch;
    process.env.NODE_ENV = 'production';
    global.fetch = sinon.stub().rejects(new Error('waitpoint unavailable'));

    const proposalLifecycleStub = createProposalLifecycleStub();
    const emailSendStub = sinon.stub().resolves({ success: false, error: 'pdf send failed' });
    const transitionCaseRuntimeStub = sinon.stub().resolves();
    const pdfProposalData = {
      id: 1202,
      case_id: 3302,
      waitpoint_token: 'waitpoint_pdf',
      action_type: 'SEND_PDF_EMAIL',
      draft_subject: 'PDF draft subject',
      draft_body_text: 'PDF draft body',
      draft_body_html: '<p>PDF draft body</p>',
      execution_key: null,
      autopilot_mode: 'SUPERVISED',
    };
    const dbStub = {
      getProposalById: sinon.stub()
        .onFirstCall().resolves({ ...pdfProposalData, status: 'PENDING_APPROVAL' })
        .callsFake(async () => ({ ...pdfProposalData, status: 'DECISION_RECEIVED' })),
      getActiveRunForCase: sinon.stub().resolves({
        id: 4402,
        status: 'waiting',
        trigger_run_id: 'run_waitpoint_pdf',
        metadata: { triggerRunId: 'run_waitpoint_pdf' },
      }),
      getCaseById: sinon.stub().resolves({
        id: 3302,
        agency_email: 'qa@example.com',
      }),
      claimProposalExecution: sinon.stub().resolves(true),
      getLatestInboundMessage: sinon.stub().resolves(null),
      getLatestResponseAnalysis: sinon.stub().resolves(null),
      getAttachmentById: sinon.stub().resolves({ file_data: Buffer.from('pdf-binary') }),
      getThreadByCaseId: sinon.stub().resolves(null),
      getThreadByCaseAgencyId: sinon.stub().resolves(null),
      getMessagesByThreadId: sinon.stub().resolves([]),
      getCaseAgencyById: sinon.stub().resolves(null),
      updateProposal: sinon.stub().resolves(),
      query: sinon.stub().resolves({ rows: [] }),
      logActivity: sinon.stub().resolves(),
    };

    const { router, restore } = loadRunEngineRouter({
      dbStub,
      proposalLifecycleStub,
      emailSendStub,
      pdfFormServiceStub: {
        getLatestPreparedPdfAttachment: sinon.stub().resolves({
          id: 77,
          filename: 'request-form.pdf',
          storage_path: null,
        }),
      },
      transitionCaseRuntimeStub,
    });

    try {
      const app = express();
      app.use(express.json());
      app.use('/api', router);

      const response = await supertest(app)
        .post('/api/proposals/1202/decision')
        .send({ action: 'APPROVE' });

      assert.strictEqual(response.status, 500);
      assert.match(response.body.error, /pdf send failed/i);
      sinon.assert.calledOnce(emailSendStub);
      sinon.assert.calledTwice(proposalLifecycleStub.markProposalDecisionReceived);
      sinon.assert.calledOnce(proposalLifecycleStub.clearHumanReviewDecision);
      sinon.assert.calledWithExactly(
        proposalLifecycleStub.clearHumanReviewDecision,
        1202,
        {
          status: 'PENDING_APPROVAL',
          extraUpdates: { executionKey: null },
        }
      );
      sinon.assert.notCalled(proposalLifecycleStub.markProposalExecuted);
    } finally {
      process.env.NODE_ENV = originalNodeEnv;
      global.fetch = originalFetch;
      restore();
    }
  });
});
