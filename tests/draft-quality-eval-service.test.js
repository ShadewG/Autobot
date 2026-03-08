const assert = require('assert');
const sinon = require('sinon');

const db = require('../services/database');
const draftQualityEvalService = require('../services/draft-quality-eval-service');

describe('Draft quality eval service', function () {
  afterEach(function () {
    sinon.restore();
  });

  it('captures resolved sent drafts into eval cases and reuses existing eval cases when present', async function () {
    const queryStub = sinon.stub(db, 'query');
    queryStub.onCall(0).resolves({
      rows: [
        {
          proposal_id: 11,
          case_id: 21,
          trigger_message_id: 31,
          action_type: 'SEND_INITIAL_REQUEST',
          closed_at: '2026-03-08T00:00:00.000Z',
          outcome_type: 'full_approval',
          outcome_summary: 'Records received',
          eval_case_id: null,
        },
        {
          proposal_id: 12,
          case_id: 22,
          trigger_message_id: 32,
          action_type: 'SEND_PDF_EMAIL',
          closed_at: '2026-03-08T00:00:00.000Z',
          outcome_type: 'partial_approval',
          outcome_summary: 'Form returned',
          eval_case_id: 77,
        },
      ],
    });
    queryStub.onCall(1).resolves({ rows: [{ id: 101 }] });

    const result = await draftQualityEvalService.captureResolvedDraftQualityEvalCases({ windowDays: 14 });

    assert.strictEqual(result.window_days, 14);
    assert.strictEqual(result.eligible_count, 2);
    assert.strictEqual(result.captured_count, 2);
    assert.deepStrictEqual(result.captured[0], {
      eval_case_id: 101,
      proposal_id: 11,
      case_id: 21,
      action_type: 'SEND_INITIAL_REQUEST',
      closed_at: '2026-03-08T00:00:00.000Z',
      outcome_type: 'full_approval',
      outcome_summary: 'Records received',
      reused_eval_case: false,
    });
    assert.deepStrictEqual(result.captured[1], {
      eval_case_id: 77,
      proposal_id: 12,
      case_id: 22,
      action_type: 'SEND_PDF_EMAIL',
      closed_at: '2026-03-08T00:00:00.000Z',
      outcome_type: 'partial_approval',
      outcome_summary: 'Form returned',
      reused_eval_case: true,
    });
  });
});
