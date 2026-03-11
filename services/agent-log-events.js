function truncate(value, maxLength = 500) {
  if (value == null) return null;
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text;
}

function summarizeRequest(value) {
  if (value == null) return null;
  if (typeof value === 'string') return truncate(value, 500);
  if (Array.isArray(value)) return truncate(value.slice(0, 5), 500);
  if (typeof value !== 'object') return truncate(value, 200);

  const summary = {};
  const preferredKeys = [
    'model',
    'url',
    'endpoint',
    'operation',
    'subject',
    'to',
    'from',
    'method',
    'query',
    'database_id',
    'page_id',
    'block_id',
    'message_type',
    'max_tokens',
    'effort',
  ];
  for (const key of preferredKeys) {
    if (value[key] != null) {
      summary[key] = value[key];
    }
  }
  if (value.headers && typeof value.headers === 'object') {
    summary.headers = Object.keys(value.headers).sort();
  }
  if (value.customArgs && typeof value.customArgs === 'object') {
    summary.customArgs = value.customArgs;
  }
  if (Array.isArray(value.attachments)) {
    summary.attachments = value.attachments.map((attachment) => ({
      filename: attachment?.filename || attachment?.name || null,
      content_type: attachment?.type || attachment?.content_type || null,
    }));
  }
  return summary;
}

function summarizeResponse(value) {
  if (value == null) return null;
  if (typeof value === 'string') return truncate(value, 500);
  if (typeof value !== 'object') return truncate(value, 200);

  const summary = {};
  const preferredKeys = [
    'status',
    'statusCode',
    'sid',
    'task_id',
    'id',
    'workflow_run_id',
    'run_id',
    'provider_message_id',
    'sendgrid_message_id',
    'model',
  ];
  for (const key of preferredKeys) {
    if (value[key] != null) {
      summary[key] = value[key];
    }
  }
  if (value.headers && typeof value.headers === 'object') {
    summary.headers = Object.keys(value.headers).sort();
  }
  return summary;
}

function buildDescription(phase, provider, operation) {
  const label = `${provider || 'external'} ${operation || 'call'}`.trim();
  if (phase === 'started') return `Started ${label}`;
  if (phase === 'completed') return `Completed ${label}`;
  return `Failed ${label}`;
}

async function logExternalCall(db, phase, context = {}) {
  if (!db || typeof db.logActivity !== 'function') return null;
  const eventType = `external_call_${phase}`;
  const description = buildDescription(phase, context.provider, context.operation);
  return db.logActivity(eventType, description, {
    case_id: context.caseId || null,
    message_id: context.messageId || null,
    actor_type: 'system',
    actor_id: context.actorId || null,
    source_service: context.sourceService || context.source_service || 'application',
    provider: context.provider || null,
    operation: context.operation || null,
    endpoint: context.endpoint || null,
    method: context.method || null,
    run_id: context.runId || null,
    proposal_id: context.proposalId || null,
    phase,
    duration_ms: context.durationMs ?? null,
    status_code: context.statusCode ?? null,
    model: context.model || null,
    retryable: context.retryable ?? null,
    request_summary: summarizeRequest(context.requestSummary || context.request),
    response_summary: summarizeResponse(context.responseSummary || context.response),
    error: phase === 'failed' ? truncate(context.error || context.errorMessage || null, 500) : null,
    metadata: context.metadata || null,
  });
}

async function logExternalCallStarted(db, context) {
  return logExternalCall(db, 'started', context);
}

async function logExternalCallCompleted(db, context) {
  return logExternalCall(db, 'completed', context);
}

async function logExternalCallFailed(db, context) {
  return logExternalCall(db, 'failed', context);
}

module.exports = {
  logExternalCallStarted,
  logExternalCallCompleted,
  logExternalCallFailed,
};
