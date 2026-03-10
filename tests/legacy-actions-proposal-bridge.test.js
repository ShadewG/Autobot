const assert = require('assert');
const path = require('path');
const sinon = require('sinon');
const express = require('express');
const supertest = require('supertest');

describe('Legacy request actions bridge to proposals', function () {
  function loadLegacyActionsRouter({ helpersStub, processProposalDecisionStub, openAIStub }) {
    const routePath = path.resolve(__dirname, '../routes/requests/legacy-actions.js');
    const helpersPath = path.resolve(__dirname, '../routes/requests/_helpers.js');
    const monitorHelpersPath = path.resolve(__dirname, '../routes/monitor/_helpers.js');
    const openAIPath = require.resolve('openai');

    const originals = {
      route: require.cache[routePath],
      helpers: require.cache[helpersPath],
      monitorHelpers: require.cache[monitorHelpersPath],
      openai: require.cache[openAIPath],
    };

    require.cache[helpersPath] = {
      id: helpersPath,
      filename: helpersPath,
      loaded: true,
      exports: helpersStub,
    };
    require.cache[monitorHelpersPath] = {
      id: monitorHelpersPath,
      filename: monitorHelpersPath,
      loaded: true,
      exports: {
        processProposalDecision: processProposalDecisionStub,
      },
    };
    require.cache[openAIPath] = {
      id: openAIPath,
      filename: openAIPath,
      loaded: true,
      exports: class OpenAI {
        constructor() {
          this.chat = {
            completions: {
              create: openAIStub,
            },
          };
        }
      },
    };

    delete require.cache[routePath];
    const router = require(routePath);

    return {
      router,
      restore() {
        if (originals.route) require.cache[routePath] = originals.route;
        else delete require.cache[routePath];
        if (originals.helpers) require.cache[helpersPath] = originals.helpers;
        else delete require.cache[helpersPath];
        if (originals.monitorHelpers) require.cache[monitorHelpersPath] = originals.monitorHelpers;
        else delete require.cache[monitorHelpersPath];
        if (originals.openai) require.cache[openAIPath] = originals.openai;
        else delete require.cache[openAIPath];
      },
    };
  }

  function createHelpersStub(dbOverrides = {}) {
    return {
      db: {
        getPendingProposalsByCaseId: sinon.stub().resolves([]),
        getCaseById: sinon.stub().resolves(null),
        getMessageById: sinon.stub().resolves(null),
        getLatestInboundMessage: sinon.stub().resolves(null),
        upsertProposal: sinon.stub().resolves(null),
        updateProposal: sinon.stub().resolves(null),
        query: sinon.stub().resolves({ rows: [] }),
        ...dbOverrides,
      },
      actionValidator: {
        validateAction: sinon.stub().resolves({ blocked: false, violations: [] }),
        blockProposal: sinon.stub().resolves(),
      },
      logger: {
        forCase() {
          return {
            info: sinon.stub(),
            warn: sinon.stub(),
            error: sinon.stub(),
          };
        },
        proposalEvent: sinon.stub(),
      },
    };
  }

  afterEach(function () {
    sinon.restore();
  });

  it('approves pending proposals via the proposal decision helper', async function () {
    const helpersStub = createHelpersStub({
      getPendingProposalsByCaseId: sinon.stub().resolves([
        { id: 77, case_id: 25169, status: 'PENDING_APPROVAL' },
      ]),
    });
    const processProposalDecisionStub = sinon.stub().resolves({
      success: true,
      message: 'Decision received, re-processing via Trigger.dev',
      trigger_run_id: 'run_123',
    });
    const openAIStub = sinon.stub().resolves({ choices: [{ message: { content: 'unused' } }] });

    const loaded = loadLegacyActionsRouter({ helpersStub, processProposalDecisionStub, openAIStub });
    try {
      const app = express();
      app.use(express.json());
      app.use('/api/requests', loaded.router);

      const response = await supertest(app)
        .post('/api/requests/25169/actions/approve')
        .send({ action_id: 77 });

      assert.strictEqual(response.status, 200);
      assert.strictEqual(response.body.success, true);
      assert.strictEqual(processProposalDecisionStub.calledOnce, true);
      assert.strictEqual(processProposalDecisionStub.firstCall.args[0], 77);
      assert.strictEqual(processProposalDecisionStub.firstCall.args[1], 'APPROVE');
      assert.strictEqual(processProposalDecisionStub.firstCall.args[2].route_mode, 'legacy_actions');
      assert.strictEqual(helpersStub.db.query.called, false);
    } finally {
      loaded.restore();
    }
  });

  it('revises pending proposals in-place instead of inserting auto_reply_queue rows', async function () {
    const helpersStub = createHelpersStub({
      getPendingProposalsByCaseId: sinon.stub().resolves([
        {
          id: 88,
          case_id: 25169,
          status: 'PENDING_APPROVAL',
          action_type: 'SEND_CLARIFICATION',
          requires_human: true,
          confidence: 0.91,
          warnings: [],
          constraints_applied: [],
          reasoning: ['Initial reasoning'],
          trigger_message_id: 501,
          draft_body_text: 'Original body',
          draft_subject: 'Original subject',
          adjustment_count: 0,
        },
      ]),
      getCaseById: sinon.stub().resolves({
        id: 25169,
        agency_name: 'Agency',
        state: 'TX',
      }),
      getMessageById: sinon.stub().resolves({
        id: 501,
        subject: 'Agency reply',
      }),
      updateProposal: sinon.stub().resolves({
        id: 88,
        case_id: 25169,
        action_type: 'SEND_CLARIFICATION',
        requires_human: true,
        confidence: 0.91,
        warnings: [],
        constraints_applied: [],
        reasoning: ['Initial reasoning'],
        draft_body_text: 'Revised body from AI',
        draft_subject: 'Original subject',
      }),
    });
    const processProposalDecisionStub = sinon.stub().resolves();
    const openAIStub = sinon.stub().resolves({
      choices: [{ message: { content: 'Revised body from AI' } }],
    });

    const loaded = loadLegacyActionsRouter({ helpersStub, processProposalDecisionStub, openAIStub });
    try {
      const app = express();
      app.use(express.json());
      app.use('/api/requests', loaded.router);

      const response = await supertest(app)
        .post('/api/requests/25169/actions/revise')
        .send({ instruction: 'Shorten it', action_id: 88 });

      assert.strictEqual(response.status, 200);
      assert.strictEqual(response.body.success, true);
      assert.strictEqual(response.body.next_action_proposal.id, '88');
      assert.strictEqual(response.body.next_action_proposal.draft_content, 'Revised body from AI');
      assert.strictEqual(helpersStub.db.updateProposal.calledOnce, true);
      assert.strictEqual(helpersStub.db.updateProposal.firstCall.args[0], 88);
      assert.strictEqual(helpersStub.db.updateProposal.firstCall.args[1].draftBodyText, 'Revised body from AI');
      const wroteLegacyQueue = helpersStub.db.query.args.some(([sql]) => /INSERT INTO auto_reply_queue/i.test(String(sql)));
      assert.strictEqual(wroteLegacyQueue, false);
      assert.strictEqual(processProposalDecisionStub.called, false);
    } finally {
      loaded.restore();
    }
  });

  it('creates a modern pending proposal when revising without an active proposal', async function () {
    const helpersStub = createHelpersStub({
      getCaseById: sinon.stub().resolves({
        id: 25169,
        agency_name: 'Agency',
        state: 'TX',
        status: 'awaiting_response',
        pause_reason: null,
      }),
      getLatestInboundMessage: sinon.stub().resolves({
        id: 501,
        subject: 'Agency reply',
      }),
      upsertProposal: sinon.stub().resolves({
        id: 101,
        case_id: 25169,
        action_type: 'SEND_CLARIFICATION',
        requires_human: true,
        confidence: 0.75,
        warnings: [],
        constraints_applied: [],
        reasoning: ['Generated based on a legacy revise instruction', 'Shorten it'],
        draft_body_text: 'Fresh body from AI',
        draft_subject: 'Agency reply',
        proposal_short: 'Custom: Shorten it...',
      }),
    });
    const processProposalDecisionStub = sinon.stub().resolves();
    const openAIStub = sinon.stub().resolves({
      choices: [{ message: { content: 'Fresh body from AI' } }],
    });

    const loaded = loadLegacyActionsRouter({ helpersStub, processProposalDecisionStub, openAIStub });
    try {
      const app = express();
      app.use(express.json());
      app.use('/api/requests', loaded.router);

      const response = await supertest(app)
        .post('/api/requests/25169/actions/revise')
        .send({ instruction: 'Shorten it' });

      assert.strictEqual(response.status, 200);
      assert.strictEqual(response.body.success, true);
      assert.strictEqual(response.body.next_action_proposal.id, '101');
      assert.strictEqual(response.body.next_action_proposal.draft_content, 'Fresh body from AI');
      assert.strictEqual(helpersStub.db.getLatestInboundMessage.calledOnceWithExactly(25169), true);
      assert.strictEqual(helpersStub.db.upsertProposal.calledOnce, true);
      assert.strictEqual(helpersStub.db.upsertProposal.firstCall.args[0].actionType, 'SEND_CLARIFICATION');
      const wroteLegacyQueue = helpersStub.db.query.args.some(([sql]) => /INSERT INTO auto_reply_queue/i.test(String(sql)));
      assert.strictEqual(wroteLegacyQueue, false);
      assert.strictEqual(processProposalDecisionStub.called, false);
    } finally {
      loaded.restore();
    }
  });

  it('dismisses pending proposals via the proposal decision helper', async function () {
    const helpersStub = createHelpersStub({
      getPendingProposalsByCaseId: sinon.stub().resolves([
        { id: 99, case_id: 25169, status: 'PENDING_APPROVAL' },
      ]),
    });
    const processProposalDecisionStub = sinon.stub().resolves({
      success: true,
      message: 'Proposal dismissed',
    });
    const openAIStub = sinon.stub().resolves({ choices: [{ message: { content: 'unused' } }] });

    const loaded = loadLegacyActionsRouter({ helpersStub, processProposalDecisionStub, openAIStub });
    try {
      const app = express();
      app.use(express.json());
      app.use('/api/requests', loaded.router);

      const response = await supertest(app)
        .post('/api/requests/25169/actions/dismiss')
        .send({ action_id: 99 });

      assert.strictEqual(response.status, 200);
      assert.strictEqual(response.body.success, true);
      assert.strictEqual(processProposalDecisionStub.calledOnce, true);
      assert.strictEqual(processProposalDecisionStub.firstCall.args[0], 99);
      assert.strictEqual(processProposalDecisionStub.firstCall.args[1], 'DISMISS');
      assert.strictEqual(processProposalDecisionStub.firstCall.args[2].route_mode, 'legacy_actions');
      assert.strictEqual(helpersStub.db.query.called, false);
    } finally {
      loaded.restore();
    }
  });
});
