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
  caseRuntime,
} from "../lib/db";
import type { ActionType, ExecutionResult } from "../lib/types";
import { hasAutomatablePortal, isNonAutomatablePortalProvider } from "../lib/portal-utils";
import { textClaimsAttachment, stripAttachmentClaimLines } from "../lib/text-sanitize";

const AI_ROUTER_V2_EXEC = process.env.AI_ROUTER_V2 || "false";

function isAIRouterV2Active(caseId: number): boolean {
  if (AI_ROUTER_V2_EXEC === "true") return true;
  if (AI_ROUTER_V2_EXEC === "false") return false;
  const pct = parseInt(AI_ROUTER_V2_EXEC, 10);
  if (isNaN(pct)) return false;
  return (caseId % 100) < pct;
}

async function applyClassificationSideEffects(
  caseId: number,
  actionType: ActionType,
  classification?: string | null
): Promise<void> {
  // WRONG_AGENCY cleanup: cancel portal tasks, dismiss proposals, add constraint
  // In legacy mode these run at decision time in decide-next-action.ts.
  // In v2 mode they run here at execution time so the AI decision is read-only.
  // Only fire for explicit WRONG_AGENCY classification — not for RESEARCH_AGENCY from other reasons
  // (e.g., no_records denial, bodycam custodian research) which should NOT cancel portal tasks.
  if (classification === "WRONG_AGENCY") {
    // Atomically cancel portal tasks + dismiss portal-type proposals via the runtime
    await caseRuntime.transitionCaseRuntime(caseId, "CASE_WRONG_AGENCY", {});

    const caseData = await db.getCaseById(caseId);
    const currentConstraints = caseData?.constraints_jsonb || caseData?.constraints || [];
    if (!currentConstraints.includes("WRONG_AGENCY")) {
      await db.updateCase(caseId, {
        constraints_jsonb: JSON.stringify([...currentConstraints, "WRONG_AGENCY"]),
      });
    }

    logger.info("Applied WRONG_AGENCY classification side effects at execution time (v2)", {
      caseId, actionType, classification,
    });
  }
}

function buildReplyHeaders(
  targetEmail: string | null | undefined,
  latestInbound: any
): Record<string, string> | null {
  const messageId = latestInbound?.message_id;
  if (!messageId) return null;

  const inboundFrom = String(latestInbound?.from_email || "").trim().toLowerCase();
  const target = String(targetEmail || "").trim().toLowerCase();
  if (!inboundFrom || !target) return null;

  // Only thread when replying to the same mailbox. Cross-recipient threading
  // can make it appear like we're replying to the wrong contact.
  if (inboundFrom !== target) {
    return null;
  }

  return {
    "In-Reply-To": messageId,
    References: messageId,
  };
}

function normalizeEmail(value: any): string | null {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw || !raw.includes("@")) return null;
  return raw;
}

function isAutoBotMailbox(email: string | null): boolean {
  if (!email) return false;
  return email.endsWith("@foib-request.com") || email.endsWith("@autobot.local");
}

function normalizePortalForCompare(value: any): string | null {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw) return null;
  return raw
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/\/+$/, "");
}

function normalizePhoneForCompare(value: any): string | null {
  const digits = String(value || "").replace(/\D/g, "");
  if (digits.length < 7) return null;
  return digits;
}

export async function executeAction(
  caseId: number,
  proposalId: number,
  actionType: ActionType,
  runId: number,
  draft: { subject: string | null; bodyText: string | null; bodyHtml: string | null },
  caseAgencyId: number | null,
  reasoning: string[],
  researchContactResult?: any,
  researchBrief?: any,
  classification?: string | null,
  options?: { chainId?: string }
): Promise<{ actionExecuted: boolean; executionResult: ExecutionResult | null }> {
  // AI Router v2: apply classification side effects at execution time
  if (isAIRouterV2Active(caseId) && classification) {
    await applyClassificationSideEffects(caseId, actionType, classification);
  }

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
  const proposalActionType = existingProposal?.action_type as ActionType | undefined;
  let effectiveActionType: ActionType = actionType;
  if (proposalActionType && proposalActionType !== actionType) {
    logger.error("executeAction action mismatch; enforcing proposal action_type", {
      caseId,
      proposalId,
      requestedActionType: actionType,
      proposalActionType,
      runId,
    });
    effectiveActionType = proposalActionType;
  }
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

  // If this proposal already has a queued/sent execution, treat retries as idempotent success.
  // This prevents duplicate waiting runs from flipping a legitimately sent proposal to BLOCKED.
  const existingExecution = await db.query(
    `SELECT id, status, action_type, created_at
     FROM executions
     WHERE proposal_id = $1
       AND status IN ('QUEUED', 'SENT')
     ORDER BY created_at DESC
     LIMIT 1`,
    [proposalId]
  );
  if (existingExecution.rows.length > 0) {
    const prior = existingExecution.rows[0];
    logger.info("Skipping duplicate executeAction; proposal already has execution", {
      caseId,
      proposalId,
      actionType: effectiveActionType,
      existingExecutionId: prior.id,
      existingExecutionStatus: prior.status,
    });
    await caseRuntime.transitionCaseRuntime(caseId, "EMAIL_SENT", { proposalId });
    return {
      actionExecuted: true,
      executionResult: { action: "already_sent_for_proposal", executionId: prior.id },
    };
  }

  // OUTBOUND RATE LIMIT: max 1 outbound per case per cooldown period
  const OUTBOUND_ACTIONS = [
    "SEND_INITIAL_REQUEST", "SEND_FOLLOWUP", "SEND_REBUTTAL", "SEND_CLARIFICATION",
    "SEND_APPEAL", "SEND_FEE_WAIVER_REQUEST", "SEND_STATUS_UPDATE",
    "RESPOND_PARTIAL_APPROVAL", "ACCEPT_FEE", "NEGOTIATE_FEE", "DECLINE_FEE",
    "REFORMULATE_REQUEST", "SUBMIT_PORTAL",
  ];
  if (OUTBOUND_ACTIONS.includes(effectiveActionType)) {
    // Skip rate limit for chain follow-ups (pre-approved as part of chain)
    const isChainFollowUp = options?.chainId != null;
    if (!isChainFollowUp) {
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
          await caseRuntime.transitionCaseRuntime(caseId, "PROPOSAL_BLOCKED", {
            proposalId,
            error: `Rate limit: already sent within ${cooldownHours}h. Approve to override.`,
          });
          return {
            actionExecuted: false,
            executionResult: { action: "rate_limited", cooldownHours },
          };
        }
      }
    }
  }

  // Recover missing draft data from proposal
  const subject = draft.subject || existingProposal?.draft_subject;
  const originalBodyText = draft.bodyText || existingProposal?.draft_body_text;
  const originalBodyHtml = draft.bodyHtml || existingProposal?.draft_body_html;

  // Claim execution
  const executionKey = generateExecutionKey(caseId, effectiveActionType, proposalId);
  const claimed = await db.claimProposalExecution(proposalId, executionKey);
  if (!claimed) {
    // Throw so Trigger.dev retries — a claim race is transient
    throw new Error(`Could not claim execution for proposal ${proposalId} — concurrent execution race`);
  }

  // Wrap all execution in try/catch to release claim on error
  try {
  const caseData = await db.getCaseById(caseId);

  // Resolve target agency
  let targetEmail = normalizeEmail(caseData?.agency_email);
  let targetPortalUrl = caseData?.portal_url;
  let resolvedCaseAgencyId =
    caseAgencyId ||
    (existingProposal?.case_agency_id ? Number(existingProposal.case_agency_id) : null) ||
    null;
  if (resolvedCaseAgencyId) {
    const targetAgency = await db.getCaseAgencyById(resolvedCaseAgencyId);
    if (targetAgency) {
      targetEmail = normalizeEmail(targetAgency.agency_email) || targetEmail;
      targetPortalUrl = targetAgency.portal_url || targetPortalUrl;
    }
  }

  // Fallback: for portal-threaded agencies (e.g. NextRequest), the reliable
  // destination can exist on email_threads / latest inbound even when
  // cases.agency_email is null.
  const thread = resolvedCaseAgencyId
    ? (await db.getThreadByCaseAgencyId(resolvedCaseAgencyId)) || (await db.getThreadByCaseId(caseId))
    : await db.getThreadByCaseId(caseId);
  const latestInbound = await db.getLatestInboundMessage(caseId);
  const inboundFrom = normalizeEmail(latestInbound?.from_email);
  const threadAgencyEmail = normalizeEmail(thread?.agency_email);
  if (!targetEmail) {
    const fallbackTargetEmail = [threadAgencyEmail, inboundFrom].find(
      (candidate) => candidate && !isAutoBotMailbox(candidate)
    ) || null;
    if (fallbackTargetEmail) {
      targetEmail = fallbackTargetEmail;
      logger.info("Resolved target email from thread/inbound fallback", {
        caseId,
        proposalId,
        actionType,
        fallbackTargetEmail,
      });

      // Persist learned destination so future runs/UI resolve consistently.
      try {
        if (!resolvedCaseAgencyId) {
          const primary = await db.getPrimaryCaseAgency(caseId);
          if (primary?.id) resolvedCaseAgencyId = primary.id;
        }
        if (resolvedCaseAgencyId) {
          await db.updateCaseAgency(resolvedCaseAgencyId, { agency_email: fallbackTargetEmail });
        } else {
          await db.updateCase(caseId, { agency_email: fallbackTargetEmail });
        }
      } catch (persistErr: any) {
        logger.warn("Failed to persist fallback target email", {
          caseId,
          fallbackTargetEmail,
          error: persistErr?.message || String(persistErr),
        });
      }
    }
  }

  const hasPortal = hasAutomatablePortal(targetPortalUrl, caseData?.portal_provider);

  // Portal check for SEND_ actions or explicit SUBMIT_PORTAL
  // If SUBMIT_PORTAL but no portal, downgrade to email send (common after agency redirect)
  let resolvedActionType: ActionType = effectiveActionType;
  if (effectiveActionType === "SUBMIT_PORTAL" && !hasPortal) {
    if (isNonAutomatablePortalProvider(caseData?.portal_provider)) {
      logger.info("SUBMIT_PORTAL downgraded to email — provider marked as non-automatable", {
        caseId,
        provider: caseData?.portal_provider,
        targetEmail,
      });
    }
    if (targetEmail) {
      logger.info("SUBMIT_PORTAL downgraded to email — no portal_url after agency override", { caseId, targetEmail });
      resolvedActionType = "SEND_INITIAL_REQUEST";
      try {
        await db.updateProposal(proposalId, { actionType: resolvedActionType });
      } catch (err: any) {
        logger.warn("Failed to update proposal action_type after SUBMIT_PORTAL downgrade", {
          caseId,
          proposalId,
          error: err?.message || String(err),
        });
      }
    } else {
      throw new Error(`SUBMIT_PORTAL requested but no portal_url or email for case ${caseId}`);
    }
  }
  const shouldForcePortal = hasPortal && (resolvedActionType.startsWith("SEND_") || resolvedActionType === "SUBMIT_PORTAL");
  if (shouldForcePortal) {
    // For follow-ups on portals with existing request numbers,
    // use the request-specific URL instead of /requests/new
    const isFollowup = resolvedActionType !== "SEND_INITIAL_REQUEST" && resolvedActionType !== "SUBMIT_PORTAL";
    const requestNumber = caseData?.portal_request_number;
    let portalInstructions = originalBodyText || originalBodyHtml || null;

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
        actionType: resolvedActionType,
        subject,
        bodyText: isFollowup && requestNumber ? portalInstructions : originalBodyText,
        bodyHtml: originalBodyHtml,
      });
    await caseRuntime.transitionCaseRuntime(caseId, "PORTAL_TASK_CREATED", {
      proposalId,
      portalTaskId: portalResult.portalTaskId,
    });

    // Don't trigger submit-portal from within this task — child tasks get stuck
    // in PENDING_VERSION during deploys. Instead, the Railway cron sweep picks up
    // PENDING_PORTAL proposals and dispatches submit-portal as a top-level task.
    return {
      actionExecuted: false,
      executionResult: { action: "portal_task_created", ...portalResult },
    };
  }

  let executionResult: ExecutionResult | null = null;

  switch (resolvedActionType) {
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
      // This execution path currently sends no attachments. Prevent accidental
      // "Attached..." claims from drafts when nothing is actually attached.
      let bodyText = originalBodyText;
      let bodyHtml = originalBodyHtml;
      if (textClaimsAttachment(bodyText) || textClaimsAttachment(bodyHtml)) {
        bodyText = bodyText ? stripAttachmentClaimLines(bodyText) : bodyText;
        bodyHtml = null; // Force plain-text fallback derived from sanitized bodyText.
        logger.warn("Removed attachment claim from outbound draft with no attachments", {
          caseId,
          proposalId,
          actionType: resolvedActionType,
        });
      }

      if (!targetEmail && !hasPortal) throw new Error("No agency_email or portal_url");
      if (!subject) throw new Error("No subject for email");
      if (!bodyText && !bodyHtml) throw new Error("No body content for email");

      if (!targetEmail && hasPortal) {
        const portalResult = await portalExecutor.createPortalTask({
          caseId, caseData, proposalId, runId, actionType, subject, bodyText, bodyHtml,
        });
        await caseRuntime.transitionCaseRuntime(caseId, "PORTAL_TASK_CREATED", {
          proposalId,
          portalTaskId: portalResult.portalTaskId,
        });
        return { actionExecuted: false, executionResult: { action: "portal_task_created", ...portalResult } };
      }

      // REFORMULATE_REQUEST is a brand-new FOIA request — send as fresh email, not a reply
      const isFreshEmail = resolvedActionType === "REFORMULATE_REQUEST" || resolvedActionType === "SEND_INITIAL_REQUEST";
      const replyHeaders = isFreshEmail ? {} : buildReplyHeaders(targetEmail, latestInbound);
      const delayMinutes = isFreshEmail ? 0 : Math.floor(Math.random() * 480) + 120;
      const delayMs = delayMinutes * 60 * 1000;

      const emailResult = await emailExecutor.sendEmail({
        to: targetEmail,
        subject,
        bodyHtml,
        bodyText,
        headers: replyHeaders,
        caseId,
        proposalId,
        runId,
        actionType: resolvedActionType,
        delayMs,
        threadId: isFreshEmail ? undefined : thread?.id,
        originalMessageId: isFreshEmail ? undefined : latestInbound?.message_id,
      });

      if (!emailResult || emailResult.success !== true) {
        // Release execution claim so proposal can be retried
        await db.updateProposal(proposalId, { execution_key: null });
        await caseRuntime.transitionCaseRuntime(caseId, "EMAIL_FAILED", {
          proposalId,
          error: `Email send failed: ${emailResult?.error || "unknown"}`.substring(0, 100),
        });
        return { actionExecuted: false, executionResult: { action: "email_failed" } };
      }

      executionResult = { action: emailResult.dryRun ? "dry_run_skipped" : "email_queued", ...emailResult };

      await createExecutionRecord({
        caseId, proposalId, runId, executionKey, actionType: resolvedActionType,
        status: emailResult.dryRun ? "DRY_RUN" : "QUEUED",
        provider: emailResult.dryRun ? "dry_run" : "email",
        providerPayload: { to: targetEmail, subject, jobId: emailResult.jobId, delayMinutes },
      });

      // Store emailJobId separately (not part of the runtime event)
      await db.updateProposal(proposalId, {
        emailJobId: emailResult.jobId || `dry_run_${executionKey}`,
      });

      // Atomically mark proposal EXECUTED + case awaiting_response
      await caseRuntime.transitionCaseRuntime(caseId, "EMAIL_SENT", { proposalId });

      // Log fee events
      if (["ACCEPT_FEE", "NEGOTIATE_FEE", "DECLINE_FEE"].includes(resolvedActionType) && !emailResult.dryRun) {
        try {
          const feeEventMap: Record<string, string> = { ACCEPT_FEE: "accepted", NEGOTIATE_FEE: "negotiated", DECLINE_FEE: "declined" };
          await db.logFeeEvent(caseId, feeEventMap[resolvedActionType], caseData?.last_fee_quote_amount || null, `${resolvedActionType} executed via proposal ${proposalId}`, null);
        } catch (e: any) { /* non-fatal */ }
      }

      // Schedule next followup if this was a followup or status update
      if ((resolvedActionType === "SEND_FOLLOWUP" || resolvedActionType === "SEND_STATUS_UPDATE") && !emailResult.dryRun) {
        const followupDays = parseInt(process.env.FOLLOWUP_DELAY_DAYS || "7", 10);
        const nextDate = new Date();
        nextDate.setDate(nextDate.getDate() + followupDays);
        await db.upsertFollowUpSchedule(caseId, { nextFollowupDate: nextDate, lastFollowupSentAt: new Date() });
      }

      break;
    }

    case "ESCALATE": {
      const hasPhoneFollowupMarker = Array.isArray(reasoning)
        && reasoning.some((r) => String(r).includes("FOLLOWUP_CHANNEL:PHONE"));
      const hasFaxFollowupMarker = Array.isArray(reasoning)
        && reasoning.some((r) => String(r).includes("FOLLOWUP_CHANNEL:FAX"));
      const suggestedAction = hasPhoneFollowupMarker
        ? "Call agency follow-up using newly researched number"
        : hasFaxFollowupMarker
          ? "Fax agency follow-up using newly researched fax number"
          : "Review case and decide next steps";

      const escalation = await db.upsertEscalation({
        caseId,
        executionKey,
        reason: (reasoning || []).join("; ") || "Escalated by agent",
        urgency: "medium",
        suggestedAction,
      });
      let phoneTaskId: number | null = null;
      if (hasPhoneFollowupMarker) {
        try {
          // @ts-ignore
          const followupScheduler = require("../../services/followup-scheduler");
          const phoneTask = await followupScheduler.escalateToPhoneQueue(caseId, "no_email_response", {
            notes: draft?.bodyText || "Research found a new phone contact for overdue follow-up.",
          });
          phoneTaskId = phoneTask?.id || null;
        } catch (e: any) {
          logger.warn("Failed to create phone call task during escalation", {
            caseId,
            proposalId,
            error: e?.message || String(e),
          });
        }
      }
      await createExecutionRecord({
        caseId, proposalId, runId, executionKey, actionType: "ESCALATE",
        status: "SENT", provider: "none",
        providerPayload: { escalationId: escalation.id, wasNew: escalation.wasInserted, phoneTaskId },
      });
      if (escalation.wasInserted) {
        try {
          // @ts-ignore
          const discordService = require("../../services/discord-service");
          await discordService.sendCaseEscalation(caseData, escalation);
        } catch (e: any) { /* non-fatal */ }
      }
      executionResult = { action: "escalated", escalationId: escalation.id, phoneTaskId };
      await caseRuntime.transitionCaseRuntime(caseId, "PROPOSAL_EXECUTED", { proposalId });
      break;
    }

    case "RESEARCH_AGENCY": {
      await createExecutionRecord({
        caseId, proposalId, runId, executionKey, actionType: "RESEARCH_AGENCY",
        status: "SENT", provider: "none", providerPayload: { reason: "Agency research complete" },
      });
      await caseRuntime.transitionCaseRuntime(caseId, "PROPOSAL_EXECUTED", { proposalId });

      const ensureResearchHandoffProposal = async (
        handoffKey: string,
        handoffReason: string,
        body: string,
        opts?: { subject?: string; gateOptions?: string[] }
      ) => {
        try {
          // Include runId so a previously auto-dismissed handoff proposal from an older
          // run cannot block creation of a fresh, actionable handoff proposal.
          const handoffProposalKey = `${caseId}:research:handoff:${handoffKey}:${runId || "no-run"}`;
          await db.upsertProposal({
            proposalKey: handoffProposalKey,
            caseId,
            runId: runId || null,
            actionType: "RESEARCH_AGENCY",
            draftSubject: opts?.subject || `Research handoff needed - case ${caseId}`,
            draftBodyText: body,
            reasoning: [handoffReason],
            confidence: 0.4,
            requiresHuman: true,
            canAutoExecute: false,
            status: "PENDING_APPROVAL",
            gateOptions: opts?.gateOptions || null,
          });
        } catch (proposalErr: any) {
          logger.warn("Failed to create research handoff proposal", {
            caseId,
            handoffKey,
            error: proposalErr?.message || String(proposalErr),
          });
        }
      };

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

      // If AI research itself failed (timeout/error), surface honest messaging
      if (brief?.researchFailed) {
        await ensureResearchHandoffProposal(
          "research-failed",
          "Agency research failed due to an error or timeout.",
          `Agency research failed: ${brief.summary || "Unknown error"}. You can retry the research, provide an adjustment instruction with the correct agency name, or dismiss this proposal.`,
          {
            subject: `Research failed — case ${caseId}`,
            gateOptions: ["RETRY_RESEARCH", "ADJUST", "DISMISS"],
          }
        );
        await caseRuntime.transitionCaseRuntime(caseId, "CASE_ESCALATED", {
          substatus: "agency_research_failed",
          pauseReason: "RESEARCH_HANDOFF",
        });
        executionResult = { action: "research_failed", followup: "needs_retry" };
        break;
      }

      const suggestedAgencies = Array.isArray(brief?.suggested_agencies)
        ? brief.suggested_agencies
        : [];
      const inboundTextForAgencyHint = `${latestInbound?.subject || ""}\n${latestInbound?.body_text || ""}`.toLowerCase();
      const prefersIowaDCI = /iowa\s+dci|division of criminal investigation|department of public safety/.test(inboundTextForAgencyHint);
      const suggestedAgency = prefersIowaDCI
        ? (suggestedAgencies.find((a: any) => {
            const n = String(a?.name || "").toLowerCase();
            return n.includes("iowa") && (n.includes("dci") || n.includes("division of criminal investigation") || n.includes("department of public safety"));
          }) || suggestedAgencies[0] || null)
        : (suggestedAgencies[0] || null);
      if (!suggestedAgency?.name) {
        await ensureResearchHandoffProposal(
          "no-suggested-agency",
          "Research completed but no clear target agency was identified.",
          "Research completed but no suggested agency was identified. Review the latest inbound and research notes, then choose an agency or add contact details before retrying.",
          { gateOptions: ["RETRY_RESEARCH", "ADJUST", "DISMISS"] }
        );
        await caseRuntime.transitionCaseRuntime(caseId, "CASE_ESCALATED", {
          substatus: "agency_research_complete",
          pauseReason: "RESEARCH_HANDOFF",
        });
        executionResult = { action: "research_complete", followup: "none" };
        break;
      }

      // Never bind generic contact lookup output to a different suggested agency.
      // Example failure mode: contactResult for Milford accidentally applied to DCI.
      let candidateEmail: string | null = null;
      let candidatePortalUrl: string | null = null;
      let candidatePhone: string | null = null;
      let candidateFax: string | null = null;
      const contactName = String(contactResult?.agency_name || contactResult?.name || "").trim().toLowerCase();
      const suggestedName = String(suggestedAgency?.name || "").trim().toLowerCase();
      const contactMatchesSuggested = !!contactName && (
        contactName.includes(suggestedName) || suggestedName.includes(contactName)
      );
      if (contactResult && contactMatchesSuggested) {
        candidateEmail = contactResult.contact_email || null;
        candidatePortalUrl = contactResult.portal_url || null;
        candidatePhone = contactResult.contact_phone || null;
        candidateFax = contactResult.contact_fax || null;
      } else if (contactResult && !contactMatchesSuggested) {
        logger.warn("Skipping mismatched contactResult for suggested agency", {
          caseId,
          suggestedAgency: suggestedAgency?.name || null,
          contactAgency: contactResult?.agency_name || contactResult?.name || null,
        });
      }
      let agencyId = null;
      let knownAgencyPhone: string | null = null;
      let knownAgencyFax: string | null = null;
      try {
        const known = await db.findAgencyByName(suggestedAgency.name, caseData?.state || null);
        if (known) {
          agencyId = known.id;
          candidateEmail = candidateEmail || known.email_main || known.email_foia || null;
          candidatePortalUrl = candidatePortalUrl || known.portal_url || known.portal_url_alt || null;
          knownAgencyPhone = known.phone || null;
          knownAgencyFax = known.fax || null;
        }
      } catch (e: any) { /* non-fatal */ }
      candidatePhone = candidatePhone || knownAgencyPhone;
      candidateFax = candidateFax || knownAgencyFax;

      // Only propose channels that are genuinely NEW vs existing case channels.
      const existingEmails = new Set<string>();
      const existingPortals = new Set<string>();
      const existingPhones = new Set<string>();
      const existingFaxes = new Set<string>();
      try {
        const existingCaseAgencies = await db.query(
          `SELECT ca.agency_email, ca.portal_url, a.phone, a.fax
           FROM case_agencies ca
           LEFT JOIN agencies a ON ca.agency_id = a.id
           WHERE ca.case_id = $1`,
          [caseId]
        );
        const knownEmails = [
          caseData?.agency_email,
          caseData?.alternate_agency_email,
          thread?.agency_email,
          ...(existingCaseAgencies.rows || []).map((r: any) => r.agency_email),
        ];
        const knownPortals = [
          caseData?.portal_url,
          ...(existingCaseAgencies.rows || []).map((r: any) => r.portal_url),
        ];
        const knownPhones = (existingCaseAgencies.rows || []).map((r: any) => r.phone);
        const knownFaxes = (existingCaseAgencies.rows || []).map((r: any) => r.fax);

        for (const v of knownEmails) {
          const n = normalizeEmail(v);
          if (n) existingEmails.add(n);
        }
        for (const v of knownPortals) {
          const n = normalizePortalForCompare(v);
          if (n) existingPortals.add(n);
        }
        for (const v of knownPhones) {
          const n = normalizePhoneForCompare(v);
          if (n) existingPhones.add(n);
        }
        for (const v of knownFaxes) {
          const n = normalizePhoneForCompare(v);
          if (n) existingFaxes.add(n);
        }
      } catch (e: any) {
        logger.warn("Failed building existing contact channel sets", { caseId, error: e?.message || String(e) });
      }

      const normalizedCandidateEmail = normalizeEmail(candidateEmail);
      const normalizedCandidatePortal = normalizePortalForCompare(candidatePortalUrl);
      const normalizedCandidatePhone = normalizePhoneForCompare(candidatePhone);
      const normalizedCandidateFax = normalizePhoneForCompare(candidateFax);

      const newEmail = normalizedCandidateEmail && !existingEmails.has(normalizedCandidateEmail)
        ? candidateEmail
        : null;
      const newPortalUrl = normalizedCandidatePortal && !existingPortals.has(normalizedCandidatePortal)
        ? candidatePortalUrl
        : null;
      const newPhone = normalizedCandidatePhone && !existingPhones.has(normalizedCandidatePhone)
        ? candidatePhone
        : null;
      const newFax = normalizedCandidateFax && !existingFaxes.has(normalizedCandidateFax)
        ? candidateFax
        : null;

      if (!newEmail && !newPortalUrl && !newPhone && !newFax) {
        // No new channel found: continue with phone-call fallback instead of
        // blocking on a manual "retry research" gate.
        let fallbackPhone: string | null = null;
        try {
          const existingCaseAgencies = await db.query(
            `SELECT a.phone
               FROM case_agencies ca
               LEFT JOIN agencies a ON ca.agency_id = a.id
              WHERE ca.case_id = $1
              ORDER BY ca.id DESC
              LIMIT 1`,
            [caseId]
          );
          fallbackPhone = existingCaseAgencies.rows?.[0]?.phone || null;
        } catch (e: any) { /* non-fatal */ }

        await db.createPhoneCallTask({
          case_id: caseId,
          agency_name: suggestedAgency.name || caseData?.agency_name || "Agency",
          agency_phone: fallbackPhone,
          agency_state: caseData?.state || null,
          reason: "clarification_needed",
          priority: 1,
          notes: `Research identified ${suggestedAgency.name} but no NEW email/portal/phone/fax channel. Fallback to phone call follow-up.`,
          days_since_sent: caseData?.send_date
            ? Math.floor((Date.now() - new Date(caseData.send_date).getTime()) / 86400000)
            : null,
        });

        await caseRuntime.transitionCaseRuntime(caseId, "CASE_ESCALATED", {
          targetStatus: "needs_phone_call",
          substatus: "agency_research_complete",
          pauseReason: "RESEARCH_HANDOFF",
        });
        executionResult = { action: "research_complete", followup: "phone_fallback_no_new_channel" };
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
        await ensureResearchHandoffProposal(
          "add-agency-failed",
          `Research identified ${suggestedAgency.name} but adding case agency failed.`,
          `Research identified ${suggestedAgency.name}, but saving it to the case failed (${e?.message || "unknown error"}). Please add the agency manually and continue.`
        );
        await caseRuntime.transitionCaseRuntime(caseId, "CASE_ESCALATED", {
          substatus: "agency_research_complete",
          pauseReason: "RESEARCH_HANDOFF",
        });
        executionResult = { action: "research_complete", followup: "add_agency_failed" };
        break;
      }

      const followupActionType = newPortalUrl
        ? "SUBMIT_PORTAL"
        : newEmail
          ? "SEND_INITIAL_REQUEST"
          : "ESCALATE";

      let foiaRequestText: string | null = null;
      if (followupActionType !== "ESCALATE") {
        try {
          const foiaResult = await aiService.generateFOIARequest({ ...caseData, agency_name: suggestedAgency.name });
          foiaRequestText = foiaResult.request_text;
        } catch (e: any) {
          await ensureResearchHandoffProposal(
            "foia-generation-failed",
            `Research identified ${suggestedAgency.name} but FOIA draft generation failed.`,
            `Research identified ${suggestedAgency.name}, but draft generation failed (${e?.message || "unknown error"}). Please draft manually or retry generation.`
          );
          await caseRuntime.transitionCaseRuntime(caseId, "CASE_ESCALATED", {
            substatus: "agency_research_complete",
            pauseReason: "RESEARCH_HANDOFF",
          });
          executionResult = { action: "research_complete", followup: "foia_generation_failed" };
          break;
        }
      }

      const escalationForPhone = !!newPhone && !newPortalUrl && !newEmail;
      const escalationForFax = !!newFax && !newPortalUrl && !newEmail && !newPhone;
      const escalationReasonMarker = escalationForPhone
        ? "FOLLOWUP_CHANNEL:PHONE"
        : escalationForFax
          ? "FOLLOWUP_CHANNEL:FAX"
          : null;
      const escalationDraftSubject = escalationForPhone
        ? `Call follow-up recommendation - ${suggestedAgency.name}`
        : `Fax follow-up recommendation - ${suggestedAgency.name}`;
      const escalationDraftBody = escalationForPhone
        ? `Research found a new phone number for follow-up: ${newPhone}\n\nRecommended next step: place a phone call to ${suggestedAgency.name} and reference case #${caseId}.`
        : `Research found a new fax number for follow-up: ${newFax}\n\nRecommended next step: send a fax follow-up to ${suggestedAgency.name}. Fax is lowest-priority and is suggested only because no new portal/email/phone channel was found.`;

      const followupKey = `${caseId}:research:ca${caseAgency.id}:${followupActionType}:0`;
      try {
        const followupProposal = await db.upsertProposal({
          proposalKey: followupKey,
          caseId,
          runId: runId || null,
          actionType: followupActionType,
          draftSubject: followupActionType === "ESCALATE"
            ? escalationDraftSubject
            : `Public Records Request - ${caseData?.subject_name || "Records Request"}`,
          draftBodyText: followupActionType === "ESCALATE"
            ? escalationDraftBody
            : foiaRequestText,
          reasoning: [
            `Research identified ${suggestedAgency.name} as likely records holder`,
            ...(newPortalUrl ? [`Proposed channel: new portal (${newPortalUrl})`] : []),
            ...(newEmail ? [`Proposed channel: new email (${newEmail})`] : []),
            ...(newPhone ? [`Discovered phone: ${newPhone}`] : []),
            ...(newFax ? [`Discovered fax: ${newFax}`] : []),
            ...(escalationReasonMarker ? [escalationReasonMarker] : []),
          ],
          confidence: suggestedAgency.confidence || 0.7,
          requiresHuman: true,
          canAutoExecute: false,
          status: "PENDING_APPROVAL",
        });
        if (followupProposal?.id) {
          await db.updateProposal(followupProposal.id, { case_agency_id: caseAgency.id });
        }
      } catch (e: any) {
        await caseRuntime.transitionCaseRuntime(caseId, "CASE_ESCALATED", {
          substatus: "agency_research_complete",
          pauseReason: "RESEARCH_HANDOFF",
        });
        executionResult = { action: "research_complete", followup: "proposal_creation_failed" };
        break;
      }

      // A concrete reroute target has now been identified and queued for approval.
      // Clear sticky WRONG_AGENCY to avoid blocking execution of the new route.
      try {
        const refreshedCase = await db.getCaseById(caseId);
        const rawConstraints = refreshedCase?.constraints_jsonb || refreshedCase?.constraints || [];
        const constraintList = Array.isArray(rawConstraints) ? rawConstraints : [];
        if (constraintList.includes("WRONG_AGENCY")) {
          const nextConstraints = constraintList.filter((c: string) => c !== "WRONG_AGENCY");
          await db.updateCase(caseId, { constraints_jsonb: JSON.stringify(nextConstraints) });
          logger.info("Cleared WRONG_AGENCY constraint after successful reroute proposal", {
            caseId,
            newAgency: suggestedAgency.name,
            actionType: followupActionType,
          });
        }
      } catch (constraintErr: any) {
        logger.warn("Failed to clear WRONG_AGENCY constraint after reroute proposal", {
          caseId,
          error: constraintErr?.message || String(constraintErr),
        });
      }

      await caseRuntime.transitionCaseRuntime(caseId, "CASE_ESCALATED", {
        substatus: "research_followup_proposed",
        pauseReason: "RESEARCH_HANDOFF",
      });
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
      // Mark proposal EXECUTED first, then complete case (which dismisses remaining active proposals)
      await caseRuntime.transitionCaseRuntime(caseId, "PROPOSAL_EXECUTED", { proposalId });
      await caseRuntime.transitionCaseRuntime(caseId, "CASE_COMPLETED", {
        substatus: "denial_accepted",
      });
      await db.updateCase(caseId, { outcome_type: "denial_accepted", outcome_recorded: true });
      await createExecutionRecord({
        caseId, proposalId, runId, executionKey, actionType: "CLOSE_CASE",
        status: "SENT", provider: "none", providerPayload: { reason: "Denial accepted" },
      });
      executionResult = { action: "case_closed", reason: "denial_accepted" };
      break;
    }

    case "NONE": {
      await createExecutionRecord({
        caseId, proposalId, runId, executionKey, actionType: "NONE",
        status: "SKIPPED", provider: "none", providerPayload: { reason: "No action required" },
      });
      executionResult = { action: "none" };
      await caseRuntime.transitionCaseRuntime(caseId, "PROPOSAL_EXECUTED", { proposalId });
      break;
    }

    default:
      throw new Error(`Unknown action type: ${resolvedActionType}`);
  }

  // Log activity
  await db.logActivity("agent_action_executed", `Executed ${resolvedActionType}`, {
    caseId, proposalId, executionKey, mode: EXECUTION_MODE, result: executionResult,
  });

  // Dismiss other pending proposals (except RESEARCH_AGENCY which creates follow-ups)
  if (resolvedActionType !== "RESEARCH_AGENCY") {
    try {
      await db.dismissPendingProposals(caseId, `Superseded by executed ${resolvedActionType}`);
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
