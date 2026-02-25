/**
 * Executor Adapter
 *
 * Phase 4: Central execution layer with DRY/LIVE mode support.
 *
 * EXECUTION_MODE env flag:
 * - DRY: Creates execution records with SKIPPED status, no actual sends
 * - LIVE: Actually executes actions (send emails, etc.)
 *
 * All executions create records in the executions table for auditability.
 */

const db = require('./database');
const logger = require('./logger');

// ============================================================================
// EXECUTION MODE CONFIGURATION
// ============================================================================

// Hardcoded execution mode: always live sends
const EXECUTION_MODE = 'LIVE';

const isDryRun = () => EXECUTION_MODE === 'DRY';
const isLiveMode = () => EXECUTION_MODE === 'LIVE';

logger.info('Executor adapter initialized', { mode: EXECUTION_MODE });

// ============================================================================
// EXECUTION RECORD HELPERS
// ============================================================================

/**
 * Generate unique execution key
 */
function generateExecutionKey(caseId, actionType, proposalId) {
  const timestamp = Date.now();
  return `exec:${caseId}:${actionType}:${proposalId || 'none'}:${timestamp}`;
}

/**
 * Create execution record in database
 */
async function createExecutionRecord(data) {
  const query = `
    INSERT INTO executions (
      case_id, proposal_id, run_id, execution_key,
      action_type, status, provider, provider_payload, error_message
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
    RETURNING *
  `;

  const values = [
    data.caseId,
    data.proposalId || null,
    data.runId || null,
    data.executionKey,
    data.actionType,
    data.status || 'QUEUED',
    data.provider || null,
    data.providerPayload ? JSON.stringify(data.providerPayload) : null,
    data.errorMessage || null
  ];

  const result = await db.query(query, values);
  return result.rows[0];
}

/**
 * Update execution record
 */
async function updateExecutionRecord(executionKey, updates) {
  const setParts = [];
  const values = [executionKey];
  let paramIndex = 2;

  if (updates.status) {
    setParts.push(`status = $${paramIndex++}`);
    values.push(updates.status);
  }
  if (updates.providerPayload) {
    setParts.push(`provider_payload = $${paramIndex++}::jsonb`);
    values.push(JSON.stringify(updates.providerPayload));
  }
  if (updates.providerMessageId) {
    setParts.push(`provider_message_id = $${paramIndex++}`);
    values.push(updates.providerMessageId);
  }
  if (updates.errorMessage !== undefined) {
    setParts.push(`error_message = $${paramIndex++}`);
    values.push(updates.errorMessage);
  }
  if (updates.completedAt) {
    setParts.push(`completed_at = $${paramIndex++}`);
    values.push(updates.completedAt);
  }

  if (setParts.length === 0) return null;

  setParts.push('updated_at = NOW()');

  const query = `
    UPDATE executions
    SET ${setParts.join(', ')}
    WHERE execution_key = $1
    RETURNING *
  `;

  const result = await db.query(query, values);
  return result.rows[0];
}

// ============================================================================
// EMAIL EXECUTOR
// ============================================================================

/**
 * Email Executor
 *
 * In DRY mode: Creates execution record with SKIPPED status, no actual send
 * In LIVE mode: Queues email for sending and stores provider info
 */
const emailExecutor = {
  /**
   * Send email (or simulate in DRY mode)
   *
   * @param {Object} params
   * @param {string} params.to - Recipient email
   * @param {string} params.subject - Email subject
   * @param {string} params.bodyHtml - HTML body
   * @param {string} params.bodyText - Plain text body
   * @param {Object} params.headers - Additional headers (In-Reply-To, References, etc.)
   * @param {number} params.caseId - Case ID for tracking
   * @param {number} params.proposalId - Proposal ID (optional)
   * @param {number} params.runId - Run ID (optional)
   * @param {string} params.actionType - Action type (SEND_FOLLOWUP, SEND_REBUTTAL, etc.)
   * @param {number} params.delayMs - Delay in milliseconds before sending (optional)
   * @returns {Object} Execution result
   */
  async sendEmail(params) {
    const {
      to, subject, bodyHtml, bodyText, headers,
      caseId, proposalId, runId, actionType,
      delayMs = 0, threadId, originalMessageId
    } = params;

    const executionKey = generateExecutionKey(caseId, actionType, proposalId);

    // DRY MODE: Create SKIPPED execution record
    if (isDryRun()) {
      const execution = await createExecutionRecord({
        caseId,
        proposalId,
        runId,
        executionKey,
        actionType,
        status: 'SKIPPED',
        provider: 'email',
        providerPayload: {
          dryRun: true,
          mode: 'DRY',
          wouldHaveSent: {
            to,
            subject,
            bodyPreview: (bodyText || '').substring(0, 200),
            headers,
            delayMs,
            scheduledFor: delayMs > 0 ? new Date(Date.now() + delayMs).toISOString() : 'immediate'
          }
        }
      });

      logger.info('[DRY_RUN] Email execution skipped', {
        executionKey,
        caseId,
        to,
        subject: subject?.substring(0, 50)
      });

      return {
        success: true,
        dryRun: true,
        executionKey,
        executionId: execution.id,
        status: 'SKIPPED',
        wouldHaveSent: {
          to,
          subject,
          delayMs,
          scheduledFor: delayMs > 0 ? new Date(Date.now() + delayMs).toISOString() : 'immediate'
        }
      };
    }

    // LIVE MODE: Actually queue the email
    try {
      // Create QUEUED execution record first
      const execution = await createExecutionRecord({
        caseId,
        proposalId,
        runId,
        executionKey,
        actionType,
        status: 'QUEUED',
        provider: 'email',
        providerPayload: { to, subject, delayMs }
      });

      // Lazy load email queue to avoid circular deps
      const { emailQueue } = require('../queues/email-queue');

      // If Redis/queue is available, queue the email (supports delayed send)
      if (emailQueue) {
        const job = await emailQueue.add('send-email', {
          caseId,
          proposalId,
          executionKey,
          executionId: execution.id,
          to,
          subject,
          bodyText,
          bodyHtml,
          messageType: actionType?.toLowerCase().replace('send_', '').replace('approve_', '') || 'reply',
          originalMessageId,
          threadId,
          headers
        }, {
          delay: delayMs,
          jobId: executionKey  // Idempotency via execution key
        });

        // Update execution with job info
        await updateExecutionRecord(executionKey, {
          providerPayload: {
            to,
            subject,
            delayMs,
            jobId: job.id,
            queuedAt: new Date().toISOString()
          }
        });

        logger.info('Email queued for sending', {
          executionKey,
          caseId,
          jobId: job.id,
          delayMs
        });

        return {
          success: true,
          dryRun: false,
          executionKey,
          executionId: execution.id,
          jobId: job.id,
          status: 'QUEUED',
          scheduledFor: delayMs > 0 ? new Date(Date.now() + delayMs).toISOString() : 'immediate'
        };
      }

      // Fallback: send directly via SendGrid when no Redis/queue available
      logger.warn('No email queue available, sending directly via SendGrid', { caseId, executionKey });
      const sendgridService = require('./sendgrid-service');
      const directResult = await sendgridService.sendEmail({
        to,
        subject,
        text: bodyText,
        html: bodyHtml,
        inReplyTo: headers?.['In-Reply-To'] || originalMessageId || null,
        references: headers?.References || null,
        caseId,
        messageType: actionType?.toLowerCase().replace('send_', '').replace('approve_', '') || 'reply',
      });

      await updateExecutionRecord(executionKey, {
        status: 'SENT',
        providerPayload: {
          to,
          subject,
          directSend: true,
          messageId: directResult.messageId,
          sendgridMessageId: directResult.sendgridMessageId,
          sentAt: new Date().toISOString()
        }
      });

      logger.info('Email sent directly (no queue)', { executionKey, caseId, messageId: directResult.messageId });

      return {
        success: true,
        dryRun: false,
        executionKey,
        executionId: execution.id,
        jobId: `direct_${executionKey}`,
        status: 'SENT',
        scheduledFor: 'immediate'
      };

    } catch (error) {
      logger.error('Email execution failed', {
        executionKey,
        caseId,
        error: error.message
      });

      // Update execution record with error
      await updateExecutionRecord(executionKey, {
        status: 'FAILED',
        errorMessage: error.message,
        completedAt: new Date()
      });

      return {
        success: false,
        dryRun: false,
        executionKey,
        status: 'FAILED',
        error: error.message
      };
    }
  },

  /**
   * Mark email as sent (called by email worker after actual send)
   */
  async markSent(executionKey, providerMessageId, providerResponse) {
    return updateExecutionRecord(executionKey, {
      status: 'SENT',
      providerMessageId,
      providerPayload: providerResponse,
      completedAt: new Date()
    });
  },

  /**
   * Mark email as failed
   */
  async markFailed(executionKey, errorMessage) {
    return updateExecutionRecord(executionKey, {
      status: 'FAILED',
      errorMessage,
      completedAt: new Date()
    });
  }
};

// ============================================================================
// PORTAL EXECUTOR
// ============================================================================

/**
 * Portal Executor
 *
 * Portal submissions ALWAYS gate for human execution.
 * Creates a "portal task" record for human to complete manually.
 */
const portalExecutor = {
  /**
   * Check if case requires portal submission
   */
  requiresPortal(caseData) {
    return !!(
      caseData.portal_url ||
      caseData.delivery_method === 'portal' ||
      caseData.submission_method === 'portal'
    );
  },

  /**
   * Create portal task for manual human execution
   *
   * @param {Object} params
   * @param {number} params.caseId - Case ID
   * @param {Object} params.caseData - Full case data
   * @param {number} params.proposalId - Proposal ID
   * @param {number} params.runId - Run ID
   * @param {string} params.actionType - Action type
   * @param {string} params.subject - Request subject
   * @param {string} params.bodyText - Request body
   * @returns {Object} Task creation result
   */
  async createPortalTask(params) {
    const {
      caseId, caseData, proposalId, runId,
      actionType, subject, bodyText, bodyHtml
    } = params;

    const executionKey = generateExecutionKey(caseId, actionType, proposalId);

    // Create execution record with PENDING_HUMAN status
    const execution = await createExecutionRecord({
      caseId,
      proposalId,
      runId,
      executionKey,
      actionType,
      status: 'PENDING_HUMAN',
      provider: 'portal',
      providerPayload: {
        portalUrl: caseData.portal_url,
        requiresManualSubmission: true,
        taskDetails: {
          subject,
          bodyPreview: (bodyText || '').substring(0, 500),
          agencyName: caseData.agency_name,
          caseName: caseData.case_name
        }
      }
    });

    // Create portal task record
    const task = await createPortalTask({
      caseId,
      executionId: execution.id,
      proposalId,
      portalUrl: caseData.portal_url,
      actionType,
      subject,
      bodyText,
      bodyHtml,
      status: 'PENDING',
      instructions: `Submit the following to ${caseData.agency_name} portal:\n\n${subject}\n\n${bodyText}`
    });

    logger.info('Portal task created for manual execution', {
      executionKey,
      caseId,
      taskId: task.id,
      portalUrl: caseData.portal_url
    });

    return {
      success: true,
      gated: true,
      executionKey,
      executionId: execution.id,
      taskId: task.id,
      status: 'PENDING_HUMAN',
      portalUrl: caseData.portal_url,
      message: 'Portal submission requires manual execution'
    };
  },

  /**
   * Mark portal task as completed
   */
  async markTaskCompleted(taskId, result) {
    const task = await updatePortalTask(taskId, {
      status: 'COMPLETED',
      completedAt: new Date(),
      completionNotes: result.notes,
      confirmationNumber: result.confirmationNumber
    });

    // Also update the execution record
    if (task?.execution_id) {
      await db.query(`
        UPDATE executions
        SET status = 'SENT',
            provider_payload = provider_payload || $2::jsonb,
            completed_at = NOW()
        WHERE id = $1
      `, [task.execution_id, JSON.stringify({
        completedManually: true,
        completionNotes: result.notes,
        confirmationNumber: result.confirmationNumber
      })]);
    }

    return task;
  }
};

// ============================================================================
// PORTAL TASK TABLE HELPERS
// ============================================================================

/**
 * Create portal task in database
 */
async function createPortalTask(data) {
  const query = `
    INSERT INTO portal_tasks (
      case_id, execution_id, proposal_id, portal_url,
      action_type, subject, body_text, body_html,
      status, instructions
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
    RETURNING *
  `;

  const values = [
    data.caseId,
    data.executionId,
    data.proposalId || null,
    data.portalUrl,
    data.actionType,
    data.subject,
    data.bodyText,
    data.bodyHtml,
    data.status || 'PENDING',
    data.instructions
  ];

  const result = await db.query(query, values);
  return result.rows[0];
}

/**
 * Update portal task
 */
async function updatePortalTask(taskId, updates) {
  const setParts = [];
  const values = [taskId];
  let paramIndex = 2;

  if (updates.status) {
    setParts.push(`status = $${paramIndex++}`);
    values.push(updates.status);
  }
  if (updates.assignedTo) {
    setParts.push(`assigned_to = $${paramIndex++}`);
    values.push(updates.assignedTo);
  }
  if (updates.completedAt) {
    setParts.push(`completed_at = $${paramIndex++}`);
    values.push(updates.completedAt);
  }
  if (updates.completedBy) {
    setParts.push(`completed_by = $${paramIndex++}`);
    values.push(updates.completedBy);
  }
  if (updates.completionNotes) {
    setParts.push(`completion_notes = $${paramIndex++}`);
    values.push(updates.completionNotes);
  }
  if (updates.confirmationNumber) {
    setParts.push(`confirmation_number = $${paramIndex++}`);
    values.push(updates.confirmationNumber);
  }

  if (setParts.length === 0) return null;

  setParts.push('updated_at = NOW()');

  const query = `
    UPDATE portal_tasks
    SET ${setParts.join(', ')}
    WHERE id = $1
    RETURNING *
  `;

  const result = await db.query(query, values);
  return result.rows[0];
}

/**
 * Get pending portal tasks
 */
async function getPendingPortalTasks(limit = 50) {
  const result = await db.query(`
    SELECT pt.*, c.case_name, c.agency_name
    FROM portal_tasks pt
    JOIN cases c ON pt.case_id = c.id
    WHERE pt.status = 'PENDING'
    ORDER BY pt.created_at ASC
    LIMIT $1
  `, [limit]);
  return result.rows;
}

/**
 * Get portal task by ID
 */
async function getPortalTaskById(taskId) {
  const result = await db.query(`
    SELECT pt.*, c.case_name, c.agency_name, c.portal_url as case_portal_url
    FROM portal_tasks pt
    JOIN cases c ON pt.case_id = c.id
    WHERE pt.id = $1
  `, [taskId]);
  return result.rows[0];
}

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
  // Mode info
  EXECUTION_MODE,
  isDryRun,
  isLiveMode,

  // Executors
  emailExecutor,
  portalExecutor,

  // Helpers
  generateExecutionKey,
  createExecutionRecord,
  updateExecutionRecord,

  // Portal tasks
  createPortalTask,
  updatePortalTask,
  getPendingPortalTasks,
  getPortalTaskById
};
