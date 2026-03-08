const assert = require('assert');
const {
  classifyOperatorActionError,
  buildOperatorActionErrorResponse,
} = require('../services/operator-action-errors');

describe('operator action error helpers', function () {
  it('classifies missing pending actions', function () {
    assert.strictEqual(
      classifyOperatorActionError(new Error('No pending action found')),
      'NO_PENDING_ACTION'
    );
  });

  it('classifies policy blocks', function () {
    assert.strictEqual(
      classifyOperatorActionError(new Error('Action blocked by policy')),
      'ACTION_BLOCKED_BY_POLICY'
    );
  });

  it('classifies manual body validation errors', function () {
    assert.strictEqual(
      classifyOperatorActionError(new Error('body is required')),
      'MANUAL_BODY_REQUIRED'
    );
  });

  it('builds a response payload with success false and stable error_code', function () {
    assert.deepStrictEqual(
      buildOperatorActionErrorResponse(new Error('No pending action found'), 'LEGACY_APPROVE_FAILED'),
      {
        success: false,
        error: 'No pending action found',
        error_code: 'NO_PENDING_ACTION',
      }
    );
  });
});
