const assert = require('assert');
const express = require('express');
const sinon = require('sinon');
const supertest = require('supertest');

const evalRouter = require('../routes/eval');
const qualityReportService = require('../services/quality-report-service');

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
});
