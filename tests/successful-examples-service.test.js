const assert = require('assert');
const sinon = require('sinon');

const db = require('../services/database');
const successfulExamples = require('../services/successful-examples-service');

describe('Successful examples service', function () {
  afterEach(function () {
    sinon.restore();
  });

  it('stores approved proposal context as a successful example', async function () {
    sinon.stub(db, 'getProposalById').resolves({
      id: 1201,
      action_type: 'SEND_CLARIFICATION',
      draft_subject: 'Need one clarification',
      draft_body_text: 'Please confirm the date range.',
      human_edited: true,
    });
    sinon.stub(db, 'getCaseById').resolves({
      id: 1202,
      agency_name: 'Synthetic Police Department',
      state: 'TX',
      requested_records: ['CAD logs', 'body camera video'],
      agency_email: 'records@example.gov',
      portal_url: 'https://portal.example.gov',
      status: 'needs_human_review',
      substatus: 'Awaiting approval',
    });
    sinon.stub(db, 'getLatestResponseAnalysis').resolves({
      classification: 'CLARIFICATION_REQUEST',
    });
    const queryStub = sinon.stub(db, 'query').resolves({ rows: [{ id: 77 }] });

    const result = await successfulExamples.storeApprovedExample({
      id: 1201,
      case_id: 1202,
      trigger_message_id: 1203,
      action_type: 'SEND_CLARIFICATION',
    }, {
      decidedBy: 'qa-user',
    });

    assert.deepStrictEqual(result, { id: 77 });
    sinon.assert.calledOnce(queryStub);
    const [sql, params] = queryStub.firstCall.args;
    assert.match(sql, /INSERT INTO successful_examples/);
    assert.strictEqual(params[0], 1201);
    assert.strictEqual(params[1], 1202);
    assert.strictEqual(params[2], 1203);
    assert.strictEqual(params[3], 'SEND_CLARIFICATION');
    assert.strictEqual(params[4], 'CLARIFICATION_REQUEST');
    assert.strictEqual(params[5], 'Synthetic Police Department');
    assert.strictEqual(params[6], 'police agency');
    assert.strictEqual(params[7], 'TX');
    assert.strictEqual(params[8], 'CAD logs; body camera video');
    assert.strictEqual(params[9], 'Need one clarification');
    assert.strictEqual(params[10], 'Please confirm the date range.');
    assert.strictEqual(params[11], true);
    assert.strictEqual(params[12], 'qa-user');
    assert.ok(params[13].includes('records@example.gov'));
    assert.ok(params[13].includes('portal.example.gov'));
  });

  it('skips successful example capture when the approved proposal has no draft', async function () {
    sinon.stub(db, 'getProposalById').resolves({
      id: 1211,
      action_type: 'SEND_INITIAL_REQUEST',
      draft_subject: null,
      draft_body_text: null,
      human_edited: false,
    });
    const queryStub = sinon.stub(db, 'query').resolves({ rows: [] });

    const result = await successfulExamples.storeApprovedExample({
      id: 1211,
      case_id: 1212,
      action_type: 'SEND_INITIAL_REQUEST',
    });

    assert.strictEqual(result, null);
    sinon.assert.notCalled(queryStub);
  });

  it('retrieves the closest approved examples for the current case context', async function () {
    const queryStub = sinon.stub(db, 'query').resolves({
      rows: [
        {
          proposal_id: 1301,
          action_type: 'SEND_CLARIFICATION',
          classification: 'CLARIFICATION_REQUEST',
          agency_type: 'police agency',
          state_code: 'TX',
          draft_subject: 'Clarify date range',
          draft_body_text: 'Please confirm the date range.',
          match_score: 9,
          human_edited: false,
          created_at: new Date().toISOString(),
        },
      ],
    });

    const results = await successfulExamples.getRelevantExamples({
      agency_name: 'Synthetic Police Department',
      state: 'TX',
    }, {
      classification: 'CLARIFICATION_REQUEST',
      actionType: 'SEND_CLARIFICATION',
      limit: 2,
    });

    assert.strictEqual(results.length, 1);
    assert.strictEqual(results[0].proposal_id, 1301);
    sinon.assert.calledOnce(queryStub);
    assert.deepStrictEqual(queryStub.firstCall.args[1], [
      'CLARIFICATION_REQUEST',
      'police agency',
      'TX',
      'SEND_CLARIFICATION',
      10,
    ]);
  });

  it('formats approved examples into a prompt block', function () {
    const block = successfulExamples.formatExamplesForPrompt([
      {
        action_type: 'SEND_CLARIFICATION',
        classification: 'CLARIFICATION_REQUEST',
        agency_type: 'police agency',
        state_code: 'TX',
        draft_subject: 'Clarify date range',
        draft_body_text: 'Please confirm the date range and incident number.',
      },
    ], {
      heading: 'Similar approved drafts',
    });

    assert.match(block, /## Similar approved drafts/);
    assert.match(block, /Approved action: SEND_CLARIFICATION/);
    assert.match(block, /Please confirm the date range and incident number\./);
  });
});
