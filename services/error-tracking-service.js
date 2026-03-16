const db = require('./database');
const logger = require('./logger');

function truncate(value, max = 1000) {
  if (value == null) return null;
  const text = String(value);
  return text.length > max ? text.slice(0, max) : text;
}

function normalizeMetadata(metadata) {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    return {};
  }

  const clean = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (value === undefined) continue;
    if (value instanceof Error) {
      clean[key] = {
        name: value.name,
        message: truncate(value.message, 1000),
        code: value.code || null,
      };
      continue;
    }

    if (typeof value === 'string') {
      clean[key] = truncate(value, 2000);
      continue;
    }

    clean[key] = value;
  }

  return clean;
}

function normalizeError(error, context = {}) {
  const err = error instanceof Error ? error : new Error(String(error || 'Unknown error'));
  const metadata = normalizeMetadata(context.metadata);

  return {
    source_service: context.sourceService || context.source_service || 'application',
    operation: context.operation || null,
    case_id: context.caseId || context.case_id || null,
    proposal_id: context.proposalId || context.proposal_id || null,
    message_id: context.messageId || context.message_id || null,
    run_id: context.runId || context.run_id || null,
    error_name: truncate(err.name || 'Error', 100),
    error_code: truncate(err.code || context.errorCode || context.error_code || null, 100),
    error_message: truncate(err.message || String(error), 4000) || 'Unknown error',
    stack: truncate(err.stack || null, 12000),
    retryable: context.retryable === undefined ? null : Boolean(context.retryable),
    retry_attempt: Number.isFinite(context.retryAttempt)
      ? context.retryAttempt
      : Number.isFinite(context.retry_attempt)
        ? context.retry_attempt
        : null,
    metadata,
  };
}

async function captureException(error, context = {}) {
  const event = normalizeError(error, context);

  logger.error('Tracked exception', {
    sourceService: event.source_service,
    operation: event.operation,
    caseId: event.case_id,
    proposalId: event.proposal_id,
    messageId: event.message_id,
    runId: event.run_id,
    errorName: event.error_name,
    errorCode: event.error_code,
    retryable: event.retryable,
    retryAttempt: event.retry_attempt,
    metadata: event.metadata,
    tracked: true,
  });

  try {
    const result = await db.query(
      `INSERT INTO error_events (
         source_service,
         operation,
         case_id,
         proposal_id,
         message_id,
         run_id,
         error_name,
         error_code,
         error_message,
         stack,
         retryable,
         retry_attempt,
         metadata
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       RETURNING *`,
      [
        event.source_service,
        event.operation,
        event.case_id,
        event.proposal_id,
        event.message_id,
        event.run_id,
        event.error_name,
        event.error_code,
        event.error_message,
        event.stack,
        event.retryable,
        event.retry_attempt,
        event.metadata,
      ]
    );

    if (event.case_id) {
      try {
        await db.logActivity('tracked_error', `${event.source_service} error: ${event.error_message}`, {
          case_id: event.case_id,
          proposal_id: event.proposal_id,
          message_id: event.message_id,
          run_id: event.run_id,
          actor_type: 'system',
          source_service: event.source_service,
          error_name: event.error_name,
          error_code: event.error_code,
          retryable: event.retryable,
          retry_attempt: event.retry_attempt,
          tracked_error_id: result.rows[0]?.id || null,
          operation: event.operation,
        });
      } catch (activityError) {
        logger.warn('Failed to log tracked error activity', {
          sourceService: event.source_service,
          caseId: event.case_id,
          error: truncate(activityError?.message, 500),
        });
      }
    }

    return result.rows[0];
  } catch (persistError) {
    logger.error('Failed to persist tracked exception', {
      sourceService: event.source_service,
      operation: event.operation,
      persistError: truncate(persistError?.message, 1000),
      originalError: event.error_message,
    });
    return null;
  }
}

async function searchErrorEvents(options = {}) {
  const clauses = [];
  const values = [];

  const addClause = (sql, value) => {
    values.push(value);
    clauses.push(sql.replace('?', `$${values.length}`));
  };

  if (options.sourceService) addClause('source_service = ?', options.sourceService);
  if (options.caseId) addClause('case_id = ?', options.caseId);
  if (options.operation) addClause('operation = ?', options.operation);
  if (options.errorCode) addClause('error_code = ?', options.errorCode);
  if (Number.isFinite(options.sinceHours)) addClause(`created_at >= NOW() - (?::int * INTERVAL '1 hour')`, options.sinceHours);
  if (options.search) {
    values.push(`%${options.search}%`);
    clauses.push(`(error_message ILIKE $${values.length} OR COALESCE(error_code, '') ILIKE $${values.length} OR COALESCE(operation, '') ILIKE $${values.length})`);
  }

  const limit = Number.isFinite(options.limit) ? Math.min(options.limit, 200) : 50;
  values.push(limit);

  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const result = await db.query(
    `SELECT * FROM error_events ${where} ORDER BY created_at DESC LIMIT $${values.length}`,
    values
  );
  return result.rows;
}

async function getLatestCaseErrorEvent(caseId) {
  const result = await db.query(
    `SELECT * FROM error_events WHERE case_id = $1 ORDER BY created_at DESC LIMIT 1`,
    [caseId]
  );
  return result.rows[0] || null;
}

module.exports = {
  captureException,
  normalizeError,
  searchErrorEvents,
  getLatestCaseErrorEvent,
};
