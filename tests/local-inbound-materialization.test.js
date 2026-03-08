const assert = require('assert');
const path = require('path');
const sinon = require('sinon');
const express = require('express');
const supertest = require('supertest');

describe('Local inbound materialization', function () {
  function loadRunEngineRouter({ dbStub, aiServiceStub, triggerDispatchStub }) {
    const routePath = path.resolve(__dirname, '../routes/run-engine.js');
    const dbPath = path.resolve(__dirname, '../services/database.js');
    const triggerSdkPath = require.resolve('@trigger.dev/sdk');
    const triggerDispatchPath = path.resolve(__dirname, '../services/trigger-dispatch-service.js');
    const loggerPath = path.resolve(__dirname, '../services/logger.js');
    const executorPath = path.resolve(__dirname, '../services/executor-adapter.js');
    const caseRuntimePath = path.resolve(__dirname, '../services/case-runtime.js');
    const caseTruthPath = path.resolve(__dirname, '../lib/case-truth.js');
    const aiServicePath = path.resolve(__dirname, '../services/ai-service.js');

    const originals = {
      route: require.cache[routePath],
      db: require.cache[dbPath],
      triggerSdk: require.cache[triggerSdkPath],
      triggerDispatch: require.cache[triggerDispatchPath],
      logger: require.cache[loggerPath],
      executor: require.cache[executorPath],
      caseRuntime: require.cache[caseRuntimePath],
      caseTruth: require.cache[caseTruthPath],
      aiService: require.cache[aiServicePath],
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
      exports: triggerDispatchStub,
    };
    require.cache[loggerPath] = {
      id: loggerPath,
      filename: loggerPath,
      loaded: true,
      exports: { info: sinon.stub(), warn: sinon.stub(), error: sinon.stub() },
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
      exports: { transitionCaseRuntime: sinon.stub().resolves() },
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
    require.cache[aiServicePath] = {
      id: aiServicePath,
      filename: aiServicePath,
      loaded: true,
      exports: aiServiceStub,
    };
    delete require.cache[routePath];

    const router = require(routePath);

    return {
      router,
      restore() {
        for (const [key, original] of Object.entries(originals)) {
          const targetPath = {
            route: routePath,
            db: dbPath,
            triggerSdk: triggerSdkPath,
            triggerDispatch: triggerDispatchPath,
            logger: loggerPath,
            executor: executorPath,
            caseRuntime: caseRuntimePath,
            caseTruth: caseTruthPath,
            aiService: aiServicePath,
          }[key];
          if (original) require.cache[targetPath] = original;
          else delete require.cache[targetPath];
        }
      },
    };
  }

  it('ingest-email creates a thread without relying on a removed case_id conflict constraint', async function () {
    const dbStub = {
      getCaseById: sinon.stub().resolves({
        id: 30001,
        our_email: 'sam@foib-request.com',
        agency_email: 'agency@example.gov',
      }),
      getThreadByCaseId: sinon.stub().resolves(null),
      createEmailThread: sinon.stub().resolves({
        id: 7001,
        case_id: 30001,
        subject: 'RE: Request',
        agency_email: 'agency@example.gov',
      }),
      updateCase: sinon.stub().resolves(),
      logActivity: sinon.stub().resolves(),
      query: sinon.stub(),
    };

    dbStub.query.onCall(0).resolves({ rows: [] });
    dbStub.query.onCall(1).resolves({ rows: [{ id: 8001, thread_id: 7001, received_at: new Date().toISOString() }] });

    const aiServiceStub = {};
    const triggerDispatchStub = { triggerTask: sinon.stub().resolves({ handle: { id: 'unused' } }) };
    const { router, restore } = loadRunEngineRouter({ dbStub, aiServiceStub, triggerDispatchStub });

    try {
      const app = express();
      app.use(express.json());
      app.use('/api', router);

      const response = await supertest(app)
        .post('/api/cases/30001/ingest-email')
        .send({
          from_email: 'agency@example.gov',
          subject: 'RE: Request',
          body_text: 'This is a valid inbound body for ingestion.',
          trigger_run: false,
        });

      assert.strictEqual(response.status, 201);
      assert.strictEqual(response.body.success, true);
      sinon.assert.calledOnce(dbStub.getThreadByCaseId);
      sinon.assert.calledOnce(dbStub.createEmailThread);
      assert.strictEqual(dbStub.createEmailThread.firstCall.args[0].agency_email, 'agency@example.gov');
    } finally {
      restore();
    }
  });

  it('materializes clarification proposals locally when Trigger credentials are absent', async function () {
    const originalNodeEnv = process.env.NODE_ENV;
    const originalTriggerSecret = process.env.TRIGGER_SECRET_KEY;
    process.env.NODE_ENV = 'development';
    delete process.env.TRIGGER_SECRET_KEY;

    const dbStub = {
      getCaseById: sinon.stub().resolves({
        id: 25273,
        case_name: 'Jordan Workflow',
        agency_name: 'Synthetic QA Records Unit',
        agency_email: 'shadewofficial@gmail.com',
      }),
      getMessageById: sinon.stub().resolves({
        id: 801,
        case_id: 25273,
        subject: 'RE: Public Records Request - Jordan Workflow',
        processed_at: null,
      }),
      getActiveRunForCase: sinon.stub().resolves(null),
      createAgentRunFull: sinon.stub().resolves({
        id: 1458,
        message_id: 801,
        langgraph_thread_id: 'case:25273:msg-801',
        metadata: {},
      }),
      getResponseAnalysisByMessageId: sinon.stub().resolves({ intent: 'CLARIFICATION_REQUEST' }),
      upsertProposal: sinon.stub().resolves({ id: 2001 }),
      updateProposal: sinon.stub().resolves(),
      updateAgentRun: sinon.stub().resolves(),
      markMessageProcessed: sinon.stub().resolves(),
      updateCase: sinon.stub().resolves(),
      query: sinon.stub().resolves({ rows: [] }),
    };

    const aiServiceStub = {
      generateAutoReply: sinon.stub().resolves({
        subject: 'RE: Public Records Request - Jordan Workflow',
        body_text: 'Clarified request body',
        body_html: '<p>Clarified request body</p>',
      }),
    };
    const triggerDispatchStub = { triggerTask: sinon.stub().rejects(new Error('should not dispatch')) };

    const { router, restore } = loadRunEngineRouter({ dbStub, aiServiceStub, triggerDispatchStub });

    try {
      const app = express();
      app.use(express.json());
      app.use('/api', router);

      const response = await supertest(app)
        .post('/api/cases/25273/run-inbound')
        .send({ messageId: 801, autopilotMode: 'SUPERVISED' });

      assert.strictEqual(response.status, 202);
      assert.strictEqual(response.body.success, true);
      assert.strictEqual(response.body.fallback, 'local_inbound_materialization');
      assert.strictEqual(response.body.proposal_id, 2001);
      sinon.assert.notCalled(triggerDispatchStub.triggerTask);
      sinon.assert.calledOnce(aiServiceStub.generateAutoReply);
      sinon.assert.calledWithExactly(dbStub.markMessageProcessed, 801, 1458, null);
      sinon.assert.calledWithExactly(
        dbStub.updateCase,
        25273,
        {
          status: 'needs_human_review',
          requires_human: true,
          pause_reason: 'SCOPE',
          substatus: 'Proposal #2001 pending review',
        }
      );
    } finally {
      process.env.NODE_ENV = originalNodeEnv;
      if (originalTriggerSecret === undefined) delete process.env.TRIGGER_SECRET_KEY;
      else process.env.TRIGGER_SECRET_KEY = originalTriggerSecret;
      restore();
    }
  });

  it('marks the run failed if local inbound materialization throws after the run is created', async function () {
    const originalNodeEnv = process.env.NODE_ENV;
    const originalTriggerSecret = process.env.TRIGGER_SECRET_KEY;
    process.env.NODE_ENV = 'development';
    delete process.env.TRIGGER_SECRET_KEY;

    const dbStub = {
      getCaseById: sinon.stub().resolves({
        id: 25273,
        case_name: 'Jordan Workflow',
        agency_name: 'Synthetic QA Records Unit',
        agency_email: 'shadewofficial@gmail.com',
      }),
      getMessageById: sinon.stub().resolves({
        id: 801,
        case_id: 25273,
        subject: 'RE: Public Records Request - Jordan Workflow',
        processed_at: null,
      }),
      getActiveRunForCase: sinon.stub().resolves(null),
      createAgentRunFull: sinon.stub().resolves({
        id: 1459,
        message_id: 801,
        langgraph_thread_id: 'case:25273:msg-801',
        metadata: {},
      }),
      getResponseAnalysisByMessageId: sinon.stub().resolves({ intent: 'CLARIFICATION_REQUEST' }),
      upsertProposal: sinon.stub(),
      updateProposal: sinon.stub().resolves(),
      updateAgentRun: sinon.stub().resolves(),
      markMessageProcessed: sinon.stub().resolves(),
      updateCase: sinon.stub().resolves(),
      query: sinon.stub().resolves({ rows: [] }),
    };

    const aiServiceStub = {
      generateAutoReply: sinon.stub().resolves({
        subject: 'RE: Public Records Request - Jordan Workflow',
        body_text: '',
        body_html: null,
      }),
    };
    const triggerDispatchStub = { triggerTask: sinon.stub().rejects(new Error('should not dispatch')) };

    const { router, restore } = loadRunEngineRouter({ dbStub, aiServiceStub, triggerDispatchStub });

    try {
      const app = express();
      app.use(express.json());
      app.use('/api', router);

      const response = await supertest(app)
        .post('/api/cases/25273/run-inbound')
        .send({ messageId: 801, autopilotMode: 'SUPERVISED' });

      assert.strictEqual(response.status, 500);
      assert.match(response.body.error, /empty send_clarification draft/i);
      sinon.assert.calledOnce(dbStub.updateAgentRun);
      sinon.assert.calledWithMatch(dbStub.updateAgentRun, 1459, {
        status: 'failed',
      });
      sinon.assert.notCalled(dbStub.markMessageProcessed);
      sinon.assert.notCalled(triggerDispatchStub.triggerTask);
    } finally {
      process.env.NODE_ENV = originalNodeEnv;
      if (originalTriggerSecret === undefined) delete process.env.TRIGGER_SECRET_KEY;
      else process.env.TRIGGER_SECRET_KEY = originalTriggerSecret;
      restore();
    }
  });

  it('materializes weak denials locally and auto-executes the rebuttal', async function () {
    const originalNodeEnv = process.env.NODE_ENV;
    const originalTriggerSecret = process.env.TRIGGER_SECRET_KEY;
    process.env.NODE_ENV = 'development';
    delete process.env.TRIGGER_SECRET_KEY;

    const dbStub = {
      getCaseById: sinon.stub().resolves({
        id: 25274,
        case_name: 'Jordan Denial Workflow',
        agency_name: 'Synthetic QA Records Unit',
        agency_email: 'shadewofficial@gmail.com',
      }),
      getMessageById: sinon.stub().resolves({
        id: 802,
        case_id: 25274,
        subject: 'Re: Public Records Request - Denied',
        processed_at: null,
        body_text: 'We do not have records matching your description.',
      }),
      getActiveRunForCase: sinon.stub().resolves(null),
      createAgentRunFull: sinon.stub().resolves({
        id: 1460,
        message_id: 802,
        langgraph_thread_id: 'case:25274:msg-802',
        metadata: {},
      }),
      getResponseAnalysisByMessageId: sinon.stub().resolves({ intent: 'DENIAL' }),
      upsertProposal: sinon.stub().resolves({ id: 2002 }),
      updateProposal: sinon.stub().resolves(),
      updateAgentRun: sinon.stub().resolves(),
      markMessageProcessed: sinon.stub().resolves(),
      updateCase: sinon.stub().resolves(),
      query: sinon.stub().resolves({ rows: [] }),
    };

    const aiServiceStub = {
      generateAutoReply: sinon.stub().rejects(new Error('should not call generateAutoReply')),
      callAI: sinon.stub().rejects(new Error('should not call callAI')),
    };
    const triggerDispatchStub = { triggerTask: sinon.stub().rejects(new Error('should not dispatch')) };

    const { router, restore } = loadRunEngineRouter({ dbStub, aiServiceStub, triggerDispatchStub });

    try {
      const app = express();
      app.use(express.json());
      app.use('/api', router);

      const response = await supertest(app)
        .post('/api/cases/25274/run-inbound')
        .send({
          messageId: 802,
          autopilotMode: 'AUTO',
          llmStubs: {
            classify: { classification: 'DENIAL', sentiment: 'neutral', key_points: ['no records found'] },
            draft: { subject: 'Re: Appeal of Denial', body: 'I am appealing this denial.' },
          },
        });

      assert.strictEqual(response.status, 202);
      assert.strictEqual(response.body.fallback, 'local_inbound_materialization');
      assert.strictEqual(response.body.action_type, 'SEND_REBUTTAL');
      assert.strictEqual(response.body.run.status, 'completed');
      sinon.assert.notCalled(triggerDispatchStub.triggerTask);
      sinon.assert.calledWithMatch(dbStub.updateProposal, 2002, {
        executionKey: sinon.match.string,
      });
      sinon.assert.calledWithMatch(dbStub.updateAgentRun, 1460, {
        status: 'completed',
      });
      sinon.assert.calledWithExactly(dbStub.updateCase, 25274, {
        status: 'awaiting_response',
        requires_human: false,
        pause_reason: null,
        substatus: 'Local SEND_REBUTTAL executed',
      });
    } finally {
      process.env.NODE_ENV = originalNodeEnv;
      if (originalTriggerSecret === undefined) delete process.env.TRIGGER_SECRET_KEY;
      else process.env.TRIGGER_SECRET_KEY = originalTriggerSecret;
      restore();
    }
  });

  it('materializes strong denials locally and gates for human review', async function () {
    const originalNodeEnv = process.env.NODE_ENV;
    const originalTriggerSecret = process.env.TRIGGER_SECRET_KEY;
    process.env.NODE_ENV = 'development';
    delete process.env.TRIGGER_SECRET_KEY;

    const dbStub = {
      getCaseById: sinon.stub().resolves({
        id: 25275,
        case_name: 'Jordan Strong Denial Workflow',
        agency_name: 'Synthetic QA Records Unit',
        agency_email: 'shadewofficial@gmail.com',
      }),
      getMessageById: sinon.stub().resolves({
        id: 803,
        case_id: 25275,
        subject: 'Re: Public Records Request - DENIED',
        processed_at: null,
        body_text: 'Denied pursuant to Exemption 7(A) and ongoing investigation.',
      }),
      getActiveRunForCase: sinon.stub().resolves(null),
      createAgentRunFull: sinon.stub().resolves({
        id: 1461,
        message_id: 803,
        langgraph_thread_id: 'case:25275:msg-803',
        metadata: {},
      }),
      getResponseAnalysisByMessageId: sinon.stub().resolves({ intent: 'DENIAL' }),
      upsertProposal: sinon.stub().resolves({ id: 2003 }),
      updateProposal: sinon.stub().resolves(),
      updateAgentRun: sinon.stub().resolves(),
      markMessageProcessed: sinon.stub().resolves(),
      updateCase: sinon.stub().resolves(),
      query: sinon.stub().resolves({ rows: [] }),
    };

    const aiServiceStub = {
      generateAutoReply: sinon.stub().rejects(new Error('should not call generateAutoReply')),
      callAI: sinon.stub().rejects(new Error('should not call callAI')),
    };
    const triggerDispatchStub = { triggerTask: sinon.stub().rejects(new Error('should not dispatch')) };

    const { router, restore } = loadRunEngineRouter({ dbStub, aiServiceStub, triggerDispatchStub });

    try {
      const app = express();
      app.use(express.json());
      app.use('/api', router);

      const response = await supertest(app)
        .post('/api/cases/25275/run-inbound')
        .send({
          messageId: 803,
          autopilotMode: 'AUTO',
          llmStubs: {
            classify: {
              classification: 'DENIAL',
              sentiment: 'negative',
              key_points: ['exemption 7(A)', 'ongoing investigation'],
            },
            draft: { subject: 'Re: Appeal of Denial', body: 'I respectfully appeal this denial.' },
          },
        });

      assert.strictEqual(response.status, 202);
      assert.strictEqual(response.body.fallback, 'local_inbound_materialization');
      assert.strictEqual(response.body.action_type, 'SEND_REBUTTAL');
      assert.strictEqual(response.body.run.status, 'waiting');
      sinon.assert.notCalled(triggerDispatchStub.triggerTask);
      sinon.assert.calledWithMatch(dbStub.updateProposal, 2003, {
        waitpoint_token: sinon.match(/^local-inbound:/),
      });
      sinon.assert.calledWithMatch(dbStub.updateAgentRun, 1461, {
        status: 'waiting',
      });
      sinon.assert.calledWithExactly(dbStub.updateCase, 25275, {
        status: 'needs_human_review',
        requires_human: true,
        pause_reason: 'DENIAL',
        substatus: 'Proposal #2003 pending review',
      });
    } finally {
      process.env.NODE_ENV = originalNodeEnv;
      if (originalTriggerSecret === undefined) delete process.env.TRIGGER_SECRET_KEY;
      else process.env.TRIGGER_SECRET_KEY = originalTriggerSecret;
      restore();
    }
  });
});
