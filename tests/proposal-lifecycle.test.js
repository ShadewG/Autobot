const assert = require('assert');
const sinon = require('sinon');

const db = require('../services/database');
const proposalLifecycle = require('../services/proposal-lifecycle');

describe('Proposal lifecycle helper', function () {
  afterEach(function () {
    sinon.restore();
  });

  it('writes full human review audit fields on approval', async function () {
    const updateStub = sinon.stub(db, 'updateProposal').resolves({ id: 101 });
    const humanDecision = proposalLifecycle.buildHumanDecision('APPROVE', {
      decidedAt: '2026-03-07T10:00:00.000Z',
      decidedBy: 'qa-user',
      instruction: 'Looks good',
    });

    await proposalLifecycle.applyHumanReviewDecision(101, {
      status: 'APPROVED',
      humanDecision,
    });

    assert.strictEqual(updateStub.calledOnce, true);
    const [proposalId, updates] = updateStub.firstCall.args;
    assert.strictEqual(proposalId, 101);
    assert.strictEqual(updates.status, 'APPROVED');
    assert.deepStrictEqual(updates.humanDecision, humanDecision);
    assert.strictEqual(updates.humanDecidedBy, 'qa-user');
    assert.ok(updates.humanDecidedAt instanceof Date);
    assert.strictEqual(updates.humanDecidedAt.toISOString(), '2026-03-07T10:00:00.000Z');
  });

  it('writes executed_at and provider metadata on executed proposals', async function () {
    const updateStub = sinon.stub(db, 'updateProposal').resolves({ id: 202 });
    const humanDecision = proposalLifecycle.buildHumanDecision('APPROVE', {
      decidedAt: '2026-03-07T11:00:00.000Z',
      decidedBy: 'qa-user',
    });
    const executedAt = new Date('2026-03-07T11:05:00.000Z');

    await proposalLifecycle.markProposalExecuted(202, {
      humanDecision,
      emailJobId: 'msg-123',
      executionKey: 'direct-email:202',
      executedAt,
    });

    assert.strictEqual(updateStub.calledOnce, true);
    const [proposalId, updates] = updateStub.firstCall.args;
    assert.strictEqual(proposalId, 202);
    assert.strictEqual(updates.status, 'EXECUTED');
    assert.deepStrictEqual(updates.humanDecision, humanDecision);
    assert.strictEqual(updates.humanDecidedBy, 'qa-user');
    assert.strictEqual(updates.emailJobId, 'msg-123');
    assert.strictEqual(updates.executionKey, 'direct-email:202');
    assert.strictEqual(updates.executedAt, executedAt);
  });

  it('bulk dismisses active case proposals with audit metadata', async function () {
    const queryStub = sinon.stub(db, 'query').resolves({ rows: [{ id: 301 }] });
    const humanDecision = proposalLifecycle.buildHumanDecision('DISMISS', {
      decidedAt: '2026-03-07T12:00:00.000Z',
      decidedBy: 'qa-user',
      reason: 'Superseded',
    });

    const rows = await proposalLifecycle.dismissActiveCaseProposals(777, {
      humanDecision,
      statuses: ['PENDING_APPROVAL', 'BLOCKED'],
    });

    assert.deepStrictEqual(rows, [{ id: 301 }]);
    assert.strictEqual(queryStub.calledOnce, true);
    const [sql, params] = queryStub.firstCall.args;
    assert.match(sql, /UPDATE proposals/);
    assert.match(sql, /human_decided_at/);
    assert.strictEqual(params[0], JSON.stringify(humanDecision));
    assert.strictEqual(params[1].toISOString(), '2026-03-07T12:00:00.000Z');
    assert.strictEqual(params[2], 'qa-user');
    assert.strictEqual(params[3], 777);
    assert.deepStrictEqual(params[4], ['PENDING_APPROVAL', 'BLOCKED']);
  });

  it('uses conditional updates for DECISION_RECEIVED claims', async function () {
    const queryStub = sinon.stub(db, 'query').resolves({ rows: [{ id: 404, status: 'DECISION_RECEIVED' }] });
    const humanDecision = proposalLifecycle.buildHumanDecision('APPROVE', {
      decidedBy: 'qa-user',
    });

    const row = await proposalLifecycle.markProposalDecisionReceived(404, {
      humanDecision,
      allowedCurrentStatuses: ['PENDING_APPROVAL', 'BLOCKED'],
    });

    assert.deepStrictEqual(row, { id: 404, status: 'DECISION_RECEIVED' });
    assert.strictEqual(queryStub.calledOnce, true);
    const [sql, params] = queryStub.firstCall.args;
    assert.match(sql, /WHERE id = \$1/);
    assert.match(sql, /status = ANY/);
    assert.match(sql, /human_decision = \$3::jsonb/);
    assert.strictEqual(params[0], 404);
    assert.strictEqual(params[params.length - 1][0], 'PENDING_APPROVAL');
    assert.strictEqual(params[params.length - 1][1], 'BLOCKED');
  });
});
