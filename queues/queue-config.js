/**
 * BullMQ Queue Configuration
 *
 * Standardized queue options for reliability:
 * - Retry policies with exponential backoff
 * - Dead letter queue (DLQ) pattern
 * - Job hygiene (removeOnComplete, removeOnFail)
 * - Idempotent job ID generation
 */

const Redis = require('ioredis');
const { Queue, Worker } = require('bullmq');
const db = require('../services/database');
const discordService = require('../services/discord-service');
const logger = require('../services/logger');

// Redis connection (shared)
let redisConnection = null;

function getRedisConnection() {
    if (!redisConnection) {
        if (!process.env.REDIS_URL) {
            console.error('❌ REDIS_URL environment variable is not set!');
            console.error('   Queue functionality will be disabled.');
            // Return a mock connection that will fail gracefully
            return null;
        }

        redisConnection = new Redis(process.env.REDIS_URL, {
            maxRetriesPerRequest: null,
            retryStrategy(times) {
                if (times > 3) {
                    console.error('❌ Redis connection failed after 3 attempts');
                    return null;
                }
                return Math.min(times * 50, 2000);
            }
        });

        redisConnection.on('connect', () => {
            console.log('✅ Redis connected successfully');
        });

        redisConnection.on('error', (err) => {
            console.error('❌ Redis connection error:', err.message);
        });
    }

    return redisConnection;
}

// ============================================================================
// STANDARDIZED QUEUE OPTIONS
// ============================================================================

/**
 * Default job options for different queue types.
 * These ensure consistent retry behavior across all queues.
 */
const JOB_OPTIONS = {
    // Email sending - high reliability needed
    email: {
        attempts: 5,
        backoff: {
            type: 'exponential',
            delay: 5000 // Start with 5s, then 10s, 20s, 40s, 80s
        },
        removeOnComplete: {
            count: 100,  // Keep last 100 completed
            age: 86400   // Or 24 hours
        },
        removeOnFail: {
            count: 500,  // Keep more failed for debugging
            age: 604800  // 7 days
        }
    },

    // Analysis - can tolerate some retries
    analysis: {
        attempts: 3,
        backoff: {
            type: 'exponential',
            delay: 10000 // 10s, 20s, 40s
        },
        removeOnComplete: {
            count: 50,
            age: 43200 // 12 hours
        },
        removeOnFail: {
            count: 200,
            age: 259200 // 3 days
        }
    },

    // Generation - AI can be slow, longer delays
    generation: {
        attempts: 3,
        backoff: {
            type: 'exponential',
            delay: 15000 // 15s, 30s, 60s
        },
        removeOnComplete: {
            count: 50,
            age: 43200
        },
        removeOnFail: {
            count: 200,
            age: 259200
        }
    },

    // Portal operations - can be slow and flaky
    portal: {
        attempts: 2, // Fewer retries - portals can be stateful
        backoff: {
            type: 'fixed',
            delay: 60000 // 1 minute between retries
        },
        removeOnComplete: {
            count: 50,
            age: 43200
        },
        removeOnFail: {
            count: 200,
            age: 259200
        }
    },

    // Agent runs - should not retry automatically (stateful)
    agent: {
        attempts: 1, // No automatic retries - agent should handle internally
        removeOnComplete: {
            count: 100,
            age: 86400
        },
        removeOnFail: {
            count: 500,
            age: 604800
        }
    }
};

/**
 * Get standardized job options for a queue type.
 */
function getJobOptions(queueType) {
    return JOB_OPTIONS[queueType] || JOB_OPTIONS.analysis;
}

// ============================================================================
// DEAD LETTER QUEUE (DLQ) PATTERN
// ============================================================================

/**
 * Move a failed job to the dead letter queue.
 * Called when a job exhausts all retries.
 */
async function moveToDeadLetterQueue(queueName, job, error) {
    const log = logger.forWorker(queueName, job.id);
    log.error(`Moving job to DLQ after ${job.attemptsMade} attempts`, {
        error: error.message,
        jobName: job.name,
        caseId: job.data.caseId
    });

    try {
        // Insert into DLQ table
        await db.query(`
            INSERT INTO dead_letter_queue (
                queue_name, job_id, job_name, job_data,
                error_message, error_stack, attempt_count,
                original_job_id, case_id
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
            RETURNING id
        `, [
            queueName,
            job.id,
            job.name,
            JSON.stringify(job.data),
            error.message,
            error.stack,
            job.attemptsMade,
            job.opts?.jobId || job.id,
            job.data.caseId || null
        ]);

        // Update agent_run if applicable
        if (job.data.runId) {
            await db.query(`
                UPDATE agent_runs
                SET status = 'failed',
                    ended_at = NOW(),
                    error = $2
                WHERE id = $1
            `, [job.data.runId, `DLQ: ${error.message}`]);
        }

        // Notify Discord
        await discordService.notify({
            title: '💀 Job Moved to Dead Letter Queue',
            description: `Job **${job.name}** failed after ${job.attemptsMade} attempts`,
            color: 0xf56565, // Red
            fields: [
                { name: 'Queue', value: queueName, inline: true },
                { name: 'Job ID', value: job.id, inline: true },
                { name: 'Case ID', value: job.data.caseId ? `#${job.data.caseId}` : 'N/A', inline: true },
                { name: 'Error', value: error.message.substring(0, 200), inline: false }
            ]
        });

        log.info('Job moved to DLQ');
    } catch (dlqError) {
        log.error('Failed to move job to DLQ', { error: dlqError.message });
    }
}

/**
 * Create a worker with standardized error handling and DLQ support.
 */
function createWorkerWithDLQ(queueName, processor, options = {}) {
    const queueType = options.queueType || 'analysis';
    const jobOptions = getJobOptions(queueType);
    const connection = getRedisConnection();

    const worker = new Worker(queueName, processor, {
        connection,
        ...options.workerOptions
    });

    // Handle job failures
    worker.on('failed', async (job, error) => {
        const log = logger.forWorker(queueName, job.id);
        log.error(`Job failed (attempt ${job.attemptsMade}/${jobOptions.attempts})`, {
            error: error.message,
            caseId: job.data.caseId
        });

        // If this was the final attempt, move to DLQ
        if (job.attemptsMade >= jobOptions.attempts) {
            await moveToDeadLetterQueue(queueName, job, error);
        }
    });

    worker.on('completed', (job) => {
        const log = logger.forWorker(queueName, job.id);
        log.info('Job completed', { caseId: job.data.caseId });
    });

    worker.on('error', (error) => {
        logger.error(`Worker error in ${queueName}`, { error: error.message });
    });

    return worker;
}

/**
 * Create a queue with standardized options.
 */
function createQueue(queueName, queueType = 'analysis') {
    const connection = getRedisConnection();
    const jobOptions = getJobOptions(queueType);

    const queue = new Queue(queueName, {
        connection,
        defaultJobOptions: jobOptions
    });

    return queue;
}

// ============================================================================
// IDEMPOTENT JOB ID GENERATION
// ============================================================================

/**
 * Generate an idempotent job ID for email sending.
 * This prevents duplicate emails when the same job is queued multiple times.
 *
 * Format: {type}-{caseId}-{proposalId|executionKey}-{hash}
 */
function generateEmailJobId(data) {
    const { type, caseId, proposalId, executionKey, originalMessageId } = data;

    if (executionKey) {
        // Use execution key directly - already unique
        return executionKey;
    }

    if (proposalId) {
        // Use proposal ID for uniqueness
        return `email-${type}-${caseId}-proposal-${proposalId}`;
    }

    if (originalMessageId) {
        // Use message ID for reply deduplication
        const hash = Buffer.from(originalMessageId).toString('base64').substring(0, 12);
        return `email-${type}-${caseId}-reply-${hash}`;
    }

    // Fallback: timestamp-based (allows duplicates but rare)
    return `email-${type}-${caseId}-${Date.now()}`;
}

/**
 * Generate an idempotent job ID for agent runs.
 */
function generateAgentJobId(caseId, triggerType, triggerData = {}) {
    const { messageId, proposalId } = triggerData;

    if (proposalId) {
        return `agent-${caseId}-proposal-${proposalId}`;
    }

    if (messageId) {
        return `agent-${caseId}-msg-${messageId}`;
    }

    // For manual triggers, allow multiple
    return `agent-${caseId}-${triggerType}-${Date.now()}`;
}

// ============================================================================
// DLQ MANAGEMENT
// ============================================================================

/**
 * Get items from the dead letter queue.
 */
async function getDLQItems(options = {}) {
    const { queueName, resolution = 'pending', limit = 50, offset = 0 } = options;

    let query = `
        SELECT dlq.*, c.case_name, c.agency_name
        FROM dead_letter_queue dlq
        LEFT JOIN cases c ON dlq.case_id = c.id
        WHERE 1=1
    `;
    const params = [];

    if (queueName) {
        params.push(queueName);
        query += ` AND dlq.queue_name = $${params.length}`;
    }

    if (resolution) {
        params.push(resolution);
        query += ` AND dlq.resolution = $${params.length}`;
    }

    params.push(limit);
    params.push(offset);
    query += ` ORDER BY dlq.created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`;

    const result = await db.query(query, params);
    return result.rows;
}

/**
 * Retry a job from the dead letter queue.
 */
async function retryDLQItem(dlqId, queueName) {
    const log = logger.forWorker('dlq', dlqId.toString());

    // Get the DLQ item
    const result = await db.query(
        'SELECT * FROM dead_letter_queue WHERE id = $1',
        [dlqId]
    );

    if (result.rows.length === 0) {
        throw new Error(`DLQ item ${dlqId} not found`);
    }

    const item = result.rows[0];
    const jobData = typeof item.job_data === 'string' ? JSON.parse(item.job_data) : item.job_data;

    log.info('Retrying DLQ item', { originalJobId: item.original_job_id });

    // Get the queue and add a new job
    const queue = createQueue(item.queue_name);
    const newJobId = `retry-${item.original_job_id}-${Date.now()}`;

    await queue.add(item.job_name || 'retry', jobData, {
        jobId: newJobId
    });

    // Update DLQ status
    await db.query(`
        UPDATE dead_letter_queue
        SET resolution = 'retried',
            processed_at = NOW(),
            resolution_notes = $2
        WHERE id = $1
    `, [dlqId, `Retried as job ${newJobId}`]);

    log.info('DLQ item retried', { newJobId });
    return { newJobId };
}

/**
 * Discard a DLQ item (mark as not retryable).
 */
async function discardDLQItem(dlqId, reason) {
    await db.query(`
        UPDATE dead_letter_queue
        SET resolution = 'discarded',
            processed_at = NOW(),
            resolution_notes = $2
        WHERE id = $1
    `, [dlqId, reason]);
}

module.exports = {
    // Connection
    getRedisConnection,

    // Queue/Worker creation
    createQueue,
    createWorkerWithDLQ,

    // Job options
    getJobOptions,
    JOB_OPTIONS,

    // Idempotent job IDs
    generateEmailJobId,
    generateAgentJobId,

    // DLQ management
    moveToDeadLetterQueue,
    getDLQItems,
    retryDLQItem,
    discardDLQItem
};
