const assert = require('assert');
const sinon = require('sinon');

const {
  createDecisionTraceTracker,
  summarizeExecutionResult,
} = require('../services/decision-trace-service');

describe('decision trace service', function () {
  afterEach(function () {
    sinon.restore();
  });

  it('creates and completes a trace with merged lifecycle data', async function () {
    const db = {
      createDecisionTrace: sinon.stub().resolves({ id: 77 }),
      completeDecisionTrace: sinon.stub().resolves({ id: 77 }),
    };

    const tracker = await createDecisionTraceTracker(db, {
      taskType: 'process-inbound',
      runId: 11,
      caseId: 22,
      messageId: 33,
      triggerType: 'INBOUND_MESSAGE',
    });

    tracker.recordNode('classify_inbound', { detail: 'classified inbound' });
    tracker.setClassification({ rawClassification: 'QUESTION', effectiveClassification: 'QUESTION' });
    tracker.setRouterOutput({ actionType: 'SEND_CLARIFICATION', requiresHuman: true });
    tracker.setGateDecision({ proposalId: 44, shouldWait: true });
    tracker.markOutcome('completed', { proposalId: 44 });

    await tracker.complete();

    sinon.assert.calledOnce(db.createDecisionTrace);
    sinon.assert.calledOnce(db.completeDecisionTrace);

    const completeArgs = db.completeDecisionTrace.getCall(0).args;
    assert.strictEqual(completeArgs[0], 77);
    assert.strictEqual(completeArgs[1].classification.rawClassification, 'QUESTION');
    assert.strictEqual(completeArgs[1].router_output.actionType, 'SEND_CLARIFICATION');
    assert.strictEqual(completeArgs[1].gate_decision.proposalId, 44);
    assert.strictEqual(completeArgs[1].node_trace.status, 'completed');
    assert.ok(Array.isArray(completeArgs[1].node_trace.steps));
    assert.ok(completeArgs[1].node_trace.steps.some((step) => step.step === 'task_started'));
    assert.ok(completeArgs[1].node_trace.steps.some((step) => step.step === 'classify_inbound'));
  });

  it('skips persistence when a run id is unavailable', async function () {
    const db = {
      createDecisionTrace: sinon.stub().resolves({ id: 99 }),
      completeDecisionTrace: sinon.stub().resolves({ id: 99 }),
    };

    const tracker = await createDecisionTraceTracker(db, {
      taskType: 'submit-portal',
      runId: null,
      caseId: 22,
    });

    tracker.markOutcome('completed', { success: true });
    await tracker.complete();

    sinon.assert.notCalled(db.createDecisionTrace);
    sinon.assert.notCalled(db.completeDecisionTrace);
  });

  it('always creates a trace row when runId and caseId are present', async function () {
    const db = {
      createDecisionTrace: sinon.stub().resolves({ id: 101 }),
      completeDecisionTrace: sinon.stub().resolves({ id: 101 }),
    };

    // Simulate all 4 task types that must create traces
    const taskTypes = [
      'process-initial-request',
      'process-inbound',
      'process-followup',
      'submit-portal',
    ];

    for (const taskType of taskTypes) {
      db.createDecisionTrace.resetHistory();
      db.completeDecisionTrace.resetHistory();

      const tracker = await createDecisionTraceTracker(db, {
        taskType,
        runId: 10,
        caseId: 20,
        messageId: 30,
      });

      sinon.assert.calledOnce(db.createDecisionTrace);
      const createArgs = db.createDecisionTrace.getCall(0).args[0];
      assert.strictEqual(createArgs.run_id, 10);
      assert.strictEqual(createArgs.case_id, 20);
      assert.strictEqual(createArgs.message_id, 30);
      assert.strictEqual(createArgs.node_trace.taskType, taskType);

      // Completing should persist
      tracker.markOutcome('completed', { success: true });
      await tracker.complete();
      sinon.assert.calledOnce(db.completeDecisionTrace);
      assert.strictEqual(db.completeDecisionTrace.getCall(0).args[0], 101);
    }
  });

  it('skips persistence when caseId is missing', async function () {
    const db = {
      createDecisionTrace: sinon.stub().resolves({ id: 102 }),
      completeDecisionTrace: sinon.stub().resolves({ id: 102 }),
    };

    const tracker = await createDecisionTraceTracker(db, {
      taskType: 'process-inbound',
      runId: 10,
      caseId: null,
    });

    tracker.markOutcome('completed');
    await tracker.complete();

    sinon.assert.notCalled(db.createDecisionTrace);
    sinon.assert.notCalled(db.completeDecisionTrace);
  });

  it('summarizes execution results without leaking nested objects', function () {
    const summary = summarizeExecutionResult({
      action: 'email_sent',
      executionKey: 'abc',
      emailJobId: 123,
      details: {
        provider: 'sendgrid',
        nested: { ok: true },
      },
    });

    assert.strictEqual(summary.action, 'email_sent');
    assert.strictEqual(summary.executionKey, 'abc');
    assert.strictEqual(summary.emailJobId, 123);
    assert.deepStrictEqual(summary.details, {
      provider: 'sendgrid',
      nested: { ok: true },
    });
  });
});
