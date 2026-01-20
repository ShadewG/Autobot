/**
 * Case Lock Service
 *
 * Provides case-level concurrency control using PostgreSQL advisory locks.
 * Ensures only one agent run can process a case at a time.
 *
 * Deliverable 2: Case-Level Concurrency Lock
 */

const db = require('./database');

/**
 * Generate a consistent lock key from a case ID.
 * Advisory locks use bigint, so we use the case ID directly.
 * We add a namespace prefix to avoid conflicts with other lock uses.
 */
function getLockKey(caseId) {
    // Namespace: 1 for case locks
    // This creates a unique lock key: namespace * 1000000 + caseId
    const namespace = 1;
    return namespace * 1000000 + parseInt(caseId, 10);
}

/**
 * Try to acquire a PostgreSQL advisory lock for a case.
 * Non-blocking - returns immediately with success or failure.
 *
 * @param {number} caseId - The case ID to lock
 * @returns {Promise<{acquired: boolean, lockKey: number}>}
 */
async function tryAcquireLock(caseId) {
    const lockKey = getLockKey(caseId);

    try {
        // pg_try_advisory_lock returns true if lock acquired, false otherwise
        const result = await db.query(
            'SELECT pg_try_advisory_lock($1) as acquired',
            [lockKey]
        );

        const acquired = result.rows[0]?.acquired === true;

        if (acquired) {
            console.log(`🔒 Lock acquired for case ${caseId} (key: ${lockKey})`);
        } else {
            console.log(`⏳ Lock NOT acquired for case ${caseId} - already held by another process`);
        }

        return { acquired, lockKey };
    } catch (error) {
        console.error(`❌ Error acquiring lock for case ${caseId}:`, error.message);
        return { acquired: false, lockKey, error: error.message };
    }
}

/**
 * Release a PostgreSQL advisory lock.
 *
 * @param {number} lockKey - The lock key to release
 * @returns {Promise<boolean>}
 */
async function releaseLock(lockKey) {
    try {
        await db.query('SELECT pg_advisory_unlock($1)', [lockKey]);
        console.log(`🔓 Lock released (key: ${lockKey})`);
        return true;
    } catch (error) {
        console.error(`❌ Error releasing lock (key: ${lockKey}):`, error.message);
        return false;
    }
}

/**
 * Execute an operation with a case lock.
 * Handles the full lifecycle:
 * 1. Creates agent_run record
 * 2. Tries to acquire lock
 * 3. If locked: marks run as skipped_locked, returns early
 * 4. If acquired: executes operation, releases lock
 *
 * @param {number} caseId - The case ID to lock
 * @param {string} triggerType - Type of trigger (inbound, cron_followup, resume, manual)
 * @param {Function} operation - Async function to execute if lock acquired
 * @param {Object} [metadata={}] - Additional metadata for the agent run
 * @returns {Promise<{success: boolean, skipped: boolean, result?: any, runId: number}>}
 */
async function withCaseLock(caseId, triggerType, operation, metadata = {}) {
    // Create agent run record first
    const agentRun = await db.createAgentRun(caseId, triggerType, {
        ...metadata,
        started_at: new Date().toISOString()
    });

    const runId = agentRun.id;

    // Try to acquire lock
    const { acquired, lockKey } = await tryAcquireLock(caseId);

    if (!acquired) {
        // Lock not acquired - another agent is processing this case
        await db.skipAgentRun(runId, 'Case locked by another agent run');
        console.log(`⏭️  Skipping agent run ${runId} for case ${caseId} - case is locked`);

        return {
            success: false,
            skipped: true,
            reason: 'Case locked by another agent run',
            runId
        };
    }

    // Update run to show lock was acquired
    await db.updateAgentRun(runId, {
        lock_acquired: true,
        lock_key: lockKey
    });

    try {
        // Execute the operation
        const result = await operation(runId);

        // Mark run as completed
        const proposalId = result?.proposalId || null;
        await db.completeAgentRun(runId, proposalId);

        return {
            success: true,
            skipped: false,
            result,
            runId
        };
    } catch (error) {
        // Mark run as failed
        await db.completeAgentRun(runId, null, error.message);

        console.error(`❌ Agent run ${runId} failed:`, error.message);

        return {
            success: false,
            skipped: false,
            error: error.message,
            runId
        };
    } finally {
        // Always release the lock
        await releaseLock(lockKey);
    }
}

/**
 * Check if a case is currently locked.
 * Useful for UI to show lock status.
 *
 * @param {number} caseId - The case ID to check
 * @returns {Promise<boolean>}
 */
async function isLocked(caseId) {
    const lockKey = getLockKey(caseId);

    try {
        // Try to acquire lock, then immediately release if successful
        const result = await db.query(
            'SELECT pg_try_advisory_lock($1) as acquired',
            [lockKey]
        );

        const acquired = result.rows[0]?.acquired === true;

        if (acquired) {
            // We got it, release it immediately
            await db.query('SELECT pg_advisory_unlock($1)', [lockKey]);
            return false; // Not locked
        }

        return true; // Locked by someone else
    } catch (error) {
        console.error(`Error checking lock status for case ${caseId}:`, error.message);
        return false; // Assume not locked on error
    }
}

/**
 * Force release all locks for a case.
 * Use with caution - only for cleanup after crashes.
 *
 * @param {number} caseId - The case ID to unlock
 * @returns {Promise<boolean>}
 */
async function forceUnlock(caseId) {
    const lockKey = getLockKey(caseId);

    try {
        // pg_advisory_unlock_all releases all session locks
        // For a specific lock, we just try to unlock it
        const result = await db.query(
            'SELECT pg_advisory_unlock($1) as released',
            [lockKey]
        );

        console.log(`⚠️  Force unlock attempted for case ${caseId} (key: ${lockKey})`);
        return result.rows[0]?.released === true;
    } catch (error) {
        console.error(`Error force unlocking case ${caseId}:`, error.message);
        return false;
    }
}

module.exports = {
    tryAcquireLock,
    releaseLock,
    withCaseLock,
    isLocked,
    forceUnlock,
    getLockKey
};
