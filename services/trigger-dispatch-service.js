const { tasks, runs } = require('@trigger.dev/sdk');
const db = require('./database');

const PENDING_STATUSES = new Set(['PENDING', 'PENDING_DEPLOYMENT', 'PENDING_EXECUTION']);
// QUEUED and PENDING_VERSION mean Trigger.dev accepted the run — it will execute
// when the worker is ready.  Creating a duplicate run is worse than waiting.
const ACCEPTED_STATUSES = new Set(['QUEUED', 'PENDING_VERSION']);
const STARTED_STATUSES = new Set(['EXECUTING', 'RUNNING', 'WAITING', 'COMPLETED', 'FAILED', 'CRASHED', 'CANCELED', 'CANCELLED']);
const TERMINAL_FAILED_STATUSES = new Set(['FAILED', 'CRASHED', 'CANCELED', 'CANCELLED']);
const ACTIVE_AGENT_RUN_STATUSES = ['created', 'queued', 'processing', 'running', 'paused', 'waiting', 'gated'];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeStatus(status) {
  return String(status || '').trim().toUpperCase();
}

function normalizeTriggerType(triggerType) {
  return String(triggerType || '').trim().toLowerCase();
}

function resolveProcessInboundIdentity(payload = {}, context = {}) {
  const caseId = context.caseId || payload.caseId || null;
  const messageId = payload.messageId ?? context.messageId ?? null;
  const triggerType = normalizeTriggerType(context.triggerType || payload.triggerType || 'inbound_message');
  return { caseId, messageId, triggerType };
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

function withStableIdempotency(options = {}, taskId, runId, caseId, payload = {}, context = {}) {
  const next = { ...(options || {}) };
  if (!next.idempotencyKey) {
    if (taskId === 'process-inbound' && caseId) {
      const { messageId, triggerType } = resolveProcessInboundIdentity(payload, context);
      const messagePart = messageId == null ? 'none' : String(messageId);
      const triggerPart = triggerType || 'inbound_message';
      next.idempotencyKey = `process-inbound:${caseId}:${messagePart}:${triggerPart}`;
      if (!next.idempotencyKeyTTL) {
        next.idempotencyKeyTTL = '30m';
      }
    } else if (runId) {
      next.idempotencyKey = `${taskId}:run:${runId}`;
    } else if (caseId) {
      next.idempotencyKey = `${taskId}:case:${caseId}:${Date.now()}`;
    }
  }
  return next;
}

async function findActiveEquivalentProcessInboundRun({ caseId, messageId, triggerType, excludeRunId = null }) {
  if (!caseId || !triggerType) return null;
  const result = await db.query(
    `SELECT id, status, message_id, trigger_type, metadata->>'triggerRunId' AS trigger_run_id
     FROM agent_runs
     WHERE case_id = $1
       AND (
         ($2::int IS NULL AND message_id IS NULL)
         OR message_id = $2::int
       )
       AND lower(trigger_type) = $3
       AND status = ANY($4::text[])
       AND ($5::int IS NULL OR id <> $5::int)
     ORDER BY started_at DESC NULLS LAST, id DESC
     LIMIT 1`,
    [caseId, messageId, triggerType, ACTIVE_AGENT_RUN_STATUSES, excludeRunId]
  );
  return result.rows[0] || null;
}

async function triggerTask(taskId, payload, options = {}, context = {}) {
  const runId = context.runId || payload?.runId || null;
  const caseId = context.caseId || payload?.caseId || null;
  const triggerType = context.triggerType || null;
  const source = context.source || 'app_dispatch';
  const processInboundIdentity = resolveProcessInboundIdentity(payload, context);

  // Dedupe process-inbound dispatches for the same case/message/trigger while one is active.
  // Resets and explicit replacements bypass dedupe — they intentionally supersede prior runs.
  const DEDUPE_BYPASS_TRIGGERS = new Set(['reset_to_last_inbound', 'orphan_case_reset']);
  const skipDedupe = context.skipDedupe === true || DEDUPE_BYPASS_TRIGGERS.has(processInboundIdentity.triggerType);
  if (taskId === 'process-inbound' && !skipDedupe) {
    const activeEquivalent = await findActiveEquivalentProcessInboundRun({
      caseId: processInboundIdentity.caseId,
      messageId: processInboundIdentity.messageId,
      triggerType: processInboundIdentity.triggerType,
      excludeRunId: runId,
    });
    if (activeEquivalent) {
      if (runId) {
        await mergeRunMetadata(runId, {
          dispatch_deduped: true,
          dedup_reason: 'active_equivalent_run',
          dedup_target_run_id: activeEquivalent.id,
          dedup_target_status: activeEquivalent.status,
          dedup_target_trigger_run_id: activeEquivalent.trigger_run_id || null,
          dedup_identity: processInboundIdentity,
          dispatch_attempted_at: new Date().toISOString(),
          dispatch_attempts: context.dispatchAttempts || 1,
          source: source || 'trigger.dev',
        });
        await db.query(
          `UPDATE agent_runs
           SET status = 'cancelled',
               ended_at = NOW(),
               error = COALESCE(error, $2)
           WHERE id = $1
             AND status IN ('created', 'queued', 'processing', 'running', 'paused', 'waiting', 'gated')`,
          [runId, `deduped to active equivalent run ${activeEquivalent.id}`]
        );
      }
      return {
        handle: { id: activeEquivalent.trigger_run_id || `dedup:${activeEquivalent.id}` },
        verify: { started: true, status: 'DEDUPED_ACTIVE_RUN' },
        deduped: true,
        dedupedToRunId: activeEquivalent.id,
      };
    }
  }

  const triggerOptions = withStableIdempotency(options, taskId, runId, caseId, payload, context);

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
