const assert = require('assert');
const sinon = require('sinon');

const db = require('../services/database');
const qualityReportService = require('../services/quality-report-service');

describe('Quality report service', function () {
  afterEach(function () {
    sinon.restore();
  });

  it('builds the weekly quality report from backend metrics', async function () {
    const queryStub = sinon.stub(db, 'query');
    queryStub.onCall(0).resolves({ rows: [{ cases_processed: 9, cases_resolved: 3 }] });
    queryStub.onCall(1).resolves({ rows: [{ total_reviews: 6, approve_count: 3, adjust_count: 2, dismiss_count: 1 }] });
    queryStub.onCall(2).resolves({ rows: [{ adjustment: 'Use a less aggressive tone', count: 2 }] });
    queryStub.onCall(3).resolves({ rows: [{ failure_category: 'WRONG_ROUTING', count: 4 }] });
    queryStub.onCall(4).resolves({
      rows: [
        {
          id: 1,
          agency_name: 'Springfield Police Department',
          created_at: '2026-03-01T00:00:00.000Z',
          closed_at: '2026-03-06T00:00:00.000Z',
        },
        {
          id: 2,
          agency_name: 'Clark County Sheriff Office',
          created_at: '2026-03-02T00:00:00.000Z',
          closed_at: '2026-03-04T00:00:00.000Z',
        },
      ],
    });

    const report = await qualityReportService.buildWeeklyQualityReport({ windowDays: 7 });

    assert.strictEqual(report.window_days, 7);
    assert.strictEqual(report.overview.cases_processed, 9);
    assert.strictEqual(report.overview.cases_resolved, 3);
    assert.strictEqual(report.overview.total_reviews, 6);
    assert.strictEqual(report.overview.approval_rate, 0.5);
    assert.strictEqual(report.common_adjustments[0].adjustment, 'Use a less aggressive tone');
    assert.strictEqual(report.common_failures[0].failure_category, 'WRONG_ROUTING');
    assert.strictEqual(report.time_to_resolution_by_agency_type[0].agency_type, 'police agency');
    assert.strictEqual(report.time_to_resolution_by_agency_type[0].avg_resolution_days, 5);
  });

  it('builds a classification confusion matrix from inferred actual classes', async function () {
    sinon.stub(db, 'query').resolves({
      rows: [
        { predicted_classification: 'denial', expected_action: 'SEND_REBUTTAL' },
        { predicted_classification: 'acknowledgment', expected_action: 'NEGOTIATE_FEE' },
        { predicted_classification: 'acknowledgment', expected_action: 'NEGOTIATE_FEE' },
      ],
    });

    const matrix = await qualityReportService.buildClassificationConfusionMatrix({ windowDays: 30 });

    assert.strictEqual(matrix.window_days, 30);
    assert.strictEqual(matrix.actual_source, 'expected_action_inference');
    assert.strictEqual(matrix.totals.samples, 3);
    assert.deepStrictEqual(matrix.matrix[0], {
      actual_classification: 'fee_notice',
      predicted_classification: 'acknowledgment',
      count: 2,
    });
    assert.deepStrictEqual(matrix.top_confusions[0], {
      actual_classification: 'fee_notice',
      predicted_classification: 'acknowledgment',
      count: 2,
    });
  });
});
