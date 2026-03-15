const { sanitizeValue } = require('./decision-trace-service');

const SENSITIVE_KEY_PATTERNS = [
  /authorization/i,
  /cookie/i,
  /password/i,
  /secret/i,
  /token/i,
  /^api[_-]?key$/i,
  /refresh[_-]?token/i,
  /access[_-]?token/i,
];

function parseIsoTimestamp(value) {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function parseCsvParam(value) {
  if (!value) return [];
  return String(value)
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
}

function isSensitiveKey(key) {
  return SENSITIVE_KEY_PATTERNS.some((pattern) => pattern.test(String(key || '')));
}

function redact(value, parentKey = null, depth = 0) {
  if (value == null) return value;
  if (depth > 6) return '[max-depth]';
  if (parentKey && isSensitiveKey(parentKey)) return '[redacted]';
  if (Array.isArray(value)) return value.map((entry) => redact(entry, parentKey, depth + 1));
  if (typeof value !== 'object') return value;
  const out = {};
  for (const [key, entry] of Object.entries(value)) {
    out[key] = redact(entry, key, depth + 1);
  }
  return out;
}

function sanitizePayload(value) {
  return redact(sanitizeValue(value));
}

function classifyActivityKind(eventType = '', metadata = {}) {
  const event = String(eventType).toLowerCase();
  if (event.startsWith('external_call_')) return 'external_call';
  if (event === 'agent_run_step') return 'agent_step';
  if (event.startsWith('agent_run_')) return 'execution';
  if (event.includes('proposal') && event.includes('dismiss')) return 'human_decision';
  if (event.includes('proposal') && (event.includes('approve') || event.includes('withdraw') || event.includes('reject'))) return 'human_decision';
  if (event.includes('proposal')) return 'proposal';
  if (event === 'tracked_error' || event.includes('error') || event.includes('failed')) return 'error';
  if (event.includes('portal')) return 'portal';
  if (event.includes('email') || event.includes('inbound') || event.includes('message') || event.includes('webhook')) return 'message';
  if (event.includes('decision') || event.includes('classif')) return 'decision';
  if (metadata?.step) return 'agent_step';
  return 'activity';
}

function severityFromKind(kind, payload = {}) {
  if (kind === 'error') return 'error';
  if (payload.retryable === false || String(payload.status || '').toLowerCase() === 'failed') return 'warning';
  return 'info';
}

function buildDecisionSummary(payload = {}) {
  const intent = payload.classification?.intent || payload.classification?.classification || null;
  const action = payload.router_output?.action_type || payload.router_output?.actionType || null;
  const gate = payload.gate_decision?.pause_reason || payload.gate_decision?.gated_reason || null;
  const parts = [];
  if (intent) parts.push(`intent ${intent}`);
  if (action) parts.push(`action ${action}`);
  if (gate) parts.push(`gate ${gate}`);
  if (parts.length === 0) return payload.run_id ? `Decision trace for run ${payload.run_id}` : 'Decision trace recorded';
  return parts.join(' • ');
}

function normalizeCaseEvent(row) {
  return {
    id: `case_event_ledger:${row.id}`,
    timestamp: row.created_at,
    kind: 'state_transition',
    source: 'case_event_ledger',
    title: row.event ? `Case event: ${row.event}` : 'Case transition',
    summary: row.transition_key || row.event || 'Case state transition recorded',
    severity: 'info',
    run_id: row.context?.run_id || row.context?.runId || null,
    message_id: row.context?.message_id || row.context?.messageId || null,
    proposal_id: row.context?.proposal_id || row.context?.proposalId || null,
    case_id: row.case_id || row.context?.case_id || null,
    step: null,
    payload: sanitizePayload({
      transition_key: row.transition_key,
      context: row.context,
      mutations_applied: row.mutations_applied,
      projection: row.projection,
    }),
  };
}

function normalizeActivity(row) {
  const metadata = row.metadata || {};
  const kind = classifyActivityKind(row.event_type, metadata);
  return {
    id: `activity_log:${row.id}`,
    timestamp: row.created_at,
    kind,
    source: 'activity_log',
    title: row.description || (row.event_type ? `Activity: ${row.event_type}` : 'Activity recorded'),
    summary: row.event_type || row.description || 'Activity recorded',
    severity: severityFromKind(kind, metadata),
    run_id: metadata.run_id || metadata.runId || null,
    message_id: metadata.message_id || metadata.messageId || null,
    proposal_id: metadata.proposal_id || metadata.proposalId || null,
    case_id: row.case_id || metadata.case_id || null,
    step: metadata.step || null,
    payload: sanitizePayload({
      event_type: row.event_type,
      actor_type: row.actor_type,
      actor_id: row.actor_id,
      source_service: row.source_service,
      metadata,
    }),
  };
}

function normalizePortalSubmission(row) {
  const status = String(row.status || '').toLowerCase();
  return {
    id: `portal_submissions:${row.id}`,
    timestamp: row.started_at || row.created_at || row.completed_at,
    kind: 'portal',
    source: 'portal_submissions',
    title: `Portal ${row.status || 'attempt'}`,
    summary: row.portal_url || row.confirmation_number || 'Portal submission attempt',
    severity: status === 'failed' ? 'warning' : 'info',
    run_id: row.run_id || null,
    message_id: null,
    proposal_id: row.proposal_id || null,
    case_id: row.case_id || null,
    step: null,
    payload: sanitizePayload(row),
  };
}

function normalizeEmailEvent(row) {
  return {
    id: `email_events:${row.id}`,
    timestamp: row.event_timestamp || row.created_at,
    kind: 'provider_event',
    source: 'email_events',
    title: `Email event: ${row.event_type || 'unknown'}`,
    summary: row.provider_message_id || row.event_type || 'Provider event recorded',
    severity: ['bounce', 'bounced', 'dropped', 'spamreport'].includes(String(row.event_type || '').toLowerCase()) ? 'warning' : 'info',
    run_id: row.run_id || null,
    message_id: row.message_id || null,
    proposal_id: row.proposal_id || null,
    case_id: row.case_id || null,
    step: null,
    payload: sanitizePayload(row),
  };
}

function normalizeErrorEvent(row) {
  return {
    id: `error_events:${row.id}`,
    timestamp: row.created_at,
    kind: 'error',
    source: 'error_events',
    title: `${row.source_service || 'application'} error`,
    summary: row.error_message || row.error_code || row.error_name || 'Tracked error',
    severity: 'error',
    run_id: row.run_id || null,
    message_id: row.message_id || null,
    proposal_id: row.proposal_id || null,
    case_id: row.case_id || null,
    step: null,
    payload: sanitizePayload(row),
  };
}

function normalizeDecisionTrace(row) {
  const nodeTrace = row.node_trace || {};
  return {
    id: `decision_traces:${row.id}`,
    timestamp: row.completed_at || row.started_at || row.created_at,
    kind: 'decision',
    source: 'decision_traces',
    title: nodeTrace.taskType ? `Decision trace: ${nodeTrace.taskType}` : 'Decision trace',
    summary: buildDecisionSummary(row),
    severity: nodeTrace.status === 'failed' ? 'warning' : 'info',
    run_id: row.run_id || null,
    message_id: row.message_id || null,
    proposal_id: row.proposal_id || null,
    case_id: row.case_id || null,
    step: null,
    payload: sanitizePayload({
      classification: row.classification,
      router_output: row.router_output,
      gate_decision: row.gate_decision,
      duration_ms: row.duration_ms,
      started_at: row.started_at,
      completed_at: row.completed_at,
      node_trace: row.node_trace,
    }),
  };
}

function buildSummary(entries) {
  return entries.reduce((acc, entry) => {
    acc.total += 1;
    acc.by_source[entry.source] = (acc.by_source[entry.source] || 0) + 1;
    acc.by_kind[entry.kind] = (acc.by_kind[entry.kind] || 0) + 1;
    if (entry.severity && entry.severity !== 'info') {
      acc.by_severity[entry.severity] = (acc.by_severity[entry.severity] || 0) + 1;
    }
    return acc;
  }, { total: 0, by_source: {}, by_kind: {}, by_severity: {} });
}

function finalizeEntries(allEntries, { limit, sourceFilters, kindFilters, before, after }) {
  const filtered = allEntries
    .filter((row) => row.timestamp)
    .filter((row) => sourceFilters.size === 0 || sourceFilters.has(row.source))
    .filter((row) => kindFilters.size === 0 || kindFilters.has(row.kind))
    .filter((row) => !before || new Date(row.timestamp).getTime() < before.getTime())
    .filter((row) => !after || new Date(row.timestamp).getTime() > after.getTime())
    .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

  const entries = filtered.slice(0, limit);
  return {
    count: entries.length,
    summary: buildSummary(entries),
    next_before: entries.length === limit ? entries[entries.length - 1]?.timestamp || null : null,
    entries,
  };
}

async function buildCaseAgentLog(db, caseId, options = {}) {
  const limit = Math.max(1, Math.min(parseInt(options.limit, 10) || 100, 300));
  const sourceFilters = new Set(parseCsvParam(options.source).map((value) => value.toLowerCase()));
  const kindFilters = new Set(parseCsvParam(options.kind).map((value) => value.toLowerCase()));
  const before = parseIsoTimestamp(options.before);
  const after = parseIsoTimestamp(options.after);

  const [ledgerResult, activityResult, portalSubmissions, emailEvents, errorEventsResult, decisionTraces] = await Promise.all([
    db.query(
      `SELECT id, case_id, event, transition_key, context, mutations_applied, projection, created_at
       FROM case_event_ledger
       WHERE case_id = $1
       ORDER BY created_at DESC, id DESC
       LIMIT $2`,
      [caseId, limit]
    ),
    db.query(
      `SELECT id, case_id, event_type, description, metadata, actor_type, actor_id, source_service, created_at
       FROM activity_log
       WHERE case_id = $1
       ORDER BY created_at DESC, id DESC
       LIMIT $2`,
      [caseId, limit]
    ),
    db.getPortalSubmissions(caseId, { limit }),
    db.getCaseEmailEvents(caseId, { limit }),
    db.query(
      `SELECT id, case_id, source_service, operation, error_name, error_code, error_message, retryable, retry_attempt, metadata, run_id, message_id, proposal_id, created_at
       FROM error_events
       WHERE case_id = $1
       ORDER BY created_at DESC, id DESC
       LIMIT $2`,
      [caseId, limit]
    ),
    db.getDecisionTracesByCaseId(caseId, limit),
  ]);

  const allEntries = [
    ...ledgerResult.rows.map(normalizeCaseEvent),
    ...activityResult.rows.map(normalizeActivity),
    ...portalSubmissions.map(normalizePortalSubmission),
    ...emailEvents.map(normalizeEmailEvent),
    ...errorEventsResult.rows.map(normalizeErrorEvent),
    ...decisionTraces.map(normalizeDecisionTrace),
  ];

  const result = finalizeEntries(allEntries, {
    limit,
    sourceFilters,
    kindFilters,
    before,
    after,
  });

  return {
    case_id: caseId,
    count: result.count,
    summary: result.summary,
    filters: {
      sources: Array.from(sourceFilters),
      kinds: Array.from(kindFilters),
      before: before ? before.toISOString() : null,
      after: after ? after.toISOString() : null,
    },
    next_before: result.next_before,
    entries: result.entries,
  };
}

async function buildGlobalAgentLog(db, options = {}) {
  const limit = Math.max(1, Math.min(parseInt(options.limit, 10) || 100, 300));
  const sourceFilters = new Set(parseCsvParam(options.source).map((value) => value.toLowerCase()));
  const kindFilters = new Set(parseCsvParam(options.kind).map((value) => value.toLowerCase()));
  const before = parseIsoTimestamp(options.before);
  const after = parseIsoTimestamp(options.after);
  const caseId = Number.isFinite(parseInt(options.caseId, 10)) ? parseInt(options.caseId, 10) : null;

  const caseClause = caseId ? 'WHERE case_id = $1' : '';
  const params = caseId ? [caseId, limit] : [limit];
  const limitIndex = caseId ? 2 : 1;

  const [ledgerResult, activityResult, portalResult, emailResult, errorEventsResult, decisionTraceResult] = await Promise.all([
    db.query(
      `SELECT id, case_id, event, transition_key, context, mutations_applied, projection, created_at
       FROM case_event_ledger
       ${caseClause}
       ORDER BY created_at DESC, id DESC
       LIMIT $${limitIndex}`,
      params
    ),
    db.query(
      `SELECT id, case_id, event_type, description, metadata, actor_type, actor_id, source_service, created_at
       FROM activity_log
       ${caseClause}
       ORDER BY created_at DESC, id DESC
       LIMIT $${limitIndex}`,
      params
    ),
    db.query(
      `SELECT *
       FROM portal_submissions
       ${caseClause}
       ORDER BY COALESCE(started_at, completed_at) DESC, id DESC
       LIMIT $${limitIndex}`,
      params
    ),
    db.query(
      `SELECT ee.*${caseId ? ', m.case_id' : ''}
       FROM email_events ee
       ${caseId ? 'INNER JOIN messages m ON m.id = ee.message_id WHERE m.case_id = $1' : ''}
       ORDER BY COALESCE(ee.event_timestamp, ee.created_at) DESC, ee.id DESC
       LIMIT $${limitIndex}`,
      params
    ),
    db.query(
      `SELECT id, case_id, source_service, operation, error_name, error_code, error_message, retryable, retry_attempt, metadata, run_id, message_id, proposal_id, created_at
       FROM error_events
       ${caseClause}
       ORDER BY created_at DESC, id DESC
       LIMIT $${limitIndex}`,
      params
    ),
    db.query(
      `SELECT id, case_id, message_id, run_id, classification, router_output, node_trace, gate_decision, duration_ms, started_at, completed_at, created_at
       FROM decision_traces
       ${caseClause}
       ORDER BY COALESCE(completed_at, started_at, created_at) DESC, id DESC
       LIMIT $${limitIndex}`,
      params
    ),
  ]);

  const allEntries = [
    ...ledgerResult.rows.map(normalizeCaseEvent),
    ...activityResult.rows.map(normalizeActivity),
    ...portalResult.rows.map(normalizePortalSubmission),
    ...emailResult.rows.map(normalizeEmailEvent),
    ...errorEventsResult.rows.map(normalizeErrorEvent),
    ...decisionTraceResult.rows.map(normalizeDecisionTrace),
  ];

  const result = finalizeEntries(allEntries, {
    limit,
    sourceFilters,
    kindFilters,
    before,
    after,
  });

  return {
    case_id: caseId,
    count: result.count,
    summary: result.summary,
    filters: {
      case_id: caseId,
      sources: Array.from(sourceFilters),
      kinds: Array.from(kindFilters),
      before: before ? before.toISOString() : null,
      after: after ? after.toISOString() : null,
    },
    next_before: result.next_before,
    entries: result.entries,
  };
}

module.exports = {
  buildCaseAgentLog,
  buildGlobalAgentLog,
};
