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
const {
  invokeFOIACaseGraph,
  resumeFOIACaseGraph,
  invokeInitialRequestGraph,
  resumeInitialRequestGraph
} = require('../langgraph');
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

// Hard timeout for graph execution (fail-safe against infinite loops/hangs)
const GRAPH_EXECUTION_TIMEOUT = parseInt(process.env.GRAPH_EXECUTION_TIMEOUT) || 120000; // 2 minutes

/**
 * Wrap a promise with a timeout
 * Returns the promise result or throws a timeout error
 */
async function withTimeout(promise, timeoutMs, errorMessage) {
  let timeoutId;
  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error(errorMessage || `Operation timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });

  try {
    const result = await Promise.race([promise, timeoutPromise]);
    clearTimeout(timeoutId);
    return result;
  } catch (error) {
    clearTimeout(timeoutId);
    throw error;
  }
}

/**
 * Process invoke-graph job
 *
 * Uses case locking service (Deliverable 2) to ensure only one agent
 * processes a case at a time. Creates agent_run records for observability.
 */
async function processInvokeJob(job) {
  const {
    caseId, triggerType,
    // Support both camelCase and snake_case for E2E compatibility
    messageId, message_id,
    scheduledFollowupId, scheduled_followup_id,
    replayRunId, originalRunId,
    llmStubs, llm_stubs,
    deterministic,
    // Human review resolution fields
    reviewAction, instruction
  } = job.data;
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
        // Support both camelCase and snake_case for E2E compatibility
        const options = { runId };
        const actualMessageId = messageId || message_id;
        const actualFollowupId = scheduledFollowupId || scheduled_followup_id;
        const actualLlmStubs = llmStubs || llm_stubs;

        if (actualMessageId) options.messageId = actualMessageId;
        if (actualFollowupId) options.scheduledFollowupId = actualFollowupId;
        if (actualLlmStubs) options.llmStubs = actualLlmStubs;  // Pass through for E2E testing
        if (reviewAction) options.reviewAction = reviewAction;
        if (instruction) options.reviewInstruction = instruction;

        log.info('Invoking graph with options', {
          caseId,
          triggerType,
          messageId: actualMessageId,
          hasLlmStubs: !!actualLlmStubs
        });

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

// =============================================================================
// PHASE 3: RUN ENGINE JOB HANDLERS
// =============================================================================

/**
 * Process run-initial-request job
 *
 * Phase 3: Invokes Initial Request Graph with run-based auditability.
 * Loads run record, acquires lock, calls graph, updates status.
 */
async function processInitialRequestJob(job) {
  const { runId, caseId, autopilotMode, threadId, llmStubs } = job.data;
  const log = logger.forAgent ? logger.forAgent(caseId, 'initial_request') : logger;

  log.info('Processing run-initial-request job', {
    jobId: job.id,
    runId,
    caseId
  });

  // Update run status to running
  await db.updateAgentRun(runId, { status: 'running', started_at: new Date() });

  try {
    // Invoke Initial Request Graph with timeout fail-safe
    const result = await withTimeout(
      invokeInitialRequestGraph(caseId, {
        runId,
        autopilotMode,
        threadId,
        llmStubs
      }),
      GRAPH_EXECUTION_TIMEOUT,
      `Initial request graph timed out after ${GRAPH_EXECUTION_TIMEOUT}ms for case ${caseId}`
    );

    // Update run based on result
    if (result.status === 'interrupted') {
      await db.updateAgentRun(runId, {
        status: 'paused',
        ended_at: new Date()
      });

      // Notify about pending approval
      const caseData = await db.getCaseById(caseId);
      await discordService.notifyCaseNeedsReview(caseData, {
        proposalId: result.interruptData?.proposalId,
        actionType: result.interruptData?.proposalActionType,
        reason: result.interruptData?.pauseReason
      });

      log.info('Initial request paused for human review', { runId, caseId });

      return {
        success: true,
        status: 'interrupted',
        proposalId: result.interruptData?.proposalId,
        threadId: result.threadId
      };
    }

    if (result.status === 'completed') {
      await db.updateAgentRun(runId, {
        status: 'completed',
        ended_at: new Date()
      });

      await notionService.syncStatusToNotion(caseId);

      log.info('Initial request completed', { runId, caseId });

      return {
        success: true,
        status: 'completed',
        threadId: result.threadId
      };
    }

    return { success: true, status: result.status };

  } catch (error) {
    log.error('Initial request job failed', { runId, caseId, error: error.message });

    await db.updateAgentRun(runId, {
      status: 'failed',
      ended_at: new Date(),
      error_message: error.message
    });

    throw error;
  }
}

/**
 * Process run-inbound-message job
 *
 * Phase 3: Invokes FOIA Case Graph (Inbound Response) with run-based auditability.
 */
async function processInboundMessageJob(job) {
  const { runId, caseId, messageId, autopilotMode, threadId, llmStubs } = job.data;
  const log = logger.forAgent ? logger.forAgent(caseId, 'inbound_message') : logger;

  log.info('Processing run-inbound-message job', {
    jobId: job.id,
    runId,
    caseId,
    messageId
  });

  // Update run status to running
  await db.updateAgentRun(runId, { status: 'running', started_at: new Date() });

  try {
    // Invoke FOIA Case Graph (Inbound Response) with timeout fail-safe
    const result = await withTimeout(
      invokeFOIACaseGraph(caseId, 'INBOUND_MESSAGE', {
        runId,
        messageId,
        autopilotMode,
        threadId,
        llmStubs
      }),
      GRAPH_EXECUTION_TIMEOUT,
      `Graph execution timed out after ${GRAPH_EXECUTION_TIMEOUT}ms for case ${caseId}`
    );

    // Mark message as processed
    await db.markMessageProcessed(messageId, runId, null);

    // Update run based on result
    if (result.status === 'interrupted') {
      const proposalId = result.interruptData?.proposalId;
      await db.updateAgentRun(runId, {
        status: 'paused',
        ended_at: new Date(),
        proposal_id: proposalId  // Link run to proposal
      });

      const caseData = await db.getCaseById(caseId);
      await discordService.notifyCaseNeedsReview(caseData, {
        proposalId,
        actionType: result.interruptData?.proposalActionType,
        reason: result.interruptData?.pauseReason
      });

      log.info('Inbound message processing paused for human review', { runId, caseId, proposalId });

      return {
        success: true,
        status: 'interrupted',
        proposalId,
        threadId: result.threadId
      };
    }

    if (result.status === 'completed') {
      // Get the proposal that was created during this run (if any)
      const proposalId = result.result?.proposalId || null;
      await db.updateAgentRun(runId, {
        status: 'completed',
        ended_at: new Date(),
        proposal_id: proposalId  // Link run to proposal
      });

      await notionService.syncStatusToNotion(caseId);

      log.info('Inbound message processing completed', { runId, caseId, proposalId });

      return {
        success: true,
        status: 'completed',
        proposalId,
        threadId: result.threadId
      };
    }

    // Defensive fallback: never leave run in "running" on unknown statuses
    await db.updateAgentRun(runId, {
      status: 'completed',
      ended_at: new Date(),
      error_message: `Non-standard graph status: ${result.status || 'unknown'}`
    });

    log.warn('Inbound message processing returned non-standard status; forcing completion', {
      runId,
      caseId,
      status: result.status
    });

    return { success: true, status: result.status || 'unknown' };

  } catch (error) {
    log.error('Inbound message job failed', { runId, caseId, error: error.message });

    // Mark message processing as failed
    await db.markMessageProcessed(messageId, runId, error.message);

    await db.updateAgentRun(runId, {
      status: 'failed',
      ended_at: new Date(),
      error_message: error.message
    });

    throw error;
  }
}

/**
 * Process run-followup-trigger job
 *
 * Phase 3: Invokes FOIA Case Graph for scheduled follow-up.
 */
async function processFollowupTriggerJob(job) {
  const { runId, caseId, followupScheduleId, autopilotMode, threadId, llmStubs } = job.data;
  const log = logger.forAgent ? logger.forAgent(caseId, 'followup_trigger') : logger;

  log.info('Processing run-followup-trigger job', {
    jobId: job.id,
    runId,
    caseId,
    followupScheduleId
  });

  // Update run status to running
  await db.updateAgentRun(runId, { status: 'running', started_at: new Date() });

  try {
    // Invoke FOIA Case Graph with followup trigger (with timeout fail-safe)
    const result = await withTimeout(
      invokeFOIACaseGraph(caseId, 'SCHEDULED_FOLLOWUP', {
        runId,
        scheduledFollowupId: followupScheduleId,
        autopilotMode,
        threadId,
        llmStubs
      }),
      GRAPH_EXECUTION_TIMEOUT,
      `Followup graph timed out after ${GRAPH_EXECUTION_TIMEOUT}ms for case ${caseId}`
    );

    // Update run based on result
    if (result.status === 'interrupted') {
      await db.updateAgentRun(runId, {
        status: 'paused',
        ended_at: new Date()
      });

      const caseData = await db.getCaseById(caseId);
      await discordService.notifyCaseNeedsReview(caseData, {
        proposalId: result.interruptData?.proposalId,
        actionType: result.interruptData?.proposalActionType,
        reason: result.interruptData?.pauseReason
      });

      log.info('Followup trigger paused for human review', { runId, caseId });

      return {
        success: true,
        status: 'interrupted',
        proposalId: result.interruptData?.proposalId,
        threadId: result.threadId
      };
    }

    if (result.status === 'completed') {
      await db.updateAgentRun(runId, {
        status: 'completed',
        ended_at: new Date()
      });

      await notionService.syncStatusToNotion(caseId);

      log.info('Followup trigger completed', { runId, caseId });

      return {
        success: true,
        status: 'completed',
        threadId: result.threadId
      };
    }

    return { success: true, status: result.status };

  } catch (error) {
    log.error('Followup trigger job failed', { runId, caseId, error: error.message });

    await db.updateAgentRun(runId, {
      status: 'failed',
      ended_at: new Date(),
      error_message: error.message
    });

    throw error;
  }
}

/**
 * Process resume-run job
 *
 * Phase 3: Resumes graph after human decision with run-based auditability.
 * Supports both Initial Request Graph and FOIA Case Graph.
 */
async function processResumeRunJob(job) {
  const { runId, caseId, humanDecision, isInitialRequest, originalProposalId } = job.data;
  const log = logger.forAgent ? logger.forAgent(caseId, 'resume') : logger;

  log.info('Processing resume-run job', {
    jobId: job.id,
    runId,
    caseId,
    action: humanDecision?.action,
    isInitialRequest
  });

  // GUARD: Check if proposal is already in terminal state (prevents infinite loops)
  if (originalProposalId) {
    const proposal = await db.getProposalById(originalProposalId);
    const terminalStatuses = ['EXECUTED', 'APPROVED', 'DISMISSED', 'CANCELLED', 'FAILED'];

    if (proposal && terminalStatuses.includes(proposal.status)) {
      log.warn('Refusing to resume - proposal already in terminal state', {
        proposalId: originalProposalId,
        proposalStatus: proposal.status,
        runId
      });

      await db.updateAgentRun(runId, {
        status: 'skipped',
        ended_at: new Date(),
        error_message: `Proposal ${originalProposalId} already in terminal state: ${proposal.status}`
      });

      return {
        success: false,
        status: 'skipped',
        reason: 'proposal_already_terminal',
        proposalStatus: proposal.status
      };
    }

    // GUARD: Check if proposal already has a successful execution record
    const existingExecution = await db.query(`
      SELECT id, status FROM executions
      WHERE proposal_id = $1 AND status IN ('SENT', 'QUEUED', 'PENDING_HUMAN')
      LIMIT 1
    `, [originalProposalId]);

    if (existingExecution.rows.length > 0) {
      log.warn('Refusing to resume - proposal already has execution', {
        proposalId: originalProposalId,
        executionId: existingExecution.rows[0].id,
        executionStatus: existingExecution.rows[0].status,
        runId
      });

      await db.updateAgentRun(runId, {
        status: 'skipped',
        ended_at: new Date(),
        error_message: `Proposal ${originalProposalId} already has execution: ${existingExecution.rows[0].id}`
      });

      return {
        success: false,
        status: 'skipped',
        reason: 'execution_already_exists',
        executionId: existingExecution.rows[0].id
      };
    }
  }

  // Update run status to running
  await db.updateAgentRun(runId, { status: 'running', started_at: new Date() });

  try {
    // Choose correct resume function based on graph type
    const resumeFn = isInitialRequest ? resumeInitialRequestGraph : resumeFOIACaseGraph;

    // Resume with timeout fail-safe
    const result = await withTimeout(
      resumeFn(caseId, humanDecision),
      GRAPH_EXECUTION_TIMEOUT,
      `Resume graph timed out after ${GRAPH_EXECUTION_TIMEOUT}ms for case ${caseId}`
    );

    // Update run based on result
    if (result.status === 'interrupted') {
      await db.updateAgentRun(runId, {
        status: 'paused',
        ended_at: new Date()
      });

      const caseData = await db.getCaseById(caseId);
      await discordService.notifyCaseNeedsReview(caseData, {
        proposalId: result.interruptData?.proposalId,
        actionType: result.interruptData?.proposalActionType,
        reason: result.interruptData?.pauseReason
      });

      log.info('Resume hit another gate', { runId, caseId });

      return {
        success: true,
        status: 'interrupted',
        proposalId: result.interruptData?.proposalId,
        threadId: result.threadId
      };
    }

    if (result.status === 'completed') {
      await db.updateAgentRun(runId, {
        status: 'completed',
        ended_at: new Date()
      });

      // Update original proposal status if provided
      if (originalProposalId) {
        await db.updateProposal(originalProposalId, {
          status: humanDecision.action === 'APPROVE' ? 'EXECUTED' : 'ADJUSTED',
          executed_at: new Date()
        });
      }

      await notionService.syncStatusToNotion(caseId);

      log.info('Resume completed', { runId, caseId });

      return {
        success: true,
        status: 'completed',
        threadId: result.threadId
      };
    }

    return { success: true, status: result.status };

  } catch (error) {
    log.error('Resume run job failed', { runId, caseId, error: error.message });

    await db.updateAgentRun(runId, {
      status: 'failed',
      ended_at: new Date(),
      error_message: error.message
    });

    throw error;
  }
}

/**
 * Create and start the agent worker
 */
function createAgentWorker() {
  const connection = getConnection();

  // Handle missing Redis connection gracefully
  if (!connection) {
    logger.warn('Agent worker not started - no Redis connection available');
    console.warn('⚠️ Agent worker not started - no Redis connection');
    return null;
  }

  const worker = new Worker('agent-queue', async (job) => {
    switch (job.name) {
      // Legacy job types (still supported)
      case 'invoke-graph':
        return processInvokeJob(job);

      case 'resume-graph':
        return processResumeJob(job);

      // Phase 3 Run Engine job types
      case 'run-initial-request':
        return processInitialRequestJob(job);

      case 'run-inbound-message':
        return processInboundMessageJob(job);

      case 'run-followup-trigger':
        return processFollowupTriggerJob(job);

      case 'resume-run':
        return processResumeRunJob(job);

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
  // Legacy handlers
  processInvokeJob,
  processResumeJob,
  // Phase 3 Run Engine handlers
  processInitialRequestJob,
  processInboundMessageJob,
  processFollowupTriggerJob,
  processResumeRunJob
};
