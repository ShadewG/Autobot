'use strict';

const { resolveReviewState, REVIEW_STATES } = require('../lib/resolve-review-state');

function assert(condition, message) {
    if (!condition) {
        throw new Error(`FAIL: ${message}`);
    }
}

function test(name, fn) {
    try {
        fn();
        console.log(`  PASS: ${name}`);
    } catch (e) {
        console.error(`  FAIL: ${name} — ${e.message}`);
        process.exitCode = 1;
    }
}

console.log('resolveReviewState tests\n');

// Rule 1: Proposal pending → DECISION_REQUIRED
test('PENDING_APPROVAL proposal → DECISION_REQUIRED', () => {
    const result = resolveReviewState({
        caseData: { id: 1, status: 'sent', requires_human: false },
        activeProposal: { status: 'PENDING_APPROVAL' },
        activeRun: null,
    });
    assert(result === REVIEW_STATES.DECISION_REQUIRED, `Expected DECISION_REQUIRED, got ${result}`);
});

test('BLOCKED proposal → DECISION_REQUIRED', () => {
    const result = resolveReviewState({
        caseData: { id: 2, status: 'sent', requires_human: false },
        activeProposal: { status: 'BLOCKED' },
        activeRun: null,
    });
    assert(result === REVIEW_STATES.DECISION_REQUIRED, `Expected DECISION_REQUIRED, got ${result}`);
});

test('PENDING_APPROVAL + active execution run → PROCESSING', () => {
    const result = resolveReviewState({
        caseData: { id: 3, status: 'awaiting_response', requires_human: false },
        activeProposal: { status: 'PENDING_APPROVAL' },
        activeRun: { status: 'running' },
    });
    assert(result === REVIEW_STATES.PROCESSING, `Expected PROCESSING, got ${result}`);
});

// Rule 2: DECISION_RECEIVED + active run → DECISION_APPLYING
test('DECISION_RECEIVED + active run → DECISION_APPLYING', () => {
    const result = resolveReviewState({
        caseData: { id: 4, status: 'needs_human_review', requires_human: true },
        activeProposal: { status: 'DECISION_RECEIVED' },
        activeRun: { status: 'running' },
    });
    assert(result === REVIEW_STATES.DECISION_APPLYING, `Expected DECISION_APPLYING, got ${result}`);
});

test('DECISION_RECEIVED + queued run → DECISION_APPLYING', () => {
    const result = resolveReviewState({
        caseData: { id: 5, status: 'needs_human_review', requires_human: true },
        activeProposal: { status: 'DECISION_RECEIVED' },
        activeRun: { status: 'queued' },
    });
    assert(result === REVIEW_STATES.DECISION_APPLYING, `Expected DECISION_APPLYING, got ${result}`);
});

test('DECISION_RECEIVED + processing run → DECISION_APPLYING', () => {
    const result = resolveReviewState({
        caseData: { id: 6, status: 'needs_human_review', requires_human: true },
        activeProposal: { status: 'DECISION_RECEIVED' },
        activeRun: { status: 'processing' },
    });
    assert(result === REVIEW_STATES.DECISION_APPLYING, `Expected DECISION_APPLYING, got ${result}`);
});

// Rule 2 negative: DECISION_RECEIVED but no active run → falls to rule 4
test('DECISION_RECEIVED + no active run + requires_human → DECISION_REQUIRED (stale recovery)', () => {
    // Should log a warning about stale proposal
    const result = resolveReviewState({
        caseData: { id: 7, status: 'needs_human_review', requires_human: true },
        activeProposal: { status: 'DECISION_RECEIVED' },
        activeRun: null,
    });
    assert(result === REVIEW_STATES.DECISION_REQUIRED, `Expected DECISION_REQUIRED, got ${result}`);
});

// Rule 3: Active run without human flag → PROCESSING
test('Active run without requires_human → PROCESSING', () => {
    const result = resolveReviewState({
        caseData: { id: 8, status: 'sent', requires_human: false },
        activeProposal: null,
        activeRun: { status: 'running' },
    });
    assert(result === REVIEW_STATES.PROCESSING, `Expected PROCESSING, got ${result}`);
});

test('Active waiting run without requires_human → PROCESSING', () => {
    const result = resolveReviewState({
        caseData: { id: 9, status: 'sent', requires_human: false },
        activeProposal: null,
        activeRun: { status: 'waiting' },
    });
    assert(result === REVIEW_STATES.PROCESSING, `Expected PROCESSING, got ${result}`);
});

test('Active execution run with requires_human → PROCESSING', () => {
    const result = resolveReviewState({
        caseData: { id: 10, status: 'needs_human_review', requires_human: true },
        activeProposal: null,
        activeRun: { status: 'running' },
    });
    assert(result === REVIEW_STATES.PROCESSING, `Expected PROCESSING, got ${result}`);
});

// Rule 4: requires_human or needs_ status → DECISION_REQUIRED
test('requires_human=true → DECISION_REQUIRED', () => {
    const result = resolveReviewState({
        caseData: { id: 11, status: 'needs_human_review', requires_human: true },
        activeProposal: null,
        activeRun: null,
    });
    assert(result === REVIEW_STATES.DECISION_REQUIRED, `Expected DECISION_REQUIRED, got ${result}`);
});

test('needs_phone_call status → DECISION_REQUIRED', () => {
    const result = resolveReviewState({
        caseData: { id: 12, status: 'needs_phone_call', requires_human: false },
        activeProposal: null,
        activeRun: null,
    });
    assert(result === REVIEW_STATES.DECISION_REQUIRED, `Expected DECISION_REQUIRED, got ${result}`);
});

test('needs_contact_info status → DECISION_REQUIRED', () => {
    const result = resolveReviewState({
        caseData: { id: 13, status: 'needs_contact_info', requires_human: false },
        activeProposal: null,
        activeRun: null,
    });
    assert(result === REVIEW_STATES.DECISION_REQUIRED, `Expected DECISION_REQUIRED, got ${result}`);
});

// Rule 5: Waiting agency statuses → WAITING_AGENCY
test('sent status → WAITING_AGENCY', () => {
    const result = resolveReviewState({
        caseData: { id: 14, status: 'sent', requires_human: false },
        activeProposal: null,
        activeRun: null,
    });
    assert(result === REVIEW_STATES.WAITING_AGENCY, `Expected WAITING_AGENCY, got ${result}`);
});

test('awaiting_response status → WAITING_AGENCY', () => {
    const result = resolveReviewState({
        caseData: { id: 15, status: 'awaiting_response', requires_human: false },
        activeProposal: null,
        activeRun: null,
    });
    assert(result === REVIEW_STATES.WAITING_AGENCY, `Expected WAITING_AGENCY, got ${result}`);
});

test('portal_in_progress status → WAITING_AGENCY', () => {
    const result = resolveReviewState({
        caseData: { id: 16, status: 'portal_in_progress', requires_human: false },
        activeProposal: null,
        activeRun: null,
    });
    assert(result === REVIEW_STATES.WAITING_AGENCY, `Expected WAITING_AGENCY, got ${result}`);
});

// Rule 6: Everything else → IDLE
test('completed status → IDLE', () => {
    const result = resolveReviewState({
        caseData: { id: 17, status: 'completed', requires_human: false },
        activeProposal: null,
        activeRun: null,
    });
    assert(result === REVIEW_STATES.IDLE, `Expected IDLE, got ${result}`);
});

test('draft status → IDLE', () => {
    const result = resolveReviewState({
        caseData: { id: 18, status: 'draft', requires_human: false },
        activeProposal: null,
        activeRun: null,
    });
    assert(result === REVIEW_STATES.IDLE, `Expected IDLE, got ${result}`);
});

test('null/empty everything → IDLE', () => {
    const result = resolveReviewState({
        caseData: { id: 19, status: '', requires_human: false },
        activeProposal: null,
        activeRun: null,
    });
    assert(result === REVIEW_STATES.IDLE, `Expected IDLE, got ${result}`);
});

// Precedence tests
test('PENDING_APPROVAL + active run resolves to PROCESSING', () => {
    const result = resolveReviewState({
        caseData: { id: 20, status: 'sent', requires_human: false },
        activeProposal: { status: 'PENDING_APPROVAL' },
        activeRun: { status: 'running' },
    });
    assert(result === REVIEW_STATES.PROCESSING, `Expected PROCESSING, got ${result}`);
});

test('DECISION_RECEIVED + active run beats requires_human (rule 2 > rule 4)', () => {
    const result = resolveReviewState({
        caseData: { id: 21, status: 'needs_human_review', requires_human: true },
        activeProposal: { status: 'DECISION_RECEIVED' },
        activeRun: { status: 'created' },
    });
    assert(result === REVIEW_STATES.DECISION_APPLYING, `Expected DECISION_APPLYING, got ${result}`);
});

test('Active run beats waiting_agency (rule 3 > rule 5)', () => {
    const result = resolveReviewState({
        caseData: { id: 22, status: 'sent', requires_human: false },
        activeProposal: null,
        activeRun: { status: 'processing' },
    });
    assert(result === REVIEW_STATES.PROCESSING, `Expected PROCESSING, got ${result}`);
});

// Edge case: completed run status should not match
test('completed run status → not PROCESSING', () => {
    const result = resolveReviewState({
        caseData: { id: 23, status: 'sent', requires_human: false },
        activeProposal: null,
        activeRun: { status: 'completed' },
    });
    assert(result === REVIEW_STATES.WAITING_AGENCY, `Expected WAITING_AGENCY, got ${result}`);
});

// Edge case: APPROVED proposal should not match rule 1
test('APPROVED proposal → not DECISION_REQUIRED', () => {
    const result = resolveReviewState({
        caseData: { id: 24, status: 'sent', requires_human: false },
        activeProposal: { status: 'APPROVED' },
        activeRun: null,
    });
    assert(result === REVIEW_STATES.WAITING_AGENCY, `Expected WAITING_AGENCY, got ${result}`);
});

console.log('\nAll tests completed.');
