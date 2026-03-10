const assert = require('assert');

const { resolveReviewState } = require('../lib/resolve-review-state');
const {
  resolveControlState,
  detectControlMismatches,
  toRequestListItem,
} = require('../routes/requests/_helpers');

describe('Review and control state regressions', function () {
  it('treats pending portal proposals as true decision-required gates', function () {
    const caseData = {
      id: 25161,
      status: 'needs_human_review',
      requires_human: true,
      pause_reason: 'UNSPECIFIED',
      substatus: 'Portal submission requires approval',
    };

    const pendingProposal = { status: 'PENDING_PORTAL' };

    const reviewState = resolveReviewState({
      caseData,
      activeProposal: pendingProposal,
      activeRun: null,
    });

    const controlState = resolveControlState({
      caseData,
      reviewState,
      pendingProposal,
      activeRun: null,
      activePortalTaskStatus: null,
    });

    const mismatches = detectControlMismatches({
      caseData,
      reviewState,
      pendingProposal,
      activeRun: null,
      activePortalTaskStatus: null,
    });

    assert.strictEqual(reviewState, 'DECISION_REQUIRED');
    assert.strictEqual(controlState, 'NEEDS_DECISION');
    assert.deepStrictEqual(mismatches, []);
  });

  it('treats portal-aborted human handoffs as blocked manual work, not missing decisions', function () {
    const caseData = {
      id: 25210,
      status: 'needs_human_review',
      requires_human: true,
      pause_reason: 'PORTAL_ABORTED',
      substatus: 'Portal account locked — manual login needed',
    };

    const reviewState = resolveReviewState({
      caseData,
      activeProposal: null,
      activeRun: null,
    });

    const controlState = resolveControlState({
      caseData,
      reviewState,
      pendingProposal: null,
      activeRun: null,
      activePortalTaskStatus: null,
    });

    const mismatches = detectControlMismatches({
      caseData,
      reviewState,
      pendingProposal: null,
      activeRun: null,
      activePortalTaskStatus: null,
    });

    assert.strictEqual(reviewState, 'IDLE');
    assert.strictEqual(controlState, 'BLOCKED');
    assert.deepStrictEqual(mismatches, []);
  });

  it('treats ready-to-send manual handoffs as blocked work, not missing decisions', function () {
    const caseData = {
      id: 25155,
      status: 'needs_human_review',
      requires_human: true,
      pause_reason: 'UNSPECIFIED',
      substatus: 'Ready to send via portal or email to Santa Rosa County SO',
    };

    const reviewState = resolveReviewState({
      caseData,
      activeProposal: null,
      activeRun: null,
    });

    const controlState = resolveControlState({
      caseData,
      reviewState,
      pendingProposal: null,
      activeRun: null,
      activePortalTaskStatus: null,
    });

    const mismatches = detectControlMismatches({
      caseData,
      reviewState,
      pendingProposal: null,
      activeRun: null,
      activePortalTaskStatus: null,
    });

    assert.strictEqual(reviewState, 'IDLE');
    assert.strictEqual(controlState, 'BLOCKED');
    assert.deepStrictEqual(mismatches, []);
  });

  it('treats import-review placeholder cases with no proposal as blocked work, not out-of-sync decisions', function () {
    const caseData = {
      id: 26635,
      status: 'needs_human_review',
      requires_human: true,
      pause_reason: 'IMPORT_REVIEW',
      substatus: 'Placeholder Notion page — fix source page before drafting',
    };

    const reviewState = resolveReviewState({
      caseData,
      activeProposal: null,
      activeRun: null,
    });

    const controlState = resolveControlState({
      caseData,
      reviewState,
      pendingProposal: null,
      activeRun: null,
      activePortalTaskStatus: null,
    });

    const mismatches = detectControlMismatches({
      caseData,
      reviewState,
      pendingProposal: null,
      activeRun: null,
      activePortalTaskStatus: null,
    });

    assert.strictEqual(reviewState, 'IDLE');
    assert.strictEqual(controlState, 'BLOCKED');
    assert.deepStrictEqual(mismatches, []);
  });

  it('treats placeholder import-review substatus as blocked work even when pause_reason is missing', function () {
    const caseData = {
      id: 26635,
      status: 'needs_human_review',
      requires_human: true,
      pause_reason: 'UNSPECIFIED',
      substatus: 'Placeholder Notion page — fix source page before drafting',
    };

    const reviewState = resolveReviewState({
      caseData,
      activeProposal: null,
      activeRun: null,
    });

    const controlState = resolveControlState({
      caseData,
      reviewState,
      pendingProposal: null,
      activeRun: null,
      activePortalTaskStatus: null,
    });

    const mismatches = detectControlMismatches({
      caseData,
      reviewState,
      pendingProposal: null,
      activeRun: null,
      activePortalTaskStatus: null,
    });

    assert.strictEqual(reviewState, 'IDLE');
    assert.strictEqual(controlState, 'BLOCKED');
    assert.deepStrictEqual(mismatches, []);
  });

  it('treats stale research phone handoffs as blocked manual work and keeps them in the paused queue', function () {
    const caseData = {
      id: 25148,
      subject_name: 'Perry case',
      requested_records: ['911 calls'],
      agency_name: 'Perry Police Department, Georgia',
      state: 'GA',
      status: 'needs_phone_call',
      requires_human: true,
      pause_reason: 'RESEARCH_HANDOFF',
      substatus: 'agency_research_complete',
      updated_at: '2026-03-06T00:00:00.000Z',
      created_at: '2026-03-05T00:00:00.000Z',
      active_run_status: null,
      active_proposal_status: null,
      active_portal_task_status: null,
      active_portal_task_type: null,
      autopilot_mode: 'SUPERVISED',
      due_info_jsonb: null,
      fee_quote_jsonb: null,
      last_fee_quote_amount: null,
      last_response_date: null,
      next_due_at: null,
    };

    const reviewState = resolveReviewState({
      caseData,
      activeProposal: null,
      activeRun: null,
    });

    const controlState = resolveControlState({
      caseData,
      reviewState,
      pendingProposal: null,
      activeRun: null,
      activePortalTaskStatus: null,
    });

    const mismatches = detectControlMismatches({
      caseData,
      reviewState,
      pendingProposal: null,
      activeRun: null,
      activePortalTaskStatus: null,
    });

    const listItem = toRequestListItem(caseData);

    assert.strictEqual(reviewState, 'IDLE');
    assert.strictEqual(controlState, 'BLOCKED');
    assert.deepStrictEqual(mismatches, []);
    assert.strictEqual(listItem.requires_human, true);
    assert.strictEqual(listItem.pause_reason, 'RESEARCH_HANDOFF');
    assert.strictEqual(listItem.control_state, 'BLOCKED');
  });

  it('treats deadline phone-call handoffs with no proposal as blocked manual work', function () {
    const caseData = {
      id: 25164,
      subject_name: 'Mobile case',
      requested_records: ['Dispatch audio'],
      agency_name: 'Mobile Police Department, Alabama',
      state: 'AL',
      status: 'needs_phone_call',
      requires_human: true,
      pause_reason: 'DEADLINE_PHONE_CALL',
      substatus: 'Deadline passed + contact updated (1d overdue)',
      updated_at: '2026-03-06T00:00:00.000Z',
      created_at: '2026-03-05T00:00:00.000Z',
      active_run_status: null,
      active_proposal_status: null,
      active_portal_task_status: null,
      active_portal_task_type: null,
      autopilot_mode: 'SUPERVISED',
      due_info_jsonb: null,
      fee_quote_jsonb: null,
      last_fee_quote_amount: null,
      last_response_date: null,
      next_due_at: null,
    };

    const reviewState = resolveReviewState({
      caseData,
      activeProposal: null,
      activeRun: null,
    });

    const controlState = resolveControlState({
      caseData,
      reviewState,
      pendingProposal: null,
      activeRun: null,
      activePortalTaskStatus: null,
    });

    const mismatches = detectControlMismatches({
      caseData,
      reviewState,
      pendingProposal: null,
      activeRun: null,
      activePortalTaskStatus: null,
    });

    const listItem = toRequestListItem(caseData);

    assert.strictEqual(reviewState, 'IDLE');
    assert.strictEqual(controlState, 'BLOCKED');
    assert.deepStrictEqual(mismatches, []);
    assert.strictEqual(listItem.requires_human, true);
    assert.strictEqual(listItem.pause_reason, 'DEADLINE_PHONE_CALL');
    assert.strictEqual(listItem.control_state, 'BLOCKED');
  });

  it('treats needs_contact_info without a pending proposal as blocked manual work', function () {
    const caseData = {
      id: 26672,
      status: 'needs_contact_info',
      requires_human: true,
      pause_reason: 'UNSPECIFIED',
      substatus: 'Need a real department mailbox or portal before sending',
    };

    const reviewState = resolveReviewState({
      caseData,
      activeProposal: null,
      activeRun: null,
    });

    const controlState = resolveControlState({
      caseData,
      reviewState,
      pendingProposal: null,
      activeRun: null,
      activePortalTaskStatus: null,
    });

    const mismatches = detectControlMismatches({
      caseData,
      reviewState,
      pendingProposal: null,
      activeRun: null,
      activePortalTaskStatus: null,
    });

    assert.strictEqual(reviewState, 'IDLE');
    assert.strictEqual(controlState, 'BLOCKED');
    assert.deepStrictEqual(mismatches, []);
  });
});
