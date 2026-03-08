const assert = require('assert');
const runEngineRouter = require('../routes/run-engine');

describe('proposal decision error codes', function () {
  const getProposalDecisionErrorCode = runEngineRouter.getProposalDecisionErrorCode;

  it('classifies waitpoint failures explicitly', function () {
    assert.strictEqual(
      getProposalDecisionErrorCode(new Error('Failed to complete waitpoint token waitpoint_123: 500 boom')),
      'WAITPOINT_COMPLETION_FAILED'
    );
  });

  it('classifies trigger dispatch failures explicitly', function () {
    assert.strictEqual(
      getProposalDecisionErrorCode(new Error('Trigger.dev dispatch failed for process-inbound')),
      'TRIGGER_DISPATCH_FAILED'
    );
  });

  it('classifies portal URL errors explicitly', function () {
    assert.strictEqual(
      getProposalDecisionErrorCode(new Error('No portal URL on case 25152')),
      'PORTAL_URL_MISSING'
    );
  });

  it('falls back to a generic proposal decision code', function () {
    assert.strictEqual(
      getProposalDecisionErrorCode(new Error('unexpected failure')),
      'PROPOSAL_DECISION_FAILED'
    );
  });
});
