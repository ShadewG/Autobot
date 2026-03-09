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
        // Real case with raw intent from response_analysis
        { raw_intent: 'denial', expected_action: 'SEND_REBUTTAL', simulated_predicted_action: null, source_action_type: null, proposal_action_type: null },
        // Real cases where intent doesn't match expected action
        { raw_intent: 'acknowledgment', expected_action: 'NEGOTIATE_FEE', simulated_predicted_action: null, source_action_type: null, proposal_action_type: null },
        { raw_intent: 'acknowledgment', expected_action: 'NEGOTIATE_FEE', simulated_predicted_action: null, source_action_type: null, proposal_action_type: null },
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

  it('uses simulated_predicted_action when raw intent is missing', async function () {
    sinon.stub(db, 'query').resolves({
      rows: [
        // Simulation case: no raw intent, falls back to simulated_predicted_action
        { raw_intent: null, expected_action: 'SEND_REBUTTAL', simulated_predicted_action: 'SEND_FOLLOWUP', source_action_type: null, proposal_action_type: null },
        // Feedback case: no raw intent, falls back to source_action_type
        { raw_intent: null, expected_action: 'NEGOTIATE_FEE', simulated_predicted_action: null, source_action_type: 'NEGOTIATE_FEE', proposal_action_type: null },
        // Proposal case: no raw intent or sim/source, falls back to proposal action_type
        { raw_intent: null, expected_action: 'SEND_REBUTTAL', simulated_predicted_action: null, source_action_type: null, proposal_action_type: 'SEND_REBUTTAL' },
      ],
    });

    const matrix = await qualityReportService.buildClassificationConfusionMatrix({ windowDays: 30 });

    assert.strictEqual(matrix.totals.samples, 3);
    // No 'unknown' predictions should appear — all fallbacks resolved
    const unknownPredictions = matrix.matrix.filter(r => r.predicted_classification === 'unknown');
    assert.strictEqual(unknownPredictions.length, 0, 'Should not have unknown predictions when fallbacks are available');
  });

  it('normalizes raw intents to canonical classification labels', function () {
    const { normalizeIntentToCanonicalClass } = qualityReportService;
    assert.strictEqual(normalizeIntentToCanonicalClass('fee_request'), 'fee_notice');
    assert.strictEqual(normalizeIntentToCanonicalClass('question'), 'clarification');
    assert.strictEqual(normalizeIntentToCanonicalClass('more_info_needed'), 'clarification');
    assert.strictEqual(normalizeIntentToCanonicalClass('denial'), 'denial');
    assert.strictEqual(normalizeIntentToCanonicalClass('partial_denial'), 'partial_approval');
    assert.strictEqual(normalizeIntentToCanonicalClass('wrong_agency'), 'wrong_agency');
    assert.strictEqual(normalizeIntentToCanonicalClass('records_ready'), 'records_delivered');
    assert.strictEqual(normalizeIntentToCanonicalClass('delivery'), 'records_delivered');
    assert.strictEqual(normalizeIntentToCanonicalClass('acknowledgment'), 'acknowledgment');
    assert.strictEqual(normalizeIntentToCanonicalClass('portal_redirect'), 'initial_request');
    assert.strictEqual(normalizeIntentToCanonicalClass('hostile'), 'hostile');
    assert.strictEqual(normalizeIntentToCanonicalClass('none'), 'none');
    assert.strictEqual(normalizeIntentToCanonicalClass('other'), 'other');
    assert.strictEqual(normalizeIntentToCanonicalClass(''), 'unknown');
    assert.strictEqual(normalizeIntentToCanonicalClass(null), 'unknown');
  });

  it('builds reconciliation sections for inbound integrity gaps', async function () {
    const queryStub = sinon.stub(db, 'query');
    queryStub.onCall(0).resolves({ rows: [{ case_id: 25148, suggested_action: 'SEND_REBUTTAL', analysis_at: '2026-03-09T00:00:00.000Z', status: 'awaiting_response', agency_name: 'Perry PD' }] });
    queryStub.onCall(1).resolves({ rows: [] });
    queryStub.onCall(2).resolves({ rows: [{ count: '1' }] });
    queryStub.onCall(3).resolves({ rows: [{ count: '2' }] });
    queryStub.onCall(4).resolves({ rows: [] });
    queryStub.onCall(5).resolves({ rows: [] });
    queryStub.onCall(6).resolves({ rows: [] });
    queryStub.onCall(7).resolves({ rows: [{ inbound_with_attachments: '4', has_extraction: '3', missing_extraction: '1' }] });
    queryStub.onCall(8).resolves({ rows: [] });
    queryStub.onCall(9).resolves({ rows: [{ message_id: 9001, from_email: 'records@example.gov', subject: 'Unmatched inbound', thread_id: null, case_id: null, received_at: '2026-03-09T01:00:00.000Z' }] });
    queryStub.onCall(10).resolves({ rows: [{ message_id: 9002, case_id: 25157, from_email: 'govqa@example.gov', subject: 'HTML only', thread_id: 53, normalized_body_source: null, attachment_count: 1, received_at: '2026-03-09T02:00:00.000Z' }] });
    queryStub.onCall(11).resolves({ rows: [{ proposal_id: 1183, proposal_case_id: 25148, proposal_status: 'PENDING_APPROVAL', trigger_message_id: 990, message_case_id: 25157, proposal_agency_name: 'Perry PD', message_agency_name: 'SJSO', subject: 'Wrong thread', message_received_at: '2026-03-09T03:00:00.000Z' }] });

    const report = await qualityReportService.buildReconciliationReport();

    assert.strictEqual(report.orphaned_inbound, 1);
    assert.strictEqual(report.stale_proposals, 2);
    assert.strictEqual(report.inbound_linkage_gaps.count, 1);
    assert.strictEqual(report.inbound_linkage_gaps.messages[0].message_id, 9001);
    assert.strictEqual(report.empty_normalized_inbound.count, 1);
    assert.strictEqual(report.empty_normalized_inbound.messages[0].attachment_count, 1);
    assert.strictEqual(report.proposal_message_mismatches.count, 1);
    assert.strictEqual(report.proposal_message_mismatches.proposals[0].proposal_id, 1183);
  });
});
