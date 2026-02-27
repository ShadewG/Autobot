const { tasks, runs } = require('@trigger.dev/sdk');
const db = require('./database');

const PENDING_STATUSES = new Set(['PENDING', 'PENDING_DEPLOYMENT', 'PENDING_EXECUTION']);
// QUEUED and PENDING_VERSION mean Trigger.dev accepted the run — it will execute
// when the worker is ready.  Creating a duplicate run is worse than waiting.
const ACCEPTED_STATUSES = new Set(['QUEUED', 'PENDING_VERSION']);
const STARTED_STATUSES = new Set(['EXECUTING', 'RUNNING', 'WAITING', 'COMPLETED', 'FAILED', 'CRASHED', 'CANCELED', 'CANCELLED']);
const TERMINAL_FAILED_STATUSES = new Set(['FAILED', 'CRASHED', 'CANCELED', 'CANCELLED']);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeStatus(status) {
  return String(status || '').trim().toUpperCase();
}

async function mergeRunMetadata(runId, patch) {
  if (!runId) return;
  await db.query(
    `UPDATE agent_runs
     SET metadata = COALESCE(metadata, '{}'::jsonb) || $2::jsonb
     WHERE id = $1`,
    [runId, JSON.stringify(patch || {})]
  );
}

async function verifyTriggerRunStarted(triggerRunId, { verifyMs = 10000, pollMs = 1500 } = {}) {
  const deadline = Date.now() + verifyMs;
  let lastStatus = null;
  while (Date.now() < deadline) {
    try {
      const run = await runs.retrieve(triggerRunId);
      const status = normalizeStatus(run?.status);
      if (status) lastStatus = status;
      if (STARTED_STATUSES.has(status) || ACCEPTED_STATUSES.has(status)) {
        return { started: true, status };
      }
      if (!PENDING_STATUSES.has(status)) {
        return { started: false, status };
      }
    } catch (_) {
      // Best-effort verification; keep polling until timeout.
    }
    await sleep(pollMs);
  }
  return { started: false, status: lastStatus || 'UNKNOWN' };
}

function withStableIdempotency(options = {}, taskId, runId, caseId) {
  const next = { ...(options || {}) };
  if (!next.idempotencyKey) {
    if (runId) next.idempotencyKey = `${taskId}:run:${runId}`;
    else if (caseId) next.idempotencyKey = `${taskId}:case:${caseId}:${Date.now()}`;
  }
  return next;
}

async function triggerTask(taskId, payload, options = {}, context = {}) {
  const runId = context.runId || payload?.runId || null;
  const caseId = context.caseId || payload?.caseId || null;
  const triggerType = context.triggerType || null;
  const source = context.source || 'app_dispatch';
  const triggerOptions = withStableIdempotency(options, taskId, runId, caseId);

  // Use task-level/default queueing only. Avoid per-trigger queue overrides.
  // This prevents stale custom queue routing and keeps run scheduling predictable.
  if (Object.prototype.hasOwnProperty.call(triggerOptions, 'queue')) {
    delete triggerOptions.queue;
  }

  const handle = await tasks.trigger(taskId, payload, triggerOptions);

  if (runId) {
    await mergeRunMetadata(runId, {
      triggerRunId: handle.id,
      dispatch_task_id: taskId,
      dispatch_payload: payload,
      dispatch_options: triggerOptions,
      dispatch_attempted_at: new Date().toISOString(),
      dispatch_attempts: context.dispatchAttempts || 1,
      source: source || 'trigger.dev',
      trigger_type: triggerType || undefined
    });
  }

  let verify = await verifyTriggerRunStarted(handle.id, context);

  if (runId) {
    await mergeRunMetadata(runId, {
      trigger_status_verified: verify.status,
      trigger_started: verify.started,
      trigger_verified_at: new Date().toISOString()
    });
  }

  return { handle, verify };
}

async function recoverStaleQueuedRuns({ maxAgeMinutes = 5, limit = 25, maxAttempts = 3 } = {}) {
  const stale = await db.query(
    `SELECT *
     FROM agent_runs
     WHERE status = 'queued'
       AND started_at < NOW() - ($1::text || ' minutes')::interval
       AND metadata->>'dispatch_task_id' IS NOT NULL
       AND metadata->>'triggerRunId' IS NOT NULL
     ORDER BY started_at ASC
     LIMIT $2`,
    [String(maxAgeMinutes), limit]
  );

  let recovered = 0;
  let failed = 0;

  for (const run of stale.rows) {
    const md = run.metadata || {};
    const attempts = Number(md.dispatch_attempts || 1);
    const taskId = md.dispatch_task_id;
    const triggerRunId = md.triggerRunId;
    const originalPayload = md.dispatch_payload || {};
    const originalOptions = md.dispatch_options || {};

    if (!taskId || !triggerRunId) continue;

    let triggerStatus = 'UNKNOWN';
    try {
      const remote = await runs.retrieve(triggerRunId);
      triggerStatus = normalizeStatus(remote?.status);
    } catch (_) {}

    if (TERMINAL_FAILED_STATUSES.has(triggerStatus)) {
      await db.updateAgentRun(run.id, {
        status: 'failed',
        ended_at: new Date(),
        error: `Trigger run ${triggerRunId} ended as ${triggerStatus}`
      });
      failed++;
      continue;
    }

    // Trigger.dev run completed successfully — mark the DB agent_run as completed too.
    if (triggerStatus === 'COMPLETED') {
      await db.updateAgentRun(run.id, {
        status: 'completed',
        ended_at: new Date(),
      });
      recovered++;
      continue;
    }

    // QUEUED / PENDING_VERSION — Trigger.dev accepted the run; it will execute
    // when the worker is ready.  Do NOT create a replacement.
    if (ACCEPTED_STATUSES.has(triggerStatus) || STARTED_STATUSES.has(triggerStatus)) {
      continue;
    }

    // If we can't determine the remote status, skip rather than risk duplicates.
    if (!PENDING_STATUSES.has(triggerStatus)) {
      continue;
    }

    if (attempts >= maxAttempts) {
      await db.updateAgentRun(run.id, {
        status: 'failed',
        ended_at: new Date(),
        error: `Dispatch retry exhausted after ${attempts} attempts (status=${triggerStatus})`
      });
      failed++;
      continue;
    }

    const replacementRun = await db.createAgentRunFull({
      case_id: run.case_id,
      trigger_type: run.trigger_type,
      message_id: run.message_id,
      status: 'queued',
      autopilot_mode: run.autopilot_mode || 'SUPERVISED',
      langgraph_thread_id: `${run.trigger_type}:${run.case_id}:recovery:${Date.now()}`,
      metadata: {
        recovered_from_run_id: run.id,
        source: 'trigger_recovery_sweeper',
      }
    });

    const payload = {
      ...originalPayload,
      runId: replacementRun.id,
      caseId: originalPayload.caseId || run.case_id,
      messageId: originalPayload.messageId ?? run.message_id ?? null,
      autopilotMode: originalPayload.autopilotMode || run.autopilot_mode || 'SUPERVISED'
    };
    const options = {
      ...originalOptions,
      idempotencyKey: `${taskId}:recovery:${replacementRun.id}`,
      idempotencyKeyTTL: originalOptions.idempotencyKeyTTL || '1h'
    };

    try {
      await triggerTask(taskId, payload, options, {
        runId: replacementRun.id,
        caseId: run.case_id,
        triggerType: run.trigger_type,
        source: 'trigger_recovery_sweeper',
        dispatchAttempts: attempts + 1,
        verifyMs: 8000,
        pollMs: 1200,
      });

      await db.updateAgentRun(run.id, {
        status: 'failed',
        ended_at: new Date(),
        error: `Recovered stale queued dispatch; replaced by run ${replacementRun.id}`
      });
      recovered++;
    } catch (error) {
      await db.updateAgentRun(replacementRun.id, {
        status: 'failed',
        ended_at: new Date(),
        error: `Recovery dispatch failed: ${error.message}`
      });
    }
  }

  return { scanned: stale.rowCount || 0, recovered, failed };
}

module.exports = {
  triggerTask,
  recoverStaleQueuedRuns,
  verifyTriggerRunStarted,
};
