/**
 * Execute Action Step
 *
 * Port of langgraph/nodes/execute-action.js
 * Executes the approved action via executor adapter.
 */

import db, {
  aiService,
  logger,
  emailExecutor,
  portalExecutor,
  generateExecutionKey,
  createExecutionRecord,
  EXECUTION_MODE,
} from "../lib/db";
import type { ActionType, ExecutionResult } from "../lib/types";

import { submitPortal } from "../tasks/submit-portal";

export async function executeAction(
  caseId: number,
  proposalId: number,
  actionType: ActionType,
  runId: number,
  draft: { subject: string | null; bodyText: string | null; bodyHtml: string | null },
  caseAgencyId: number | null,
  reasoning: string[],
  researchContactResult?: any,
  researchBrief?: any
): Promise<{ actionExecuted: boolean; executionResult: ExecutionResult | null }> {
  // TIMEOUT GUARD
  if (runId) {
    const currentRun = await db.getAgentRunById(runId);
    if (currentRun && ["failed", "skipped"].includes(currentRun.status)) {
      return {
        actionExecuted: false,
        executionResult: { action: "run_already_terminal", runStatus: currentRun.status },
      };
    }
  }

  // IDEMPOTENCY CHECK
  const existingProposal = await db.getProposalById(proposalId);
  if (existingProposal?.status === "EXECUTED") {
    return {
      actionExecuted: true,
      executionResult: { action: "already_executed", emailJobId: existingProposal.email_job_id },
    };
  }
  if (existingProposal?.execution_key) {
    return {
      actionExecuted: true,
      executionResult: { action: "execution_in_progress" },
    };
  }

  // OUTBOUND RATE LIMIT: max 1 outbound per case per cooldown period
  const OUTBOUND_ACTIONS = [
    "SEND_INITIAL_REQUEST", "SEND_FOLLOWUP", "SEND_REBUTTAL", "SEND_CLARIFICATION",
    "SEND_APPEAL", "SEND_FEE_WAIVER_REQUEST", "SEND_STATUS_UPDATE",
    "RESPOND_PARTIAL_APPROVAL", "ACCEPT_FEE", "NEGOTIATE_FEE", "DECLINE_FEE",
    "REFORMULATE_REQUEST", "SUBMIT_PORTAL",
  ];
  if (OUTBOUND_ACTIONS.includes(actionType)) {
    const cooldownHours = parseInt(process.env.OUTBOUND_COOLDOWN_HOURS || "24", 10);
    if (cooldownHours > 0) {
      const recent = await db.query(
        `SELECT id FROM executions
         WHERE case_id = $1 AND status IN ('QUEUED', 'SENT')
           AND action_type = ANY($2::text[])
           AND created_at > NOW() - make_interval(hours => $3)
         LIMIT 1`,
        [caseId, OUTBOUND_ACTIONS, cooldownHours]
      );
      if (recent.rows.length > 0) {
        logger.warn("Outbound rate limit hit", { caseId, proposalId, actionType, cooldownHours });
        await db.updateProposal(proposalId, { status: "BLOCKED", execution_key: null });
        await db.updateCaseStatus(caseId, "needs_human_review", {
          requires_human: true,
          substatus: `Rate limit: already sent within ${cooldownHours}h. Approve to override.`,
        });
        return {
          actionExecuted: false,
          executionResult: { action: "rate_limited", cooldownHours },
        };
      }
    }
  }

  // Recover missing draft data from proposal
  const subject = draft.subject || existingProposal?.draft_subject;
  const bodyText = draft.bodyText || existingProposal?.draft_body_text;
  const bodyHtml = draft.bodyHtml || existingProposal?.draft_body_html;

  // Claim execution
  const executionKey = generateExecutionKey(caseId, actionType, proposalId);
  const claimed = await db.claimProposalExecution(proposalId, executionKey);
  if (!claimed) {
    // Throw so Trigger.dev retries — a claim race is transient
    throw new Error(`Could not claim execution for proposal ${proposalId} — concurrent execution race`);
  }

  // Wrap all execution in try/catch to release claim on error
  try {
  const caseData = await db.getCaseById(caseId);

  // Resolve target agency
  let targetEmail = caseData?.agency_email;
  let targetPortalUrl = caseData?.portal_url;
  if (caseAgencyId) {
    const targetAgency = await db.getCaseAgencyById(caseAgencyId);
    if (targetAgency) {
      targetEmail = targetAgency.agency_email || targetEmail;
      targetPortalUrl = targetAgency.portal_url || targetPortalUrl;
    }
  }

  const hasPortal = portalExecutor.requiresPortal({ ...caseData, portal_url: targetPortalUrl });

  // Portal check for SEND_ actions or explicit SUBMIT_PORTAL
  if (actionType === "SUBMIT_PORTAL" && !hasPortal) {
    throw new Error(`SUBMIT_PORTAL requested but no portal_url for case ${caseId}`);
  }
  const shouldForcePortal = hasPortal && (actionType.startsWith("SEND_") || actionType === "SUBMIT_PORTAL");
  if (shouldForcePortal) {
    // For follow-ups on portals with existing request numbers,
    // use the request-specific URL instead of /requests/new
    const isFollowup = actionType !== "SEND_INITIAL_REQUEST" && actionType !== "SUBMIT_PORTAL";
    const requestNumber = caseData?.portal_request_number;
    let portalInstructions = bodyText || bodyHtml || null;

    if (isFollowup && requestNumber && targetPortalUrl) {
      // Build request-specific URL for NextRequest portals
      const baseUrl = targetPortalUrl.replace(/\/requests\/new\/?$/, "");
      const requestUrl = `${baseUrl}/requests/${requestNumber}`;
      targetPortalUrl = requestUrl;
      portalInstructions = `IMPORTANT: This is a FOLLOW-UP message on existing request #${requestNumber}.\n` +
        `Navigate to ${requestUrl} and add a message/reply to the existing request.\n` +
        `Do NOT create a new request.\n\n` +
        `Message to send:\n${portalInstructions}`;
    }

    const portalResult = await portalExecutor.createPortalTask({
      caseId,
      caseData,
      proposalId,
      runId,
      actionType,
      subject,
      bodyText: isFollowup && requestNumber ? portalInstructions : bodyText,
      bodyHtml,
    });
    await db.updateProposal(proposalId, { status: "PENDING_PORTAL" });

    // Trigger portal submission as a separate Trigger.dev task
    await submitPortal.trigger({
      caseId,
      portalUrl: targetPortalUrl!,
      provider: caseData.portal_provider || null,
      instructions: portalInstructions,
      portalTaskId: portalResult.taskId || null,
    }, {
      queue: { name: `case-${caseId}`, concurrencyLimit: 1 },
      idempotencyKey: `exec-portal:${caseId}:${proposalId}`,
      idempotencyKeyTTL: "1h",
    });

    return {
      actionExecuted: false,
      executionResult: { action: "portal_task_created", ...portalResult },
    };
  }

  let executionResult: ExecutionResult | null = null;

  switch (actionType) {
    case "SUBMIT_PORTAL":
      // SUBMIT_PORTAL should always be caught by shouldForcePortal above.
      // If we get here, it means hasPortal was false but we didn't throw — should not happen.
      throw new Error(`SUBMIT_PORTAL reached switch but was not handled by portal check for case ${caseId}`);

    case "SEND_INITIAL_REQUEST":
    case "SEND_FOLLOWUP":
    case "SEND_REBUTTAL":
    case "SEND_CLARIFICATION":
    case "SEND_APPEAL":
    case "SEND_FEE_WAIVER_REQUEST":
    case "SEND_STATUS_UPDATE":
    case "RESPOND_PARTIAL_APPROVAL":
    case "ACCEPT_FEE":
    case "NEGOTIATE_FEE":
    case "DECLINE_FEE":
    case "REFORMULATE_REQUEST": {
      // Validate
      if (!targetEmail && !hasPortal) throw new Error("No agency_email or portal_url");
      if (!subject) throw new Error("No subject for email");
      if (!bodyText && !bodyHtml) throw new Error("No body content for email");

      if (!targetEmail && hasPortal) {
        const portalResult = await portalExecutor.createPortalTask({
          caseId, caseData, proposalId, runId, actionType, subject, bodyText, bodyHtml,
        });
        await db.updateProposal(proposalId, { status: "PENDING_PORTAL" });
        return { actionExecuted: false, executionResult: { action: "portal_task_created", ...portalResult } };
      }

      const thread = await db.getThreadByCaseId(caseId);
      const latestInbound = await db.getLatestInboundMessage(caseId);
      const isInitial = actionType === "SEND_INITIAL_REQUEST";
      const delayMinutes = isInitial ? 0 : Math.floor(Math.random() * 480) + 120;
      const delayMs = delayMinutes * 60 * 1000;

      const emailResult = await emailExecutor.sendEmail({
        to: targetEmail,
        subject,
        bodyHtml,
        bodyText,
        headers: latestInbound ? { "In-Reply-To": latestInbound.message_id, References: latestInbound.message_id } : null,
        caseId,
        proposalId,
        runId,
        actionType,
        delayMs,
        threadId: thread?.id,
        originalMessageId: latestInbound?.message_id,
      });

      if (!emailResult || emailResult.success !== true) {
        await db.updateProposal(proposalId, { status: "BLOCKED", execution_key: null });
        await db.updateCaseStatus(caseId, "needs_human_review", {
          requires_human: true,
          pause_reason: "EMAIL_FAILED",
          substatus: `Email send failed: ${emailResult?.error || "unknown"}`.substring(0, 100),
        });
        return { actionExecuted: false, executionResult: { action: "email_failed" } };
      }

      executionResult = { action: emailResult.dryRun ? "dry_run_skipped" : "email_queued", ...emailResult };

      await createExecutionRecord({
        caseId, proposalId, runId, executionKey, actionType,
        status: emailResult.dryRun ? "DRY_RUN" : "QUEUED",
        provider: emailResult.dryRun ? "dry_run" : "email",
        providerPayload: { to: targetEmail, subject, jobId: emailResult.jobId, delayMinutes },
      });

      await db.updateProposal(proposalId, {
        status: "EXECUTED",
        executedAt: new Date(),
        emailJobId: emailResult.jobId || `dry_run_${executionKey}`,
      });

      // Log fee events
      if (["ACCEPT_FEE", "NEGOTIATE_FEE", "DECLINE_FEE"].includes(actionType) && !emailResult.dryRun) {
        try {
          const feeEventMap: Record<string, string> = { ACCEPT_FEE: "accepted", NEGOTIATE_FEE: "negotiated", DECLINE_FEE: "declined" };
          await db.logFeeEvent(caseId, feeEventMap[actionType], caseData?.last_fee_quote_amount || null, `${actionType} executed via proposal ${proposalId}`, null);
        } catch (e: any) { /* non-fatal */ }
      }

      // Schedule next followup if this was a followup or status update
      if ((actionType === "SEND_FOLLOWUP" || actionType === "SEND_STATUS_UPDATE") && !emailResult.dryRun) {
        const followupDays = parseInt(process.env.FOLLOWUP_DELAY_DAYS || "7", 10);
        const nextDate = new Date();
        nextDate.setDate(nextDate.getDate() + followupDays);
        await db.upsertFollowUpSchedule(caseId, { nextFollowupDate: nextDate, lastFollowupSentAt: new Date() });
      }

      await db.updateCaseStatus(caseId, "awaiting_response", { requires_human: false, pause_reason: null });
      break;
    }

    case "ESCALATE": {
      const escalation = await db.upsertEscalation({
        caseId,
        executionKey,
        reason: (reasoning || []).join("; ") || "Escalated by agent",
        urgency: "medium",
        suggestedAction: "Review case and decide next steps",
      });
      await createExecutionRecord({
        caseId, proposalId, runId, executionKey, actionType: "ESCALATE",
        status: "SENT", provider: "none",
        providerPayload: { escalationId: escalation.id, wasNew: escalation.wasInserted },
      });
      if (escalation.wasInserted) {
        try {
          // @ts-ignore
          const discordService = require("../../services/discord-service");
          await discordService.sendCaseEscalation(caseData, escalation);
        } catch (e: any) { /* non-fatal */ }
      }
      executionResult = { action: "escalated", escalationId: escalation.id };
      await db.updateProposal(proposalId, { status: "EXECUTED", executedAt: new Date() });
      break;
    }

    case "RESEARCH_AGENCY": {
      await createExecutionRecord({
        caseId, proposalId, runId, executionKey, actionType: "RESEARCH_AGENCY",
        status: "SENT", provider: "none", providerPayload: { reason: "Agency research complete" },
      });
      await db.updateProposal(proposalId, { status: "EXECUTED", executedAt: new Date() });

      // Auto-create follow-up proposal for new agency
      let contactResult = researchContactResult || null;
      let brief = researchBrief || null;
      if (!brief) {
        try {
          const freshCase = await db.getCaseById(caseId);
          if (freshCase?.contact_research_notes) {
            const parsed = typeof freshCase.contact_research_notes === "string"
              ? JSON.parse(freshCase.contact_research_notes)
              : freshCase.contact_research_notes;
            contactResult = contactResult || parsed.contactResult || null;
            brief = parsed.brief || null;
          }
        } catch (e: any) { /* non-fatal */ }
      }

      const suggestedAgency = brief?.suggested_agencies?.[0] || null;
      if (!suggestedAgency?.name) {
        await db.updateCaseStatus(caseId, "needs_human_review", { substatus: "agency_research_complete", requires_human: true });
        executionResult = { action: "research_complete", followup: "none" };
        break;
      }

      let newEmail = contactResult?.contact_email || null;
      let newPortalUrl = contactResult?.portal_url || null;
      let agencyId = null;
      try {
        const known = await db.findAgencyByName(suggestedAgency.name, caseData?.state || null);
        if (known) {
          agencyId = known.id;
          newEmail = newEmail || known.email_main || null;
          newPortalUrl = newPortalUrl || known.portal_url || null;
        }
      } catch (e: any) { /* non-fatal */ }

      if (!newEmail && !newPortalUrl) {
        await db.updateCaseStatus(caseId, "needs_human_review", { substatus: "agency_research_complete", requires_human: true });
        executionResult = { action: "research_complete", followup: "no_contact_info" };
        break;
      }

      let caseAgency;
      try {
        caseAgency = await db.addCaseAgency(caseId, {
          agency_id: agencyId,
          agency_name: suggestedAgency.name,
          agency_email: newEmail,
          portal_url: newPortalUrl,
          is_primary: false,
          added_source: "research",
          notes: suggestedAgency.reason || brief?.summary || null,
        });
      } catch (e: any) {
        await db.updateCaseStatus(caseId, "needs_human_review", { substatus: "agency_research_complete", requires_human: true });
        executionResult = { action: "research_complete", followup: "add_agency_failed" };
        break;
      }

      let foiaResult;
      try {
        foiaResult = await aiService.generateFOIARequest({ ...caseData, agency_name: suggestedAgency.name });
      } catch (e: any) {
        await db.updateCaseStatus(caseId, "needs_human_review", { substatus: "agency_research_complete", requires_human: true });
        executionResult = { action: "research_complete", followup: "foia_generation_failed" };
        break;
      }

      const followupActionType = newPortalUrl ? "SUBMIT_PORTAL" : "SEND_INITIAL_REQUEST";
      const followupKey = `${caseId}:research:ca${caseAgency.id}:${followupActionType}:0`;
      try {
        await db.upsertProposal({
          proposalKey: followupKey,
          caseId,
          runId: runId || null,
          actionType: followupActionType,
          draftSubject: `Public Records Request - ${caseData?.subject_name || "Records Request"}`,
          draftBodyText: foiaResult.request_text,
          reasoning: [`Research identified ${suggestedAgency.name} as likely records holder`],
          confidence: suggestedAgency.confidence || 0.7,
          requiresHuman: true,
          canAutoExecute: false,
          status: "PENDING_APPROVAL",
        });
      } catch (e: any) {
        await db.updateCaseStatus(caseId, "needs_human_review", { substatus: "agency_research_complete", requires_human: true });
        executionResult = { action: "research_complete", followup: "proposal_creation_failed" };
        break;
      }

      await db.updateCaseStatus(caseId, "needs_human_review", { substatus: "research_followup_proposed", requires_human: true });
      await db.logActivity("research_followup_proposed", `Research complete - proposed ${followupActionType} to ${suggestedAgency.name}`, {
        caseId, proposalId, newAgency: suggestedAgency.name, actionType: followupActionType,
      });

      executionResult = {
        action: "research_complete",
        followup: "proposal_created",
        newAgency: suggestedAgency.name,
        actionType: followupActionType,
      };
      break;
    }

    case "CLOSE_CASE": {
      await db.updateCaseStatus(caseId, "completed", { substatus: "Denial accepted", requires_human: false });
      await db.updateCase(caseId, { outcome_type: "denial_accepted", outcome_recorded: true });
      await createExecutionRecord({
        caseId, proposalId, runId, executionKey, actionType: "CLOSE_CASE",
        status: "SENT", provider: "none", providerPayload: { reason: "Denial accepted" },
      });
      executionResult = { action: "case_closed", reason: "denial_accepted" };
      await db.updateProposal(proposalId, { status: "EXECUTED", executedAt: new Date() });
      break;
    }

    case "NONE": {
      await createExecutionRecord({
        caseId, proposalId, runId, executionKey, actionType: "NONE",
        status: "SKIPPED", provider: "none", providerPayload: { reason: "No action required" },
      });
      executionResult = { action: "none" };
      await db.updateProposal(proposalId, { status: "EXECUTED", executedAt: new Date() });
      break;
    }

    default:
      throw new Error(`Unknown action type: ${actionType}`);
  }

  // Log activity
  await db.logActivity("agent_action_executed", `Executed ${actionType}`, {
    caseId, proposalId, executionKey, mode: EXECUTION_MODE, result: executionResult,
  });

  // Dismiss other pending proposals (except RESEARCH_AGENCY which creates follow-ups)
  if (actionType !== "RESEARCH_AGENCY") {
    try {
      await db.dismissPendingProposals(caseId, `Superseded by executed ${actionType}`);
    } catch (e: any) { /* non-fatal */ }
  }

  return { actionExecuted: true, executionResult };

  } catch (execError: any) {
    // Release claim so proposal can be retried
    try {
      await db.updateProposal(proposalId, { execution_key: null });
    } catch (releaseErr: any) {
      logger.error("Failed to release execution claim after error", {
        caseId, proposalId, error: releaseErr.message,
      });
    }
    throw execError; // Re-throw for Trigger.dev retry
  }
}
