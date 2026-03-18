const https = require('https');

/**
 * Discord Error Notifier
 * Sends unhandled errors and BullMQ job failures to a Discord channel.
 * Uses the raw Discord REST API (no discord.js dependency required).
 *
 * Deduplication: identical error messages are suppressed for 5 minutes.
 *
 * Usage:
 *   const errorNotifier = require('./services/discord-error-notifier');
 *   errorNotifier.init();                          // hooks process-level handlers
 *   errorNotifier.hookWorker(worker, 'email');      // hooks a BullMQ worker
 */

const BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const CHANNEL_ID = process.env.DISCORD_CHANNEL_ERRORS;

// Deduplication: map of errorKey -> timestamp (ms)
const recentErrors = new Map();
const DEDUP_WINDOW_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Generate a dedup key from error message (first 200 chars)
 */
function dedupKey(message) {
    return String(message || 'unknown').slice(0, 200);
}

/**
 * Check if this error was already sent recently
 */
function isDuplicate(key) {
    const lastSent = recentErrors.get(key);
    if (lastSent && Date.now() - lastSent < DEDUP_WINDOW_MS) {
        return true;
    }
    return false;
}

/**
 * Mark this error as sent
 */
function markSent(key) {
    recentErrors.set(key, Date.now());
    // Prune old entries periodically to prevent memory leak
    if (recentErrors.size > 500) {
        const cutoff = Date.now() - DEDUP_WINDOW_MS;
        for (const [k, v] of recentErrors) {
            if (v < cutoff) recentErrors.delete(k);
        }
    }
}

/**
 * Send a message to the Discord error channel via REST API
 */
function sendToDiscord(content) {
    if (!BOT_TOKEN || !CHANNEL_ID) return;

    const payload = JSON.stringify({ content });
    const url = new URL(`https://discord.com/api/v10/channels/${CHANNEL_ID}/messages`);

    const options = {
        hostname: url.hostname,
        path: url.pathname,
        method: 'POST',
        headers: {
            'Authorization': `Bot ${BOT_TOKEN}`,
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(payload),
        },
    };

    const req = https.request(options, (res) => {
        // Drain the response
        res.on('data', () => {});
        res.on('end', () => {
            if (res.statusCode < 200 || res.statusCode >= 300) {
                console.error(`[discord-error-notifier] Failed to send (HTTP ${res.statusCode})`);
            }
        });
    });

    req.on('error', (err) => {
        console.error(`[discord-error-notifier] Request error: ${err.message}`);
    });

    req.write(payload);
    req.end();
}

/**
 * Format and send an error notification
 * @param {Error|string} error - The error object or message
 * @param {object} context - Optional context (caseId, worker, jobId, etc.)
 */
function notify(error, context = {}) {
    if (!BOT_TOKEN || !CHANNEL_ID) return;

    const errMsg = error instanceof Error
        ? `${error.message}\n${error.stack || ''}`
        : String(error || 'Unknown error');

    const key = dedupKey(errMsg);
    if (isDuplicate(key)) return;
    markSent(key);

    // Truncate to 1800 chars for Discord message limits
    const truncated = errMsg.length > 1800 ? errMsg.slice(0, 1800) + '\n...truncated' : errMsg;
    const timestamp = new Date().toISOString();

    let caseInfo = '';
    if (context.caseId || context.case_id) {
        caseInfo = `\nCase: #${context.caseId || context.case_id}`;
    }

    let workerInfo = '';
    if (context.worker) {
        workerInfo = `\nWorker: ${context.worker}`;
    }
    if (context.jobId || context.job_id) {
        workerInfo += ` | Job: ${context.jobId || context.job_id}`;
    }

    const message = `\u274C **Autobot Error**${caseInfo}${workerInfo}\n\`\`\`\n${truncated}\n\`\`\`\nTime: ${timestamp}`;

    sendToDiscord(message);
}

/**
 * Hook into a BullMQ Worker's error and failed events
 * @param {Worker} worker - BullMQ Worker instance
 * @param {string} name - Descriptive name for the worker
 */
function hookWorker(worker, name) {
    if (!worker) return;

    worker.on('failed', (job, err) => {
        const caseId = job?.data?.case_id || job?.data?.caseId || null;
        notify(err, {
            worker: name,
            jobId: job?.id,
            caseId,
        });
    });

    worker.on('error', (err) => {
        notify(err, { worker: name });
    });
}

/**
 * Install global unhandled error handlers
 */
function init() {
    if (!BOT_TOKEN || !CHANNEL_ID) {
        console.log('[discord-error-notifier] Disabled (DISCORD_BOT_TOKEN or DISCORD_CHANNEL_ERRORS not set)');
        return;
    }

    console.log('[discord-error-notifier] Initialized — errors will be sent to Discord');

    process.on('uncaughtException', (err) => {
        notify(err, { source: 'uncaughtException' });
        // Log locally too — don't swallow the error
        console.error('Uncaught Exception:', err);
    });

    process.on('unhandledRejection', (reason) => {
        const err = reason instanceof Error ? reason : new Error(String(reason));
        notify(err, { source: 'unhandledRejection' });
        console.error('Unhandled Rejection:', reason);
    });
}

module.exports = {
    init,
    notify,
    hookWorker,
    sendToDiscord,
};
