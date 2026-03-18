/**
 * AI quota retry service stub.
 * Schedules retries when AI API credit limits are hit.
 */

async function scheduleAICreditRetry({ taskId, payload, error, delayMs = 60000 } = {}) {
    const logger = require('./logger');
    logger.warn('AI credit retry requested (stub)', { taskId, delayMs, error: error?.message || error });
    return null;
}

module.exports = { scheduleAICreditRetry };
