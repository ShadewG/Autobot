/**
 * Agent Queue
 *
 * Separate BullMQ queue for LangGraph agent jobs.
 * P1 FIX #9: Keep agent work separate from email sending.
 *
 * Jobs:
 * - invoke-graph: Run LangGraph for a case (new inbound, scheduled, etc.)
 * - resume-graph: Resume interrupted graph with human decision
 *
 * Reliability features (Deliverable 5):
 * - Uses shared Redis connection and standardized job options
 * - Integrates with case locking service
 * - Creates agent_run records for observability
 */

const { Queue, Worker } = require('bullmq');
const {
  getRedisConnection,
  getJobOptions,
  generateAgentJobId,
  moveToDeadLetterQueue
} = require('./queue-config');

// Try to load logger from services (primary) or utils (fallback)
let logger;
try {
  logger = require('../services/logger');
} catch (e) {
  logger = require('../utils/logger');
}

// Get shared Redis connection
const connection = getRedisConnection();

// Get standardized job options for agent queue
const agentJobOptions = getJobOptions('agent');

// Create the agent queue with standardized options
const agentQueue = new Queue('agent-queue', {
  connection,
  defaultJobOptions: agentJobOptions
});

/**
 * Add a job to invoke the LangGraph for a case
 *
 * @param {number} caseId - The case ID
 * @param {string} triggerType - 'INBOUND_MESSAGE' | 'SCHEDULED_FOLLOWUP' | 'MANUAL'
 * @param {object} options - Additional options (messageId, proposalId, etc.)
 */
async function enqueueAgentJob(caseId, triggerType, options = {}) {
  // Generate idempotent job ID to prevent duplicate processing
  const jobId = generateAgentJobId(caseId, triggerType, options);

  const job = await agentQueue.add('invoke-graph', {
    caseId,
    triggerType,
    ...options
  }, {
    jobId,
    // Override defaults for agent jobs (no auto-retry - stateful)
    attempts: 1,
    removeOnComplete: {
      count: 100,
      age: 86400
    },
    removeOnFail: {
      count: 200,
      age: 604800
    }
  });

  logger.info('Agent job enqueued', { jobId: job.id, caseId, triggerType });
  return job;
}

/**
 * Add a job to resume an interrupted graph
 *
 * Reliability: Uses atomic execution claim to prevent duplicate resume
 * of an already-executed proposal.
 *
 * @param {number} caseId - The case ID
 * @param {object} decision - Human decision { action, proposalId, adjustments, reason }
 */
async function enqueueResumeJob(caseId, decision) {
  // For resume jobs, use proposalId for idempotency
  const jobId = decision.proposalId
    ? `resume:${caseId}:proposal-${decision.proposalId}`
    : `resume:${caseId}:${Date.now()}`;

  const job = await agentQueue.add('resume-graph', {
    caseId,
    decision,
    // Include proposal ID for atomic claim checking in worker
    proposalId: decision.proposalId
  }, {
    jobId,
    removeOnComplete: {
      count: 100,
      age: 86400
    },
    removeOnFail: {
      count: 100,
      age: 604800
    },
    attempts: 1,  // No auto-retry for resume (human decision already made)
  });

  logger.info('Resume job enqueued', { jobId: job.id, caseId, action: decision.action, proposalId: decision.proposalId });
  return job;
}

/**
 * Get queue statistics
 */
async function getQueueStats() {
  const [waiting, active, completed, failed, delayed] = await Promise.all([
    agentQueue.getWaitingCount(),
    agentQueue.getActiveCount(),
    agentQueue.getCompletedCount(),
    agentQueue.getFailedCount(),
    agentQueue.getDelayedCount()
  ]);

  return { waiting, active, completed, failed, delayed };
}

/**
 * Get the queue instance (for worker setup)
 */
function getAgentQueue() {
  return agentQueue;
}

/**
 * Get the Redis connection (for worker setup)
 */
function getConnection() {
  return connection;
}

module.exports = {
  agentQueue,
  getAgentQueue,
  getConnection,
  enqueueAgentJob,
  enqueueResumeJob,
  getQueueStats
};
