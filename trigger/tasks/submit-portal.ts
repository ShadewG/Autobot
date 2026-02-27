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
      // Cancel the orphaned Skyvern workflow so it doesn't keep running
      const caseRow = await db.query(
        `SELECT last_portal_run_id FROM cases WHERE id = $1`,
        [caseId]
      );
      const skyvernRunId = caseRow.rows[0]?.last_portal_run_id;
      if (skyvernRunId) {
        const skyvern = getSkyvern();
        await skyvern.cancelWorkflowRun(skyvernRunId);
      }

      if (portalTaskId) {
        await db.query(
          `UPDATE portal_tasks SET status = 'CANCELLED', completed_at = NOW(),
           completion_notes = $2 WHERE id = $1 AND status IN ('PENDING', 'IN_PROGRESS')`,
          [portalTaskId, `Timed out or crashed: ${String(error).substring(0, 200)}`]
        );
      }
      await db.updateCaseStatus(caseId, "needs_human_review", {
        requires_human: true,
        substatus: "Portal submission timed out — manual submission needed",
      });
      await db.logActivity("portal_submission_failed", `Portal timed out for case ${caseId}`, {
        case_id: caseId, error: String(error).substring(0, 500),
      });
      // Close the tracking agent_run
      if (agentRunId) {
        await db.query(
          `UPDATE agent_runs SET status = 'failed', ended_at = NOW(), error = $2 WHERE id = $1 AND status IN ('created', 'queued', 'running', 'processing')`,
          [agentRunId, `Trigger.dev task crashed: ${String(error).substring(0, 200)}`]
        );
      }
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
      await db.updateCaseStatus(caseId, "needs_human_review", {
        requires_human: true,
        substatus: `Portal circuit breaker: ${failCount} failures in ${FAILURE_WINDOW_HOURS}h`,
      });
      if (portalTaskId) {
        await db.query(
          `UPDATE portal_tasks SET status = 'CANCELLED', completion_notes = 'Circuit breaker triggered' WHERE id = $1`,
          [portalTaskId]
        );
      }
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
      await db.updateCaseStatus(caseId, "needs_human_review", {
        requires_human: true,
        substatus: `Portal hard limit: ${todayRuns} today (max ${MAX_PORTAL_RUNS_PER_DAY}), ${totalRuns} total (max ${MAX_PORTAL_RUNS_TOTAL})`,
      });
      if (portalTaskId) {
        await db.query(
          `UPDATE portal_tasks SET status = 'CANCELLED', completion_notes = 'Hard rate limit hit' WHERE id = $1`,
          [portalTaskId]
        );
      }
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
      await db.updateCaseStatus(caseId, "needs_human_review", {
        requires_human: true,
        substatus: "No online portal available (paper form required)",
      });
      if (portalTaskId) {
        await db.query(
          `UPDATE portal_tasks SET status = 'CANCELLED', completion_notes = 'Provider marked paper-only (no online portal)' WHERE id = $1`,
          [portalTaskId]
        );
      }
      await closeAgentRun("failed", "Provider is paper-only");
      return { success: false, skipped: true, reason: "provider_paper_only" };
    }

    // ── WRONG_AGENCY guard: skip if case has WRONG_AGENCY constraint ──
    const rawConstraints = caseData.constraints_jsonb || caseData.constraints || [];
    const constraints = Array.isArray(rawConstraints) ? rawConstraints : [];
    if (constraints.includes("WRONG_AGENCY")) {
      logger.warn("Portal submission skipped — wrong agency", { caseId });
      await cancelPortalTask("Case marked WRONG_AGENCY");
      await closeAgentRun("failed", "Wrong agency");
      return { success: false, skipped: true, reason: "wrong_agency" };
    }

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
      await db.updateCaseStatus(caseId, "needs_human_review", {
        requires_human: true,
        substatus: "No portal URL available for submission",
      });
      if (portalTaskId) {
        await db.query(
          `UPDATE portal_tasks SET status = 'CANCELLED', completion_notes = 'Missing portal URL' WHERE id = $1`,
          [portalTaskId]
        );
      }
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
        await db.updateCaseStatus(caseId, "needs_human_review", {
          requires_human: true,
          substatus: `Portal account ${portalAccount.account_status} — manual login needed`,
        });
        if (portalTaskId) {
          await db.query(
            `UPDATE portal_tasks SET status = 'CANCELLED', completion_notes = $2 WHERE id = $1`,
            [portalTaskId, `Portal account blocked: ${portalAccount.account_status}`]
          );
        }
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
      await db.updateCaseStatus(caseId, "portal_in_progress", {
        substatus: "Agency requested portal submission",
        requires_human: false,
        pause_reason: null,
        last_portal_status: "Portal submission started",
        last_portal_status_at: new Date(),
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
          await db.updateCaseStatus(caseId, "needs_human_review", {
            requires_human: true,
            substatus: `Portal requires manual handling: ${result.status}`,
          });
          if (portalTaskId) {
            await db.query(
              `UPDATE portal_tasks SET status = 'CANCELLED', completion_notes = $2 WHERE id = $1 AND status IN ('PENDING', 'IN_PROGRESS')`,
              [portalTaskId, `Alternative path: ${result.status}`]
            );
          }
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
          await db.updateCaseStatus(caseId, "needs_human_review", {
            substatus: `Portal skipped: ${result.reason}`,
          });
        }
        await cancelPortalTask(`Skyvern dedup skip: ${result.reason || "already handled"}`);
        await closeAgentRun("completed");
        return result;
      }

      // ── Success: update everything ──
      const engineUsed = result.engine || "skyvern";
      const statusText = result.status || "submitted";
      const taskUrl = result.taskId ? `https://app.skyvern.com/tasks/${result.taskId}` : null;

      await db.updateCaseStatus(caseId, "sent", {
        substatus: `Portal submission completed (${statusText})`,
        send_date: caseData.send_date || new Date(),
        requires_human: false,
        pause_reason: null,
      });

      await db.updateCasePortalStatus(caseId, {
        portal_url: targetUrl,
        portal_provider: provider || caseData.portal_provider || "Auto-detected",
        last_portal_status: `Submission completed (${statusText})`,
        last_portal_status_at: new Date(),
        last_portal_engine: engineUsed,
        last_portal_run_id: result.taskId || result.runId || null,
        last_portal_details: result.extracted_data ? JSON.stringify(result.extracted_data) : null,
        last_portal_task_url: taskUrl,
        last_portal_recording_url: result.recording_url || taskUrl,
        last_portal_account_email: result.accountEmail || caseData.last_portal_account_email || null,
      });

      // Mark portal_task as completed
      if (portalTaskId) {
        await db.query(
          `UPDATE portal_tasks SET status = 'COMPLETED', completed_at = NOW(),
           completion_notes = $2 WHERE id = $1`,
          [portalTaskId, `Submitted via ${engineUsed}`]
        );
      }

      // Update linked proposal
      const linkedProposal = portalTaskId
        ? await db.query(`SELECT proposal_id FROM portal_tasks WHERE id = $1`, [portalTaskId])
        : null;
      if (linkedProposal?.rows[0]?.proposal_id) {
        await db.updateProposal(linkedProposal.rows[0].proposal_id, {
          status: "EXECUTED",
          executedAt: new Date(),
        });
      }

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

      // Mark portal_task as failed
      if (portalTaskId) {
        await db.query(
          `UPDATE portal_tasks SET status = 'CANCELLED', completed_at = NOW(),
           completion_notes = $2 WHERE id = $1`,
          [portalTaskId, `Failed: ${error.message}`.substring(0, 500)]
        );
      }

      // Flag case for human review
      await db.updateCaseStatus(caseId, "needs_human_review", {
        substatus: "Portal submission failed - requires human submission",
        requires_human: true,
      });

      try { await getNotion().syncStatusToNotion(caseId); } catch {}

      // Don't re-throw — we've handled the failure. Retrying Skyvern is expensive.
      await closeAgentRun("failed", error.message);
      return { success: false, error: error.message };
    }
  },
});
