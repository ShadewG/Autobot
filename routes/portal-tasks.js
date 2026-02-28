/**
 * Portal Tasks Routes
 *
 * Phase 4: API for managing portal submission tasks.
 *
 * Portal cases require manual human submission. These routes allow:
 * - Viewing pending portal tasks
 * - Claiming a task (mark as in progress)
 * - Completing a task with confirmation details
 * - Cancelling a task
 */

const express = require('express');
const router = express.Router();
const {
  getPendingPortalTasks,
  getPortalTaskById,
  updatePortalTask,
  portalExecutor
} = require('../services/executor-adapter');
const db = require('../services/database');
const logger = require('../services/logger');
const { transitionCaseRuntime, CaseLockContention } = require('../services/case-runtime');

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function transitionCaseRuntimeWithRetry(caseId, event, context = {}, options = {}) {
  const attempts = Number.isFinite(options.attempts) ? options.attempts : 4;
  const baseDelayMs = Number.isFinite(options.baseDelayMs) ? options.baseDelayMs : 150;
  let lastError = null;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await transitionCaseRuntime(caseId, event, context);
    } catch (error) {
      lastError = error;
      const isLockError = error instanceof CaseLockContention || error?.name === 'CaseLockContention';
      if (!isLockError || attempt === attempts) {
        throw error;
      }
      await sleep(baseDelayMs * attempt);
    }
  }

  throw lastError || new Error(`transitionCaseRuntimeWithRetry failed for case ${caseId}`);
}

/**
 * GET /portal-tasks
 *
 * Get all pending portal tasks
 */
router.get('/', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 50;
    const tasks = await getPendingPortalTasks(limit);

    res.json({
      success: true,
      count: tasks.length,
      tasks
    });
  } catch (error) {
    logger.error('Error fetching portal tasks', { error: error.message });
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /portal-tasks/:id
 *
 * Get a specific portal task with full details
 */
router.get('/:id', async (req, res) => {
  try {
    const taskId = parseInt(req.params.id);
    const task = await getPortalTaskById(taskId);

    if (!task) {
      return res.status(404).json({
        success: false,
        error: `Portal task ${taskId} not found`
      });
    }

    // Get associated proposal if exists
    let proposal = null;
    if (task.proposal_id) {
      proposal = await db.getProposalById(task.proposal_id);
    }

    res.json({
      success: true,
      task,
      proposal
    });
  } catch (error) {
    logger.error('Error fetching portal task', { taskId: req.params.id, error: error.message });
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * POST /portal-tasks/:id/claim
 *
 * Claim a portal task (mark as in progress)
 *
 * Body:
 * - assignedTo: Name/ID of person claiming the task
 */
router.post('/:id/claim', async (req, res) => {
  try {
    const taskId = parseInt(req.params.id);
    const { assignedTo } = req.body;

    const task = await getPortalTaskById(taskId);
    if (!task) {
      return res.status(404).json({
        success: false,
        error: `Portal task ${taskId} not found`
      });
    }

    if (task.status !== 'PENDING') {
      return res.status(409).json({
        success: false,
        error: `Task is already ${task.status}`,
        current_status: task.status,
        assigned_to: task.assigned_to
      });
    }

    const updated = await updatePortalTask(taskId, {
      status: 'IN_PROGRESS',
      assignedTo: assignedTo || 'unknown'
    });

    logger.info('Portal task claimed', { taskId, assignedTo });

    res.json({
      success: true,
      message: 'Task claimed successfully',
      task: updated
    });
  } catch (error) {
    logger.error('Error claiming portal task', { taskId: req.params.id, error: error.message });
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * POST /portal-tasks/:id/complete
 *
 * Mark a portal task as completed
 *
 * Body:
 * - confirmationNumber: Optional confirmation/reference number from portal
 * - notes: Optional completion notes
 * - completedBy: Who completed the task
 */
router.post('/:id/complete', async (req, res) => {
  try {
    const taskId = parseInt(req.params.id);
    const { confirmationNumber, notes, completedBy } = req.body;

    const task = await getPortalTaskById(taskId);
    if (!task) {
      return res.status(404).json({
        success: false,
        error: `Portal task ${taskId} not found`
      });
    }

    if (task.status === 'COMPLETED') {
      return res.status(409).json({
        success: false,
        error: 'Task is already completed',
        completed_at: task.completed_at
      });
    }

    // Mark task as completed
    const updated = await portalExecutor.markTaskCompleted(taskId, {
      confirmationNumber,
      notes,
      completedBy
    });

    // Update proposal status if linked
    if (task.proposal_id) {
      await db.updateProposal(task.proposal_id, {
        status: 'EXECUTED',
        executedAt: new Date()
      });
    }

    // Reconcile case status; if the case is locked, complete task anyway and queue reconcile retry.
    let reconcileQueued = false;
    try {
      await transitionCaseRuntimeWithRetry(task.case_id, 'CASE_RECONCILED', {
        targetStatus: 'awaiting_response',
      });
    } catch (error) {
      if (error?.name !== 'CaseLockContention') {
        throw error;
      }
      reconcileQueued = true;
      setTimeout(() => {
        transitionCaseRuntimeWithRetry(task.case_id, 'CASE_RECONCILED', {
          targetStatus: 'awaiting_response',
        }).catch((retryErr) => {
          logger.warn('Deferred reconcile after portal completion failed', {
            taskId,
            caseId: task.case_id,
            error: retryErr.message,
          });
        });
      }, 1200);
    }

    logger.info('Portal task completed', {
      taskId,
      caseId: task.case_id,
      confirmationNumber
    });

    res.json({
      success: true,
      message: reconcileQueued
        ? 'Task completed; case status reconcile queued'
        : 'Task completed successfully',
      reconcile_pending: reconcileQueued,
      task: updated,
    });
  } catch (error) {
    logger.error('Error completing portal task', { taskId: req.params.id, error: error.message });
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * POST /portal-tasks/:id/cancel
 *
 * Cancel a portal task
 *
 * Body:
 * - reason: Reason for cancellation
 */
router.post('/:id/cancel', async (req, res) => {
  try {
    const taskId = parseInt(req.params.id);
    const { reason } = req.body;

    const task = await getPortalTaskById(taskId);
    if (!task) {
      return res.status(404).json({
        success: false,
        error: `Portal task ${taskId} not found`
      });
    }

    if (task.status === 'COMPLETED') {
      return res.status(409).json({
        success: false,
        error: 'Cannot cancel a completed task'
      });
    }

    const updated = await updatePortalTask(taskId, {
      status: 'CANCELLED',
      completionNotes: reason || 'Cancelled by user'
    });

    // Update execution record if exists
    if (task.execution_id) {
      await db.query(`
        UPDATE executions
        SET status = 'FAILED',
            error_message = $2,
            completed_at = NOW()
        WHERE id = $1
      `, [task.execution_id, `Cancelled: ${reason || 'No reason provided'}`]);
    }

    // Update proposal status if linked
    if (task.proposal_id) {
      await db.updateProposal(task.proposal_id, {
        status: 'CANCELLED'
      });
    }

    logger.info('Portal task cancelled', { taskId, reason });

    res.json({
      success: true,
      message: 'Task cancelled',
      task: updated
    });
  } catch (error) {
    logger.error('Error cancelling portal task', { taskId: req.params.id, error: error.message });
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /portal-tasks/case/:caseId
 *
 * Get all portal tasks for a specific case
 */
router.get('/case/:caseId', async (req, res) => {
  try {
    const caseId = parseInt(req.params.caseId);

    const result = await db.query(`
      SELECT pt.*, c.case_name, c.agency_name
      FROM portal_tasks pt
      JOIN cases c ON pt.case_id = c.id
      WHERE pt.case_id = $1
      ORDER BY pt.created_at DESC
    `, [caseId]);

    res.json({
      success: true,
      count: result.rows.length,
      tasks: result.rows
    });
  } catch (error) {
    logger.error('Error fetching case portal tasks', { caseId: req.params.caseId, error: error.message });
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

module.exports = router;
