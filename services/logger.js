/**
 * Structured Logger Service
 *
 * Winston-based logging with context-aware child loggers.
 * Provides structured logging for cases, agents, and workers.
 *
 * Deliverable 5: Observability - Structured Logging
 */

const winston = require('winston');

// Log levels
const levels = {
    error: 0,
    warn: 1,
    info: 2,
    http: 3,
    debug: 4
};

// Log colors for console output
const colors = {
    error: 'red',
    warn: 'yellow',
    info: 'green',
    http: 'magenta',
    debug: 'cyan'
};

winston.addColors(colors);

// Determine log level from environment
const level = () => {
    const env = process.env.NODE_ENV || 'development';
    const configuredLevel = process.env.LOG_LEVEL;

    if (configuredLevel) {
        return configuredLevel;
    }

    return env === 'production' ? 'info' : 'debug';
};

// Custom format for structured logging
const structuredFormat = winston.format.printf(({
    level,
    message,
    timestamp,
    caseId,
    agentRunId,
    triggerType,
    queueName,
    jobId,
    proposalId,
    ...meta
}) => {
    // Build context string
    const contextParts = [];
    if (caseId) contextParts.push(`case:${caseId}`);
    if (agentRunId) contextParts.push(`run:${agentRunId}`);
    if (triggerType) contextParts.push(`trigger:${triggerType}`);
    if (queueName) contextParts.push(`queue:${queueName}`);
    if (jobId) contextParts.push(`job:${jobId}`);
    if (proposalId) contextParts.push(`proposal:${proposalId}`);

    const context = contextParts.length > 0 ? `[${contextParts.join(' ')}]` : '';

    // Handle additional metadata
    const metaStr = Object.keys(meta).length > 0
        ? ` ${JSON.stringify(meta)}`
        : '';

    return `${timestamp} ${level.toUpperCase().padEnd(5)} ${context} ${message}${metaStr}`;
});

// Console format (colorized for development)
const consoleFormat = winston.format.combine(
    winston.format.colorize({ all: true }),
    winston.format.timestamp({ format: 'HH:mm:ss.SSS' }),
    structuredFormat
);

// File/JSON format (structured for production)
const jsonFormat = winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
);

// Create transports
const transports = [
    // Console transport (always enabled)
    new winston.transports.Console({
        format: consoleFormat
    })
];

// Add file transport in production
if (process.env.NODE_ENV === 'production' && process.env.LOG_FILE) {
    transports.push(
        new winston.transports.File({
            filename: process.env.LOG_FILE,
            format: jsonFormat,
            maxsize: 10 * 1024 * 1024, // 10MB
            maxFiles: 5,
            tailable: true
        })
    );
}

// Add error file transport
if (process.env.NODE_ENV === 'production' && process.env.ERROR_LOG_FILE) {
    transports.push(
        new winston.transports.File({
            filename: process.env.ERROR_LOG_FILE,
            level: 'error',
            format: jsonFormat,
            maxsize: 10 * 1024 * 1024,
            maxFiles: 5
        })
    );
}

// Create the main logger
const logger = winston.createLogger({
    level: level(),
    levels,
    transports
});

/**
 * Create a child logger with case context.
 *
 * @param {number} caseId - The case ID
 * @returns {Object} Child logger with case context
 */
function forCase(caseId) {
    return logger.child({ caseId });
}

/**
 * Create a child logger with agent context.
 *
 * @param {number} caseId - The case ID
 * @param {string} triggerType - The trigger type (inbound, cron_followup, etc.)
 * @param {number} [runId] - Optional agent run ID
 * @returns {Object} Child logger with agent context
 */
function forAgent(caseId, triggerType, runId = null) {
    const context = { caseId, triggerType };
    if (runId) context.agentRunId = runId;
    return logger.child(context);
}

/**
 * Create a child logger with worker/queue context.
 *
 * @param {string} queueName - The queue name
 * @param {string} [jobId] - Optional job ID
 * @returns {Object} Child logger with worker context
 */
function forWorker(queueName, jobId = null) {
    const context = { queueName };
    if (jobId) context.jobId = jobId;
    return logger.child(context);
}

/**
 * Create a child logger with proposal context.
 *
 * @param {number} caseId - The case ID
 * @param {number} proposalId - The proposal ID
 * @returns {Object} Child logger with proposal context
 */
function forProposal(caseId, proposalId) {
    return logger.child({ caseId, proposalId });
}

/**
 * Log a timing metric.
 *
 * @param {string} operation - The operation being timed
 * @param {number} durationMs - Duration in milliseconds
 * @param {Object} [context] - Additional context
 */
function timing(operation, durationMs, context = {}) {
    logger.info(`${operation} completed`, {
        ...context,
        durationMs,
        timing: true
    });
}

/**
 * Start a timer and return a function to log completion.
 *
 * @param {string} operation - The operation being timed
 * @param {Object} [context] - Additional context
 * @returns {Function} Function to call when operation completes
 */
function startTimer(operation, context = {}) {
    const start = Date.now();

    return (additionalContext = {}) => {
        const durationMs = Date.now() - start;
        timing(operation, durationMs, { ...context, ...additionalContext });
        return durationMs;
    };
}

/**
 * Log an agent run lifecycle event.
 *
 * @param {string} event - Event type (started, completed, failed, skipped)
 * @param {Object} runData - Agent run data
 */
function agentRunEvent(event, runData) {
    const logFn = event === 'failed' ? logger.error.bind(logger) : logger.info.bind(logger);

    logFn(`Agent run ${event}`, {
        caseId: runData.case_id,
        agentRunId: runData.id,
        triggerType: runData.trigger_type,
        status: runData.status,
        lockAcquired: runData.lock_acquired,
        error: runData.error || undefined,
        durationMs: runData.ended_at && runData.started_at
            ? new Date(runData.ended_at) - new Date(runData.started_at)
            : undefined
    });
}

/**
 * Log a proposal lifecycle event.
 *
 * @param {string} event - Event type (created, approved, blocked, executed)
 * @param {Object} proposalData - Proposal data
 */
function proposalEvent(event, proposalData) {
    const logFn = event === 'blocked' ? logger.warn.bind(logger) : logger.info.bind(logger);

    logFn(`Proposal ${event}`, {
        caseId: proposalData.case_id,
        proposalId: proposalData.id,
        actionType: proposalData.action_type,
        status: proposalData.status,
        requiresApproval: proposalData.requires_approval,
        blockedReason: proposalData.blocked_reason || undefined
    });
}

/**
 * Log a policy violation.
 *
 * @param {string} ruleName - The rule that was violated
 * @param {Object} context - Violation context
 */
function policyViolation(ruleName, context) {
    logger.warn(`Policy violation: ${ruleName}`, {
        rule: ruleName,
        action: context.action,
        reason: context.reason,
        caseId: context.caseId,
        proposalId: context.proposalId
    });
}

// Export the logger and helper functions
module.exports = {
    // Main logger instance
    logger,

    // Context-aware child logger creators
    forCase,
    forAgent,
    forWorker,
    forProposal,

    // Timing utilities
    timing,
    startTimer,

    // Structured event loggers
    agentRunEvent,
    proposalEvent,
    policyViolation,

    // Direct access to log methods
    error: logger.error.bind(logger),
    warn: logger.warn.bind(logger),
    info: logger.info.bind(logger),
    http: logger.http.bind(logger),
    debug: logger.debug.bind(logger)
};
