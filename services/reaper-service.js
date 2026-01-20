/**
 * Reaper Service
 *
 * Handles cleanup of stuck locks and stale agent runs.
 * Runs as a cron job to ensure system reliability.
 *
 * Features:
 * - Stuck lock reaper: finds advisory locks older than TTL and releases them
 * - Stuck run reaper: finds agent_runs stuck in 'running' status and marks them failed
 * - Audit trail for all reaper actions
 * - Discord notifications for visibility
 */

const { CronJob } = require('cron');
const db = require('./database');
const discordService = require('./discord-service');
const logger = require('./logger');
const caseLockService = require('./case-lock-service');

// Configuration
const LOCK_TTL_MINUTES = parseInt(process.env.LOCK_TTL_MINUTES || '30');
const RUN_STALE_MINUTES = parseInt(process.env.RUN_STALE_MINUTES || '45');
const HEARTBEAT_INTERVAL_SECONDS = parseInt(process.env.HEARTBEAT_INTERVAL_SECONDS || '30');
const REAPER_CRON_SCHEDULE = process.env.REAPER_CRON_SCHEDULE || '*/5 * * * *'; // Every 5 minutes

/**
 * Log a reaper action to the audit table.
 */
async function logReaperAction(reaperType, targetType, targetId, caseId, action, details = {}) {
    try {
        await db.query(`
            INSERT INTO reaper_audit_log (reaper_type, target_type, target_id, case_id, action_taken, details)
            VALUES ($1, $2, $3, $4, $5, $6)
        `, [reaperType, targetType, targetId, caseId, action, JSON.stringify(details)]);
    } catch (error) {
        logger.error('Failed to log reaper action', { error: error.message, reaperType, targetType, targetId });
    }
}

/**
 * Find and release stuck advisory locks.
 * Looks for agent_runs that have been running too long with a lock.
 */
async function reapStuckLocks() {
    const log = logger.forWorker('reaper', 'stuck-locks');
    log.info('Starting stuck lock reaper');

    try {
        // Find runs with locks that have been running too long
        const result = await db.query(`
            SELECT ar.id, ar.case_id, ar.lock_key, ar.started_at, ar.trigger_type,
                   c.case_name, c.agency_name
            FROM agent_runs ar
            LEFT JOIN cases c ON ar.case_id = c.id
            WHERE ar.status = 'running'
              AND ar.lock_acquired = true
              AND ar.started_at < NOW() - INTERVAL '${LOCK_TTL_MINUTES} minutes'
              AND ar.recovery_attempted = false
        `);

        const stuckRuns = result.rows;

        if (stuckRuns.length === 0) {
            log.info('No stuck locks found');
            return { released: 0 };
        }

        log.warn(`Found ${stuckRuns.length} stuck lock(s)`);

        let releasedCount = 0;

        for (const run of stuckRuns) {
            try {
                log.info(`Releasing stuck lock for run ${run.id} (case ${run.case_id})`);

                // Release the advisory lock if we have the key
                if (run.lock_key) {
                    await caseLockService.forceUnlock(run.case_id);
                }

                // Mark the run as failed due to stuck lock
                await db.query(`
                    UPDATE agent_runs
                    SET status = 'failed_stale',
                        ended_at = NOW(),
                        error = 'Recovered by reaper: lock held too long (${LOCK_TTL_MINUTES}+ minutes)',
                        recovery_attempted = true,
                        recovered_by_reaper = true
                    WHERE id = $1
                `, [run.id]);

                // Log the reaper action
                await logReaperAction('lock_reaper', 'agent_run', run.id.toString(), run.case_id, 'released', {
                    lock_key: run.lock_key,
                    started_at: run.started_at,
                    trigger_type: run.trigger_type,
                    stuck_duration_minutes: Math.round((Date.now() - new Date(run.started_at).getTime()) / 60000)
                });

                // Notify Discord
                await discordService.notify({
                    title: '🔓 Stuck Lock Released',
                    description: `Reaper released a stuck lock for **${run.case_name || 'Case #' + run.case_id}**`,
                    color: 0xed8936, // Orange
                    fields: [
                        { name: 'Case ID', value: `#${run.case_id}`, inline: true },
                        { name: 'Run ID', value: `#${run.id}`, inline: true },
                        { name: 'Agency', value: run.agency_name || 'Unknown', inline: true },
                        { name: 'Trigger', value: run.trigger_type, inline: true },
                        { name: 'Stuck Since', value: new Date(run.started_at).toISOString(), inline: false }
                    ]
                });

                releasedCount++;
            } catch (error) {
                log.error(`Failed to release stuck lock for run ${run.id}`, { error: error.message });
            }
        }

        log.info(`Released ${releasedCount} stuck lock(s)`);
        return { released: releasedCount };
    } catch (error) {
        log.error('Stuck lock reaper failed', { error: error.message });
        throw error;
    }
}

/**
 * Find and mark stale agent runs as failed.
 * Different from stuck locks - these are runs that may not have acquired a lock
 * but have been in 'running' status too long (worker crash, etc.)
 */
async function reapStaleRuns() {
    const log = logger.forWorker('reaper', 'stale-runs');
    log.info('Starting stale run reaper');

    try {
        // Find runs that have been running too long without heartbeat
        const result = await db.query(`
            SELECT ar.id, ar.case_id, ar.lock_key, ar.lock_acquired, ar.started_at,
                   ar.heartbeat_at, ar.trigger_type, c.case_name, c.agency_name
            FROM agent_runs ar
            LEFT JOIN cases c ON ar.case_id = c.id
            WHERE ar.status = 'running'
              AND ar.started_at < NOW() - INTERVAL '${RUN_STALE_MINUTES} minutes'
              AND ar.recovery_attempted = false
        `);

        const staleRuns = result.rows;

        if (staleRuns.length === 0) {
            log.info('No stale runs found');
            return { marked: 0 };
        }

        log.warn(`Found ${staleRuns.length} stale run(s)`);

        let markedCount = 0;

        for (const run of staleRuns) {
            try {
                log.info(`Marking stale run ${run.id} (case ${run.case_id}) as failed`);

                // Release lock if held
                if (run.lock_acquired && run.lock_key) {
                    await caseLockService.forceUnlock(run.case_id);
                }

                // Mark the run as failed
                await db.query(`
                    UPDATE agent_runs
                    SET status = 'failed_stale',
                        ended_at = NOW(),
                        error = 'Recovered by reaper: run stale for ${RUN_STALE_MINUTES}+ minutes (possible worker crash)',
                        recovery_attempted = true,
                        recovered_by_reaper = true
                    WHERE id = $1
                `, [run.id]);

                // Log the reaper action
                await logReaperAction('run_reaper', 'agent_run', run.id.toString(), run.case_id, 'marked_stale', {
                    lock_acquired: run.lock_acquired,
                    lock_key: run.lock_key,
                    started_at: run.started_at,
                    heartbeat_at: run.heartbeat_at,
                    trigger_type: run.trigger_type,
                    stale_duration_minutes: Math.round((Date.now() - new Date(run.started_at).getTime()) / 60000)
                });

                // Notify Discord
                await discordService.notify({
                    title: '⚠️ Stale Run Recovered',
                    description: `Reaper marked a stale run as failed for **${run.case_name || 'Case #' + run.case_id}**`,
                    color: 0xf56565, // Red
                    fields: [
                        { name: 'Case ID', value: `#${run.case_id}`, inline: true },
                        { name: 'Run ID', value: `#${run.id}`, inline: true },
                        { name: 'Agency', value: run.agency_name || 'Unknown', inline: true },
                        { name: 'Trigger', value: run.trigger_type, inline: true },
                        { name: 'Had Lock', value: run.lock_acquired ? 'Yes' : 'No', inline: true },
                        { name: 'Started At', value: new Date(run.started_at).toISOString(), inline: false }
                    ]
                });

                markedCount++;
            } catch (error) {
                log.error(`Failed to mark stale run ${run.id}`, { error: error.message });
            }
        }

        log.info(`Marked ${markedCount} stale run(s) as failed`);
        return { marked: markedCount };
    } catch (error) {
        log.error('Stale run reaper failed', { error: error.message });
        throw error;
    }
}

/**
 * Update heartbeat for a running agent run.
 * Call this periodically during long-running operations.
 */
async function updateHeartbeat(runId) {
    try {
        await db.query(`
            UPDATE agent_runs
            SET heartbeat_at = NOW()
            WHERE id = $1 AND status = 'running'
        `, [runId]);
    } catch (error) {
        logger.error('Failed to update heartbeat', { runId, error: error.message });
    }
}

/**
 * Set lock expiration time when acquiring a lock.
 */
async function setLockExpiration(runId, ttlMinutes = LOCK_TTL_MINUTES) {
    try {
        await db.query(`
            UPDATE agent_runs
            SET lock_expires_at = NOW() + INTERVAL '${ttlMinutes} minutes',
                heartbeat_at = NOW()
            WHERE id = $1
        `, [runId]);
    } catch (error) {
        logger.error('Failed to set lock expiration', { runId, error: error.message });
    }
}

/**
 * Run all reapers.
 */
async function runReapers() {
    const log = logger.forWorker('reaper', 'all');
    log.info('Running all reapers');

    const results = {
        locks: { released: 0 },
        runs: { marked: 0 },
        errors: []
    };

    try {
        results.locks = await reapStuckLocks();
    } catch (error) {
        results.errors.push({ reaper: 'locks', error: error.message });
    }

    try {
        results.runs = await reapStaleRuns();
    } catch (error) {
        results.errors.push({ reaper: 'runs', error: error.message });
    }

    log.info('Reaper run complete', results);
    return results;
}

/**
 * Start the reaper cron job.
 */
let reaperJob = null;

function startReaperCron() {
    if (reaperJob) {
        logger.info('Reaper cron already running');
        return;
    }

    logger.info(`Starting reaper cron with schedule: ${REAPER_CRON_SCHEDULE}`);

    reaperJob = new CronJob(REAPER_CRON_SCHEDULE, async () => {
        try {
            await runReapers();
        } catch (error) {
            logger.error('Reaper cron job failed', { error: error.message });
        }
    }, null, true, 'America/New_York');

    logger.info('Reaper cron started');
}

function stopReaperCron() {
    if (reaperJob) {
        reaperJob.stop();
        reaperJob = null;
        logger.info('Reaper cron stopped');
    }
}

/**
 * Get reaper status and recent audit log.
 */
async function getReaperStatus(limit = 20) {
    const result = await db.query(`
        SELECT * FROM reaper_audit_log
        ORDER BY created_at DESC
        LIMIT $1
    `, [limit]);

    return {
        isRunning: !!reaperJob,
        cronSchedule: REAPER_CRON_SCHEDULE,
        lockTtlMinutes: LOCK_TTL_MINUTES,
        runStaleMinutes: RUN_STALE_MINUTES,
        recentActions: result.rows
    };
}

module.exports = {
    reapStuckLocks,
    reapStaleRuns,
    runReapers,
    updateHeartbeat,
    setLockExpiration,
    startReaperCron,
    stopReaperCron,
    getReaperStatus,
    logReaperAction,
    LOCK_TTL_MINUTES,
    RUN_STALE_MINUTES,
    HEARTBEAT_INTERVAL_SECONDS
};
