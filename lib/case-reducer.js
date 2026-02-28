'use strict';

/**
 * Pure reducer for the case runtime state machine.
 *
 * Every function here is pure — no DB access, no I/O.
 * Inputs: snapshot (loaded in-transaction) + event + context (passed by caller).
 * Output: a mutations object describing what to write.
 */

const { resolveReviewState } = require('./resolve-review-state');

// ---------------------------------------------------------------------------
// Event enum
// ---------------------------------------------------------------------------

const CaseEvent = Object.freeze({
  // Run lifecycle
  RUN_CLAIMED:          'RUN_CLAIMED',
  RUN_WAITING:          'RUN_WAITING',
  RUN_COMPLETED:        'RUN_COMPLETED',
  RUN_FAILED:           'RUN_FAILED',
  RUN_STALE_CLEANED:    'RUN_STALE_CLEANED',

  // Proposal lifecycle
  PROPOSAL_GATED:       'PROPOSAL_GATED',
  PROPOSAL_APPROVED:    'PROPOSAL_APPROVED',
  PROPOSAL_DISMISSED:   'PROPOSAL_DISMISSED',
  PROPOSAL_WITHDRAWN:   'PROPOSAL_WITHDRAWN',
  PROPOSAL_ADJUSTED:    'PROPOSAL_ADJUSTED',
  PROPOSAL_EXPIRED:     'PROPOSAL_EXPIRED',
  PROPOSAL_EXECUTED:    'PROPOSAL_EXECUTED',
  PROPOSAL_BLOCKED:     'PROPOSAL_BLOCKED',
  PROPOSAL_CANCELLED:   'PROPOSAL_CANCELLED',

  // Execution outcomes
  EMAIL_SENT:           'EMAIL_SENT',
  EMAIL_FAILED:         'EMAIL_FAILED',
  PORTAL_TASK_CREATED:  'PORTAL_TASK_CREATED',
  PORTAL_STARTED:       'PORTAL_STARTED',
  PORTAL_COMPLETED:     'PORTAL_COMPLETED',
  PORTAL_FAILED:        'PORTAL_FAILED',
  PORTAL_TIMED_OUT:     'PORTAL_TIMED_OUT',

  // Case-level
  CASE_SENT:            'CASE_SENT',
  CASE_COMPLETED:       'CASE_COMPLETED',
  CASE_CANCELLED:       'CASE_CANCELLED',
  CASE_ESCALATED:       'CASE_ESCALATED',
  CASE_RECONCILED:      'CASE_RECONCILED',
  CASE_WRONG_AGENCY:    'CASE_WRONG_AGENCY',

  // Cron cleanup
  STALE_FLAGS_CLEARED:  'STALE_FLAGS_CLEARED',
  STUCK_PORTAL_TASK_FAILED: 'STUCK_PORTAL_TASK_FAILED',
  PORTAL_STUCK:         'PORTAL_STUCK',
});

// ---------------------------------------------------------------------------
// Status constants (mirror database.js)
// ---------------------------------------------------------------------------

const ACTIVE_PROPOSAL_STATUSES = ['PENDING_APPROVAL', 'BLOCKED', 'DECISION_RECEIVED', 'PENDING_PORTAL'];
const CASE_STATUSES_CLEAR_ACTIVE_PROPOSALS = ['sent', 'awaiting_response', 'responded', 'completed', 'cancelled'];
const FOLLOWUP_TERMINAL_CASE_STATUSES = ['completed', 'cancelled', 'needs_phone_call'];
const FOLLOWUP_ELIGIBLE_CASE_STATUSES = ['sent', 'awaiting_response'];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function hasActiveProposals(snapshot) {
  return (snapshot.proposals || []).some(p => ACTIVE_PROPOSAL_STATUSES.includes(p.status));
}

function isReviewStatus(status) {
  return ['needs_human_review', 'needs_human_fee_approval', 'needs_phone_call'].includes(status);
}

/** Build standard portal metadata fields from context.portalMetadata */
function portalMetaFields(ctx) {
  const pm = ctx.portalMetadata || {};
  const fields = {};
  if (pm.last_portal_status !== undefined)         fields.last_portal_status = pm.last_portal_status;
  if (pm.last_portal_status_at !== undefined)       fields.last_portal_status_at = pm.last_portal_status_at;
  if (pm.last_portal_run_id !== undefined)          fields.last_portal_run_id = pm.last_portal_run_id;
  if (pm.last_portal_task_url !== undefined)        fields.last_portal_task_url = pm.last_portal_task_url;
  if (pm.last_portal_recording_url !== undefined)   fields.last_portal_recording_url = pm.last_portal_recording_url;
  if (pm.last_portal_details !== undefined)         fields.last_portal_details = pm.last_portal_details;
  if (pm.last_portal_engine !== undefined)          fields.last_portal_engine = pm.last_portal_engine;
  if (pm.last_portal_screenshot_url !== undefined)  fields.last_portal_screenshot_url = pm.last_portal_screenshot_url;
  if (pm.last_portal_account_email !== undefined)   fields.last_portal_account_email = pm.last_portal_account_email;
  if (pm.portal_request_number !== undefined)       fields.portal_request_number = pm.portal_request_number;
  return fields;
}

/**
 * Auto-align followup status when case status changes.
 * Returns followup mutations or empty object.
 */
function followupAlignmentForStatus(newCaseStatus) {
  if (FOLLOWUP_TERMINAL_CASE_STATUSES.includes(newCaseStatus)) {
    return { followups: { status: 'cancelled' } };
  }
  if (!FOLLOWUP_ELIGIBLE_CASE_STATUSES.includes(newCaseStatus)) {
    return { followups: { status: 'paused', onlyFromStatuses: ['scheduled', 'processing'] } };
  }
  return {};
}

/**
 * Auto-dismiss active proposals when case enters a clear status.
 * Returns proposal mutations or empty object.
 */
function proposalDismissForStatus(newCaseStatus, reason) {
  if (CASE_STATUSES_CLEAR_ACTIVE_PROPOSALS.includes(newCaseStatus)) {
    return { proposals_dismiss_all: { reason: reason || `case_status:${newCaseStatus}` } };
  }
  return {};
}

// ---------------------------------------------------------------------------
// computeMutations — the core reducer
// ---------------------------------------------------------------------------

/**
 * Compute the set of mutations to apply for a given event.
 *
 * @param {object} snapshot - { caseData, activeRun, proposals, portalTasks, followup }
 * @param {string} event - One of CaseEvent values
 * @param {object} context - Caller-provided context fields
 * @returns {object} mutations - { cases, agent_runs, proposals, portal_tasks, followups, proposals_dismiss_all }
 */
function computeMutations(snapshot, event, context = {}) {
  const m = {};

  switch (event) {

    // -----------------------------------------------------------------------
    // Run lifecycle
    // -----------------------------------------------------------------------

    case CaseEvent.RUN_CLAIMED: {
      m.agent_runs = { id: context.runId, status: 'running' };
      m.agent_runs_cancel_others = { exceptRunId: context.runId };
      break;
    }

    case CaseEvent.RUN_COMPLETED: {
      m.agent_runs = { id: context.runId, status: 'completed', ended_at: new Date().toISOString() };
      break;
    }

    case CaseEvent.RUN_FAILED: {
      m.cases = {
        status: 'needs_human_review',
        requires_human: true,
        pause_reason: context.substatus || 'agent_run_failed',
      };
      m.agent_runs = { id: context.runId, status: 'failed', error: context.error, ended_at: new Date().toISOString() };
      break;
    }

    case CaseEvent.RUN_WAITING: {
      m.agent_runs = { id: context.runId, status: 'waiting' };
      break;
    }

    case CaseEvent.RUN_STALE_CLEANED: {
      m.agent_runs = { id: context.runId, status: 'failed', error: 'stale_run_cleaned', ended_at: new Date().toISOString() };
      break;
    }

    // -----------------------------------------------------------------------
    // Proposal lifecycle
    // -----------------------------------------------------------------------

    case CaseEvent.PROPOSAL_GATED: {
      m.cases = {
        status: 'needs_human_review',
        requires_human: true,
        pause_reason: context.pauseReason || 'proposal_pending',
      };
      if (context.runId) {
        m.agent_runs = { id: context.runId, status: 'waiting' };
      }
      m.proposals = { id: context.proposalId, status: 'PENDING_APPROVAL' };
      break;
    }

    case CaseEvent.PROPOSAL_APPROVED: {
      const decision = context.humanDecision || {};
      // APPROVED = direct auto-execute path, DECISION_RECEIVED = needs trigger run
      const proposalStatus = decision.autoExecute ? 'APPROVED' : 'DECISION_RECEIVED';
      m.cases = { requires_human: false, pause_reason: null };
      m.proposals = {
        id: context.proposalId,
        status: proposalStatus,
        human_decision: decision,
        human_decided_at: new Date().toISOString(),
        human_decided_by: decision.decidedBy || null,
        approved_by: decision.decidedBy || null,
        approved_at: new Date().toISOString(),
      };
      break;
    }

    case CaseEvent.PROPOSAL_DISMISSED: {
      m.proposals = {
        id: context.proposalId,
        status: 'DISMISSED',
        human_decision_merge: {
          auto_dismiss_reason: context.autoDismissReason || context.reason || 'dismissed',
          auto_dismissed_at: new Date().toISOString(),
        },
      };
      // Reconcile: clear human flags if no other active proposals remain
      const otherActive = (snapshot.proposals || []).some(
        p => p.id !== context.proposalId && ACTIVE_PROPOSAL_STATUSES.includes(p.status)
      );
      if (!otherActive) {
        m.cases = { requires_human: false, pause_reason: null };
      }
      break;
    }

    case CaseEvent.PROPOSAL_WITHDRAWN: {
      m.cases = { status: 'cancelled', substatus: context.substatus || 'proposal_withdrawn' };
      m.proposals = { id: context.proposalId, status: 'WITHDRAWN' };
      m.followups = { status: 'cancelled' };
      break;
    }

    case CaseEvent.PROPOSAL_ADJUSTED: {
      m.proposals = {
        id: context.proposalId,
        status: 'PENDING_APPROVAL',
        adjustment_instruction: context.adjustmentInstruction,
      };
      break;
    }

    case CaseEvent.PROPOSAL_EXPIRED: {
      m.proposals = { id: context.proposalId, status: 'DISMISSED' };
      break;
    }

    case CaseEvent.PROPOSAL_EXECUTED: {
      m.proposals = {
        id: context.proposalId,
        status: 'EXECUTED',
        executed_at: context.executedAt || new Date().toISOString(),
      };
      break;
    }

    case CaseEvent.PROPOSAL_BLOCKED: {
      m.cases = {
        status: 'needs_human_review',
        requires_human: true,
        pause_reason: 'execution_blocked',
      };
      m.proposals = { id: context.proposalId, status: 'BLOCKED', error: context.error };
      break;
    }

    case CaseEvent.PROPOSAL_CANCELLED: {
      m.proposals = { id: context.proposalId, status: 'DISMISSED' };
      break;
    }

    // -----------------------------------------------------------------------
    // Execution outcomes
    // -----------------------------------------------------------------------

    case CaseEvent.EMAIL_SENT: {
      m.cases = {
        status: 'sent',
        send_date: context.sendDate || new Date().toISOString(),
        ...(context.outcomeType ? { outcome_type: context.outcomeType } : {}),
      };
      m.proposals = { id: context.proposalId, status: 'EXECUTED', executed_at: new Date().toISOString() };
      // Dismiss other active proposals + align followups
      Object.assign(m, proposalDismissForStatus('sent', `case_status:sent`));
      Object.assign(m, followupAlignmentForStatus('sent'));
      break;
    }

    case CaseEvent.EMAIL_FAILED: {
      m.cases = {
        status: 'needs_human_review',
        requires_human: true,
        pause_reason: 'email_send_failed',
      };
      m.proposals = { id: context.proposalId, status: 'BLOCKED', error: context.error };
      break;
    }

    case CaseEvent.PORTAL_TASK_CREATED: {
      m.proposals = { id: context.proposalId, status: 'PENDING_PORTAL' };
      m.portal_tasks = { id: context.portalTaskId, status: 'PENDING' };
      break;
    }

    case CaseEvent.PORTAL_STARTED: {
      m.cases = {
        status: 'portal_in_progress',
        ...portalMetaFields(context),
      };
      if (context.runId) {
        m.agent_runs = { id: context.runId, status: 'running' };
      }
      m.portal_tasks = { id: context.portalTaskId, status: 'IN_PROGRESS' };
      break;
    }

    case CaseEvent.PORTAL_COMPLETED: {
      m.cases = {
        status: 'sent',
        send_date: context.sendDate || new Date().toISOString(),
        ...portalMetaFields(context),
        ...(context.confirmationNumber ? { portal_request_number: context.confirmationNumber } : {}),
      };
      if (context.runId) {
        m.agent_runs = { id: context.runId, status: 'completed', ended_at: new Date().toISOString() };
      }
      if (context.proposalId) {
        m.proposals = { id: context.proposalId, status: 'EXECUTED', executed_at: new Date().toISOString() };
      }
      m.portal_tasks = { id: context.portalTaskId, status: 'COMPLETED', completed_at: new Date().toISOString() };
      Object.assign(m, proposalDismissForStatus('sent', 'case_status:sent'));
      Object.assign(m, followupAlignmentForStatus('sent'));
      break;
    }

    case CaseEvent.PORTAL_FAILED: {
      m.cases = {
        status: 'needs_human_review',
        requires_human: true,
        pause_reason: 'portal_failed',
        ...portalMetaFields(context),
      };
      if (context.runId) {
        m.agent_runs = { id: context.runId, status: 'failed', error: context.error, ended_at: new Date().toISOString() };
      }
      m.portal_tasks = { id: context.portalTaskId, status: 'FAILED', error: context.error };
      break;
    }

    case CaseEvent.PORTAL_TIMED_OUT: {
      m.cases = {
        status: 'needs_human_review',
        requires_human: true,
        pause_reason: 'portal_timed_out',
        ...portalMetaFields(context),
      };
      if (context.runId) {
        m.agent_runs = { id: context.runId, status: 'failed', error: context.error, ended_at: new Date().toISOString() };
      }
      m.portal_tasks = { id: context.portalTaskId, status: 'CANCELLED' };
      break;
    }

    // -----------------------------------------------------------------------
    // Case-level
    // -----------------------------------------------------------------------

    case CaseEvent.CASE_SENT: {
      m.cases = {
        status: 'sent',
        send_date: context.sendDate || new Date().toISOString(),
      };
      Object.assign(m, proposalDismissForStatus('sent', 'case_status:sent'));
      Object.assign(m, followupAlignmentForStatus('sent'));
      break;
    }

    case CaseEvent.CASE_COMPLETED: {
      m.cases = {
        status: 'completed',
        substatus: context.substatus,
        ...(context.outcomeType ? { outcome_type: context.outcomeType } : {}),
        ...(context.outcomeSummary ? { outcome_summary: context.outcomeSummary } : {}),
      };
      m.proposals_dismiss_all = { reason: 'case_status:completed' };
      m.followups = { status: 'cancelled' };
      break;
    }

    case CaseEvent.CASE_CANCELLED: {
      m.cases = {
        status: 'cancelled',
        ...(context.substatus ? { substatus: context.substatus } : {}),
      };
      m.proposals_dismiss_all = { reason: 'case_status:cancelled' };
      m.followups = { status: 'cancelled' };
      break;
    }

    case CaseEvent.CASE_ESCALATED: {
      m.cases = {
        status: 'needs_human_review',
        requires_human: true,
        pause_reason: context.pauseReason || 'escalated',
        substatus: context.substatus,
      };
      break;
    }

    case CaseEvent.CASE_WRONG_AGENCY: {
      // Dismiss portal-type proposals, cancel active portal tasks
      m.proposals_dismiss_portal = { reason: 'wrong_agency' };
      m.portal_tasks_cancel_active = true;
      break;
    }

    case CaseEvent.CASE_RECONCILED: {
      // Clear review flags if no active proposals remain
      if (!hasActiveProposals(snapshot)) {
        m.cases = { requires_human: false, pause_reason: null };
      }
      break;
    }

    // -----------------------------------------------------------------------
    // Cron cleanup
    // -----------------------------------------------------------------------

    case CaseEvent.STALE_FLAGS_CLEARED: {
      m.cases = { requires_human: false, pause_reason: null };
      break;
    }

    case CaseEvent.STUCK_PORTAL_TASK_FAILED: {
      m.cases = {
        status: 'needs_human_review',
        requires_human: true,
        pause_reason: 'stuck_portal_task',
        ...portalMetaFields(context),
      };
      m.portal_tasks = { id: context.portalTaskId, status: 'FAILED', error: context.error || 'stuck_portal_task' };
      break;
    }

    case CaseEvent.PORTAL_STUCK: {
      m.cases = {
        status: 'needs_human_review',
        requires_human: true,
        pause_reason: 'portal_stuck',
      };
      break;
    }

    default:
      throw new Error(`Unknown CaseEvent: ${event}`);
  }

  // Safety net: needs_human_review must always have pause_reason
  if (m.cases?.status === 'needs_human_review' && !m.cases.pause_reason) {
    m.cases.pause_reason = 'UNSPECIFIED';
  }
  if (m.cases && isReviewStatus(m.cases.status) && m.cases.requires_human === undefined) {
    m.cases.requires_human = true;
  }

  return m;
}

// ---------------------------------------------------------------------------
// computeProjection — canonical status for API consumers
// ---------------------------------------------------------------------------

/**
 * Compute the canonical projection from a snapshot.
 *
 * @param {object} snapshot - { caseData, activeRun, proposals, portalTasks, followup }
 * @returns {object} Projection object
 */
function computeProjection(snapshot) {
  const { caseData, activeRun, proposals, portalTasks, followup } = snapshot;

  const activeProposal = (proposals || []).find(p => ACTIVE_PROPOSAL_STATUSES.includes(p.status)) || null;
  const activePortalTask = (portalTasks || []).find(p => ['PENDING', 'IN_PROGRESS'].includes(p.status)) || null;

  const reviewState = resolveReviewState({
    caseData,
    activeProposal,
    activeRun,
  });

  return {
    case_id: caseData.id,
    status: caseData.status,
    substatus: caseData.substatus || null,
    requires_human: Boolean(caseData.requires_human),
    pause_reason: caseData.pause_reason || null,
    review_state: reviewState,
    active_run: activeRun ? {
      id: activeRun.id,
      status: activeRun.status,
      trigger_type: activeRun.trigger_type,
      started_at: activeRun.started_at,
    } : null,
    active_proposal: activeProposal ? {
      id: activeProposal.id,
      status: activeProposal.status,
      action_type: activeProposal.action_type,
      requires_human: Boolean(activeProposal.requires_human),
    } : null,
    active_portal_task: activePortalTask ? {
      id: activePortalTask.id,
      status: activePortalTask.status,
    } : null,
    followup_schedule: followup ? {
      id: followup.id,
      status: followup.status,
      next_followup_date: followup.next_followup_date,
    } : null,
    last_portal_status: caseData.last_portal_status || null,
    updated_at: caseData.updated_at,
  };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  CaseEvent,
  computeMutations,
  computeProjection,
  // Helpers exposed for testing
  hasActiveProposals,
  isReviewStatus,
  portalMetaFields,
  followupAlignmentForStatus,
  proposalDismissForStatus,
  // Constants
  ACTIVE_PROPOSAL_STATUSES,
  CASE_STATUSES_CLEAR_ACTIVE_PROPOSALS,
  FOLLOWUP_TERMINAL_CASE_STATUSES,
  FOLLOWUP_ELIGIBLE_CASE_STATUSES,
};
