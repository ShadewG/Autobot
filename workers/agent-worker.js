/**
 * Agent Worker
 *
 * BullMQ worker that processes LangGraph agent jobs.
 * Runs the FOIA case graph for inbound messages, scheduled follow-ups, etc.
 *
 * Job types:
 * - invoke-graph: Initial invocation for a trigger
 * - resume-graph: Resume after human decision
 *
 * Reliability features (Deliverable 5):
 * - Uses case locking service for concurrency control
 * - Creates agent_run records for observability
 * - Atomic execution claim for resume operations
 * - Heartbeat updates for stuck detection
 */

const { Worker } = require('bullmq');
const { getConnection } = require('../queues/agent-queue');
const { moveToDeadLetterQueue } = require('../queues/queue-config');
const { invokeFOIACaseGraph, resumeFOIACaseGraph } = require('../langgraph');
const db = require('../services/database');
const caseLockService = require('../services/case-lock-service');
const reaperService = require('../services/reaper-service');
const notionService = require('../services/notion-service');
const discordService = require('../services/discord-service');

// Try to load logger from services (primary) or utils (fallback)
let logger;
try {
  logger = require('../services/logger');
} catch (e) {
  logger = require('../utils/logger');
}

// Worker concurrency - one at a time to avoid race conditions
const WORKER_CONCURRENCY = parseInt(process.env.AGENT_WORKER_CONCURRENCY) || 1;

// Lock duration for long-running AI calls
const LOCK_DURATION = parseInt(process.env.AGENT_LOCK_DURATION) || 300000; // 5 minutes

// Heartbeat interval for stuck detection
const HEARTBEAT_INTERVAL = parseInt(process.env.HEARTBEAT_INTERVAL) || 30000; // 30 seconds

/**
 * Process invoke-graph job
 *
 * Uses case locking service (Deliverable 2) to ensure only one agent
 * processes a case at a time. Creates agent_run records for observability.
 */
async function processInvokeJob(job) {
  const { caseId, triggerType, messageId, scheduledFollowupId, replayRunId, originalRunId } = job.data;
  const log = logger.forAgent ? logger.forAgent(caseId, triggerType) : logger;

  log.info('Processing invoke-graph job', {
    jobId: job.id,
    caseId,
    triggerType,
    isReplay: !!replayRunId
  });

  // Use case lock wrapper (Deliverable 2)
  const lockResult = await caseLockService.withCaseLock(
    caseId,
    triggerType,
    async (runId) => {
      log.info(`Agent run ${runId} acquired lock`);

      // Set lock expiration for reaper detection
      await reaperService.setLockExpiration(runId);

      // Set up heartbeat interval
      const heartbeatInterval = setInterval(async () => {
        await reaperService.updateHeartbeat(runId);
      }, HEARTBEAT_INTERVAL);

      try {
        // Build options based on trigger type
        const options = { runId };
        if (messageId) options.messageId = messageId;
        if (scheduledFollowupId) options.scheduledFollowupId = scheduledFollowupId;

        // Run the graph
        const result = await invokeFOIACaseGraph(caseId, triggerType, options);

        log.info('Graph invocation completed', {
          jobId: job.id,
          caseId,
          status: result.status
        });

        // Handle interrupted state
        if (result.status === 'interrupted') {
          const caseData = await db.getCaseById(caseId);

          // Notify Discord about pending approval
          await discordService.notifyCaseNeedsReview(caseData, {
            proposalId: result.interruptData?.proposalId,
            actionType: result.interruptData?.proposalActionType,
            reason: result.interruptData?.pauseReason
          });

          // Sync to Notion
          await notionService.syncStatusToNotion(caseId);

          return {
            success: true,
            status: 'interrupted',
            proposalId: result.interruptData?.proposalId,
            threadId: result.threadId
          };
        }

        // Handle completed state
        if (result.status === 'completed') {
          await notionService.syncStatusToNotion(caseId);

          return {
            success: true,
            status: 'completed',
            isComplete: result.result?.isComplete,
            actionExecuted: result.result?.actionExecuted,
            threadId: result.threadId
          };
        }

        return { success: true, status: result.status };

      } finally {
        clearInterval(heartbeatInterval);
      }
    },
    { jobId: job.id, messageId, replayRunId, originalRunId }
  );

  // Handle skipped due to lock
  if (lockResult.skipped) {
    log.warn('Job skipped - case is locked by another agent run');

    if (logger.agentRunEvent) {
      logger.agentRunEvent('skipped', {
        case_id: caseId,
        id: lockResult.runId,
        trigger_type: triggerType,
        status: 'skipped_locked'
      });
    }

    return {
      success: false,
      skipped: true,
      reason: lockResult.reason,
      runId: lockResult.runId
    };
  }

  // Handle failure
  if (!lockResult.success) {
    log.error(`Agent run failed: ${lockResult.error}`);

    // Update case status to indicate error
    await db.updateCaseStatus(caseId, 'needs_human_review', {
      requires_human: true,
      pause_reason: `Agent error: ${lockResult.error}`
    });

    throw new Error(lockResult.error);
  }

  return lockResult.result;
}

/**
 * Process resume-graph job
 *
 * Uses atomic execution claim (Deliverable 1) to prevent duplicate resume
 * of an already-executed proposal. Also uses case locking.
 */
async function processResumeJob(job) {
  const { caseId, decision, proposalId } = job.data;
  const log = logger.forAgent ? logger.forAgent(caseId, 'resume') : logger;

  log.info('Processing resume-graph job', {
    jobId: job.id,
    caseId,
    action: decision?.action,
    proposalId
  });

  // If we have a proposalId, check if it's already executed (atomic claim)
  if (proposalId) {
    // Check if proposal is in proposals table
    const proposal = await db.getProposalById(proposalId);

    if (proposal?.status === 'EXECUTED') {
      log.warn('Proposal already executed, skipping resume', {
        proposalId,
        executedAt: proposal.executed_at
      });

      return {
        success: false,
        skipped: true,
        reason: 'Proposal already executed',
        executedAt: proposal.executed_at
      };
    }
  }

  // Use case lock wrapper for resume as well
  const lockResult = await caseLockService.withCaseLock(
    caseId,
    'resume',
    async (runId) => {
      log.info(`Resume run ${runId} acquired lock`);

      // Set lock expiration
      await reaperService.setLockExpiration(runId);

      // Set up heartbeat
      const heartbeatInterval = setInterval(async () => {
        await reaperService.updateHeartbeat(runId);
      }, HEARTBEAT_INTERVAL);

      try {
        // Resume the graph with the human decision
        const result = await resumeFOIACaseGraph(caseId, decision);

        log.info('Graph resume completed', {
          jobId: job.id,
          caseId,
          status: result.status
        });

        // Handle re-interrupted state (another gate hit)
        if (result.status === 'interrupted') {
          const caseData = await db.getCaseById(caseId);

          await discordService.notifyCaseNeedsReview(caseData, {
            proposalId: result.interruptData?.proposalId,
            actionType: result.interruptData?.proposalActionType,
            reason: result.interruptData?.pauseReason
          });

          await notionService.syncStatusToNotion(caseId);

          return {
            success: true,
            status: 'interrupted',
            proposalId: result.interruptData?.proposalId,
            threadId: result.threadId
          };
        }

        // Handle completed state
        if (result.status === 'completed') {
          await notionService.syncStatusToNotion(caseId);

          return {
            success: true,
            status: 'completed',
            isComplete: result.result?.isComplete,
            actionExecuted: result.result?.actionExecuted,
            threadId: result.threadId
          };
        }

        return { success: true, status: result.status };

      } finally {
        clearInterval(heartbeatInterval);
      }
    },
    { jobId: job.id, proposalId, decision }
  );

  // Handle skipped due to lock
  if (lockResult.skipped) {
    log.warn('Resume skipped - case is locked by another agent run');
    return {
      success: false,
      skipped: true,
      reason: lockResult.reason,
      runId: lockResult.runId
    };
  }

  // Handle failure
  if (!lockResult.success) {
    log.error(`Resume failed: ${lockResult.error}`);

    await db.updateCaseStatus(caseId, 'needs_human_review', {
      requires_human: true,
      pause_reason: `Resume error: ${lockResult.error}`
    });

    throw new Error(lockResult.error);
  }

  return lockResult.result;
}

/**
 * Create and start the agent worker
 */
function createAgentWorker() {
  const connection = getConnection();

  const worker = new Worker('agent-queue', async (job) => {
    switch (job.name) {
      case 'invoke-graph':
        return processInvokeJob(job);

      case 'resume-graph':
        return processResumeJob(job);

      default:
        logger.warn('Unknown agent job type', { jobName: job.name, jobId: job.id });
        throw new Error(`Unknown job type: ${job.name}`);
    }
  }, {
    connection,
    concurrency: WORKER_CONCURRENCY,
    lockDuration: LOCK_DURATION,
    lockRenewTime: LOCK_DURATION / 2
  });

  // Event handlers
  worker.on('completed', (job, result) => {
    logger.info('Agent job completed', {
      jobId: job.id,
      jobName: job.name,
      caseId: job.data.caseId,
      status: result?.status
    });
  });

  worker.on('failed', (job, err) => {
    logger.error('Agent job failed', {
      jobId: job?.id,
      jobName: job?.name,
      caseId: job?.data?.caseId,
      error: err.message
    });
  });

  worker.on('error', (err) => {
    logger.error('Agent worker error', { error: err.message });
  });

  worker.on('stalled', (jobId) => {
    logger.warn('Agent job stalled', { jobId });
  });

  logger.info('Agent worker started', {
    concurrency: WORKER_CONCURRENCY,
    lockDuration: LOCK_DURATION
  });

  return worker;
}

// Export for use in server startup
module.exports = {
  createAgentWorker,
  processInvokeJob,
  processResumeJob
};
