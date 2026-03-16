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
const { createDecisionTraceTracker, summarizeExecutionResult } = require("../../services/decision-trace-service");

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
const getPlaywright = lazy(() => require("../../services/portal-agent-service-playwright"));
const getNotion = lazy(() => require("../../services/notion-service"));
const getDiscord = lazy(() => require("../../services/discord-service"));
const getDecisionMemory = lazy(() => require("../../services/decision-memory-service"));
const getExecutor = lazy(() => require("../../services/executor-adapter"));

const MAX_RECENT_FAILURES = 2;
const FAILURE_WINDOW_HOURS = 24;
const MAX_PORTAL_RUNS_PER_DAY = 2;
const MAX_PORTAL_RUNS_TOTAL = 2;
const STALE_CREDENTIAL_DAYS = 30;

function parsePortalPrepAllowlist(rawValue: any): Set<string> {
  return new Set(
    String(rawValue || "")
      .split(",")
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean)
  );
}

function shouldUsePlaywrightPrep(provider: any, portalUrl: any): boolean {
  if (String(process.env.PLAYWRIGHT_PORTAL_PREP_ENABLED || "").toLowerCase() !== "true") {
    return false;
  }

  const normalizedProvider = String(provider || "").trim().toLowerCase();
  const allowlist = parsePortalPrepAllowlist(
    process.env.PLAYWRIGHT_PORTAL_PREP_PROVIDERS || "nextrequest"
  );
  if (normalizedProvider && allowlist.has(normalizedProvider)) {
    return true;
  }

  const normalizedUrl = String(portalUrl || "").toLowerCase();
  return Array.from(allowlist).some((value) => normalizedUrl.includes(value));
}

function inferAgencyType(agencyName: any): string {
  const text = String(agencyName || "").toLowerCase();
  if (!text) return "unknown agency";
  if (text.includes("sheriff")) return "sheriff agency";
  if (text.includes("police")) return "police agency";
  if (text.includes("state patrol") || text.includes("trooper") || text.includes("dci")) return "state law enforcement agency";
  if (text.includes("district attorney") || text.includes("prosecutor")) return "prosecutor office";
  if (text.includes("attorney general")) return "attorney general office";
  if (text.includes("county")) return "county agency";
  if (text.includes("city")) return "city agency";
  return "records agency";
}

export function getPortalFailureSignature(errorText: any): string {
  const text = String(errorText || "").toLowerCase();
  if (!text.trim()) return "generic_failure";
  if (/blocked-words|blocked words|spam filter|spam-filter/.test(text)) return "blocked_words";
  if (/timeout|timed out|max duration|deadline exceeded|exceeded/.test(text)) return "timeout";
  if (/captcha/.test(text)) return "captcha";
  if (/login|sign in|authentication|credential|password/.test(text)) return "login_failure";
  if (/duplicate|already submitted|already exists|previously submitted/.test(text)) return "duplicate_request";
  if (/required field|validation|required/.test(text)) return "validation_error";
  return "generic_failure";
}

export function buildPortalFailureLesson(caseData: any, provider: string | null, errorText: any) {
  const agencyType = inferAgencyType(caseData?.agency_name);
  const providerLabel = String(provider || caseData?.portal_provider || "unknown portal").trim();
  const signature = getPortalFailureSignature(errorText);
  const hasEmailFallback = Boolean(caseData?.agency_email || caseData?.alternate_agency_email);
  const lesson = hasEmailFallback
    ? `When portal submission for a ${agencyType} fails via ${providerLabel} with ${signature}, prefer email instead of retrying the same portal path.`
    : `When portal submission for a ${agencyType} fails via ${providerLabel} with ${signature}, prefer manual portal handling instead of retrying the same portal path.`;

  return {
    category: "portal",
    triggerPattern: `portal failed for ${agencyType} (${signature}) with ${hasEmailFallback ? "email_fallback" : "manual_fallback"}`,
    lesson,
    priority: 8,
  };
}

async function learnFromPortalFailure(caseData: any, provider: string | null, errorText: any) {
  try {
    if (!caseData?.id) return;
    const decisionMemory = getDecisionMemory();
    const lesson = buildPortalFailureLesson(caseData, provider, errorText);
    await decisionMemory.learnFromOutcome({
      ...lesson,
      sourceCaseId: caseData.id,
    });
  } catch {}
}

export async function recordPortalSubmissionStart(
  db: any,
  {
    caseId,
    runId = null,
    skyvernTaskId = null,
    status = "started",
    engine = null,
    accountEmail = null,
  }: {
    caseId: number;
    runId?: number | null;
    skyvernTaskId?: string | null;
    status?: string;
    engine?: string | null;
    accountEmail?: string | null;
  }
) {
  return db.createPortalSubmission({
    caseId,
    runId,
    skyvernTaskId,
    status,
    engine,
    accountEmail,
  });
}

export async function finalizePortalSubmissionSuccess(
  db: any,
  submissionRowId: number,
  result: any,
  taskUrl: string | null = null
) {
  return db.updatePortalSubmission(submissionRowId, {
    status: "completed",
    skyvern_task_id: result?.taskId || result?.runId || null,
    screenshot_url: result?.screenshot_url || null,
    recording_url: result?.recording_url || taskUrl,
    extracted_data: result?.extracted_data ? JSON.stringify(result.extracted_data) : null,
    completed_at: new Date(),
  });
}

export async function finalizePortalSubmissionFailure(
  db: any,
  submissionRowId: number,
  error: any
) {
  return db.updatePortalSubmission(submissionRowId, {
    status: "failed",
    error_message: String(error?.message || error || "").substring(0, 500) || null,
    completed_at: new Date(),
  });
}

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
      const failedCase = await db.getCaseById(caseId).catch(() => null);
      if (failedCase) {
        await learnFromPortalFailure(failedCase, failedCase.portal_provider || null, errorText);
      }

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

      // Update portal submission history row (find the latest started one for this case)
      try {
        await db.query(
          `UPDATE portal_submissions
           SET status = 'timed_out', error_message = $2, completed_at = NOW()
           WHERE id = (
             SELECT id FROM portal_submissions
             WHERE case_id = $1 AND status = 'started'
             ORDER BY started_at DESC LIMIT 1
           )`,
          [caseId, errorText.substring(0, 500)]
        );
      } catch {}
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
    const trace = await createDecisionTraceTracker(db, {
      taskType: "submit-portal",
      runId: agentRunId || null,
      caseId,
      triggerType: "SUBMIT_PORTAL",
      classification: {
        classification: "SUBMIT_PORTAL",
        source: "PORTAL_TASK",
      },
      routerOutput: {
        actionType: "SUBMIT_PORTAL",
        portalUrl,
        provider: provider || null,
      },
      context: {
        portalTaskId: portalTaskId || null,
      },
    });
    const recordNode = (step: string, payload: Record<string, any> = {}) => {
      trace?.recordNode(step, payload);
    };

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
    recordNode("start", { portalUrl, provider: provider || null, portalTaskId: portalTaskId || null });

    let linkedProposalId: number | undefined;
    let linkedExecutionId: number | undefined;
    let linkedExecutionKey: string | undefined;
    if (portalTaskId) {
      const ptRow = (await db.query(
        "SELECT proposal_id, execution_id FROM portal_tasks WHERE id = $1 LIMIT 1", [portalTaskId]
      )).rows[0];
      linkedProposalId = Number(ptRow?.proposal_id || 0) || undefined;
      linkedExecutionId = Number(ptRow?.execution_id || 0) || undefined;
      if (linkedExecutionId) {
        const execRow = (await db.query(
          "SELECT execution_key FROM executions WHERE id = $1 LIMIT 1", [linkedExecutionId]
        )).rows[0];
        linkedExecutionKey = execRow?.execution_key || undefined;
      }
    }

    try {
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
      trace.setGateDecision({ reason: "circuit_breaker", recentFailures: failCount });
      trace.markOutcome("skipped", { reason: "circuit_breaker", recentFailures: failCount });
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
      trace.setGateDecision({ reason: "hard_rate_limit", todayRuns, totalRuns });
      trace.markOutcome("skipped", { reason: "hard_rate_limit", todayRuns, totalRuns });
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
    const primaryCaseAgency = await db.getPrimaryCaseAgency(caseId);
    const primaryPortalUrl = String(primaryCaseAgency?.portal_url || "").trim() || null;

    // ── Idempotency: skip if case already past submission stage ──
    const skipStatuses = ["sent", "awaiting_response", "responded", "completed", "needs_phone_call"];
    if (skipStatuses.includes(caseData.status)) {
      trace.markOutcome("skipped", { reason: caseData.status });
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
      trace.setGateDecision({ reason: "provider_paper_only", provider: provider || caseData.portal_provider || null });
      trace.markOutcome("skipped", { reason: "provider_paper_only" });
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
        trace.markOutcome("skipped", { reason: "task_cancelled" });
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
      trace.markOutcome("skipped", { reason: "recent_success" });
      logger.warn("Portal submission skipped — successful submission within last hour", { caseId });
      await cancelPortalTask("Recent successful portal submission detected");
      await closeAgentRun("completed");
      return { success: true, skipped: true, reason: "recent_success" };
    }

    let discoveredPortalUrl: string | null = null;
    if (!portalUrl && !caseData.portal_url) {
      // Fallback 1: use most recent non-empty portal_url recorded on prior portal tasks.
      const portalFromTask = await db.query(
        `SELECT NULLIF(portal_url, '') AS portal_url
         FROM portal_tasks
         WHERE case_id = $1
           AND portal_url IS NOT NULL
           AND portal_url <> ''
         ORDER BY COALESCE(updated_at, created_at) DESC
         LIMIT 1`,
        [caseId]
      );
      discoveredPortalUrl = (portalFromTask.rows[0]?.portal_url || '').trim() || null;

      // Fallback 2: recover from activity log metadata if task table has no URL.
      if (!discoveredPortalUrl) {
        const portalFromActivity = await db.query(
          `SELECT
              COALESCE(
                NULLIF(metadata->>'portal_url', ''),
                NULLIF(metadata->>'portalUrl', '')
              ) AS portal_url
           FROM activity_log
           WHERE case_id = $1
             AND (
               event_type = 'portal_notification'
               OR event_type LIKE 'portal_%'
             )
           ORDER BY created_at DESC
           LIMIT 1`,
          [caseId]
        );
        discoveredPortalUrl = (portalFromActivity.rows[0]?.portal_url || '').trim() || null;
      }

      // Fallback 3: recover from recent inbound portal notifications.
      if (!discoveredPortalUrl) {
        const portalFromMessages = await db.query(
          `SELECT
              COALESCE(
                NULLIF(m.metadata->>'portal_url', ''),
                NULLIF(m.metadata->>'portalUrl', '')
              ) AS portal_url
           FROM messages m
           WHERE m.case_id = $1
             AND m.direction = 'inbound'
             AND (
               m.portal_notification = true
               OR m.from_email ILIKE '%@govqa.%'
               OR m.subject ILIKE '%records center%'
             )
           ORDER BY COALESCE(m.received_at, m.created_at) DESC
           LIMIT 1`,
          [caseId]
        );
        discoveredPortalUrl = (portalFromMessages.rows[0]?.portal_url || '').trim() || null;
      }

      if (discoveredPortalUrl) {
        await db.updateCase(caseId, {
          portal_url: discoveredPortalUrl,
          last_portal_status: `Recovered portal URL from inbound notification`,
          last_portal_status_at: new Date(),
        });
      }
    }

    const targetUrl = portalUrl || caseData.portal_url || primaryPortalUrl || discoveredPortalUrl;
    if (!targetUrl) {
      trace.setGateDecision({ reason: "invalid_portal_url" });
      trace.markOutcome("failed", { reason: "invalid_portal_url" });
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
    const shouldRunPlaywrightPrep = shouldUsePlaywrightPrep(
      provider || caseData.portal_provider || null,
      targetUrl
    );
    let portalAccount = await db.getPortalAccountByUrl(targetUrl, caseData.user_id || null, { includeInactive: true });
    if (portalAccount) {
      const blockedStatuses = new Set(["locked", "inactive"]);
      if (blockedStatuses.has(portalAccount.account_status)) {
        if (shouldRunPlaywrightPrep) {
          logger.info("Playwright prep enabled — attempting account recovery before blocking on account status", {
            caseId,
            targetUrl,
            accountId: portalAccount.id,
            accountStatus: portalAccount.account_status,
            accountEmail: portalAccount.email,
          });
        } else {
        trace.setGateDecision({
          reason: `portal_account_${portalAccount.account_status}`,
          accountStatus: portalAccount.account_status,
          accountEmail: portalAccount.email || null,
        });
        trace.markOutcome("failed", { reason: `portal_account_${portalAccount.account_status}` });
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

    if (shouldRunPlaywrightPrep) {
      try {
        recordNode("playwright_prep_started", {
          provider: provider || caseData.portal_provider || null,
          portalUrl: targetUrl,
        });
        const playwright = getPlaywright();
        const prepResult = await playwright.preparePortalSession(caseData, targetUrl, {
          trackInAutobot: true,
          ensureAccount: true,
          forceAccountSetup: true,
        });
        recordNode("playwright_prep_completed", {
          success: prepResult?.success === true,
          status: prepResult?.status || null,
          accountEmail: prepResult?.accountEmail || null,
        });

        if (prepResult?.success) {
          portalAccount = await db.getPortalAccountByUrl(targetUrl, caseData.user_id || null, { includeInactive: true });
          logger.info("Playwright prep completed before Skyvern submission", {
            caseId,
            portalUrl: targetUrl,
            status: prepResult?.status || null,
            accountEmail: prepResult?.accountEmail || portalAccount?.email || null,
          });
        } else {
          logger.warn("Playwright prep did not complete cleanly; continuing with Skyvern fallback", {
            caseId,
            portalUrl: targetUrl,
            status: prepResult?.status || null,
            blockers: prepResult?.blockers || [],
          });
        }
      } catch (prepError: any) {
        recordNode("playwright_prep_failed", {
          error: prepError?.message || String(prepError),
        });
        logger.warn("Playwright prep failed; continuing with Skyvern fallback", {
          caseId,
          portalUrl: targetUrl,
          error: prepError?.message || String(prepError),
        });
      }
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
    trace.setRouterOutput({
      actionType: "SUBMIT_PORTAL",
      portalUrl: targetUrl,
      provider: provider || caseData.portal_provider || null,
      bypassApprovalGate,
    });

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

    // ── Record portal submission attempt ──
    let submissionRow: any = null;
    try {
      submissionRow = await recordPortalSubmissionStart(db, {
        caseId,
        runId: agentRunId || null,
        skyvernTaskId: null, // filled after Skyvern returns
        status: "started",
        engine: provider || caseData.portal_provider || null,
        accountEmail: portalAccount?.email || caseData.last_portal_account_email || null,
      });
    } catch (subErr: any) {
      logger.warn("Failed to create portal_submissions row", { caseId, error: subErr?.message });
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
          trace.setGateDecision({
            needsApproval: true,
            reason: result.reason || null,
          });
          trace.markOutcome("blocked", { reason: result.reason || "needs_approval" });
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
          trace.setGateDecision({
            alternativePath: result.status,
            reason: result.reason || null,
          });
          trace.markOutcome("failed", { reason: result.status });
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
        trace.markOutcome("skipped", { reason: result.reason || "dedup_skip" });
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
        completedBy: engineUsed,
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

      // Update portal submission history row
      if (submissionRow?.id) {
        try {
          await finalizePortalSubmissionSuccess(db, submissionRow.id, result, taskUrl);
        } catch {}
      }
      try {
        await db.upsertPortalAutomationPolicy({
          portalUrl: targetUrl,
          provider: provider || caseData.portal_provider || null,
          policyStatus: 'trusted',
          decisionSource: 'automation_success',
          decisionReason: 'successful_portal_submission',
          caseId,
          submissionId: submissionRow?.id || null,
          successDelta: 1,
        });
      } catch (policyErr: any) {
        logger.warn('Failed to persist portal automation success policy', { error: policyErr?.message });
      }

      // Update the linked execution record from PENDING_HUMAN → SENT
      if (linkedExecutionKey) {
        try {
          await getExecutor().updateExecutionRecord(linkedExecutionKey, {
            status: "SENT",
            providerPayload: {
              portalTaskId,
              portalUrl: targetUrl,
              engine: engineUsed,
              taskId: result.taskId || result.runId || null,
              confirmationNumber: result.confirmationNumber || null,
            },
            completedAt: new Date(),
          });
        } catch (execErr: any) {
          logger.warn("Failed to update portal execution record", { error: execErr?.message });
        }
      }

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

      trace.setGateDecision({
        portalResult: summarizeExecutionResult({
          success: result.success,
          status: result.status || "submitted",
          reason: result.reason || null,
          portalTaskId: result.taskId || result.runId || null,
          details: {
            confirmationNumber: result.confirmationNumber || null,
            engine: engineUsed,
            taskUrl,
          },
        }),
      });
      trace.markOutcome("completed", {
        success: true,
        portalTaskId: result.taskId || result.runId || null,
      });
      logger.info("Portal submission succeeded", { caseId, engine: engineUsed, taskUrl });
      await closeAgentRun("completed");
      return result;

    } catch (error: any) {
      trace.markOutcome("failed", { error: error.message });
      logger.error("Portal submission failed", { caseId, error: error.message });
      await learnFromPortalFailure(caseData, provider, error.message);

      // Update portal submission history row
      if (submissionRow?.id) {
        try {
          await finalizePortalSubmissionFailure(db, submissionRow.id, error);
        } catch {}
      }
      try {
        await db.upsertPortalAutomationPolicy({
          portalUrl: targetUrl,
          provider: provider || caseData.portal_provider || null,
          decisionSource: 'automation_failure',
          decisionReason: getPortalFailureSignature(error.message),
          caseId,
          submissionId: submissionRow?.id || null,
          failureDelta: 1,
        });
      } catch (policyErr: any) {
        logger.warn('Failed to persist portal automation failure telemetry', { error: policyErr?.message });
      }

      // Update the linked execution record from PENDING_HUMAN → FAILED
      if (linkedExecutionKey) {
        try {
          await getExecutor().updateExecutionRecord(linkedExecutionKey, {
            status: "FAILED",
            providerPayload: { portalTaskId, portalUrl: targetUrl },
            errorMessage: error.message?.substring(0, 500) || null,
            failureStage: "portal_submission",
            failureCode: getPortalFailureSignature(error.message),
            completedAt: new Date(),
          });
        } catch (execErr: any) {
          logger.warn("Failed to update portal execution record", { error: execErr?.message });
        }
      }

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

      // Create manual-submission proposal if none exists (covers non-Skyvern engines & edge cases)
      try {
        await db.upsertProposal({
          proposalKey: `${caseId}:portal_failure:SUBMIT_PORTAL:1`,
          caseId,
          actionType: "SUBMIT_PORTAL",
          reasoning: [
            `Automated portal submission failed: ${error.message?.substring(0, 200)}`,
            "Manual portal submission required — use the portal helper to copy fields and submit manually",
          ],
          confidence: 0,
          requiresHuman: true,
          canAutoExecute: false,
          draftSubject: `Manual portal submission: ${caseData.case_name}`.substring(0, 200),
          draftBodyText: `Portal URL: ${targetUrl}\nPrevious attempt failed: ${error.message?.substring(0, 200)}\n\nOpen the portal and use the copy helper to manually fill the form.`,
          status: "PENDING_APPROVAL",
        });
      } catch (proposalErr: any) {
        logger.warn("Failed to create manual submission proposal", { error: proposalErr?.message });
      }

      // Don't re-throw — we've handled the failure. Retrying Skyvern is expensive.
      return { success: false, error: error.message };
    }
    } catch (error: any) {
      trace?.markFailed(error, { taskType: "submit-portal" });
      throw error;
    } finally {
      await trace?.complete();
    }
  },
});
