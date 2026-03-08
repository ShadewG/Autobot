const assert = require('assert');
const express = require('express');
const supertest = require('supertest');
const sinon = require('sinon');

describe('Request proposals adjust feedback capture', function () {
  let feedbackModule;
  let lifecycleModule;
  let helpersModule;
  let routerPath;
  let originalFeedbackExports;
  let originalLifecycleExports;
  let originalHelpersExports;

  beforeEach(function () {
    feedbackModule = require('../services/proposal-feedback');
    lifecycleModule = require('../services/proposal-lifecycle');
    helpersModule = require('../routes/requests/_helpers');
    routerPath = require.resolve('../routes/requests/proposals');

    originalFeedbackExports = { ...feedbackModule };
    originalLifecycleExports = { ...lifecycleModule };
    originalHelpersExports = { ...helpersModule };

    delete require.cache[routerPath];
  });

  afterEach(function () {
    Object.assign(feedbackModule, originalFeedbackExports);
    Object.assign(lifecycleModule, originalLifecycleExports);
    Object.assign(helpersModule, originalHelpersExports);
    delete require.cache[routerPath];
    sinon.restore();
  });

  it('captures an eval case when adjusting via the request proposals route', async function () {
    const autoCaptureStub = sinon.stub().resolves();
    feedbackModule.autoCaptureEvalCase = autoCaptureStub;
    feedbackModule.captureDismissFeedback = sinon.stub().resolves();

    lifecycleModule.applyHumanReviewDecision = sinon.stub().resolves();
    lifecycleModule.buildHumanDecision = sinon.stub().returns({ action: 'ADJUST' });

    helpersModule.db = {
      getProposalById: sinon.stub().resolves({
        id: 555,
        case_id: 444,
        status: 'PENDING_APPROVAL',
        action_type: 'SEND_INITIAL_REQUEST',
        adjustment_count: 0,
        waitpoint_token: null,
        run_id: 0,
        message_id: 777,
      }),
    };
    helpersModule.logger = {
      forCase: () => ({
        info() {},
        error() {},
      }),
    };
    helpersModule.triggerDispatch = {
      triggerTask: sinon.stub().resolves({ handle: { id: 'run_test_1' } }),
    };

    const proposalsRouter = require('../routes/requests/proposals');

    const app = express();
    app.use(express.json());
    app.use('/api/requests', proposalsRouter);

    const response = await supertest(app)
      .post('/api/requests/444/proposals/555/adjust')
      .send({ instruction: 'Shorten the draft and remove the second paragraph' });

    assert.strictEqual(response.status, 200);
    sinon.assert.calledOnce(autoCaptureStub);
    sinon.assert.calledWithMatch(autoCaptureStub, {
      id: 555,
      case_id: 444,
      action_type: 'SEND_INITIAL_REQUEST',
    }, {
      action: 'ADJUST',
      instruction: 'Shorten the draft and remove the second paragraph',
      decidedBy: 'human',
    });
  });

  it('captures an eval case when approving via the request proposals route', async function () {
    const autoCaptureStub = sinon.stub().resolves();
    feedbackModule.autoCaptureEvalCase = autoCaptureStub;
    feedbackModule.captureDismissFeedback = sinon.stub().resolves();

    lifecycleModule.markProposalDecisionReceived = sinon.stub().resolves();
    lifecycleModule.buildHumanDecision = sinon.stub().returns({ action: 'APPROVE' });

    helpersModule.db = {
      getCaseById: sinon.stub().resolves({ id: 444 }),
      getProposalById: sinon.stub().resolves({
        id: 556,
        case_id: 444,
        status: 'PENDING_APPROVAL',
        action_type: 'SEND_INITIAL_REQUEST',
        waitpoint_token: null,
        run_id: 0,
        message_id: 778,
      }),
    };
    helpersModule.logger = {
      forCase: () => ({
        info() {},
        error() {},
      }),
    };
    helpersModule.triggerDispatch = {
      triggerTask: sinon.stub().resolves({ handle: { id: 'run_test_approve' } }),
    };

    const proposalsRouter = require('../routes/requests/proposals');

    const app = express();
    app.use(express.json());
    app.use('/api/requests', proposalsRouter);

    const response = await supertest(app)
      .post('/api/requests/444/proposals/556/approve')
      .send({});

    assert.strictEqual(response.status, 200);
    sinon.assert.calledOnce(autoCaptureStub);
    sinon.assert.calledWithMatch(autoCaptureStub, {
      id: 556,
      case_id: 444,
      action_type: 'SEND_INITIAL_REQUEST',
    }, {
      action: 'APPROVE',
      decidedBy: 'human',
    });
  });
});
