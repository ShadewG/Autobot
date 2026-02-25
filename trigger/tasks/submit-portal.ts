/**
 * Submit Portal Task (Trigger.dev)
 *
 * Replaces the BullMQ portal-queue worker.
 * Handles portal submission via Skyvern with:
 * - Dedup guard (skip if PENDING task already exists for case)
 * - Circuit breaker (skip after 3 recent failures for same case)
 * - Idempotency (skip if case already past submission)
 */

import { task, logger } from "@trigger.dev/sdk/v3";

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

export const submitPortal = task({
  id: "submit-portal",
  maxDuration: 1200, // 20 minutes — cancel if Skyvern takes too long
  retry: { maxAttempts: 1 }, // Don't auto-retry portal submissions (expensive)

  onFailure: async ({ payload, error }) => {
    // Runs on hard timeout or unexpected crash — ensure case is flagged for human
    if (!payload || typeof payload !== "object") return;
    const db = getDb();
    const { caseId, portalTaskId } = payload as any;
    if (!caseId) return;
    try {
      if (portalTaskId) {
        await db.query(
          `UPDATE portal_tasks SET status = 'CANCELLED', completed_at = NOW(),
           completion_notes = $2 WHERE id = $1 AND status = 'PENDING'`,
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
    } catch {}
  },

  run: async (payload: {
    caseId: number;
    portalUrl: string;
    provider: string | null;
    instructions: string | null;
    portalTaskId?: number;
  }) => {
    const { caseId, portalUrl, provider, instructions, portalTaskId } = payload;
    const db = getDb();

    logger.info("submit-portal started", { caseId, portalUrl, portalTaskId });

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
      return { success: false, skipped: true, reason: "circuit_breaker" };
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
      return { success: true, skipped: true, reason: caseData.status };
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
      return { success: true, skipped: true, reason: "recent_success" };
    }

    const targetUrl = portalUrl || caseData.portal_url;
    if (!targetUrl) {
      throw new Error(`No portal URL available for case ${caseId}`);
    }

    // ── Mark case as portal in progress ──
    if (caseData.status !== "sent") {
      await db.updateCaseStatus(caseId, "portal_in_progress", {
        substatus: "Agency requested portal submission",
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
      });

      if (!result || !result.success) {
        // PDF fallback / not-real-portal handled inside Skyvern service
        if (result?.status === "pdf_form_pending" || result?.status === "not_real_portal") {
          logger.info("Portal handled via alternative path", { caseId, status: result.status });
          return result;
        }
        throw new Error(result?.error || "Portal submission failed");
      }

      // ── Dedup skip: Skyvern service detected this was already submitted — don't re-update status ──
      if (result.skipped) {
        logger.info("Portal submission was a dedup skip", { caseId, reason: result.reason });
        return result;
      }

      // ── Success: update everything ──
      const engineUsed = result.engine || "skyvern";
      const statusText = result.status || "submitted";
      const taskUrl = result.taskId ? `https://app.skyvern.com/tasks/${result.taskId}` : null;

      await db.updateCaseStatus(caseId, "sent", {
        substatus: `Portal submission completed (${statusText})`,
        send_date: caseData.send_date || new Date(),
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
      return { success: false, error: error.message };
    }
  },
});
