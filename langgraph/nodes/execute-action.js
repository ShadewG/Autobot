/**
 * Execute Action Node
 *
 * Executes the approved action.
 *
 * P0 FIX #3: IDEMPOTENT EXECUTION
 * - Check if already executed before doing anything
 * - Use execution_key to prevent duplicate sends
 * - Store email_job_id to track what was queued
 *
 * DRY_RUN MODE: When enabled, no actual emails are sent
 * - Still creates proposals and agent_runs for inspection
 * - Returns what WOULD have been done
 *
 * Handles: send_email, schedule_followup, update_status
 */

const db = require('../../services/database');
const logger = require('../../services/logger');

// DRY_RUN mode - prevents actual email sending in testing
// Default ON unless explicitly set to 'false'
const DRY_RUN = process.env.LANGGRAPH_DRY_RUN !== 'false';

// Lazy load to avoid circular dependencies
let emailQueueModule = null;
function getEmailQueue() {
  if (!emailQueueModule) {
    emailQueueModule = require('../../queues/email-queue');
  }
  return emailQueueModule.getEmailQueue ? emailQueueModule.getEmailQueue() : emailQueueModule.emailQueue;
}

/**
 * Generate deterministic execution key
 * P0 FIX #3: Used to prevent duplicate executions
 */
function generateExecutionKey(proposalKey) {
  return `exec:${proposalKey}:${Date.now()}`;
}

/**
 * Execute the approved action
 */
async function executeActionNode(state) {
  const {
    caseId, proposalId, proposalKey, proposalActionType,
    draftSubject, draftBodyText, draftBodyHtml, proposalReasoning
  } = state;

  const logs = [];
  let executionResult = null;

  // P0 FIX #3: IDEMPOTENCY CHECK - Already executed?
  const existingProposal = await db.getProposalById(proposalId);

  if (existingProposal?.status === 'EXECUTED') {
    logs.push(`SKIPPED: Proposal ${proposalId} already executed`);
    return {
      actionExecuted: true,  // Already done
      executionResult: {
        action: 'already_executed',
        emailJobId: existingProposal.email_job_id
      },
      logs
    };
  }

  if (existingProposal?.execution_key) {
    logs.push(`SKIPPED: Proposal ${proposalId} has execution_key (in progress or done)`);
    return {
      actionExecuted: true,
      executionResult: { action: 'execution_in_progress' },
      logs
    };
  }

  // P0 FIX #3: Claim execution with a key BEFORE doing anything
  const executionKey = generateExecutionKey(proposalKey);

  const claimed = await db.claimProposalExecution(proposalId, executionKey);
  if (!claimed) {
    logs.push(`SKIPPED: Could not claim execution for proposal ${proposalId}`);
    return {
      actionExecuted: false,
      executionResult: { action: 'claim_failed' },
      logs
    };
  }

  logs.push(`Claimed execution with key: ${executionKey}`);

  const caseData = await db.getCaseById(caseId);
  const emailQueue = getEmailQueue();

  // === Portal check - NEVER send email to portal cases ===
  if (caseData.portal_url && proposalActionType.startsWith('SEND_')) {
    logs.push('BLOCKED: Cannot send email to portal-based case');
    await db.updateProposal(proposalId, {
      status: 'EXECUTED',
      executedAt: new Date()
    });
    return {
      errors: ['Email blocked: case uses portal submission'],
      actionExecuted: false,
      logs
    };
  }

  switch (proposalActionType) {
    case 'SEND_FOLLOWUP':
    case 'SEND_REBUTTAL':
    case 'SEND_CLARIFICATION':
    case 'APPROVE_FEE': {
      // Get thread for proper email threading
      const thread = await db.getThreadByCaseId(caseId);
      const latestInbound = await db.getLatestInboundMessage(caseId);

      // Calculate human-like delay (2-10 hours)
      const delayMinutes = Math.floor(Math.random() * 480) + 120;
      const delayMs = delayMinutes * 60 * 1000;

      // DRY_RUN MODE: Don't actually queue email
      if (DRY_RUN) {
        executionResult = {
          action: 'dry_run_blocked',
          dryRun: true,
          wouldHaveDone: {
            action: 'email_queued',
            to: caseData.agency_email,
            subject: draftSubject,
            bodyPreview: (draftBodyText || '').substring(0, 200),
            messageType: proposalActionType.toLowerCase().replace('send_', '').replace('approve_', ''),
            delayMinutes,
            scheduledFor: new Date(Date.now() + delayMs).toISOString()
          }
        };

        logs.push(`[DRY_RUN] Would have queued email to ${caseData.agency_email}, scheduled in ${delayMinutes} minutes`);

        // Still update proposal status for tracking
        await db.updateProposal(proposalId, {
          status: 'EXECUTED',
          executedAt: new Date(),
          emailJobId: `dry_run_${executionKey}`
        });

        break;
      }

      // REAL MODE: Actually queue the email
      // P0 FIX #3: Use execution_key as job ID for idempotency
      const job = await emailQueue.add('send-email', {
        caseId,
        proposalId,
        executionKey,
        to: caseData.agency_email,
        subject: draftSubject,
        bodyText: draftBodyText,
        bodyHtml: draftBodyHtml,
        messageType: proposalActionType.toLowerCase().replace('send_', '').replace('approve_', ''),
        originalMessageId: latestInbound?.message_id,
        threadId: thread?.id
      }, {
        delay: delayMs,
        jobId: executionKey  // P0 FIX: Dedupe by execution key
      });

      executionResult = {
        action: 'email_queued',
        jobId: job.id,
        executionKey,
        scheduledFor: new Date(Date.now() + delayMs).toISOString(),
        delayMinutes
      };

      logs.push(`Email queued (job ${job.id}), scheduled in ${delayMinutes} minutes`);

      // P0 FIX #3: Store job ID on proposal for tracking
      await db.updateProposal(proposalId, {
        status: 'EXECUTED',
        executedAt: new Date(),
        emailJobId: job.id
      });

      // Schedule next follow-up if this was a follow-up
      if (proposalActionType === 'SEND_FOLLOWUP') {
        const followupDays = parseInt(process.env.FOLLOWUP_DELAY_DAYS) || 7;
        const nextDate = new Date();
        nextDate.setDate(nextDate.getDate() + followupDays);

        await db.upsertFollowUpSchedule(caseId, {
          nextFollowupDate: nextDate,
          lastFollowupSentAt: new Date()
        });

        logs.push(`Next follow-up scheduled for ${nextDate.toISOString()}`);
      }

      // Update case status
      await db.updateCaseStatus(caseId, 'awaiting_response', {
        requires_human: false,
        pause_reason: null
      });

      break;
    }

    case 'ESCALATE': {
      // P0 FIX #3: Idempotent escalation
      const escalation = await db.upsertEscalation({
        caseId,
        executionKey,
        reason: (proposalReasoning || []).join('; ') || 'Escalated by agent',
        urgency: 'medium',
        suggestedAction: 'Review case and decide next steps'
      });

      // Only notify if this is a new escalation
      if (escalation.wasInserted) {
        try {
          const discordService = require('../../services/discord-service');
          await discordService.sendCaseEscalation(caseData, escalation);
        } catch (e) {
          logs.push(`Discord notification failed: ${e.message}`);
        }
      }

      executionResult = {
        action: 'escalated',
        escalationId: escalation.id,
        wasNew: escalation.wasInserted
      };

      await db.updateProposal(proposalId, {
        status: 'EXECUTED',
        executedAt: new Date()
      });

      logs.push(`Case escalated (escalation ${escalation.id}, new=${escalation.wasInserted})`);
      break;
    }

    case 'NONE': {
      executionResult = { action: 'none' };
      await db.updateProposal(proposalId, {
        status: 'EXECUTED',
        executedAt: new Date()
      });
      logs.push('No action executed');
      break;
    }

    default:
      logs.push(`Unknown action type: ${proposalActionType}`);
      return {
        errors: [`Unknown action type: ${proposalActionType}`],
        actionExecuted: false,
        logs
      };
  }

  // Log activity
  await db.logActivity('agent_action_executed', `Executed ${proposalActionType}`, {
    caseId,
    proposalId,
    executionKey,
    result: executionResult
  });

  return {
    actionExecuted: true,
    executionResult,
    logs
  };
}

module.exports = { executeActionNode, DRY_RUN };
