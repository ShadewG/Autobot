const assert = require('assert');
const express = require('express');
const sinon = require('sinon');
const supertest = require('supertest');

const evalRouter = require('../routes/eval');
const qualityReportService = require('../services/quality-report-service');
const errorTrackingService = require('../services/error-tracking-service');

describe('Eval quality report routes', function () {
  afterEach(function () {
    sinon.restore();
  });

  it('serves the weekly quality report payload', async function () {
    sinon.stub(qualityReportService, 'buildWeeklyQualityReport').resolves({
      window_days: 7,
      overview: { cases_processed: 12 },
      common_adjustments: [],
      common_failures: [],
      time_to_resolution_by_agency_type: [],
    });

    const app = express();
    app.use('/api/eval', evalRouter);

    const response = await supertest(app).get('/api/eval/quality-report?windowDays=7');

    assert.strictEqual(response.status, 200);
    assert.strictEqual(response.body.success, true);
    assert.strictEqual(response.body.report.window_days, 7);
    assert.strictEqual(response.body.report.overview.cases_processed, 12);
  });

  it('serves the classification confusion matrix payload', async function () {
    sinon.stub(qualityReportService, 'buildClassificationConfusionMatrix').resolves({
      window_days: 30,
      totals: { samples: 4 },
      matrix: [],
      top_confusions: [],
    });

    const app = express();
    app.use('/api/eval', evalRouter);

    const response = await supertest(app).get('/api/eval/classification-confusion?windowDays=30');

    assert.strictEqual(response.status, 200);
    assert.strictEqual(response.body.success, true);
    assert.strictEqual(response.body.confusion_matrix.window_days, 30);
    assert.strictEqual(response.body.confusion_matrix.totals.samples, 4);
  });

  it('serves tracked error events', async function () {
    sinon.stub(errorTrackingService, 'searchErrorEvents').resolves([
      { id: 7, source_service: 'eval_api', error_message: 'boom' },
    ]);

    const app = express();
    app.use('/api/eval', evalRouter);

    const response = await supertest(app).get('/api/eval/errors?sourceService=eval_api&limit=10');

    assert.strictEqual(response.status, 200);
    assert.strictEqual(response.body.success, true);
    assert.strictEqual(response.body.errors.length, 1);
    assert.strictEqual(response.body.errors[0].id, 7);
    assert.strictEqual(errorTrackingService.searchErrorEvents.firstCall.args[0].sourceService, 'eval_api');
    assert.strictEqual(errorTrackingService.searchErrorEvents.firstCall.args[0].limit, 10);
  });

  it('captures route failures in tracked errors', async function () {
    sinon.stub(qualityReportService, 'buildWeeklyQualityReport').rejects(new Error('report blew up'));
    const captureStub = sinon.stub(errorTrackingService, 'captureException').resolves(null);

    const app = express();
    app.use('/api/eval', evalRouter);

    const response = await supertest(app).get('/api/eval/quality-report?windowDays=7');

    assert.strictEqual(response.status, 500);
    assert.strictEqual(response.body.success, false);
    assert.strictEqual(captureStub.calledOnce, true);
    assert.strictEqual(captureStub.firstCall.args[1].sourceService, 'eval_api');
    assert.strictEqual(captureStub.firstCall.args[1].operation, 'quality_report');
  });
});
