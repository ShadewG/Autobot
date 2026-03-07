const assert = require('assert');
const sinon = require('sinon');

const db = require('../services/database');
const decisionMemory = require('../services/decision-memory-service');
const proposalFeedback = require('../services/proposal-feedback');

describe('Proposal feedback helpers', function () {
  afterEach(function () {
    sinon.restore();
  });

  it('captures dismiss eval cases with normalized notes', async function () {
    const queryStub = sinon.stub(db, 'query').resolves({ rows: [] });
    sinon.stub(decisionMemory, 'learnFromOutcome').resolves();

    await proposalFeedback.captureDismissFeedback({
      id: 901,
      case_id: 902,
      trigger_message_id: 903,
      action_type: 'SEND_REBUTTAL',
    }, {
      instruction: 'Do not send this',
      reason: 'Wrong agency',
      decidedBy: 'qa-user',
    });

    const evalInsertCall = queryStub.getCalls().find((call) => String(call.args[0]).includes('INSERT INTO eval_cases'));
    assert.ok(evalInsertCall, 'expected eval case insert query');
    const [sql, params] = evalInsertCall.args;
    assert.match(sql, /INSERT INTO eval_cases/);
    assert.strictEqual(params[0], 901);
    assert.strictEqual(params[1], 902);
    assert.strictEqual(params[2], 903);
    assert.strictEqual(params[3], 'DISMISSED');
    assert.match(params[4], /Auto-captured from monitor decision: DISMISS/);
    assert.match(params[4], /Instruction: Do not send this/);
    assert.match(params[4], /Reason: Wrong agency/);
    assert.match(params[4], /Decided by: qa-user/);
  });

  it('learns from dismiss outcomes without throwing when the DB case exists', async function () {
    sinon.stub(db, 'query').resolves({ rows: [] });
    sinon.stub(db, 'getCaseById').resolves({
      id: 902,
      case_name: 'Jordan Example request',
      agency_name: 'Synthetic Records Unit',
    });
    const learnStub = sinon.stub(decisionMemory, 'learnFromOutcome').resolves();

    await proposalFeedback.captureDismissFeedback({
      id: 901,
      case_id: 902,
      trigger_message_id: 903,
      action_type: 'SEND_REBUTTAL',
    }, {
      reason: 'Wrong action type',
    });

    sinon.assert.calledOnce(learnStub);
    sinon.assert.calledWithMatch(learnStub, {
      category: 'general',
      triggerPattern: 'dismissed SEND_REBUTTAL for Synthetic Records Unit',
      sourceCaseId: 902,
      priority: 6,
    });
  });
});
