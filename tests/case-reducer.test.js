#!/usr/bin/env node
/**
 * Case Reducer — Pure Unit Tests
 *
 * Tests computeMutations() for every CaseEvent used across PRs 1–10.
 * No DB, no I/O — pure function in, assertion out.
 */

'use strict';

const {
  CaseEvent,
  computeMutations,
  computeProjection,
  hasActiveProposals,
  isReviewStatus,
  followupAlignmentForStatus,
  proposalDismissForStatus,
  ACTIVE_PROPOSAL_STATUSES,
} = require('../lib/case-reducer');

// ── Test harness ────────────────────────────────────────────────────────────

let passCount = 0;
let failCount = 0;
const failures = [];

function assert(condition, label) {
  if (condition) {
    console.log(`  ✅ ${label}`);
    passCount++;
  } else {
    console.log(`  ❌ ${label}`);
    failCount++;
    failures.push(label);
  }
}

function assertEq(actual, expected, label) {
  const ok = actual === expected;
  if (!ok) {
    console.log(`  ❌ ${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    failCount++;
    failures.push(label);
  } else {
    console.log(`  ✅ ${label}`);
    passCount++;
  }
}

function assertDeep(actual, expected, label) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) {
    console.log(`  ❌ ${label}`);
    console.log(`     expected: ${JSON.stringify(expected)}`);
    console.log(`     got:      ${JSON.stringify(actual)}`);
    failCount++;
    failures.push(label);
  } else {
    console.log(`  ✅ ${label}`);
    passCount++;
  }
}

// ── Snapshot factory ────────────────────────────────────────────────────────

function makeSnapshot(overrides = {}) {
  return {
    caseData: {
      id: 100,
      status: 'ready_to_send',
      substatus: null,
      requires_human: false,
      pause_reason: null,
      ...(overrides.caseData || {}),
    },
    activeRun: overrides.activeRun || null,
    proposals: overrides.proposals || [],
    portalTasks: overrides.portalTasks || [],
    followup: overrides.followup || null,
  };
}

// ── Tests ───────────────────────────────────────────────────────────────────

function testCaseSent() {
  console.log('\n=== CASE_SENT ===');

  const snap = makeSnapshot();
  const m = computeMutations(snap, CaseEvent.CASE_SENT, {
    sendDate: '2025-01-15T12:00:00Z',
  });

  assertEq(m.cases.status, 'sent', 'status → sent');
  assertEq(m.cases.send_date, '2025-01-15T12:00:00Z', 'send_date set');
  assertEq(m.cases.requires_human, false, 'requires_human cleared');
  assertEq(m.cases.pause_reason, null, 'pause_reason cleared');
  assert(m.proposals_dismiss_all, 'active proposals dismissed');

  // Without explicit sendDate
  const m2 = computeMutations(snap, CaseEvent.CASE_SENT, {});
  assert(typeof m2.cases.send_date === 'string', 'send_date defaults to ISO string');

  // With substatus
  const m3 = computeMutations(snap, CaseEvent.CASE_SENT, {
    sendDate: '2025-01-15T12:00:00Z',
    substatus: 'Test sent',
  });
  assertEq(m3.cases.substatus, 'Test sent', 'substatus passed through');
}

function testPortalStarted() {
  console.log('\n=== PORTAL_STARTED ===');

  const snap = makeSnapshot();
  const m = computeMutations(snap, CaseEvent.PORTAL_STARTED, {
    substatus: 'Portal URL set - queued for submission',
  });

  assertEq(m.cases.status, 'portal_in_progress', 'status → portal_in_progress');
  assertEq(m.cases.requires_human, false, 'requires_human cleared');
  assertEq(m.cases.pause_reason, null, 'pause_reason cleared');
  assertEq(m.cases.substatus, 'Portal URL set - queued for submission', 'substatus set');

  // With portal metadata
  const m2 = computeMutations(snap, CaseEvent.PORTAL_STARTED, {
    portalTaskId: 42,
    portalMetadata: { last_portal_status: 'navigating' },
  });
  assert(m2.portal_tasks, 'portal_tasks mutation present');
  assertEq(m2.portal_tasks.id, 42, 'portal task ID set');
  assertEq(m2.cases.last_portal_status, 'navigating', 'portal metadata applied');

  // Followup alignment: portal_in_progress is NOT in eligible list → paused
  assert(m.followups, 'followups mutation present');
  assertEq(m.followups.status, 'paused', 'followups paused for portal_in_progress');
}

function testCaseReconciled() {
  console.log('\n=== CASE_RECONCILED ===');

  // With explicit targetStatus
  const snap = makeSnapshot({ caseData: { status: 'needs_human_review', requires_human: true } });
  const m = computeMutations(snap, CaseEvent.CASE_RECONCILED, {
    targetStatus: 'awaiting_response',
    substatus: 'Approved - queued for portal submission',
  });

  assertEq(m.cases.status, 'awaiting_response', 'status → targetStatus');
  assertEq(m.cases.requires_human, false, 'requires_human cleared');
  assertEq(m.cases.pause_reason, null, 'pause_reason cleared');
  assertEq(m.cases.substatus, 'Approved - queued for portal submission', 'substatus set');
  assert(m.proposals_dismiss_all, 'proposals dismissed for awaiting_response');

  // Without targetStatus → falls back to snapshot status
  const snap2 = makeSnapshot({ caseData: { status: 'responded' } });
  const m2 = computeMutations(snap2, CaseEvent.CASE_RECONCILED, {});
  assertEq(m2.cases.status, 'responded', 'falls back to snapshot status');

  // Non-standard status (fee_negotiation)
  const m3 = computeMutations(snap, CaseEvent.CASE_RECONCILED, {
    targetStatus: 'fee_negotiation',
    substatus: 'Fee response sent (negotiate)',
  });
  assertEq(m3.cases.status, 'fee_negotiation', 'non-standard status accepted');
  assert(!m3.proposals_dismiss_all, 'no proposal dismiss for non-standard status');

  // needs_contact_info
  const m4 = computeMutations(snap, CaseEvent.CASE_RECONCILED, {
    targetStatus: 'needs_contact_info',
    substatus: 'Missing contact information',
  });
  assertEq(m4.cases.status, 'needs_contact_info', 'needs_contact_info accepted');

  // daysOverdue context
  const m5 = computeMutations(snap, CaseEvent.CASE_RECONCILED, {
    targetStatus: 'awaiting_response',
    daysOverdue: 45,
  });
  assertEq(m5.cases.days_overdue, 45, 'daysOverdue mapped to days_overdue');
}

function testCaseEscalated() {
  console.log('\n=== CASE_ESCALATED ===');

  const snap = makeSnapshot();

  // Default targetStatus
  const m = computeMutations(snap, CaseEvent.CASE_ESCALATED, {
    pauseReason: 'DENIAL',
  });
  assertEq(m.cases.status, 'needs_human_review', 'defaults to needs_human_review');
  assertEq(m.cases.requires_human, true, 'requires_human set');
  assertEq(m.cases.pause_reason, 'DENIAL', 'pause_reason set');

  // Explicit targetStatus
  const m2 = computeMutations(snap, CaseEvent.CASE_ESCALATED, {
    targetStatus: 'needs_phone_call',
    pauseReason: 'PHONE_CALL',
  });
  assertEq(m2.cases.status, 'needs_phone_call', 'explicit targetStatus');

  // With substatus
  const m3 = computeMutations(snap, CaseEvent.CASE_ESCALATED, {
    substatus: 'Agency mismatch detected',
    pauseReason: 'UNSPECIFIED',
  });
  assertEq(m3.cases.substatus, 'Agency mismatch detected', 'substatus set');

  // Default pauseReason
  const m4 = computeMutations(snap, CaseEvent.CASE_ESCALATED, {});
  assertEq(m4.cases.pause_reason, 'UNSPECIFIED', 'pause_reason defaults to UNSPECIFIED');

  // Invalid targetStatus throws
  let threw = false;
  try {
    computeMutations(snap, CaseEvent.CASE_ESCALATED, { targetStatus: 'sent' });
  } catch (e) {
    threw = true;
  }
  assert(threw, 'throws on invalid targetStatus');

  // Followup alignment: needs_human_review is NOT terminal or eligible → paused
  assert(m.followups, 'followups mutation present');
  assertEq(m.followups.status, 'paused', 'followups paused for needs_human_review');
}

function testCaseResponded() {
  console.log('\n=== CASE_RESPONDED ===');

  const snap = makeSnapshot({ caseData: { status: 'awaiting_response' } });
  const m = computeMutations(snap, CaseEvent.CASE_RESPONDED, {
    lastResponseDate: '2025-02-01T10:00:00Z',
    substatus: 'Agency replied with records',
  });

  assertEq(m.cases.status, 'responded', 'status → responded');
  assertEq(m.cases.requires_human, false, 'requires_human cleared');
  assertEq(m.cases.last_response_date, '2025-02-01T10:00:00Z', 'last_response_date set');
  assertEq(m.cases.substatus, 'Agency replied with records', 'substatus set');
  assert(m.proposals_dismiss_all, 'proposals dismissed for responded');
}

function testCaseCompleted() {
  console.log('\n=== CASE_COMPLETED ===');

  const snap = makeSnapshot({ caseData: { status: 'responded' } });
  const m = computeMutations(snap, CaseEvent.CASE_COMPLETED, {
    substatus: 'records_received',
    outcomeType: 'FULL_COMPLIANCE',
    outcomeSummary: 'All records received',
  });

  assertEq(m.cases.status, 'completed', 'status → completed');
  assertEq(m.cases.substatus, 'records_received', 'substatus set');
  assertEq(m.cases.outcome_type, 'FULL_COMPLIANCE', 'outcome_type set');
  assertEq(m.cases.outcome_summary, 'All records received', 'outcome_summary set');
  assert(m.proposals_dismiss_all, 'proposals dismissed');
  assertEq(m.followups.status, 'cancelled', 'followups cancelled');
}

function testCaseCancelled() {
  console.log('\n=== CASE_CANCELLED ===');

  const snap = makeSnapshot();
  const m = computeMutations(snap, CaseEvent.CASE_CANCELLED, {
    substatus: 'duplicate_case',
  });

  assertEq(m.cases.status, 'cancelled', 'status → cancelled');
  assertEq(m.cases.substatus, 'duplicate_case', 'substatus set');
  assert(m.proposals_dismiss_all, 'proposals dismissed');
  assertEq(m.followups.status, 'cancelled', 'followups cancelled');
}

function testEmailSent() {
  console.log('\n=== EMAIL_SENT ===');

  const snap = makeSnapshot();
  const m = computeMutations(snap, CaseEvent.EMAIL_SENT, {
    proposalId: 5,
  });

  assertEq(m.cases.status, 'awaiting_response', 'status → awaiting_response');
  assertEq(m.cases.requires_human, false, 'requires_human cleared');
  assertEq(m.proposals.id, 5, 'proposal ID set');
  assertEq(m.proposals.status, 'EXECUTED', 'proposal → EXECUTED');
  assert(m.proposals_dismiss_all, 'other proposals dismissed');
}

function testEmailFailed() {
  console.log('\n=== EMAIL_FAILED ===');

  const snap = makeSnapshot();
  const m = computeMutations(snap, CaseEvent.EMAIL_FAILED, {
    proposalId: 5,
    error: 'SMTP timeout',
  });

  assertEq(m.cases.status, 'needs_human_review', 'status → needs_human_review');
  assertEq(m.cases.requires_human, true, 'requires_human set');
  assertEq(m.cases.pause_reason, 'EMAIL_FAILED', 'pause_reason set');
  assertEq(m.proposals.status, 'BLOCKED', 'proposal → BLOCKED');
}

function testPortalCompleted() {
  console.log('\n=== PORTAL_COMPLETED ===');

  const snap = makeSnapshot({ caseData: { status: 'portal_in_progress' } });
  const m = computeMutations(snap, CaseEvent.PORTAL_COMPLETED, {
    sendDate: '2025-03-01T09:00:00Z',
    portalTaskId: 10,
    confirmationNumber: 'REQ-12345',
  });

  assertEq(m.cases.status, 'sent', 'status → sent');
  assertEq(m.cases.send_date, '2025-03-01T09:00:00Z', 'send_date set');
  assertEq(m.cases.portal_request_number, 'REQ-12345', 'confirmation number set');
  assertEq(m.portal_tasks.status, 'COMPLETED', 'portal task → COMPLETED');
  assert(m.proposals_dismiss_all, 'proposals dismissed');
}

function testPortalFailed() {
  console.log('\n=== PORTAL_FAILED ===');

  const snap = makeSnapshot({ caseData: { status: 'portal_in_progress' } });
  const m = computeMutations(snap, CaseEvent.PORTAL_FAILED, {
    portalTaskId: 10,
    error: 'CAPTCHA unsolved',
    substatus: 'Portal submission failed',
  });

  assertEq(m.cases.status, 'needs_human_review', 'status → needs_human_review');
  assertEq(m.cases.requires_human, true, 'requires_human set');
  assertEq(m.cases.pause_reason, 'PORTAL_FAILED', 'pause_reason set');
  assertEq(m.portal_tasks.status, 'FAILED', 'portal task → FAILED');
}

function testPortalTimedOut() {
  console.log('\n=== PORTAL_TIMED_OUT ===');

  const snap = makeSnapshot({ caseData: { status: 'portal_in_progress' } });
  const m = computeMutations(snap, CaseEvent.PORTAL_TIMED_OUT, {
    portalTaskId: 10,
    error: 'Exceeded 10min timeout',
  });

  assertEq(m.cases.status, 'needs_human_review', 'status → needs_human_review');
  assertEq(m.cases.pause_reason, 'PORTAL_TIMED_OUT', 'pause_reason set');
  assertEq(m.portal_tasks.status, 'CANCELLED', 'portal task → CANCELLED');
}

function testPortalAborted() {
  console.log('\n=== PORTAL_ABORTED ===');

  const snap = makeSnapshot();
  const m = computeMutations(snap, CaseEvent.PORTAL_ABORTED, {
    portalTaskId: 10,
    pauseReason: 'WRONG_AGENCY',
  });

  assertEq(m.cases.status, 'needs_human_review', 'status → needs_human_review');
  assertEq(m.cases.pause_reason, 'WRONG_AGENCY', 'pause_reason from context');
}

function testPortalTaskCreated() {
  console.log('\n=== PORTAL_TASK_CREATED ===');

  const snap = makeSnapshot();
  const m = computeMutations(snap, CaseEvent.PORTAL_TASK_CREATED, {
    proposalId: 5,
    portalTaskId: 10,
  });

  assertEq(m.proposals.status, 'PENDING_PORTAL', 'proposal → PENDING_PORTAL');
  assertEq(m.portal_tasks.id, 10, 'portal task ID set');
  assertEq(m.portal_tasks.status, 'PENDING', 'portal task → PENDING');
}

function testFeeQuoteReceived() {
  console.log('\n=== FEE_QUOTE_RECEIVED ===');

  const snap = makeSnapshot({ caseData: { status: 'responded' } });
  const m = computeMutations(snap, CaseEvent.FEE_QUOTE_RECEIVED, {
    feeQuoteAmount: 150.00,
    feeQuoteCurrency: 'USD',
    substatus: 'Fee quote: $150',
  });

  assertEq(m.cases.status, 'needs_human_fee_approval', 'status → needs_human_fee_approval');
  assertEq(m.cases.requires_human, true, 'requires_human set');
  assertEq(m.cases.pause_reason, 'FEE_QUOTE', 'pause_reason = FEE_QUOTE');
  assertEq(m.cases.last_fee_quote_amount, 150.00, 'fee amount set');
}

function testRunLifecycle() {
  console.log('\n=== RUN LIFECYCLE ===');

  const snap = makeSnapshot();

  // RUN_CLAIMED
  const m1 = computeMutations(snap, CaseEvent.RUN_CLAIMED, { runId: 'run-1' });
  assertEq(m1.agent_runs.id, 'run-1', 'RUN_CLAIMED: run ID');
  assertEq(m1.agent_runs.status, 'running', 'RUN_CLAIMED: status → running');
  assert(m1.agent_runs_cancel_others, 'RUN_CLAIMED: cancels other runs');

  // RUN_WAITING
  const m2 = computeMutations(snap, CaseEvent.RUN_WAITING, { runId: 'run-1' });
  assertEq(m2.agent_runs.status, 'waiting', 'RUN_WAITING: status → waiting');

  // RUN_COMPLETED
  const m3 = computeMutations(snap, CaseEvent.RUN_COMPLETED, { runId: 'run-1' });
  assertEq(m3.agent_runs.status, 'completed', 'RUN_COMPLETED: status → completed');

  // RUN_FAILED
  const m4 = computeMutations(snap, CaseEvent.RUN_FAILED, {
    runId: 'run-1',
    error: 'timeout',
    pauseReason: 'AGENT_RUN_FAILED',
  });
  assertEq(m4.cases.status, 'needs_human_review', 'RUN_FAILED: status → needs_human_review');
  assertEq(m4.cases.requires_human, true, 'RUN_FAILED: requires_human set');
  assertEq(m4.agent_runs.status, 'failed', 'RUN_FAILED: run → failed');

  // RUN_STALE_CLEANED
  const m5 = computeMutations(snap, CaseEvent.RUN_STALE_CLEANED, { runId: 'run-1' });
  assertEq(m5.agent_runs.status, 'failed', 'RUN_STALE_CLEANED: run → failed');
}

function testProposalLifecycle() {
  console.log('\n=== PROPOSAL LIFECYCLE ===');

  const snap = makeSnapshot({
    proposals: [{ id: 1, status: 'PENDING_APPROVAL' }],
  });

  // PROPOSAL_GATED
  const m1 = computeMutations(snap, CaseEvent.PROPOSAL_GATED, {
    proposalId: 1,
    pauseReason: 'DENIAL',
    runId: 'run-1',
  });
  assertEq(m1.cases.status, 'needs_human_review', 'PROPOSAL_GATED: status');
  assertEq(m1.cases.requires_human, true, 'PROPOSAL_GATED: requires_human');
  assertEq(m1.proposals.status, 'PENDING_APPROVAL', 'PROPOSAL_GATED: proposal status');

  // PROPOSAL_APPROVED (decision_received path)
  const m2 = computeMutations(snap, CaseEvent.PROPOSAL_APPROVED, {
    proposalId: 1,
    humanDecision: { decidedBy: 'admin' },
  });
  assertEq(m2.cases.requires_human, false, 'PROPOSAL_APPROVED: requires_human cleared');
  assertEq(m2.proposals.status, 'DECISION_RECEIVED', 'PROPOSAL_APPROVED: proposal → DECISION_RECEIVED');

  // PROPOSAL_APPROVED (auto-execute path)
  const m2b = computeMutations(snap, CaseEvent.PROPOSAL_APPROVED, {
    proposalId: 1,
    humanDecision: { autoExecute: true, decidedBy: 'admin' },
  });
  assertEq(m2b.proposals.status, 'APPROVED', 'PROPOSAL_APPROVED: auto-execute → APPROVED');

  // PROPOSAL_DISMISSED (last active proposal)
  const m3 = computeMutations(snap, CaseEvent.PROPOSAL_DISMISSED, {
    proposalId: 1,
    reason: 'stale',
  });
  assertEq(m3.proposals.status, 'DISMISSED', 'PROPOSAL_DISMISSED: proposal → DISMISSED');
  assertEq(m3.cases.requires_human, false, 'PROPOSAL_DISMISSED: requires_human cleared (no other active)');

  // PROPOSAL_DISMISSED (with another active proposal)
  const snap2 = makeSnapshot({
    proposals: [
      { id: 1, status: 'PENDING_APPROVAL' },
      { id: 2, status: 'BLOCKED' },
    ],
  });
  const m3b = computeMutations(snap2, CaseEvent.PROPOSAL_DISMISSED, {
    proposalId: 1,
  });
  assert(!m3b.cases, 'PROPOSAL_DISMISSED: no case mutation when other proposals active');

  // PROPOSAL_EXECUTED
  const m4 = computeMutations(snap, CaseEvent.PROPOSAL_EXECUTED, { proposalId: 1 });
  assertEq(m4.proposals.status, 'EXECUTED', 'PROPOSAL_EXECUTED: proposal → EXECUTED');

  // PROPOSAL_BLOCKED
  const m5 = computeMutations(snap, CaseEvent.PROPOSAL_BLOCKED, {
    proposalId: 1,
    error: 'Missing email',
  });
  assertEq(m5.cases.status, 'needs_human_review', 'PROPOSAL_BLOCKED: status');
  assertEq(m5.cases.pause_reason, 'EXECUTION_BLOCKED', 'PROPOSAL_BLOCKED: pause_reason');
  assertEq(m5.proposals.status, 'BLOCKED', 'PROPOSAL_BLOCKED: proposal → BLOCKED');

  // PROPOSAL_CANCELLED
  const m6 = computeMutations(snap, CaseEvent.PROPOSAL_CANCELLED, { proposalId: 1 });
  assertEq(m6.proposals.status, 'DISMISSED', 'PROPOSAL_CANCELLED: proposal → DISMISSED');
}

function testStaleAndCron() {
  console.log('\n=== CRON / STALE CLEANUP ===');

  const snap = makeSnapshot({ caseData: { requires_human: true, pause_reason: 'STALE' } });

  const m1 = computeMutations(snap, CaseEvent.STALE_FLAGS_CLEARED, {});
  assertEq(m1.cases.requires_human, false, 'STALE_FLAGS_CLEARED: requires_human cleared');
  assertEq(m1.cases.pause_reason, null, 'STALE_FLAGS_CLEARED: pause_reason cleared');

  const m2 = computeMutations(snap, CaseEvent.STUCK_PORTAL_TASK_FAILED, {
    portalTaskId: 10,
    error: 'timeout',
  });
  assertEq(m2.cases.status, 'needs_human_review', 'STUCK_PORTAL_TASK_FAILED: status');
  assertEq(m2.cases.pause_reason, 'STUCK_PORTAL_TASK', 'STUCK_PORTAL_TASK_FAILED: pause_reason');
  assertEq(m2.portal_tasks.status, 'FAILED', 'STUCK_PORTAL_TASK_FAILED: portal task → FAILED');

  const m3 = computeMutations(snap, CaseEvent.PORTAL_STUCK, {
    substatus: 'Portal stuck for 24h',
  });
  assertEq(m3.cases.status, 'needs_human_review', 'PORTAL_STUCK: status');
  assertEq(m3.cases.pause_reason, 'PORTAL_STUCK', 'PORTAL_STUCK: pause_reason');
}

function testSafetyNets() {
  console.log('\n=== SAFETY NETS ===');

  const snap = makeSnapshot();

  // Safety net 1: needs_human_review without pause_reason gets UNSPECIFIED
  const m1 = computeMutations(snap, CaseEvent.RUN_FAILED, { runId: 'r1' });
  assert(m1.cases.pause_reason !== null, 'needs_human_review always has pause_reason');

  // Safety net 2: review status without requires_human gets auto-set
  // (This fires when requires_human is undefined, not when explicitly false)
  const m2 = computeMutations(snap, CaseEvent.CASE_ID_STATE, {});
  assertEq(m2.cases.status, 'id_state', 'CASE_ID_STATE: status → id_state');
  assertEq(m2.cases.requires_human, true, 'CASE_ID_STATE: requires_human auto-set');
}

function testAcknowledgmentReceived() {
  console.log('\n=== ACKNOWLEDGMENT_RECEIVED ===');

  const snap = makeSnapshot({ caseData: { status: 'sent' } });
  const m = computeMutations(snap, CaseEvent.ACKNOWLEDGMENT_RECEIVED, {});

  assertEq(m.cases.status, 'awaiting_response', 'status → awaiting_response');
  assertEq(m.cases.requires_human, false, 'requires_human cleared');
  assert(m.proposals_dismiss_all, 'proposals dismissed');
}

function testCaseWrongAgency() {
  console.log('\n=== CASE_WRONG_AGENCY ===');

  const snap = makeSnapshot();
  const m = computeMutations(snap, CaseEvent.CASE_WRONG_AGENCY, {});

  assert(m.proposals_dismiss_portal, 'portal proposals dismissed');
  assert(m.portal_tasks_cancel_active, 'portal tasks cancelled');
  assert(!m.cases, 'no case status change');
}

function testUnknownEventThrows() {
  console.log('\n=== UNKNOWN EVENT ===');

  let threw = false;
  try {
    computeMutations(makeSnapshot(), 'BOGUS_EVENT', {});
  } catch (e) {
    threw = e.message.includes('Unknown CaseEvent');
  }
  assert(threw, 'unknown event throws Error');
}

function testHelpers() {
  console.log('\n=== HELPER FUNCTIONS ===');

  // isReviewStatus
  assert(isReviewStatus('needs_human_review'), 'needs_human_review is review status');
  assert(isReviewStatus('needs_human_fee_approval'), 'needs_human_fee_approval is review status');
  assert(isReviewStatus('needs_phone_call'), 'needs_phone_call is review status');
  assert(!isReviewStatus('sent'), 'sent is NOT review status');
  assert(!isReviewStatus('portal_in_progress'), 'portal_in_progress is NOT review status');

  // hasActiveProposals
  assert(!hasActiveProposals({ proposals: [] }), 'empty proposals → false');
  assert(hasActiveProposals({ proposals: [{ status: 'PENDING_APPROVAL' }] }), 'PENDING_APPROVAL is active');
  assert(hasActiveProposals({ proposals: [{ status: 'BLOCKED' }] }), 'BLOCKED is active');
  assert(!hasActiveProposals({ proposals: [{ status: 'EXECUTED' }] }), 'EXECUTED is NOT active');

  // followupAlignmentForStatus
  assertEq(followupAlignmentForStatus('completed').followups.status, 'cancelled', 'completed → followups cancelled');
  assertEq(followupAlignmentForStatus('cancelled').followups.status, 'cancelled', 'cancelled → followups cancelled');
  assertEq(followupAlignmentForStatus('needs_phone_call').followups.status, 'cancelled', 'needs_phone_call → followups cancelled');
  assertEq(followupAlignmentForStatus('needs_human_review').followups.status, 'paused', 'needs_human_review → followups paused');
  assertDeep(followupAlignmentForStatus('sent'), {}, 'sent → no followup change');
  assertDeep(followupAlignmentForStatus('awaiting_response'), {}, 'awaiting_response → no followup change');

  // proposalDismissForStatus
  assert(proposalDismissForStatus('sent').proposals_dismiss_all, 'sent dismisses proposals');
  assert(proposalDismissForStatus('awaiting_response').proposals_dismiss_all, 'awaiting_response dismisses proposals');
  assert(proposalDismissForStatus('completed').proposals_dismiss_all, 'completed dismisses proposals');
  assertDeep(proposalDismissForStatus('needs_human_review'), {}, 'needs_human_review does NOT dismiss');
  assertDeep(proposalDismissForStatus('portal_in_progress'), {}, 'portal_in_progress does NOT dismiss');
}

function testComputeProjection() {
  console.log('\n=== computeProjection ===');

  const snap = makeSnapshot({
    caseData: {
      id: 42,
      status: 'needs_human_review',
      substatus: 'Pending review',
      requires_human: true,
      pause_reason: 'DENIAL',
      updated_at: '2025-01-01T00:00:00Z',
    },
    proposals: [{ id: 1, status: 'PENDING_APPROVAL', action_type: 'SEND_REBUTTAL', requires_human: true }],
  });

  const proj = computeProjection(snap);
  assertEq(proj.case_id, 42, 'case_id projected');
  assertEq(proj.status, 'needs_human_review', 'status projected');
  assertEq(proj.requires_human, true, 'requires_human projected');
  assertEq(proj.pause_reason, 'DENIAL', 'pause_reason projected');
  assert(proj.active_proposal, 'active_proposal present');
  assertEq(proj.active_proposal.id, 1, 'active_proposal.id correct');
  assertEq(proj.active_proposal.action_type, 'SEND_REBUTTAL', 'active_proposal.action_type correct');
  assert(proj.review_state, 'review_state computed');
}

// ── Main ────────────────────────────────────────────────────────────────────

function main() {
  console.log('╔══════════════════════════════════════════════════════════╗');
  console.log('║   Case Reducer — Pure Unit Tests (PRs 1–10)            ║');
  console.log('╚══════════════════════════════════════════════════════════╝');

  // Case-level events (PR 1-10 migration targets)
  testCaseSent();
  testPortalStarted();
  testCaseReconciled();
  testCaseEscalated();
  testCaseResponded();
  testCaseCompleted();
  testCaseCancelled();

  // Execution outcomes
  testEmailSent();
  testEmailFailed();
  testPortalCompleted();
  testPortalFailed();
  testPortalTimedOut();
  testPortalAborted();
  testPortalTaskCreated();
  testFeeQuoteReceived();

  // Run lifecycle
  testRunLifecycle();

  // Proposal lifecycle
  testProposalLifecycle();

  // Cron / cleanup
  testStaleAndCron();

  // Classification-driven
  testAcknowledgmentReceived();
  testCaseWrongAgency();

  // Safety nets
  testSafetyNets();

  // Unknown event
  testUnknownEventThrows();

  // Helpers
  testHelpers();

  // Projection
  testComputeProjection();

  // ── Report ──────────────────────────────────────────────────────────────

  console.log('\n' + '='.repeat(60));
  console.log(`  RESULTS: ${passCount} passed, ${failCount} failed`);
  console.log('='.repeat(60));

  if (failures.length > 0) {
    console.log('\nFailed tests:');
    failures.forEach(f => console.log(`  ❌ ${f}`));
  }

  process.exit(failCount > 0 ? 1 : 0);
}

main();
