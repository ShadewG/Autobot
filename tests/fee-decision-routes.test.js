const assert = require('assert');
const express = require('express');
const sinon = require('sinon');
const supertest = require('supertest');

const runEngineRouter = require('../routes/run-engine');
const monitorHelpers = require('../routes/monitor/_helpers');
const db = require('../services/database');
const feeWorkflowService = require('../services/fee-workflow-service');

describe('fee decision routes', function () {
  afterEach(function () {
    sinon.restore();
  });

  it('run-engine accepts ADD_TO_INVOICING and delegates to fee workflow handling', async function () {
    sinon.stub(db, 'getProposalById').resolves({
      id: 2024,
      case_id: 25161,
      action_type: 'ACCEPT_FEE',
      status: 'PENDING_APPROVAL',
      gate_options: ['APPROVE', 'ADD_TO_INVOICING', 'WAIT_FOR_GOOD_TO_PAY', 'ADJUST', 'DISMISS'],
    });
    sinon.stub(db, 'getActiveRunForCase').resolves(null);
    const feeStub = sinon.stub(feeWorkflowService, 'handleFeeProposalDecision').resolves({
      handled: true,
      response: {
        success: true,
        message: 'Case added to invoicing and parked until payment is marked paid.',
        proposal_id: 2024,
        action: 'ADD_TO_INVOICING',
      },
    });
    const completeStub = sinon.stub(feeWorkflowService, 'completeFeeProposalWaitpoint').resolves({
      completed: true,
      tokenId: 'waitpoint_fee_2024',
    });

    const app = express();
    app.use(express.json());
    app.use('/api', runEngineRouter);

    const response = await supertest(app)
      .post('/api/proposals/2024/decision')
      .send({ action: 'ADD_TO_INVOICING' });

    assert.strictEqual(response.status, 200);
    assert.strictEqual(response.body.success, true);
    assert.strictEqual(response.body.action, 'ADD_TO_INVOICING');
    sinon.assert.calledOnce(feeStub);
    sinon.assert.calledOnce(completeStub);
    sinon.assert.calledWithMatch(feeStub, sinon.match.has('id', 2024), sinon.match({
      action: 'ADD_TO_INVOICING',
    }));
    sinon.assert.calledWithMatch(completeStub, sinon.match.has('id', 2024), sinon.match({
      action: 'ADD_TO_INVOICING',
    }));
  });

  it('monitor helper accepts WAIT_FOR_GOOD_TO_PAY and delegates to fee workflow handling', async function () {
    sinon.stub(db, 'getProposalById').resolves({
      id: 2025,
      case_id: 25161,
      action_type: 'ACCEPT_FEE',
      status: 'PENDING_APPROVAL',
      gate_options: ['APPROVE', 'ADD_TO_INVOICING', 'WAIT_FOR_GOOD_TO_PAY', 'ADJUST', 'DISMISS'],
      autopilot_mode: 'SUPERVISED',
    });
    sinon.stub(db, 'getActiveRunForCase').resolves(null);
    const feeStub = sinon.stub(feeWorkflowService, 'handleFeeProposalDecision').resolves({
      handled: true,
      response: {
        success: true,
        message: 'Case parked until Notion marks it good to pay.',
        proposal_id: 2025,
        action: 'WAIT_FOR_GOOD_TO_PAY',
      },
    });
    const completeStub = sinon.stub(feeWorkflowService, 'completeFeeProposalWaitpoint').resolves({
      completed: true,
      tokenId: 'waitpoint_fee_2025',
    });

    const result = await monitorHelpers.processProposalDecision(2025, 'WAIT_FOR_GOOD_TO_PAY', {
      reason: 'Need finance signoff',
      decidedBy: 'dashboard',
      userId: 42,
    });

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.action, 'WAIT_FOR_GOOD_TO_PAY');
    sinon.assert.calledOnce(feeStub);
    sinon.assert.calledOnce(completeStub);
    sinon.assert.calledWithMatch(feeStub, sinon.match.has('id', 2025), sinon.match({
      action: 'WAIT_FOR_GOOD_TO_PAY',
      userId: 42,
    }));
    sinon.assert.calledWithMatch(completeStub, sinon.match.has('id', 2025), sinon.match({
      action: 'WAIT_FOR_GOOD_TO_PAY',
    }));
  });
});
