const assert = require('assert');
const express = require('express');
const sinon = require('sinon');
const supertest = require('supertest');

const evalRouter = require('../routes/eval');
const draftQualityEvalService = require('../services/draft-quality-eval-service');
const { tasks } = require('@trigger.dev/sdk');

describe('Eval draft quality capture route', function () {
  afterEach(function () {
    sinon.restore();
  });

  it('captures resolved draft eval cases and triggers draft_quality eval runs', async function () {
    sinon.stub(draftQualityEvalService, 'captureResolvedDraftQualityEvalCases').resolves({
      window_days: 30,
      eligible_count: 2,
      captured_count: 2,
      captured: [
        { eval_case_id: 101, proposal_id: 11 },
        { eval_case_id: 102, proposal_id: 12 },
      ],
    });
    const triggerStub = sinon.stub(tasks, 'trigger');
    triggerStub.onCall(0).resolves({ id: 'run_1' });
    triggerStub.onCall(1).resolves({ id: 'run_2' });

    const app = express();
    app.use(express.json());
    app.use('/api/eval', evalRouter);

    const response = await supertest(app)
      .post('/api/eval/capture-draft-quality')
      .send({ windowDays: 30, triggerRuns: true });

    assert.strictEqual(response.status, 200);
    assert.strictEqual(response.body.success, true);
    assert.strictEqual(response.body.capture.captured_count, 2);
    assert.deepStrictEqual(response.body.triggered, [
      { eval_case_id: 101, trigger_run_id: 'run_1' },
      { eval_case_id: 102, trigger_run_id: 'run_2' },
    ]);
    assert.deepStrictEqual(triggerStub.firstCall.args, ['eval-decision', { evalCaseId: 101, evaluationType: 'draft_quality' }]);
    assert.deepStrictEqual(triggerStub.secondCall.args, ['eval-decision', { evalCaseId: 102, evaluationType: 'draft_quality' }]);
  });
});
