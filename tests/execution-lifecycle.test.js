const assert = require('assert');
const sinon = require('sinon');

const db = require('../services/database');
const {
  createExecutionRecord,
  transitionExecutionRecord,
  emailExecutor,
  portalExecutor,
} = require('../services/executor-adapter');

describe('Execution lifecycle helpers', function () {
  afterEach(function () {
    sinon.restore();
  });

  it('merges provider payload and derives provider_message_id for terminal transitions', async function () {
    const completedAt = new Date('2026-03-07T14:00:00.000Z');
    sinon.stub(db, 'getExecutionByKey').resolves({
      id: 501,
      provider_payload: {
        to: 'qa@example.com',
        jobId: 'job-1',
        queuedAt: '2026-03-07T13:59:00.000Z',
      },
      provider_message_id: null,
    });
    const updateStub = sinon.stub(db, 'updateExecution').resolves({ id: 501 });

    await transitionExecutionRecord({
      executionKey: 'exec:501',
      updates: {
        status: 'SENT',
        providerPayload: {
          sendgridMessageId: 'sg-123',
          sentAt: '2026-03-07T14:00:00.000Z',
        },
        completedAt,
      },
    });

    sinon.assert.calledOnce(updateStub);
    const [executionId, updates] = updateStub.firstCall.args;
    assert.strictEqual(executionId, 501);
    assert.strictEqual(updates.status, 'SENT');
    assert.strictEqual(updates.provider_message_id, 'sg-123');
    assert.strictEqual(updates.completed_at, completedAt);
    assert.deepStrictEqual(updates.provider_payload, {
      to: 'qa@example.com',
      jobId: 'job-1',
      queuedAt: '2026-03-07T13:59:00.000Z',
      sendgridMessageId: 'sg-123',
      sentAt: '2026-03-07T14:00:00.000Z',
    });
  });

  it('stores completed_at on skipped dry-run executions', async function () {
    const completedAt = new Date('2026-03-07T14:05:00.000Z');
    const queryStub = sinon.stub(db, 'query').resolves({ rows: [{ id: 502 }] });

    await createExecutionRecord({
      caseId: 9001,
      proposalId: 9002,
      runId: 9003,
      executionKey: 'exec:dry:502',
      actionType: 'SEND_INITIAL_REQUEST',
      status: 'SKIPPED',
      provider: 'email',
      providerPayload: { dryRun: true },
      completedAt,
    });

    sinon.assert.calledOnce(queryStub);
    const [, params] = queryStub.firstCall.args;
    assert.strictEqual(params[9], completedAt);
  });

  it('marks queued email executions as sent with merged provider payload', async function () {
    sinon.stub(db, 'getExecutionByKey').resolves({
      id: 601,
      provider_payload: {
        to: 'qa@example.com',
        subject: 'Queued reply',
        jobId: 'job-99',
      },
      provider_message_id: null,
    });
    const updateStub = sinon.stub(db, 'updateExecution').resolves({ id: 601 });

    await emailExecutor.markSent('exec:601', 'msg-601', {
      statusCode: 202,
      sendgridMessageId: 'sg-601',
      sentAt: '2026-03-07T14:10:00.000Z',
    });

    sinon.assert.calledOnce(updateStub);
    const [executionId, updates] = updateStub.firstCall.args;
    assert.strictEqual(executionId, 601);
    assert.strictEqual(updates.status, 'SENT');
    assert.strictEqual(updates.provider_message_id, 'msg-601');
    assert.ok(updates.completed_at instanceof Date);
    assert.deepStrictEqual(updates.provider_payload, {
      to: 'qa@example.com',
      subject: 'Queued reply',
      jobId: 'job-99',
      channel: 'email',
      transport: 'queued',
      statusCode: 202,
      sendgridMessageId: 'sg-601',
      sentAt: '2026-03-07T14:10:00.000Z',
    });
  });

  it('marks manual portal completion as SENT with merged payload', async function () {
    const queryStub = sinon.stub(db, 'query');
    queryStub.resolves({
      rows: [{
        id: 701,
        status: 'COMPLETED',
        execution_id: 801,
      }],
    });
    sinon.stub(db, 'getExecutionById').resolves({
      id: 801,
      provider_payload: {
        portalUrl: 'https://portal.example.test',
        requiresManualSubmission: true,
      },
      provider_message_id: null,
    });
    const updateStub = sinon.stub(db, 'updateExecution').resolves({ id: 801 });

    await portalExecutor.markTaskCompleted(701, {
      notes: 'Submitted in portal',
      confirmationNumber: 'ABC123',
    });

    sinon.assert.calledOnce(updateStub);
    const [executionId, updates] = updateStub.firstCall.args;
    assert.strictEqual(executionId, 801);
    assert.strictEqual(updates.status, 'SENT');
    assert.ok(updates.completed_at instanceof Date);
    assert.deepStrictEqual(updates.provider_payload, {
      portalUrl: 'https://portal.example.test',
      requiresManualSubmission: true,
      channel: 'portal',
      transport: 'manual',
      completedManually: true,
      completionNotes: 'Submitted in portal',
      confirmationNumber: 'ABC123',
    });
  });

  it('marks manual portal cancellation as CANCELLED instead of FAILED', async function () {
    const queryStub = sinon.stub(db, 'query');
    queryStub.resolves({
      rows: [{
        id: 702,
        status: 'CANCELLED',
        execution_id: 802,
      }],
    });
    sinon.stub(db, 'getExecutionById').resolves({
      id: 802,
      provider_payload: {
        portalUrl: 'https://portal.example.test',
        requiresManualSubmission: true,
      },
      provider_message_id: null,
    });
    const updateStub = sinon.stub(db, 'updateExecution').resolves({ id: 802 });

    await portalExecutor.markTaskCancelled(702, 'Duplicate submission');

    sinon.assert.calledOnce(updateStub);
    const [executionId, updates] = updateStub.firstCall.args;
    assert.strictEqual(executionId, 802);
    assert.strictEqual(updates.status, 'CANCELLED');
    assert.strictEqual(updates.error_message, 'Cancelled: Duplicate submission');
    assert.ok(updates.completed_at instanceof Date);
    assert.deepStrictEqual(updates.provider_payload, {
      portalUrl: 'https://portal.example.test',
      requiresManualSubmission: true,
      channel: 'portal',
      transport: 'manual',
      cancelledManually: true,
      cancellationReason: 'Duplicate submission',
    });
  });
});
