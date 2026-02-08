/**
 * Execute Action Node
 *
 * Executes the approved action using the executor adapter.
 *
 * Phase 4: Uses executor-adapter for DRY/LIVE mode support.
 * - Email actions: emailExecutor handles DRY (skip) vs LIVE (send)
 * - Portal actions: portalExecutor always gates for human execution
 *
 * IDEMPOTENCY:
 * - Checks if proposal already executed before doing anything
 * - Uses execution_key to prevent duplicate executions
 *
 * Handles: SEND_INITIAL_REQUEST, SEND_FOLLOWUP, SEND_REBUTTAL, SEND_CLARIFICATION,
 *          RESPOND_PARTIAL_APPROVAL, ACCEPT_FEE, NEGOTIATE_FEE, DECLINE_FEE,
 *          ESCALATE, SUBMIT_PORTAL, NONE
 */

const db = require('../../services/database');
const logger = require('../../services/logger');
const {
  EXECUTION_MODE,
  isDryRun,
  emailExecutor,
  portalExecutor,
  generateExecutionKey,
  createExecutionRecord
} = require('../../services/executor-adapter');

/**
 * Execute the approved action
 */
async function executeActionNode(state) {
  let {
    caseId, proposalId, proposalKey, proposalActionType,
    draftSubject, draftBodyText, draftBodyHtml, proposalReasoning,
    runId
  } = state;

  const logs = [];
  let executionResult = null;

  logs.push(`Execution mode: ${EXECUTION_MODE}`);

  // IDEMPOTENCY CHECK - Already executed?
  const existingProposal = await db.getProposalById(proposalId);

  // Recover missing state from proposal if checkpoint lost data
  if (!caseId && existingProposal?.case_id) {
    caseId = existingProposal.case_id;
    logs.push(`Recovered caseId from proposal: ${caseId}`);
  }
  if (!proposalActionType && existingProposal?.action_type) {
    proposalActionType = existingProposal.action_type;
    logs.push(`Recovered proposalActionType from proposal: ${proposalActionType}`);
  }
  if (!draftSubject && existingProposal?.draft_subject) {
    draftSubject = existingProposal.draft_subject;
  }
  if (!draftBodyText && existingProposal?.draft_body_text) {
    draftBodyText = existingProposal.draft_body_text;
  }
  if (!draftBodyHtml && existingProposal?.draft_body_html) {
    draftBodyHtml = existingProposal.draft_body_html;
  }

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

  // Claim execution with a key BEFORE doing anything
  const executionKey = generateExecutionKey(caseId, proposalActionType, proposalId);

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
  const runData = runId ? await db.getAgentRunById(runId) : null;
  const routeMode = runData?.metadata?.route_mode || null;
  const hasPortal = portalExecutor.requiresPortal(caseData);
  const hasEmail = !!caseData?.agency_email;

  logs.push(`Route mode: ${routeMode || 'auto'}`);

  // For initial requests with both channels available, force explicit routing.
  if (proposalActionType === 'SEND_INITIAL_REQUEST' && hasPortal && hasEmail && !routeMode) {
    const pauseReason = 'Route decision required: choose email or portal for initial request';
    logs.push(`BLOCKED: ${pauseReason}`);

    await db.updateCaseStatus(caseId, 'needs_human_review', {
      requires_human: true,
      pause_reason: pauseReason
    });

    await db.updateProposal(proposalId, {
      status: 'PENDING_APPROVAL',
      execution_key: null
    });

    return {
      actionExecuted: false,
      gatedForReview: true,
      missingFields: ['route_mode'],
      errors: [pauseReason],
      logs
    };
  }

  // =========================================================================
  // PORTAL CHECK - Route portal cases to portal executor
  // =========================================================================
  const shouldForcePortal =
    routeMode === 'portal' ||
    (routeMode !== 'email' && hasPortal);

  if (shouldForcePortal && proposalActionType.startsWith('SEND_')) {
    logs.push('Portal case detected - routing to portal executor');

    const portalResult = await portalExecutor.createPortalTask({
      caseId,
      caseData,
      proposalId,
      runId,
      actionType: proposalActionType,
      subject: draftSubject,
      bodyText: draftBodyText,
      bodyHtml: draftBodyHtml
    });

    // Update proposal status
    await db.updateProposal(proposalId, {
      status: 'PENDING_PORTAL',
      portalTaskId: portalResult.taskId
    });

    logs.push(`Portal task created: ${portalResult.taskId}`);

    return {
      actionExecuted: false,  // Not executed yet - waiting for human
      requiresPortal: true,
      portalTaskId: portalResult.taskId,
      executionResult: portalResult,
      logs
    };
  }

  // =========================================================================
  // ACTION EXECUTION
  // =========================================================================
  switch (proposalActionType) {
    case 'SEND_INITIAL_REQUEST':
    case 'SEND_FOLLOWUP':
    case 'SEND_REBUTTAL':
    case 'SEND_CLARIFICATION':
    case 'RESPOND_PARTIAL_APPROVAL':
    case 'ACCEPT_FEE':    // Canonical name
    case 'APPROVE_FEE':   // Legacy name (for backwards compatibility)
    case 'NEGOTIATE_FEE':
    case 'DECLINE_FEE': {
      // =========================================================================
      // VALIDATION - Check all required fields before sending anything
      // =========================================================================
      const missingFields = [];

      // Check delivery method
      if (!hasEmail && !hasPortal) {
        missingFields.push('agency_email or portal_url');
      }

      // Check draft content
      if (!draftSubject) {
        missingFields.push('subject');
      }
      if (!draftBodyText && !draftBodyHtml) {
        missingFields.push('body content');
      }

      // Check case data
      if (!caseData.agency_name) {
        missingFields.push('agency_name');
      }

      // If anything is missing, gate for human review
      if (missingFields.length > 0) {
        const pauseReason = `Cannot send: missing ${missingFields.join(', ')}`;
        logs.push(`BLOCKED: ${pauseReason}`);

        await db.updateCaseStatus(caseId, 'needs_human_review', {
          requires_human: true,
          pause_reason: pauseReason
        });

        await db.updateProposal(proposalId, {
          status: 'BLOCKED',
          execution_key: null  // Release claim so it can retry after fix
        });

        return {
          actionExecuted: false,
          gatedForReview: true,
          missingFields,
          errors: [pauseReason],
          logs
        };
      }

      // =========================================================================
      // ROUTING - Portal vs Email
      // =========================================================================
      if (!hasEmail && hasPortal) {
        logs.push('No agency_email but portal_url exists - routing to portal executor');

        const portalResult = await portalExecutor.createPortalTask({
          caseId,
          caseData,
          proposalId,
          runId,
          actionType: proposalActionType,
          subject: draftSubject,
          bodyText: draftBodyText,
          bodyHtml: draftBodyHtml
        });

        await db.updateProposal(proposalId, {
          status: 'PENDING_PORTAL',
          portalTaskId: portalResult.taskId
        });

        logs.push(`Portal task created: ${portalResult.taskId}`);

        return {
          actionExecuted: false,
          requiresPortal: true,
          portalTaskId: portalResult.taskId,
          executionResult: portalResult,
          logs
        };
      }

      // Get thread for proper email threading
      const thread = await db.getThreadByCaseId(caseId);
      const latestInbound = await db.getLatestInboundMessage(caseId);

      // Calculate human-like delay (2-10 hours for replies, immediate for initial)
      const isInitial = proposalActionType === 'SEND_INITIAL_REQUEST';
      const delayMinutes = isInitial ? 0 : Math.floor(Math.random() * 480) + 120;
      const delayMs = delayMinutes * 60 * 1000;

      // Use email executor (handles DRY vs LIVE mode)
      const emailResult = await emailExecutor.sendEmail({
        to: caseData.agency_email,
        subject: draftSubject,
        bodyHtml: draftBodyHtml,
        bodyText: draftBodyText,
        headers: latestInbound ? {
          'In-Reply-To': latestInbound.message_id,
          'References': latestInbound.message_id
        } : null,
        caseId,
        proposalId,
        runId,
        actionType: proposalActionType,
        delayMs,
        threadId: thread?.id,
        originalMessageId: latestInbound?.message_id
      });

      executionResult = {
        action: emailResult.dryRun ? 'dry_run_skipped' : 'email_queued',
        ...emailResult
      };

      if (emailResult.dryRun) {
        logs.push(`[DRY_RUN] Would have sent email to ${caseData.agency_email}`);
      } else {
        logs.push(`Email queued (job ${emailResult.jobId}), scheduled in ${delayMinutes} minutes`);
      }

      // Create execution record for audit trail
      await createExecutionRecord({
        caseId,
        proposalId,
        runId,
        executionKey,
        actionType: proposalActionType,
        status: emailResult.dryRun ? 'DRY_RUN' : 'QUEUED',
        provider: emailResult.dryRun ? 'dry_run' : 'email',
        providerPayload: {
          to: caseData.agency_email,
          subject: draftSubject,
          jobId: emailResult.jobId,
          delayMinutes,
          dryRun: emailResult.dryRun
        }
      });

      // Update proposal status
      await db.updateProposal(proposalId, {
        status: 'EXECUTED',
        executedAt: new Date(),
        emailJobId: emailResult.jobId || `dry_run_${executionKey}`
      });

      // Schedule next follow-up if this was a follow-up
      if (proposalActionType === 'SEND_FOLLOWUP' && !emailResult.dryRun) {
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
      // Idempotent escalation
      const escalation = await db.upsertEscalation({
        caseId,
        executionKey,
        reason: (proposalReasoning || []).join('; ') || 'Escalated by agent',
        urgency: 'medium',
        suggestedAction: 'Review case and decide next steps'
      });

      // Create execution record for escalation
      await createExecutionRecord({
        caseId,
        proposalId,
        runId,
        executionKey,
        actionType: 'ESCALATE',
        status: 'SENT',
        provider: 'none',
        providerPayload: {
          escalationId: escalation.id,
          wasNew: escalation.wasInserted
        }
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
      // Create execution record for audit trail
      await createExecutionRecord({
        caseId,
        proposalId,
        runId,
        executionKey,
        actionType: 'NONE',
        status: 'SKIPPED',
        provider: 'none',
        providerPayload: { reason: 'No action required' }
      });

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
    mode: EXECUTION_MODE,
    result: executionResult
  });

  return {
    actionExecuted: true,
    executionResult,
    logs
  };
}

module.exports = {
  executeActionNode,
  EXECUTION_MODE,
  isDryRun
};
