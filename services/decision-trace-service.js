const DEFAULT_MAX_DEPTH = 6;

function serializeError(error) {
  if (!error) return null;
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack || null,
    };
  }

  return {
    message: String(error),
  };
}

function sanitizeValue(value, depth = 0) {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (depth > DEFAULT_MAX_DEPTH) return '[max-depth]';
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) return serializeError(value);

  const type = typeof value;
  if (type === 'function') return undefined;
  if (type !== 'object') return value;

  if (Array.isArray(value)) {
    return value
      .map((item) => sanitizeValue(item, depth + 1))
      .filter((item) => item !== undefined);
  }

  const output = {};
  for (const [key, entry] of Object.entries(value)) {
    const sanitized = sanitizeValue(entry, depth + 1);
    if (sanitized !== undefined) {
      output[key] = sanitized;
    }
  }
  return output;
}

function mergeObjects(base, update) {
  const left = sanitizeValue(base) || {};
  const right = sanitizeValue(update) || {};
  return { ...left, ...right };
}

function summarizeExecutionResult(result) {
  if (!result) return null;
  return sanitizeValue({
    action: result.action || null,
    mode: result.mode || null,
    executionKey: result.executionKey || null,
    emailJobId: result.emailJobId || null,
    portalTaskId: result.portalTaskId || null,
    status: result.status || null,
    reason: result.reason || null,
    skipped: result.skipped || false,
    success: result.success,
    error: result.error || null,
    details: result.details || null,
  });
}

class DecisionTraceTracker {
  constructor(db, params) {
    this.db = db;
    this.traceId = null;
    this.runId = params.runId;
    this.caseId = params.caseId;
    this.messageId = params.messageId || null;
    this.startedAt = new Date();
    this.classification = sanitizeValue(params.classification) || null;
    this.routerOutput = sanitizeValue(params.routerOutput) || null;
    this.gateDecision = sanitizeValue(params.gateDecision) || null;
    this.nodeTrace = {
      taskType: params.taskType,
      status: 'running',
      startedAt: this.startedAt.toISOString(),
      triggerType: params.triggerType || null,
      context: sanitizeValue(params.context) || {},
      steps: [],
    };
  }

  async start() {
    if (!this.runId || !this.caseId) return null;
    const row = await this.db.createDecisionTrace({
      run_id: this.runId,
      case_id: this.caseId,
      message_id: this.messageId,
      classification: this.classification,
      router_output: this.routerOutput,
      node_trace: this.nodeTrace,
      gate_decision: this.gateDecision,
      started_at: this.startedAt,
    });
    this.traceId = row?.id || null;
    return row;
  }

  recordNode(step, payload = {}) {
    this.nodeTrace.steps.push({
      step,
      at: new Date().toISOString(),
      ...sanitizeValue(payload),
    });
  }

  setClassification(update) {
    this.classification = mergeObjects(this.classification, update);
    return this.classification;
  }

  setRouterOutput(update) {
    this.routerOutput = mergeObjects(this.routerOutput, update);
    return this.routerOutput;
  }

  setGateDecision(update) {
    this.gateDecision = mergeObjects(this.gateDecision, update);
    return this.gateDecision;
  }

  markOutcome(status, payload = {}) {
    this.nodeTrace.status = status;
    this.nodeTrace.outcome = {
      status,
      at: new Date().toISOString(),
      ...sanitizeValue(payload),
    };
  }

  markFailed(error, payload = {}) {
    this.recordNode('task_failed', {
      ...sanitizeValue(payload),
      error: serializeError(error),
    });
    this.markOutcome('failed', {
      ...sanitizeValue(payload),
      error: serializeError(error),
    });
  }

  async complete(extra = {}) {
    if (!this.traceId) return null;

    if (extra.classification) this.setClassification(extra.classification);
    if (extra.routerOutput) this.setRouterOutput(extra.routerOutput);
    if (extra.gateDecision) this.setGateDecision(extra.gateDecision);
    if (extra.nodeTrace) {
      this.nodeTrace = mergeObjects(this.nodeTrace, extra.nodeTrace);
    }
    if (!this.nodeTrace.outcome) {
      this.markOutcome('completed');
    }

    return this.db.completeDecisionTrace(this.traceId, {
      classification: this.classification,
      router_output: this.routerOutput,
      node_trace: this.nodeTrace,
      gate_decision: this.gateDecision,
    });
  }
}

async function createDecisionTraceTracker(db, params) {
  const tracker = new DecisionTraceTracker(db, params);
  await tracker.start();
  tracker.recordNode('task_started', {
    runId: params.runId,
    caseId: params.caseId,
    messageId: params.messageId || null,
  });
  return tracker;
}

module.exports = {
  createDecisionTraceTracker,
  summarizeExecutionResult,
  sanitizeValue,
};
