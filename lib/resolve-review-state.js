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
const PROPOSAL_PENDING_STATUSES = new Set(['PENDING_APPROVAL', 'BLOCKED']);
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

    // Rule 1: Proposal is pending human decision
    if (proposalStatus && PROPOSAL_PENDING_STATUSES.has(proposalStatus)) {
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
    if (requiresHuman || caseStatus.startsWith('needs_')) {
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

    // Rule 5: Waiting for agency response
    if (WAITING_AGENCY_CASE_STATUSES.has(caseStatus)) {
        return REVIEW_STATES.WAITING_AGENCY;
    }

    // Rule 6: Default
    return REVIEW_STATES.IDLE;
}

module.exports = { resolveReviewState, REVIEW_STATES };
