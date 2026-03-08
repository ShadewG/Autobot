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
    assert.strictEqual(params[4], 'SEND_REBUTTAL');
    assert.strictEqual(params[5], 'human_review');
    assert.strictEqual(params[6], 'DISMISS');
    assert.strictEqual(params[7], 'Do not send this');
    assert.strictEqual(params[8], 'Wrong agency');
    assert.strictEqual(params[9], 'qa-user');
    assert.match(params[10], /Auto-captured from monitor decision: DISMISS/);
    assert.match(params[10], /Instruction: Do not send this/);
    assert.match(params[10], /Reason: Wrong agency/);
    assert.match(params[10], /Decided by: qa-user/);
  });

  it('captures adjust eval cases with structured feedback fields', async function () {
    const queryStub = sinon.stub(db, 'query').resolves({ rows: [] });
    sinon.stub(db, 'getCaseById').resolves({
      id: 912,
      agency_name: 'Synthetic Records Unit',
    });
    sinon.stub(decisionMemory, 'learnFromOutcome').resolves();

    await proposalFeedback.autoCaptureEvalCase({
      id: 911,
      case_id: 912,
      trigger_message_id: 913,
      action_type: 'SEND_INITIAL_REQUEST',
    }, {
      action: 'ADJUST',
      instruction: 'Keep the action but shorten the draft and remove the fee paragraph',
      reason: 'Too long',
      decidedBy: 'qa-user',
    });

    const evalInsertCall = queryStub.getCalls().find((call) => String(call.args[0]).includes('INSERT INTO eval_cases'));
    assert.ok(evalInsertCall, 'expected eval case insert query');
    const [, params] = evalInsertCall.args;
    assert.strictEqual(params[0], 911);
    assert.strictEqual(params[1], 912);
    assert.strictEqual(params[2], 913);
    assert.strictEqual(params[3], 'SEND_INITIAL_REQUEST');
    assert.strictEqual(params[4], 'SEND_INITIAL_REQUEST');
    assert.strictEqual(params[5], 'human_review');
    assert.strictEqual(params[6], 'ADJUST');
    assert.strictEqual(params[7], 'Keep the action but shorten the draft and remove the fee paragraph');
    assert.strictEqual(params[8], 'Too long');
    assert.strictEqual(params[9], 'qa-user');
    assert.match(params[10], /Auto-captured from monitor decision: ADJUST/);
  });

  it('learns reusable lessons from adjust instructions', async function () {
    sinon.stub(db, 'query').resolves({ rows: [] });
    sinon.stub(db, 'getCaseById').resolves({
      id: 912,
      agency_name: 'Synthetic Records Unit',
    });
    const learnStub = sinon.stub(decisionMemory, 'learnFromOutcome').resolves();

    await proposalFeedback.autoCaptureEvalCase({
      id: 921,
      case_id: 912,
      trigger_message_id: 913,
      action_type: 'SEND_INITIAL_REQUEST',
    }, {
      action: 'ADJUST',
      instruction: "Don't be aggressive with this agency",
      reason: 'Tone',
      decidedBy: 'qa-user',
    });

    sinon.assert.calledOnce(learnStub);
    sinon.assert.calledWithMatch(learnStub, {
      category: 'general',
      triggerPattern: 'adjusted SEND_INITIAL_REQUEST for Synthetic Records Unit',
      lesson: 'Use a collaborative, non-aggressive tone unless the agency has clearly denied the request with cited authority.',
      sourceCaseId: 912,
      priority: 7,
    });
  });

  it('learns reusable patterns from approvals without human edits', async function () {
    sinon.stub(db, 'query').resolves({ rows: [] });
    sinon.stub(db, 'getProposalById').resolves({
      id: 931,
      case_id: 932,
      action_type: 'SEND_CLARIFICATION',
      human_edited: false,
    });
    sinon.stub(db, 'getCaseById').resolves({
      id: 932,
      agency_name: 'Synthetic Police Department',
    });
    sinon.stub(db, 'getLatestResponseAnalysis').resolves({
      classification: 'CLARIFICATION_REQUEST',
    });
    const learnStub = sinon.stub(decisionMemory, 'learnFromOutcome').resolves();

    await proposalFeedback.autoCaptureEvalCase({
      id: 931,
      case_id: 932,
      trigger_message_id: 933,
      action_type: 'SEND_CLARIFICATION',
    }, {
      action: 'APPROVE',
      decidedBy: 'qa-user',
    });

    sinon.assert.calledOnce(learnStub);
    sinon.assert.calledWithMatch(learnStub, {
      category: 'general',
      triggerPattern: 'approved SEND_CLARIFICATION for police agency / CLARIFICATION_REQUEST',
      lesson: 'When the classification is CLARIFICATION_REQUEST for a police agency, SEND_CLARIFICATION has been approved without edits. Prefer this action when the surrounding facts match.',
      sourceCaseId: 932,
      priority: 6,
    });
  });

  it('skips approval learning when the approved draft was human-edited', async function () {
    sinon.stub(db, 'query').resolves({ rows: [] });
    sinon.stub(db, 'getProposalById').resolves({
      id: 941,
      case_id: 942,
      action_type: 'SEND_INITIAL_REQUEST',
      human_edited: true,
    });
    const learnStub = sinon.stub(decisionMemory, 'learnFromOutcome').resolves();

    await proposalFeedback.autoCaptureEvalCase({
      id: 941,
      case_id: 942,
      trigger_message_id: 943,
      action_type: 'SEND_INITIAL_REQUEST',
    }, {
      action: 'APPROVE',
      decidedBy: 'qa-user',
    });

    sinon.assert.notCalled(learnStub);
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
