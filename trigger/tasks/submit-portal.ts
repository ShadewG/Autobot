/**
 * Submit Portal Task (Trigger.dev)
 *
 * Replaces the BullMQ portal-queue worker.
 * Handles portal submission via Skyvern with:
 * - Dedup guard (skip if PENDING task already exists for case)
 * - Circuit breaker (skip after 3 recent failures for same case)
 * - Idempotency (skip if case already past submission)
 */

import { task, logger } from "@trigger.dev/sdk";

// Lazy-load heavy services (same pattern as lib/db.ts)
function lazy<T>(loader: () => T): () => T {
  let cached: T;
  return () => {
    if (!cached) cached = loader();
    return cached;
  };
}

const getDb = lazy(() => require("../../services/database"));
const getCaseRuntime = lazy(() => require("../../services/case-runtime"));
const getSkyvern = lazy(() => require("../../services/portal-agent-service-skyvern"));
const getNotion = lazy(() => require("../../services/notion-service"));
const getDiscord = lazy(() => require("../../services/discord-service"));

const MAX_RECENT_FAILURES = 2;
const FAILURE_WINDOW_HOURS = 24;
const MAX_PORTAL_RUNS_PER_DAY = 3;
const MAX_PORTAL_RUNS_TOTAL = 8;
const STALE_CREDENTIAL_DAYS = 30;

export const submitPortal = task({
  id: "submit-portal",
  maxDuration: 1200, // 20 minutes — cancel if Skyvern takes too long
  retry: { maxAttempts: 1 }, // Don't auto-retry portal submissions (expensive)

  onFailure: async ({ payload, error }) => {
    // Runs on hard timeout or unexpected crash — ensure case is flagged for human
    if (!payload || typeof payload !== "object") return;
    const db = getDb();
    const { caseId, portalTaskId, agentRunId } = payload as any;
    if (!caseId) return;
    try {
      const errorText = String(error || "");
      const looksLikeTimeout =
        /timeout|timed out|max duration|deadline exceeded|exceeded/i.test(errorText);

      // Cancel the orphaned Skyvern workflow so it doesn't keep running
      const caseRow = await db.query(
        `SELECT last_portal_run_id FROM cases WHERE id = $1`,
        [caseId]
      );
      const skyvernRunId = caseRow.rows[0]?.last_portal_run_id;
      let cancelSucceeded = false;
      if (skyvernRunId) {
        const skyvern = getSkyvern();
        cancelSucceeded = !!(await skyvern.cancelWorkflowRun(skyvernRunId));
      }

      // Atomically update case, portal_task, and agent_run via the runtime
      await getCaseRuntime().transitionCaseRuntime(caseId, "PORTAL_TIMED_OUT", {
        portalTaskId: portalTaskId || undefined,
        runId: agentRunId || undefined,
        error: `Trigger.dev task crashed: ${errorText.substring(0, 200)}`,
        substatus: "Portal submission timed out — manual submission needed",
        portalMetadata: {
          last_portal_status: `Timed out or crashed: ${errorText.substring(0, 100)}`,
          last_portal_status_at: new Date(),
        },
      });

      await db.logActivity(
        looksLikeTimeout ? "portal_hard_timeout" : "portal_task_crash",
        looksLikeTimeout
          ? `Portal hard timeout for case ${caseId}`
          : `Portal task crash for case ${caseId}`,
        {
          case_id: caseId,
          run_id: skyvernRunId || null,
          cancel_attempted: !!skyvernRunId,
          cancel_succeeded: cancelSucceeded,
          error: errorText.substring(0, 500),
        }
      );
      await db.logActivity("portal_submission_failed", `Portal timed out for case ${caseId}`, {
        case_id: caseId, error: String(error).substring(0, 500),
      });
    } catch {}
  },

  run: async (payload: {
    caseId: number;
    portalUrl: string;
    provider: string | null;
    instructions: string | null;
    portalTaskId?: number;
    agentRunId?: number;
  }) => {
    const { caseId, portalUrl, provider, instructions, portalTaskId, agentRunId } = payload;
    const db = getDb();

    const ensurePortalSubmissionMessage = async (
      latestCase: any,
      targetPortalUrl: string,
      submissionResult: any
    ) => {
      try {
        let thread = await db.getThreadByCaseId(caseId);
        if (!thread) {
          let host = "portal.local";
          try { host = new URL(targetPortalUrl).hostname || host; } catch {}
          thread = await db.createEmailThread({
            case_id: caseId,
            thread_id: `portal:${caseId}:${host}`,
            subject: `Portal submission for case #${caseId}`,
            agency_email: latestCase?.agency_email || latestCase?.alternate_agency_email || null,
            initial_message_id: `<portal-thread-${caseId}-${Date.now()}@autobot.local>`,
            status: "active",
            case_agency_id: latestCase?.agency_id || null,
          });
        }

        const stableRunToken =
          String(submissionResult?.taskId || submissionResult?.runId || Date.now());
        const syntheticMessageId = `<portal-submit-${caseId}-${stableRunToken}@autobot.local>`;
        const existing = await db.getMessageByMessageIdentifier(syntheticMessageId);
        if (existing) return existing;

        const providerLabel =
          provider || latestCase?.portal_provider || submissionResult?.provider || "portal";
        const submittedAtIso = new Date().toISOString();
        const confirmation = submissionResult?.confirmationNumber
          ? `\nConfirmation number: ${submissionResult.confirmationNumber}`
          : "";
        const runRef = submissionResult?.taskId || submissionResult?.runId
          ? `\nPortal run: ${submissionResult.taskId || submissionResult.runId}`
          : "";
        const engineRef = submissionResult?.engine
          ? `\nEngine: ${submissionResult.engine}`
          : "";

        return await db.createMessage({
          thread_id: thread?.id || null,
          case_id: caseId,
          message_id: syntheticMessageId,
          sendgrid_message_id: null,
          direction: "outbound",
          from_email: process.env.REQUESTS_INBOX || "requests@foib-request.com",
          to_email:
            latestCase?.agency_email ||
            latestCase?.alternate_agency_email ||
            targetPortalUrl,
          cc_emails: null,
          subject: submissionResult?.confirmationNumber
            ? `Portal submission completed (${submissionResult.confirmationNumber})`
            : "Portal submission completed",
          body_text:
            `Portal request submitted.\n` +
            `Submitted at: ${submittedAtIso}\n` +
            `Portal URL: ${targetPortalUrl}\n` +
            `Provider: ${providerLabel}${confirmation}${runRef}${engineRef}`,
          body_html: null,
          has_attachments: false,
          attachment_count: 0,
          message_type: "portal_submission",
          portal_notification: false,
          portal_notification_type: null,
          portal_notification_provider: null,
          sent_at: new Date(),
          received_at: null,
          summary: "System logged portal submission event",
          metadata: {
            source: "submit_portal_task",
            portal_url: targetPortalUrl,
            portal_provider: providerLabel,
            confirmation_number: submissionResult?.confirmationNumber || null,
            run_id: submissionResult?.runId || null,
            task_id: submissionResult?.taskId || null,
            engine: submissionResult?.engine || null,
          },
        });
      } catch (messageErr: any) {
        logger.warn("Failed to record portal submission correspondence", {
          caseId,
          error: messageErr?.message || String(messageErr),
        });
        return null;
      }
    };

    // Helper: mark the tracking agent_run as completed/failed
    const closeAgentRun = async (status: "completed" | "failed", error?: string) => {
      if (!agentRunId) return;
      try {
        await db.query(
          `UPDATE agent_runs SET status = $1, ended_at = NOW(), error = $3 WHERE id = $2 AND status IN ('created', 'queued', 'running', 'processing')`,
          [status, agentRunId, error || null]
        );
      } catch {}
    };

    const cancelPortalTask = async (note: string) => {
      if (!portalTaskId) return;
      await db.query(
        `UPDATE portal_tasks
         SET status = 'CANCELLED',
             completed_at = COALESCE(completed_at, NOW()),
             completion_notes = $2,
             updated_at = NOW()
         WHERE id = $1
           AND status IN ('PENDING', 'IN_PROGRESS')`,
        [portalTaskId, note]
      );
    };

    logger.info("submit-portal started", { caseId, portalUrl, portalTaskId, agentRunId });

    const linkedProposalId = portalTaskId
      ? Number((await db.query("SELECT proposal_id FROM portal_tasks WHERE id = $1 LIMIT 1", [portalTaskId])).rows[0]?.proposal_id || 0) || undefined
      : undefined;

    // Mark agent_run as running
    if (agentRunId) {
      try {
        await db.query(
          `UPDATE agent_runs SET status = 'running' WHERE id = $1 AND status IN ('created', 'queued')`,
          [agentRunId]
        );
      } catch {}
    }

    // ── Circuit breaker: check recent failures for this case ──
    const recentFailures = await db.query(
      `SELECT COUNT(*) as cnt FROM activity_log
       WHERE event_type = 'portal_submission_failed'
         AND case_id = $1
         AND created_at > NOW() - INTERVAL '${FAILURE_WINDOW_HOURS} hours'`,
      [caseId]
    );
    const failCount = parseInt(recentFailures.rows[0]?.cnt || "0", 10);
    if (failCount >= MAX_RECENT_FAILURES) {
      logger.warn("Circuit breaker: too many recent portal failures", {
        caseId, failCount, threshold: MAX_RECENT_FAILURES,
      });
      await getCaseRuntime().transitionCaseRuntime(caseId, "PORTAL_ABORTED", {
        substatus: `Portal circuit breaker: ${failCount} failures in ${FAILURE_WINDOW_HOURS}h`,
        pauseReason: "PORTAL_ABORTED",
        portalTaskId: portalTaskId || undefined,
        proposalId: linkedProposalId,
        error: "Circuit breaker triggered",
      });
      await closeAgentRun("failed", "Circuit breaker triggered");
      return { success: false, skipped: true, reason: "circuit_breaker" };
    }

    // ── Hard rate limit: max portal runs per case per day AND total ever ──
    const portalRunCounts = await db.query(
      `SELECT
         COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '24 hours') as today,
         COUNT(*) as total
       FROM activity_log
       WHERE event_type IN ('portal_workflow_triggered', 'portal_stage_started')
         AND case_id = $1`,
      [caseId]
    );
    const todayRuns = parseInt(portalRunCounts.rows[0]?.today || "0", 10);
    const totalRuns = parseInt(portalRunCounts.rows[0]?.total || "0", 10);
    if (todayRuns >= MAX_PORTAL_RUNS_PER_DAY || totalRuns >= MAX_PORTAL_RUNS_TOTAL) {
      logger.error("HARD LIMIT: portal submission blocked — too many runs for this case", {
        caseId, todayRuns, totalRuns,
        dailyLimit: MAX_PORTAL_RUNS_PER_DAY, totalLimit: MAX_PORTAL_RUNS_TOTAL,
      });
      await getCaseRuntime().transitionCaseRuntime(caseId, "PORTAL_ABORTED", {
        substatus: `Portal hard limit: ${todayRuns} today (max ${MAX_PORTAL_RUNS_PER_DAY}), ${totalRuns} total (max ${MAX_PORTAL_RUNS_TOTAL})`,
        pauseReason: "PORTAL_ABORTED",
        portalTaskId: portalTaskId || undefined,
        proposalId: linkedProposalId,
        error: "Hard rate limit hit",
      });
      await closeAgentRun("failed", "Hard rate limit");
      return { success: false, skipped: true, reason: "hard_rate_limit" };
    }

    // ── Load case ──
    const caseData = await db.getCaseById(caseId);
    if (!caseData) {
      throw new Error(`Case ${caseId} not found`);
    }

    // ── Idempotency: skip if case already past submission stage ──
    const skipStatuses = ["sent", "awaiting_response", "responded", "completed", "needs_phone_call"];
    if (skipStatuses.includes(caseData.status)) {
      logger.info("Portal submission skipped — case already advanced", { caseId, status: caseData.status });
      await cancelPortalTask(`Case already advanced (${caseData.status})`);
      await closeAgentRun("completed");
      return { success: true, skipped: true, reason: caseData.status };
    }

    // ── Provider guard: do not attempt portal automation when provider indicates paper-only flow ──
    const providerLabel = String(provider || caseData.portal_provider || "").toLowerCase();
    const paperOnlyProvider =
      providerLabel.includes("no online portal") ||
      providerLabel.includes("paper form required") ||
      providerLabel.includes("paper-only") ||
      providerLabel.includes("paper only");
    if (paperOnlyProvider) {
      logger.warn("Portal submission skipped — provider marked as paper-only", {
        caseId,
        provider: provider || caseData.portal_provider || null,
      });
      await getCaseRuntime().transitionCaseRuntime(caseId, "PORTAL_ABORTED", {
        substatus: "No online portal available (paper form required)",
        pauseReason: "PORTAL_ABORTED",
        portalTaskId: portalTaskId || undefined,
        proposalId: linkedProposalId,
        error: "Provider marked paper-only (no online portal)",
      });
      await closeAgentRun("failed", "Provider is paper-only");
      return { success: false, skipped: true, reason: "provider_paper_only" };
    }

    // NOTE: WRONG_AGENCY is informational after reroute and must not globally block
    // portal submission for newly researched agencies. Active wrong-agency work is
    // already stopped by CASE_WRONG_AGENCY transitions + cancelled portal_task guard below.

    // ── Cancelled task guard: skip if portal task was cancelled (e.g. by WRONG_AGENCY handler) ──
    if (portalTaskId) {
      const taskCheck = await db.query("SELECT status FROM portal_tasks WHERE id = $1", [portalTaskId]);
      if (taskCheck.rows[0]?.status === "CANCELLED") {
        logger.warn("Portal task was cancelled", { caseId, portalTaskId });
        await closeAgentRun("completed");
        return { success: false, skipped: true, reason: "task_cancelled" };
      }
    }

    // ── Dedup guard: skip if a successful portal submission happened recently ──
    const recentSuccess = await db.query(
      `SELECT id FROM activity_log
       WHERE event_type = 'portal_stage_completed'
         AND case_id = $1
         AND metadata->>'engine' = 'skyvern_workflow'
         AND created_at > NOW() - INTERVAL '1 hour'
       LIMIT 1`,
      [caseId]
    );
    if (recentSuccess.rows.length > 0) {
      logger.warn("Portal submission skipped — successful submission within last hour", { caseId });
      await cancelPortalTask("Recent successful portal submission detected");
      await closeAgentRun("completed");
      return { success: true, skipped: true, reason: "recent_success" };
    }

    const targetUrl = portalUrl || caseData.portal_url;
    if (!targetUrl) {
      logger.warn("Portal submission skipped — missing portal URL", { caseId });
      await getCaseRuntime().transitionCaseRuntime(caseId, "PORTAL_ABORTED", {
        substatus: "No portal URL available for submission",
        pauseReason: "PORTAL_ABORTED",
        portalTaskId: portalTaskId || undefined,
        proposalId: linkedProposalId,
        error: "Missing portal URL",
      });
      await closeAgentRun("failed", "Missing portal URL");
      return { success: false, skipped: true, reason: "invalid_portal_url" };
    }

    // ── Pre-flight: check if portal account is locked (don't waste Skyvern credits) ──
    // Note: document URLs are NOT blocked here — Skyvern service handles fallback to PDF/research
    const portalAccount = await db.getPortalAccountByUrl(targetUrl, caseData.user_id || null, { includeInactive: true });
    if (portalAccount) {
      const blockedStatuses = new Set(["locked", "inactive"]);
      if (blockedStatuses.has(portalAccount.account_status)) {
        logger.warn("Portal submission skipped — account not active", {
          caseId, targetUrl,
          accountId: portalAccount.id,
          accountStatus: portalAccount.account_status,
          accountEmail: portalAccount.email,
        });
        await getCaseRuntime().transitionCaseRuntime(caseId, "PORTAL_ABORTED", {
          substatus: `Portal account ${portalAccount.account_status} — manual login needed`,
          pauseReason: "PORTAL_ABORTED",
          portalTaskId: portalTaskId || undefined,
          proposalId: linkedProposalId,
          error: `Portal account blocked: ${portalAccount.account_status}`,
        });
        await closeAgentRun("failed", `Portal account ${portalAccount.account_status}`);
        return { success: false, skipped: true, reason: `portal_account_${portalAccount.account_status}` };
      }

      if (portalAccount.last_used_at) {
        const daysSinceUse = (Date.now() - new Date(portalAccount.last_used_at).getTime()) / (1000 * 60 * 60 * 24);
        if (daysSinceUse > STALE_CREDENTIAL_DAYS) {
          logger.warn("Portal credentials are stale (>30 days since last use)", {
            caseId, targetUrl, accountId: portalAccount.id, daysSinceUse: Math.floor(daysSinceUse),
          });
        }
      }
    } else {
      logger.info("No portal credentials found — will use default login-first workflow", {
        caseId, targetUrl, userId: caseData.user_id || null,
      });
    }

    let bypassApprovalGate = false;
    if (portalTaskId) {
      const portalTaskMeta = await db.query(
        `SELECT action_type FROM portal_tasks WHERE id = $1 LIMIT 1`,
        [portalTaskId]
      );
      const actionType = String(portalTaskMeta.rows[0]?.action_type || "");
      // Retry/manual portal tasks are human-initiated and should not require an additional proposal approval gate.
      bypassApprovalGate = actionType === "SUBMIT_VIA_PORTAL";
    }

    // ── Mark case as portal in progress ──
    if (caseData.status !== "sent") {
      await getCaseRuntime().transitionCaseRuntime(caseId, "PORTAL_STARTED", {
        portalTaskId: portalTaskId || undefined,
        runId: agentRunId || undefined,
        substatus: "Agency requested portal submission",
        portalMetadata: {
          last_portal_status: "Portal submission started",
          last_portal_status_at: new Date(),
        },
      });
    }

    // ── Call Skyvern ──
    const skyvern = getSkyvern();
    try {
      const result = await skyvern.submitToPortal(caseData, targetUrl, {
        maxSteps: 60,
        dryRun: false,
        instructions,
        bypassApprovalGate,
      });

      if (!result || !result.success) {
        // Late-result guard: if the case already advanced (e.g., fallback email
        // sent successfully), do not let a stale portal failure overwrite it.
        const latestCase = await db.getCaseById(caseId);
        const advancedStatuses = new Set([
          "sent",
          "awaiting_response",
          "responded",
          "completed",
          "cancelled",
          "needs_phone_call",
        ]);
        if (advancedStatuses.has(String(latestCase?.status || "").toLowerCase())) {
          logger.info("Ignoring failed portal result because case already advanced", {
            caseId,
            currentStatus: latestCase?.status || null,
            portalResultStatus: result?.status || null,
          });
          await cancelPortalTask(
            `Ignored stale portal result (${result?.status || "failed"}) because case is already ${latestCase?.status}`
          );
          await closeAgentRun("completed");
          return {
            success: true,
            skipped: true,
            reason: "case_already_advanced_after_portal_result",
            priorStatus: latestCase?.status || null,
            portalResultStatus: result?.status || null,
          };
        }

        // Approval gate: proposal created, waiting for human — not a failure
        if (result?.needsApproval) {
          logger.info("Portal submission blocked — needs approval", { caseId, reason: result.reason });
          // Status already set to needs_human_review by the service; ensure portal_task is updated
          if (portalTaskId) {
            await db.query(
              `UPDATE portal_tasks SET status = 'CANCELLED', completion_notes = 'Waiting for approval' WHERE id = $1 AND status IN ('PENDING', 'IN_PROGRESS')`,
              [portalTaskId]
            );
          }
          await closeAgentRun("completed");
          return result;
        }
        // PDF fallback / not-real-portal handled inside Skyvern service
        if (result?.status === "pdf_form_pending" || result?.status === "not_real_portal") {
          logger.info("Portal handled via alternative path", { caseId, status: result.status });
          // Mark provider as non-automatable so future "retry_portal" actions
          // fall back to email/research instead of looping portal attempts.
          try {
            await db.updateCasePortalStatus(caseId, {
              portal_provider: "No online portal - paper form required",
              last_portal_status: `Alternative path required (${result.status})`,
              last_portal_status_at: new Date(),
            });
          } catch (providerErr: any) {
            logger.warn("Failed to update portal provider after alternative path", {
              caseId,
              error: providerErr?.message,
            });
          }
          await getCaseRuntime().transitionCaseRuntime(caseId, "PORTAL_ABORTED", {
            substatus: `Portal requires manual handling: ${result.status}`,
            pauseReason: "PORTAL_ABORTED",
            portalTaskId: portalTaskId || undefined,
            proposalId: linkedProposalId,
            error: `Alternative path: ${result.status}`,
          });
          await closeAgentRun("failed", `Alternative path: ${result.status}`);
          return result;
        }
        throw new Error(result?.error || "Portal submission failed");
      }

      // ── Dedup skip: Skyvern service detected this was already submitted ──
      if (result.skipped) {
        logger.info("Portal submission was a dedup skip", { caseId, reason: result.reason });
        // Reset status from portal_in_progress if it was set
        if (caseData.status === "portal_in_progress") {
          await getCaseRuntime().transitionCaseRuntime(caseId, "PORTAL_ABORTED", {
            substatus: `Portal skipped: ${result.reason}`,
            pauseReason: "PORTAL_ABORTED",
            portalTaskId: portalTaskId || undefined,
            proposalId: linkedProposalId,
            error: `Skyvern dedup skip: ${result.reason || "already handled"}`,
          });
        } else {
          await cancelPortalTask(`Skyvern dedup skip: ${result.reason || "already handled"}`);
        }
        await closeAgentRun("completed");
        return result;
      }

      // ── Success: update everything atomically via the runtime ──
      const engineUsed = result.engine || "skyvern";
      const statusText = result.status || "submitted";
      const taskUrl = result.taskId ? `https://app.skyvern.com/tasks/${result.taskId}` : null;

      await getCaseRuntime().transitionCaseRuntime(caseId, "PORTAL_COMPLETED", {
        portalTaskId: portalTaskId || undefined,
        runId: agentRunId || undefined,
        proposalId: linkedProposalId,
        sendDate: caseData.send_date || new Date().toISOString(),
        confirmationNumber: result.confirmationNumber,
        portalMetadata: {
          last_portal_status: `Submission completed (${statusText})`,
          last_portal_status_at: new Date(),
          last_portal_engine: engineUsed,
          last_portal_run_id: result.taskId || result.runId || null,
          last_portal_details: result.extracted_data ? JSON.stringify(result.extracted_data) : null,
          last_portal_task_url: taskUrl,
          last_portal_recording_url: result.recording_url || taskUrl,
          last_portal_account_email: result.accountEmail || caseData.last_portal_account_email || null,
        },
      });

      // Portal-specific fields not part of the runtime (portal_url, portal_provider)
      await db.updateCasePortalStatus(caseId, {
        portal_url: targetUrl,
        portal_provider: provider || caseData.portal_provider || "Auto-detected",
      });

      // Ensure there is a correspondence artifact for portal submissions so
      // status/reply workflows don't look like they have no outbound contact.
      await ensurePortalSubmissionMessage(caseData, targetUrl, result);

      try { await getNotion().syncStatusToNotion(caseId); } catch {}
      try { await getDiscord().notifyPortalSubmission(caseData, { success: true, portalUrl: targetUrl, steps: result.steps || 0 }); } catch {}
      try { await getDiscord().notifyRequestSent(caseData, "portal"); } catch {}

      await db.logActivity("portal_submission", `Portal submission completed for case ${caseId}`, {
        case_id: caseId,
        portal_url: targetUrl,
        portal_provider: provider || caseData.portal_provider || "Auto-detected",
        instructions,
        run_id: result.taskId || result.runId || null,
        recording_url: result.recording_url || taskUrl,
        task_url: taskUrl,
        engine: engineUsed,
      });

      logger.info("Portal submission succeeded", { caseId, engine: engineUsed, taskUrl });
      await closeAgentRun("completed");
      return result;

    } catch (error: any) {
      logger.error("Portal submission failed", { caseId, error: error.message });

      await db.logActivity("portal_submission_failed", `Portal submission failed: ${error.message}`, {
        case_id: caseId,
        portal_url: targetUrl,
        portal_provider: provider,
        instructions,
      });

      // Atomically update case, portal_task, and agent_run via the runtime
      await getCaseRuntime().transitionCaseRuntime(caseId, "PORTAL_FAILED", {
        portalTaskId: portalTaskId || undefined,
        runId: agentRunId || undefined,
        error: error.message?.substring(0, 500),
        substatus: "Portal submission failed - requires human submission",
        portalMetadata: {
          last_portal_status: `Failed: ${error.message?.substring(0, 100)}`,
          last_portal_status_at: new Date(),
        },
      });

      // Don't re-throw — we've handled the failure. Retrying Skyvern is expensive.
      return { success: false, error: error.message };
    }
  },
});
