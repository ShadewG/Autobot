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
 *          ESCALATE, SUBMIT_PORTAL, SEND_PDF_EMAIL, NONE
 */

const db = require('../../services/database');
const aiService = require('../../services/ai-service');
const logger = require('../../services/logger');
const { portalQueue } = require('../../queues/email-queue');
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

  // TIMEOUT GUARD: If the run has already been marked failed/skipped (e.g. by reaper),
  // bail out immediately to avoid executing on a cancelled run.
  if (runId) {
    const currentRun = await db.getAgentRunById(runId);
    if (currentRun && ['failed', 'skipped'].includes(currentRun.status)) {
      logs.push(`SKIPPED: Run ${runId} already in terminal state '${currentRun.status}'`);
      return {
        actionExecuted: false,
        executionResult: { action: 'run_already_terminal', runStatus: currentRun.status },
        logs
      };
    }
  }

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

  // Resolve target agency from case_agencies when caseAgencyId is set
  let targetEmail = caseData?.agency_email;
  let targetPortalUrl = caseData?.portal_url;
  if (state.caseAgencyId) {
    const targetAgency = await db.getCaseAgencyById(state.caseAgencyId);
    if (targetAgency) {
      targetEmail = targetAgency.agency_email || targetEmail;
      targetPortalUrl = targetAgency.portal_url || targetPortalUrl;
      logs.push(`Using target agency #${state.caseAgencyId}: ${targetAgency.agency_name}`);
    }
  }

  const runData = runId ? await db.getAgentRunById(runId) : null;
  const routeMode = runData?.metadata?.route_mode || existingProposal?.human_decision?.route_mode || null;
  const hasPortal = portalExecutor.requiresPortal({ ...caseData, portal_url: targetPortalUrl });
  const hasEmail = !!targetEmail;

  logs.push(`Route mode: ${routeMode || 'auto'}`);

  // When both channels exist and no explicit route_mode, default to portal
  if (proposalActionType === 'SEND_INITIAL_REQUEST' && hasPortal && hasEmail && !routeMode) {
    logs.push('Both email and portal available - defaulting to portal');
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

    // Auto-launch Skyvern for portal route after approval
    if (portalQueue) {
      const portalJob = await portalQueue.add('portal-submit', {
        caseId,
        portalUrl: targetPortalUrl,
        provider: caseData.portal_provider || null,
        instructions: draftBodyText || draftBodyHtml || null
      }, {
        jobId: `${caseId}:portal-submit`,
        attempts: 1,
        removeOnComplete: 100,
        removeOnFail: 100
      });
      logs.push(`Portal submission queued: ${portalJob.id}`);
    } else {
      logs.push('Portal queue unavailable - portal task created without auto-launch');
    }

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
      if (!targetEmail && !hasPortal) {
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
      if (!targetEmail && hasPortal) {
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
        to: targetEmail,
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

      // Check for send failure (email executor returned success: false)
      if (emailResult.success === false) {
        const failReason = emailResult.error || 'Email send failed';
        logs.push(`BLOCKED: ${failReason}`);

        await db.updateProposal(proposalId, {
          status: 'BLOCKED',
          execution_key: null
        });

        await db.updateCaseStatus(caseId, 'needs_human_review', {
          requires_human: true,
          pause_reason: `Email send failed: ${failReason}`
        });

        return {
          actionExecuted: false,
          gatedForReview: true,
          errors: [failReason],
          logs
        };
      }

      executionResult = {
        action: emailResult.dryRun ? 'dry_run_skipped' : 'email_queued',
        ...emailResult
      };

      if (emailResult.dryRun) {
        logs.push(`[DRY_RUN] Would have sent email to ${targetEmail}`);
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
          to: targetEmail,
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

      // Feature 2: Log fee events for fee-related actions
      if (['ACCEPT_FEE', 'APPROVE_FEE', 'NEGOTIATE_FEE', 'DECLINE_FEE'].includes(proposalActionType) && !emailResult.dryRun) {
        try {
          const feeEventMap = {
            'ACCEPT_FEE': 'accepted',
            'APPROVE_FEE': 'accepted',
            'NEGOTIATE_FEE': 'negotiated',
            'DECLINE_FEE': 'declined'
          };
          await db.logFeeEvent(
            caseId,
            feeEventMap[proposalActionType],
            caseData?.last_fee_quote_amount || null,
            `${proposalActionType} executed via proposal ${proposalId}`,
            null
          );
        } catch (feeErr) {
          logs.push(`Fee event log failed: ${feeErr.message}`);
        }
      }

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

    case 'RESEARCH_AGENCY': {
      // Mark the research proposal as executed
      await createExecutionRecord({
        caseId,
        proposalId,
        runId,
        executionKey,
        actionType: 'RESEARCH_AGENCY',
        status: 'SENT',
        provider: 'none',
        providerPayload: { reason: 'Agency research complete' }
      });

      await db.updateProposal(proposalId, {
        status: 'EXECUTED',
        executedAt: new Date()
      });
      logs.push('Agency research proposal executed');

      // --- Auto-create follow-up proposal for new agency ---
      // Get research data from state (passed by draft-response) or parse from case
      let contactResult = state.researchContactResult || null;
      let brief = state.researchBrief || null;

      if (!brief) {
        // Fallback: parse from contact_research_notes stored on case
        try {
          const freshCase = await db.getCaseById(caseId);
          if (freshCase?.contact_research_notes) {
            const parsed = typeof freshCase.contact_research_notes === 'string'
              ? JSON.parse(freshCase.contact_research_notes)
              : freshCase.contact_research_notes;
            contactResult = contactResult || parsed.contactResult || null;
            brief = parsed.brief || null;
          }
        } catch (parseErr) {
          logs.push(`Could not parse contact_research_notes: ${parseErr.message}`);
        }
      }

      // Extract the best new agency from research
      const suggestedAgency = brief?.suggested_agencies?.[0] || null;

      if (!suggestedAgency?.name) {
        logs.push('No suggested agency found in research — falling back to human review');
        await db.updateCaseStatus(caseId, 'needs_human_review', {
          substatus: 'agency_research_complete',
          requires_human: true
        });
        executionResult = { action: 'research_complete', followup: 'none' };
        break;
      }

      logs.push(`Research suggests new agency: ${suggestedAgency.name} (confidence: ${suggestedAgency.confidence})`);

      // Cross-reference with agencies table for portal/email info
      let newAgencyEmail = contactResult?.contact_email || null;
      let newAgencyPortalUrl = contactResult?.portal_url || null;
      let newAgencyPortalProvider = null;
      let agencyId = null;

      try {
        const knownAgency = await db.findAgencyByName(
          suggestedAgency.name,
          caseData?.state || null
        );
        if (knownAgency) {
          agencyId = knownAgency.id;
          newAgencyEmail = newAgencyEmail || knownAgency.email_main || null;
          newAgencyPortalUrl = newAgencyPortalUrl || knownAgency.portal_url || null;
          logs.push(`Matched "${suggestedAgency.name}" to known agency #${knownAgency.id}`);
        }
      } catch (lookupErr) {
        logs.push(`Agency lookup failed: ${lookupErr.message}`);
      }

      // Must have at least one delivery channel
      if (!newAgencyEmail && !newAgencyPortalUrl) {
        logs.push('New agency has no email or portal URL — falling back to human review');
        await db.updateCaseStatus(caseId, 'needs_human_review', {
          substatus: 'agency_research_complete',
          requires_human: true
        });
        executionResult = { action: 'research_complete', followup: 'no_contact_info' };
        break;
      }

      // Add the new agency to case_agencies
      let caseAgency;
      try {
        caseAgency = await db.addCaseAgency(caseId, {
          agency_id: agencyId,
          agency_name: suggestedAgency.name,
          agency_email: newAgencyEmail,
          portal_url: newAgencyPortalUrl,
          portal_provider: newAgencyPortalProvider,
          is_primary: false,
          added_source: 'research',
          notes: suggestedAgency.reason || brief?.summary || null
        });
        logs.push(`Added case_agency #${caseAgency.id}: ${suggestedAgency.name}`);
      } catch (addErr) {
        logs.push(`Failed to add case agency: ${addErr.message}`);
        await db.updateCaseStatus(caseId, 'needs_human_review', {
          substatus: 'agency_research_complete',
          requires_human: true
        });
        executionResult = { action: 'research_complete', followup: 'add_agency_failed' };
        break;
      }

      // Generate a FOIA request for the new agency
      let foiaResult;
      try {
        const modifiedCaseData = { ...caseData, agency_name: suggestedAgency.name };
        foiaResult = await aiService.generateFOIARequest(modifiedCaseData);
        logs.push('Generated FOIA request for new agency');
      } catch (foiaErr) {
        logs.push(`FOIA generation failed: ${foiaErr.message} — falling back to human review`);
        await db.updateCaseStatus(caseId, 'needs_human_review', {
          substatus: 'agency_research_complete',
          requires_human: true
        });
        executionResult = { action: 'research_complete', followup: 'foia_generation_failed' };
        break;
      }

      // Determine action type based on available channels
      const followupActionType = newAgencyPortalUrl ? 'SUBMIT_PORTAL' : 'SEND_INITIAL_REQUEST';
      const followupProposalKey = `${caseId}:research:ca${caseAgency.id}:${followupActionType}:0`;

      // Build reasoning
      const followupReasoning = [
        `Agency research identified ${suggestedAgency.name} as likely records holder`,
        suggestedAgency.reason || brief?.summary || 'Based on AI research analysis',
        `Delivery method: ${followupActionType === 'SUBMIT_PORTAL' ? 'portal submission' : 'email'}`,
        `Confidence: ${suggestedAgency.confidence || 'medium'}`
      ];

      // Build subject line
      const subjectName = caseData?.subject_name || 'Records Request';
      const draftSubject = `Public Records Request - ${subjectName}`;

      // Create the follow-up proposal
      try {
        const followupProposal = await db.upsertProposal({
          proposalKey: followupProposalKey,
          caseId,
          runId: runId || null,
          actionType: followupActionType,
          draftSubject,
          draftBodyText: foiaResult.request_text,
          draftBodyHtml: null,
          reasoning: followupReasoning,
          confidence: suggestedAgency.confidence || 0.7,
          requiresHuman: true,
          canAutoExecute: false,
          status: 'PENDING_APPROVAL'
        });
        logs.push(`Created follow-up proposal #${followupProposal.id} (${followupActionType}) for ${suggestedAgency.name}`);
      } catch (proposalErr) {
        logs.push(`Follow-up proposal creation failed: ${proposalErr.message}`);
        await db.updateCaseStatus(caseId, 'needs_human_review', {
          substatus: 'agency_research_complete',
          requires_human: true
        });
        executionResult = { action: 'research_complete', followup: 'proposal_creation_failed' };
        break;
      }

      // Set case to ready_to_send (not needs_human_review) — one-click approval
      await db.updateCaseStatus(caseId, 'ready_to_send', {
        substatus: 'research_followup_proposed',
        requires_human: true
      });

      await db.logActivity('research_followup_proposed', `Research complete — proposed ${followupActionType} to ${suggestedAgency.name}`, {
        caseId,
        proposalId,
        newAgency: suggestedAgency.name,
        actionType: followupActionType,
        caseAgencyId: caseAgency.id,
        confidence: suggestedAgency.confidence
      });

      executionResult = {
        action: 'research_complete',
        followup: 'proposal_created',
        newAgency: suggestedAgency.name,
        actionType: followupActionType,
        caseAgencyId: caseAgency.id
      };
      logs.push('Research loop closed — follow-up proposal ready for approval');
      break;
    }

    case 'REFORMULATE_REQUEST': {
      // Treat like SEND_INITIAL_REQUEST — route through email or portal executor
      // The draft is a fresh request, not a follow-up
      if (!draftSubject || (!draftBodyText && !draftBodyHtml)) {
        logs.push('BLOCKED: Reformulated request has no draft content');
        await db.updateProposal(proposalId, {
          status: 'BLOCKED',
          execution_key: null
        });
        return {
          actionExecuted: false,
          errors: ['Reformulated request missing draft content'],
          logs
        };
      }

      const thread = await db.getThreadByCaseId(caseId);
      const delayMinutes = Math.floor(Math.random() * 480) + 120;
      const delayMs = delayMinutes * 60 * 1000;

      const emailResult = await emailExecutor.sendEmail({
        to: targetEmail,
        subject: draftSubject,
        bodyHtml: draftBodyHtml,
        bodyText: draftBodyText,
        caseId,
        proposalId,
        runId,
        actionType: 'REFORMULATE_REQUEST',
        delayMs,
        threadId: thread?.id
      });

      executionResult = {
        action: emailResult.dryRun ? 'dry_run_skipped' : 'email_queued',
        ...emailResult
      };

      await createExecutionRecord({
        caseId,
        proposalId,
        runId,
        executionKey,
        actionType: 'REFORMULATE_REQUEST',
        status: emailResult.dryRun ? 'DRY_RUN' : 'QUEUED',
        provider: emailResult.dryRun ? 'dry_run' : 'email',
        providerPayload: {
          to: targetEmail,
          subject: draftSubject,
          jobId: emailResult.jobId,
          delayMinutes,
          dryRun: emailResult.dryRun
        }
      });

      await db.updateProposal(proposalId, {
        status: 'EXECUTED',
        executedAt: new Date(),
        emailJobId: emailResult.jobId || `dry_run_${executionKey}`
      });

      await db.updateCaseStatus(caseId, 'awaiting_response', {
        requires_human: false,
        pause_reason: null
      });

      logs.push(emailResult.dryRun
        ? `[DRY_RUN] Would have sent reformulated request to ${targetEmail}`
        : `Reformulated request queued (job ${emailResult.jobId}), scheduled in ${delayMinutes} minutes`
      );
      break;
    }

    case 'SUBMIT_PORTAL': {
      // Portal submission — route to portal executor
      logs.push('SUBMIT_PORTAL — routing to portal executor');

      const portalResult = await portalExecutor.createPortalTask({
        caseId,
        caseData,
        proposalId,
        runId,
        actionType: 'SUBMIT_PORTAL',
        subject: draftSubject,
        bodyText: draftBodyText,
        bodyHtml: draftBodyHtml
      });

      await createExecutionRecord({
        caseId,
        proposalId,
        runId,
        executionKey,
        actionType: 'SUBMIT_PORTAL',
        status: 'PENDING_PORTAL',
        provider: 'portal',
        providerPayload: { portalTaskId: portalResult.taskId }
      });

      await db.updateProposal(proposalId, {
        status: 'PENDING_PORTAL',
        portalTaskId: portalResult.taskId
      });

      if (portalQueue) {
        const portalJob = await portalQueue.add('portal-submit', {
          caseId,
          portalUrl: targetPortalUrl,
          provider: caseData.portal_provider || null,
          instructions: draftBodyText || draftBodyHtml || null
        }, {
          jobId: `${caseId}:portal-submit`,
          attempts: 1,
          removeOnComplete: 100,
          removeOnFail: 100
        });
        logs.push(`Portal submission queued: ${portalJob.id}`);
      }

      executionResult = { action: 'portal_task_created', ...portalResult };
      logs.push(`Portal task created: ${portalResult.taskId}`);
      break;
    }

    case 'SEND_PDF_EMAIL': {
      // =========================================================================
      // PDF EMAIL - Send filled PDF form to agency via email
      // =========================================================================
      if (!targetEmail) {
        const pauseReason = 'Cannot send PDF email: no agency_email on case';
        logs.push(`BLOCKED: ${pauseReason}`);
        await db.updateCaseStatus(caseId, 'needs_human_review', {
          requires_human: true,
          pause_reason: pauseReason
        });
        await db.updateProposal(proposalId, {
          status: 'BLOCKED',
          execution_key: null
        });
        return {
          actionExecuted: false,
          gatedForReview: true,
          errors: [pauseReason],
          logs
        };
      }

      // Find the filled PDF attachment for this case
      const attachments = await db.getAttachmentsByCaseId(caseId);
      const pdfAttachment = attachments.find(a =>
        a.filename?.startsWith('filled_') && a.content_type === 'application/pdf'
      );

      if (!pdfAttachment) {
        logs.push('BLOCKED: No filled PDF attachment found for case');
        await db.updateProposal(proposalId, {
          status: 'BLOCKED',
          execution_key: null
        });
        return {
          actionExecuted: false,
          errors: ['No filled PDF attachment found'],
          logs
        };
      }

      // Read PDF from disk or DB file_data
      const fs = require('fs');
      const pdfPath = pdfAttachment.storage_path;
      let pdfBuffer;
      if (pdfPath && fs.existsSync(pdfPath)) {
        pdfBuffer = fs.readFileSync(pdfPath);
      } else {
        // Fall back to DB binary (survives ephemeral deploys)
        const fullAtt = await db.getAttachmentById(pdfAttachment.id);
        if (fullAtt?.file_data) {
          pdfBuffer = fullAtt.file_data;
          logs.push('PDF loaded from database (disk file missing after deploy)');
        }
      }
      if (!pdfBuffer) {
        logs.push(`BLOCKED: PDF file not found on disk or in database`);
        await db.updateProposal(proposalId, {
          status: 'BLOCKED',
          execution_key: null
        });
        return {
          actionExecuted: false,
          errors: ['PDF file not available'],
          logs
        };
      }
      const pdfBase64 = pdfBuffer.toString('base64');

      // Send email with PDF attachment via SendGrid directly
      const sendgridService = require('../../services/sendgrid-service');
      const sendResult = await sendgridService.sendEmail({
        to: targetEmail,
        subject: draftSubject || `Public Records Request - ${caseData.subject_name || caseData.case_name}`,
        text: draftBodyText || draftBodyHtml,
        html: draftBodyHtml || null,
        caseId,
        messageType: 'send_pdf_email',
        attachments: [{
          content: pdfBase64,
          filename: pdfAttachment.filename,
          type: 'application/pdf',
          disposition: 'attachment'
        }]
      });

      logs.push(`PDF email sent to ${targetEmail} (messageId: ${sendResult.messageId})`);

      // Create execution record
      await createExecutionRecord({
        caseId,
        proposalId,
        runId,
        executionKey,
        actionType: 'SEND_PDF_EMAIL',
        status: 'SENT',
        provider: 'email',
        providerPayload: {
          to: targetEmail,
          subject: draftSubject,
          messageId: sendResult.messageId,
          attachmentId: pdfAttachment.id,
          attachmentFilename: pdfAttachment.filename
        }
      });

      // Update proposal status
      await db.updateProposal(proposalId, {
        status: 'EXECUTED',
        executedAt: new Date(),
        emailJobId: sendResult.messageId
      });

      // Update case status
      await db.updateCaseStatus(caseId, 'awaiting_response', {
        substatus: 'PDF form emailed to agency',
        send_date: caseData.send_date || new Date()
      });

      executionResult = {
        action: 'pdf_email_sent',
        messageId: sendResult.messageId,
        attachmentId: pdfAttachment.id,
        to: targetEmail
      };

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
