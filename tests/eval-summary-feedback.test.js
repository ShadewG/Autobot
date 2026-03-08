const assert = require('assert');
const express = require('express');
const sinon = require('sinon');
const supertest = require('supertest');

const evalRouter = require('../routes/eval');
const db = require('../services/database');

describe('Eval summary feedback metrics', function () {
  afterEach(function () {
    sinon.restore();
  });

  it('includes approval, adjust, and dismiss metrics by action type, agency, and classification', async function () {
    const queryStub = sinon.stub(db, 'query');
    queryStub.onCall(0).resolves({
      rows: [{
        total_cases: 12,
        runs_last_7d: 5,
        avg_score_7d: '4.20',
        correct_7d: 4,
        total_7d: 5,
      }],
    });
    queryStub.onCall(1).resolves({ rows: [{ failure_category: 'WRONG_ROUTING', count: 2 }] });
    queryStub.onCall(2).resolves({
      rows: [{
        total_reviews: 10,
        approve_count: 6,
        adjust_count: 3,
        dismiss_count: 1,
      }],
    });
    queryStub.onCall(3).resolves({
      rows: [{
        proposal_action_type: 'SEND_INITIAL_REQUEST',
        total_reviews: 5,
        approve_count: 2,
        adjust_count: 2,
        dismiss_count: 1,
      }],
    });
    queryStub.onCall(4).resolves({
      rows: [{
        agency_name: 'Synthetic Records Unit',
        total_reviews: 4,
        approve_count: 1,
        adjust_count: 2,
        dismiss_count: 1,
      }],
    });
    queryStub.onCall(5).resolves({
      rows: [{
        classification: 'denial',
        total_reviews: 3,
        approve_count: 1,
        adjust_count: 1,
        dismiss_count: 1,
      }],
    });

    const app = express();
    app.use('/api/eval', evalRouter);

    const response = await supertest(app).get('/api/eval/summary');

    assert.strictEqual(response.status, 200);
    assert.strictEqual(response.body.success, true);
    assert.strictEqual(response.body.summary.total_cases, 12);
    assert.strictEqual(response.body.feedback_metrics.window_days, 30);
    assert.strictEqual(response.body.feedback_metrics.overview.total_reviews, 10);
    assert.strictEqual(response.body.feedback_metrics.overview.approve_count, 6);
    assert.strictEqual(response.body.feedback_metrics.overview.adjust_count, 3);
    assert.strictEqual(response.body.feedback_metrics.overview.dismiss_count, 1);
    assert.strictEqual(response.body.feedback_metrics.by_action_type[0].proposal_action_type, 'SEND_INITIAL_REQUEST');
    assert.strictEqual(response.body.feedback_metrics.by_action_type[0].approval_rate, 0.4);
    assert.strictEqual(response.body.feedback_metrics.by_agency[0].agency_name, 'Synthetic Records Unit');
    assert.strictEqual(response.body.feedback_metrics.by_agency[0].dismiss_rate, 0.25);
    assert.strictEqual(response.body.feedback_metrics.by_classification[0].classification, 'denial');
    assert.strictEqual(response.body.feedback_metrics.by_classification[0].adjust_rate, 0.3333);
  });
});
