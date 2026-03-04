'use strict';

/**
 * Review states — derived from case fields, proposal status, and active run status.
 * Computed on every API response (not stored in DB).
 */
const REVIEW_STATES = {
    DECISION_REQUIRED: 'DECISION_REQUIRED',
    DECISION_APPLYING: 'DECISION_APPLYING',
    PROCESSING: 'PROCESSING',
    WAITING_AGENCY: 'WAITING_AGENCY',
    IDLE: 'IDLE',
};

const ACTIVE_RUN_STATUSES = new Set(['created', 'queued', 'processing', 'running', 'waiting']);
const ACTIVE_EXECUTION_RUN_STATUSES = new Set(['created', 'queued', 'processing', 'running']);
const PROPOSAL_PENDING_STATUSES = new Set(['PENDING_APPROVAL', 'BLOCKED']);
const NON_DECISION_HUMAN_PAUSES = new Set([
    'PORTAL_ABORTED',
    'PORTAL_FAILED',
    'PORTAL_TIMED_OUT',
    'STUCK_PORTAL_TASK',
    'PORTAL_STUCK',
    'RESEARCH_HANDOFF',
    'MANUAL',
]);
const REVIEW_REQUIRED_CASE_STATUSES = new Set([
    'needs_human_review',
    'needs_human_fee_approval',
    'needs_phone_call',
    'needs_contact_info',
    'needs_rebuttal',
    'pending_fee_decision',
    'id_state',
]);
// These statuses are all externally-waiting states from the user's perspective.
// "responded" means the agency replied and we're monitoring/awaiting the next external step,
// so it should not render as a different "monitoring" bucket.
const WAITING_AGENCY_CASE_STATUSES = new Set(['sent', 'awaiting_response', 'portal_in_progress', 'responded']);

/**
 * Resolve a single authoritative review_state from three data sources.
 *
 * @param {object} opts
 * @param {object} opts.caseData        - Row from cases table (requires_human, status, pause_reason)
 * @param {object|null} opts.activeProposal - Latest active proposal (status field)
 * @param {object|null} opts.activeRun      - Latest active agent_run (status field)
 * @returns {string} One of REVIEW_STATES values
 */
function resolveReviewState({ caseData, activeProposal, activeRun }) {
    const proposalStatus = activeProposal?.status || null;
    const runStatus = activeRun?.status?.toLowerCase() || null;
    const caseStatus = caseData?.status?.toLowerCase() || '';
    const requiresHuman = Boolean(caseData?.requires_human);
    const pauseReason = String(caseData?.pause_reason || '').toUpperCase();

    // Portal lifecycle should not be treated as human-decision-required just because
    // stale flags remain on the case row. If a portal flow is active, prefer processing/waiting.
    if (caseStatus === 'portal_in_progress') {
        if (runStatus && ACTIVE_RUN_STATUSES.has(runStatus)) {
            return REVIEW_STATES.PROCESSING;
        }
        return REVIEW_STATES.WAITING_AGENCY;
    }

    // Rule 1: Proposal is pending human decision.
    // If an execution run is already active, prefer PROCESSING over DECISION_REQUIRED
    // to avoid contradictory "decision required + active run" states.
    if (proposalStatus && PROPOSAL_PENDING_STATUSES.has(proposalStatus)) {
        if (runStatus && ACTIVE_EXECUTION_RUN_STATUSES.has(runStatus)) {
            console.warn(
                `[review_state] Pending proposal with active execution run for case ${caseData?.id}: ` +
                `proposal status=${proposalStatus}, run status=${runStatus}. ` +
                `Treating as PROCESSING.`
            );
            return REVIEW_STATES.PROCESSING;
        }
        return REVIEW_STATES.DECISION_REQUIRED;
    }

    // Rule 2: Decision received, action is being applied
    if (proposalStatus === 'DECISION_RECEIVED' && runStatus && ACTIVE_RUN_STATUSES.has(runStatus)) {
        return REVIEW_STATES.DECISION_APPLYING;
    }

    // Rule 3: Active run without human flag = agent is working
    if (runStatus && ACTIVE_RUN_STATUSES.has(runStatus) && !requiresHuman) {
        return REVIEW_STATES.PROCESSING;
    }

    // Rule 4: Case flagged for human review
    // Guard against stale rows where status still reads needs_* but no human gate
    // actually exists (no pending proposal + requires_human=false).
    const hasDecisionGateFromCaseFlags = requiresHuman && !NON_DECISION_HUMAN_PAUSES.has(pauseReason);
    const hasLiveHumanGate = Boolean(
        hasDecisionGateFromCaseFlags ||
        (proposalStatus && PROPOSAL_PENDING_STATUSES.has(proposalStatus)) ||
        proposalStatus === 'DECISION_RECEIVED'
    );
    if (hasLiveHumanGate) {
        if (runStatus && ACTIVE_EXECUTION_RUN_STATUSES.has(runStatus)) {
            return REVIEW_STATES.PROCESSING;
        }
        // Conflict detection: DECISION_RECEIVED proposal exists but no active run
        if (proposalStatus === 'DECISION_RECEIVED' && (!runStatus || !ACTIVE_RUN_STATUSES.has(runStatus))) {
            console.warn(
                `[review_state] Stale DECISION_RECEIVED proposal for case ${caseData?.id}: ` +
                `proposal status=${proposalStatus}, run status=${runStatus || 'none'}. ` +
                `Expected an active run. Falling back to DECISION_REQUIRED.`
            );
        }
        return REVIEW_STATES.DECISION_REQUIRED;
    }

    // Rule 4b: Human-review statuses should remain decision-required even when
    // requires_human/proposal flags are stale or temporarily inconsistent.
    if (REVIEW_REQUIRED_CASE_STATUSES.has(caseStatus)) {
        if (runStatus && ACTIVE_EXECUTION_RUN_STATUSES.has(runStatus)) {
            return REVIEW_STATES.PROCESSING;
        }
        return REVIEW_STATES.DECISION_REQUIRED;
    }

    // Rule 5: Waiting for agency response
    if (WAITING_AGENCY_CASE_STATUSES.has(caseStatus)) {
        return REVIEW_STATES.WAITING_AGENCY;
    }

    // Rule 6: Default
    return REVIEW_STATES.IDLE;
}

module.exports = { resolveReviewState, REVIEW_STATES };
