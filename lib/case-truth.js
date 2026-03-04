'use strict';

const { resolveReviewState } = require('./resolve-review-state');

const ACTIVE_PROPOSAL_STATUSES = Object.freeze([
    'PENDING_APPROVAL',
    'BLOCKED',
    'DECISION_RECEIVED',
    'PENDING_PORTAL',
]);

const HUMAN_REVIEW_PROPOSAL_STATUSES = Object.freeze([
    'PENDING_APPROVAL',
    'BLOCKED',
    'DECISION_RECEIVED',
]);

const ACTIVE_PROPOSAL_STATUSES_SQL = ACTIVE_PROPOSAL_STATUSES.map((s) => `'${s}'`).join(', ');
const HUMAN_REVIEW_PROPOSAL_STATUSES_SQL = HUMAN_REVIEW_PROPOSAL_STATUSES.map((s) => `'${s}'`).join(', ');

function buildCaseTruth({ caseData, activeProposal = null, activeRun = null }) {
    const review_state = resolveReviewState({
        caseData,
        activeProposal,
        activeRun,
    });

    return {
        review_state,
        active_proposal_status: activeProposal?.status || null,
        active_proposal_id: activeProposal?.id || null,
        active_run_status: activeRun?.status || null,
    };
}

module.exports = {
    ACTIVE_PROPOSAL_STATUSES,
    HUMAN_REVIEW_PROPOSAL_STATUSES,
    ACTIVE_PROPOSAL_STATUSES_SQL,
    HUMAN_REVIEW_PROPOSAL_STATUSES_SQL,
    buildCaseTruth,
};
