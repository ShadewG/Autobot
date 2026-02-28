'use strict';

/**
 * Case Runtime — single entry point for all case lifecycle transitions.
 *
 * transitionCaseRuntime(caseId, event, context) atomically:
 *   1. Acquires a transaction-bound advisory lock
 *   2. Checks idempotency via transition_key
 *   3. Loads the 5-table snapshot
 *   4. Computes mutations via the pure reducer
 *   5. Applies mutations within the same transaction
 *   6. Inserts a ledger row for audit + idempotency
 *   7. Fires post-commit side effects (SSE, Notion, reactive dispatch)
 */

const db = require('./database');
const { emitDataUpdate } = require('./event-bus');
const { CaseEvent, computeMutations, computeProjection, ACTIVE_PROPOSAL_STATUSES } = require('../lib/case-reducer');

// ---------------------------------------------------------------------------
// Error classes
// ---------------------------------------------------------------------------

class CaseLockContention extends Error {
  constructor(caseId) {
    super(`Case ${caseId} is locked by another transaction`);
    this.name = 'CaseLockContention';
    this.caseId = caseId;
  }
}

class CaseNotFound extends Error {
  constructor(caseId) {
    super(`Case ${caseId} not found`);
    this.name = 'CaseNotFound';
    this.caseId = caseId;
  }
}

// ---------------------------------------------------------------------------
// Snapshot loader — reads all 5 tables in one transaction
// ---------------------------------------------------------------------------

async function loadCaseSnapshot(txQuery, caseId) {
  const [caseRes, runRes, proposalRes, portalRes, followupRes] = await Promise.all([
    txQuery('SELECT * FROM cases WHERE id = $1', [caseId]),
    txQuery(
      `SELECT * FROM agent_runs
       WHERE case_id = $1 AND status IN ('created','queued','running','paused','waiting')
       ORDER BY started_at DESC LIMIT 1`,
      [caseId]
    ),
    txQuery(
      `SELECT * FROM proposals WHERE case_id = $1 AND status = ANY($2::text[])
       ORDER BY created_at DESC`,
      [caseId, ACTIVE_PROPOSAL_STATUSES]
    ),
    txQuery(
      `SELECT * FROM portal_tasks WHERE case_id = $1 AND status IN ('PENDING','IN_PROGRESS')
       ORDER BY created_at DESC LIMIT 1`,
      [caseId]
    ),
    txQuery(
      `SELECT * FROM follow_up_schedule WHERE case_id = $1
       AND status NOT IN ('cancelled','max_reached')
       ORDER BY created_at DESC LIMIT 1`,
      [caseId]
    ),
  ]);

  if (caseRes.rowCount === 0) throw new CaseNotFound(caseId);

  return {
    caseData: caseRes.rows[0],
    activeRun: runRes.rows[0] || null,
    proposals: proposalRes.rows,
    portalTasks: portalRes.rows,
    followup: followupRes.rows[0] || null,
  };
}

// ---------------------------------------------------------------------------
// Mutation applier — translates reducer output to SQL
// ---------------------------------------------------------------------------

async function applyMutations(txQuery, caseId, mutations) {
  const promises = [];

  // --- cases ---
  if (mutations.cases) {
    const fields = { ...mutations.cases, updated_at: new Date() };
    // Substatus length guard
    if (typeof fields.substatus === 'string') {
      fields.substatus = fields.substatus.substring(0, 100);
    }
    const keys = Object.keys(fields);
    const setClause = keys.map((k, i) => `${k} = $${i + 2}`).join(', ');
    const values = [caseId, ...keys.map(k => fields[k])];
    promises.push(txQuery(`UPDATE cases SET ${setClause} WHERE id = $1`, values));
  }

  // --- agent_runs ---
  if (mutations.agent_runs && mutations.agent_runs.id) {
    const { id, ...fields } = mutations.agent_runs;
    if (Object.keys(fields).length > 0) {
      const keys = Object.keys(fields);
      const setClause = keys.map((k, i) => `${k} = $${i + 3}`).join(', ');
      const values = [id, caseId, ...keys.map(k => fields[k])];
      promises.push(txQuery(`UPDATE agent_runs SET ${setClause} WHERE id = $1 AND case_id = $2`, values));
    }
  }

  // --- agent_runs_cancel_others: cancel other active runs for this case ---
  if (mutations.agent_runs_cancel_others) {
    const exceptId = mutations.agent_runs_cancel_others.exceptRunId;
    promises.push(txQuery(
      `UPDATE agent_runs SET status = 'failed', error = 'superseded', ended_at = NOW()
       WHERE case_id = $1 AND id != $2 AND status IN ('created','queued','running','paused','waiting')`,
      [caseId, exceptId]
    ));
  }

  // --- proposals (single) ---
  if (mutations.proposals && mutations.proposals.id) {
    const { id, human_decision_merge, error: propError, ...fields } = mutations.proposals;
    const updates = { ...fields, updated_at: new Date() };
    if (propError !== undefined) updates.error = propError;

    // Merge human_decision JSONB if specified
    if (human_decision_merge) {
      const keys = Object.keys(updates);
      const offset = keys.length + 3; // $1 = id, $2 = caseId, then updates, then merge value
      const setClause = [
        ...keys.map((k, i) => `${k} = $${i + 3}`),
        `human_decision = COALESCE(human_decision, '{}'::jsonb) || $${offset}::jsonb`,
      ].join(', ');
      const values = [id, caseId, ...keys.map(k => updates[k]), JSON.stringify(human_decision_merge)];
      promises.push(txQuery(`UPDATE proposals SET ${setClause} WHERE id = $1 AND case_id = $2`, values));
    } else {
      const keys = Object.keys(updates);
      const setClause = keys.map((k, i) => `${k} = $${i + 3}`).join(', ');
      const values = [id, caseId, ...keys.map(k => updates[k])];
      promises.push(txQuery(`UPDATE proposals SET ${setClause} WHERE id = $1 AND case_id = $2`, values));
    }
  }

  // --- proposals_dismiss_all: dismiss all active proposals for the case ---
  if (mutations.proposals_dismiss_all) {
    const reason = mutations.proposals_dismiss_all.reason || 'auto_dismissed';
    promises.push(txQuery(
      `UPDATE proposals
       SET status = 'DISMISSED', updated_at = NOW(),
           human_decision = COALESCE(human_decision, '{}'::jsonb)
             || jsonb_build_object('auto_dismiss_reason', $2::text, 'auto_dismissed_at', NOW()::text)
       WHERE case_id = $1 AND status = ANY($3::text[])`,
      [caseId, reason, ACTIVE_PROPOSAL_STATUSES]
    ));
  }

  // --- proposals_dismiss_portal: dismiss portal-type and outbound proposals (for wrong_agency) ---
  if (mutations.proposals_dismiss_portal) {
    const reason = mutations.proposals_dismiss_portal.reason || 'auto_dismissed';
    promises.push(txQuery(
      `UPDATE proposals
       SET status = 'DISMISSED', updated_at = NOW(),
           human_decision = COALESCE(human_decision, '{}'::jsonb)
             || jsonb_build_object('auto_dismiss_reason', $2::text, 'auto_dismissed_at', NOW()::text)
       WHERE case_id = $1 AND status = ANY($3::text[])
         AND action_type IN ('SUBMIT_PORTAL', 'PORTAL_SUBMISSION', 'SEND_INITIAL_REQUEST', 'SEND_FOLLOWUP')`,
      [caseId, reason, ACTIVE_PROPOSAL_STATUSES]
    ));
  }

  // --- portal_tasks (single) ---
  if (mutations.portal_tasks && mutations.portal_tasks.id) {
    const { id, error: ptError, ...fields } = mutations.portal_tasks;
    const updates = { ...fields, updated_at: new Date() };
    if (ptError !== undefined) updates.completion_notes = ptError;
    const keys = Object.keys(updates);
    const setClause = keys.map((k, i) => `${k} = $${i + 3}`).join(', ');
    const values = [id, caseId, ...keys.map(k => updates[k])];
    promises.push(txQuery(`UPDATE portal_tasks SET ${setClause} WHERE id = $1 AND case_id = $2`, values));
  }

  // --- portal_tasks_cancel_active: cancel all active portal tasks for the case ---
  if (mutations.portal_tasks_cancel_active) {
    promises.push(txQuery(
      `UPDATE portal_tasks SET status = 'CANCELLED', updated_at = NOW()
       WHERE case_id = $1 AND status IN ('PENDING', 'IN_PROGRESS')`,
      [caseId]
    ));
  }

  // --- followups ---
  if (mutations.followups) {
    const { onlyFromStatuses, ...fields } = mutations.followups;
    const statusFilter = onlyFromStatuses || null;
    if (statusFilter) {
      promises.push(txQuery(
        `UPDATE follow_up_schedule SET status = $2, updated_at = NOW()
         WHERE case_id = $1 AND status = ANY($3::text[])`,
        [caseId, fields.status, statusFilter]
      ));
    } else {
      promises.push(txQuery(
        `UPDATE follow_up_schedule SET status = $2, updated_at = NOW()
         WHERE case_id = $1 AND status NOT IN ('cancelled', 'max_reached')`,
        [caseId, fields.status]
      ));
    }
  }

  await Promise.all(promises);
}

// ---------------------------------------------------------------------------
// Side effects — fire-and-forget after commit
// ---------------------------------------------------------------------------

async function fireSideEffects(caseId, event, projection) {
  // SSE push
  try {
    emitDataUpdate('case_update', {
      case_id: caseId,
      status: projection.status,
      substatus: projection.substatus,
      review_state: projection.review_state,
    });
  } catch (_) {}

  // Portal SSE for portal events
  const portalEvents = new Set([
    CaseEvent.PORTAL_STARTED, CaseEvent.PORTAL_COMPLETED,
    CaseEvent.PORTAL_FAILED, CaseEvent.PORTAL_TIMED_OUT,
    CaseEvent.STUCK_PORTAL_TASK_FAILED,
  ]);
  if (portalEvents.has(event)) {
    try {
      emitDataUpdate('portal_status', {
        case_id: caseId,
        portal_status: projection.last_portal_status,
      });
    } catch (_) {}
  }

  // Notion sync
  try {
    const notionService = require('./notion-service');
    notionService.syncStatusToNotion(caseId).catch(() => {});
  } catch (_) {}

  // Reactive dispatch
  try {
    if (projection.status === 'ready_to_send') {
      const { dispatchReadyToSend } = require('./dispatch-helper');
      dispatchReadyToSend(caseId, { source: 'case_runtime' }).catch(() => {});
    }
  } catch (_) {}
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Transition case state atomically.
 *
 * @param {number} caseId
 * @param {string} event - One of CaseEvent values
 * @param {object} [context={}] - Event-specific context fields + optional transitionKey
 * @returns {Promise<object>} Canonical projection
 */
async function transitionCaseRuntime(caseId, event, context = {}) {
  const numericId = parseInt(caseId, 10);
  if (!Number.isFinite(numericId) || numericId <= 0) {
    throw new Error(`Invalid caseId: ${caseId}`);
  }
  let projection;

  await db.withTransaction(async (txQuery) => {
    // 1. Transaction-bound advisory lock (auto-releases on commit/rollback)
    const lockKey = 1000000 + numericId;
    const lockResult = await txQuery('SELECT pg_try_advisory_xact_lock($1) AS acquired', [lockKey]);
    if (!lockResult.rows[0].acquired) {
      throw new CaseLockContention(caseId);
    }

    // 2. Idempotency check
    if (context.transitionKey) {
      const existing = await txQuery(
        'SELECT projection FROM case_event_ledger WHERE transition_key = $1 AND case_id = $2',
        [context.transitionKey, caseId]
      );
      if (existing.rowCount > 0) {
        projection = existing.rows[0].projection;
        return; // Already applied — idempotent no-op
      }
    }

    // 3. Load snapshot
    const snapshot = await loadCaseSnapshot(txQuery, caseId);

    // 4. Compute mutations (pure)
    const mutations = computeMutations(snapshot, event, context);

    // 5. Apply mutations
    await applyMutations(txQuery, caseId, mutations);

    // 6. Insert ledger row
    // Re-load snapshot after mutations for projection
    const updatedSnapshot = await loadCaseSnapshot(txQuery, caseId);
    projection = computeProjection(updatedSnapshot);

    await txQuery(
      `INSERT INTO case_event_ledger (case_id, event, transition_key, context, mutations_applied, projection)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        caseId,
        event,
        context.transitionKey || null,
        JSON.stringify(context),
        JSON.stringify(mutations),
        JSON.stringify(projection),
      ]
    );
  });

  // 7. Post-commit side effects (fire-and-forget)
  fireSideEffects(caseId, event, projection).catch(() => {});

  return projection;
}

/**
 * Dry-run a transition: compute mutations without writing anything.
 * Useful for shadow mode comparison.
 *
 * @param {number} caseId
 * @param {string} event
 * @param {object} [context={}]
 * @returns {Promise<{mutations: object, projection: object}>}
 */
async function dryRunTransition(caseId, event, context = {}) {
  const numericId = parseInt(caseId, 10);
  if (!Number.isFinite(numericId) || numericId <= 0) {
    throw new Error(`Invalid caseId: ${caseId}`);
  }
  let result;

  await db.withTransaction(async (txQuery) => {
    const lockKey = 1000000 + numericId;
    const lockResult = await txQuery('SELECT pg_try_advisory_xact_lock($1) AS acquired', [lockKey]);
    if (!lockResult.rows[0].acquired) {
      throw new CaseLockContention(caseId);
    }

    const snapshot = await loadCaseSnapshot(txQuery, caseId);
    const mutations = computeMutations(snapshot, event, context);
    const projection = computeProjection(snapshot);

    result = { mutations, projection, snapshot };

    // Transaction rolls back — no writes
    throw new DryRunRollback();
  }).catch(err => {
    if (!(err instanceof DryRunRollback)) throw err;
  });

  return result;
}

class DryRunRollback extends Error {
  constructor() {
    super('dry_run_rollback');
    this.name = 'DryRunRollback';
  }
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  transitionCaseRuntime,
  dryRunTransition,
  CaseEvent,
  CaseLockContention,
  CaseNotFound,
  // Internals exposed for testing
  loadCaseSnapshot,
  applyMutations,
  fireSideEffects,
};
