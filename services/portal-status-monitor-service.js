const db = require('./database');
const logger = require('./logger');
const skyvern = require('./portal-agent-service-skyvern');
const errorTrackingService = require('./error-tracking-service');

const READY_PATTERNS = [
  /\brecords?\s+(are\s+)?ready\b/i,
  /\bready for (download|pickup|release)\b/i,
  /\bavailable for (download|pickup|release)\b/i,
  /\brequest (is )?(completed|fulfilled)\b/i,
  /\bdocuments? (are )?available\b/i,
];

const DENIED_PATTERNS = [
  /\bdenied\b/i,
  /\brejected\b/i,
  /\bwithheld\b/i,
  /\bunable to release\b/i,
];

const MORE_INFO_PATTERNS = [
  /\bmore info\b/i,
  /\bmore information\b/i,
  /\badditional information\b/i,
  /\bawaiting your response\b/i,
  /\baction required\b/i,
  /\bverification required\b/i,
  /\bid required\b/i,
  /\bmissing information\b/i,
];

const AUTH_FAILURE_PATTERNS = [
  { kind: 'totp_missing', pattern: /no totp verification code found/i },
  { kind: 'login_failure', pattern: /invalid login attempt|password incorrect|unable to log in|unable to login|couldn't find your account|could not find your account|email address .* not found/i },
  { kind: 'reset_flow', pattern: /password reset|reset email has been sent|sign in help|confirmation for a password reset|dead end.*password reset/i },
];

function collapseWhitespace(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function buildStatusSummary(result = {}) {
  const pieces = [
    result.statusText,
    result.extracted_data?.status_detail,
    result.extracted_data?.summary,
  ]
    .map(collapseWhitespace)
    .filter(Boolean);
  return pieces.join(' | ').slice(0, 255) || 'Portal status check completed';
}

function classifyPortalCheckFailure(rawError) {
  const text = collapseWhitespace(rawError).toLowerCase();
  if (!text) return null;

  for (const entry of AUTH_FAILURE_PATTERNS) {
    if (entry.pattern.test(text)) {
      return entry.kind;
    }
  }

  return null;
}

function classifyPortalStatus(result = {}) {
  const summary = buildStatusSummary(result);
  const text = summary.toLowerCase();

  if (READY_PATTERNS.some((pattern) => pattern.test(text))) {
    return { category: 'records_ready', summary };
  }
  if (MORE_INFO_PATTERNS.some((pattern) => pattern.test(text))) {
    return { category: 'more_info_needed', summary };
  }
  if (DENIED_PATTERNS.some((pattern) => pattern.test(text))) {
    return { category: 'denied', summary };
  }

  return { category: 'monitoring', summary };
}

async function createPortalAlertProposal(caseData, classification, deps = {}) {
  const database = deps.db || db;
  const statusLabel = classification.category === 'denied' ? 'denial' : 'additional action needed';

  return database.upsertProposal({
    proposalKey: `${caseData.id}:portal_status:${classification.category}:ESCALATE`,
    caseId: caseData.id,
    actionType: 'ESCALATE',
    reasoning: [
      { step: 'Portal status monitor', detail: `Skyvern reported ${statusLabel}` },
      { step: 'Portal status', detail: classification.summary },
      { step: 'Operator action', detail: 'Review the portal and decide the next manual step' },
    ],
    confidence: 0.85,
    requiresHuman: true,
    canAutoExecute: false,
    draftSubject: `Portal review needed: ${caseData.case_name}`.slice(0, 200),
    draftBodyText: `Portal status check for ${caseData.case_name} reported: ${classification.summary}\n\nPlease review the case and decide the next manual step.`,
    status: 'PENDING_APPROVAL',
  });
}

async function applyPortalStatusOutcome(caseData, result, deps = {}) {
  const database = deps.db || db;
  const classification = classifyPortalStatus(result);
  const portalUpdate = {
    last_portal_status: classification.summary,
    last_portal_status_at: new Date(),
    last_portal_engine: 'skyvern',
    last_portal_run_id: result.taskId || null,
    last_portal_details: result.extracted_data || null,
    last_portal_task_url: result.submissionUrl || undefined,
    last_portal_recording_url: result.recording_url || undefined,
    last_portal_account_email: result.accountEmail || undefined,
  };

  if (result.submissionUrl) {
    portalUpdate.portal_url = result.submissionUrl;
  }

  await database.updateCasePortalStatus(caseData.id, portalUpdate);
  await database.logActivity(
    'portal_status_checked',
    `Portal status checked for ${caseData.case_name}: ${classification.summary}`,
    {
      case_id: caseData.id,
      actor_type: 'system',
      source_service: 'portal_status_monitor',
      portal_status_category: classification.category,
      portal_task_id: result.taskId || null,
    }
  );

  if (classification.category === 'records_ready') {
    try {
      await database.dismissPendingProposals(caseData.id, 'Portal indicates records are ready', ['SUBMIT_PORTAL']);
    } catch (_) {}
    await database.updateCase(caseData.id, {
      status: 'completed',
      substatus: `Portal indicates records are ready`.slice(0, 100),
      outcome_type: 'records_ready',
      outcome_recorded: true,
    });
    await database.logActivity(
      'portal_status_records_ready',
      `Portal indicates records are ready for ${caseData.case_name}`,
      {
        case_id: caseData.id,
        actor_type: 'system',
        source_service: 'portal_status_monitor',
        portal_status: classification.summary,
      }
    );
  }

  if (classification.category === 'denied' || classification.category === 'more_info_needed') {
    await createPortalAlertProposal(caseData, classification, { db: database });
    await database.updateCase(caseData.id, {
      status: 'needs_human_review',
      substatus: `Portal alert: ${classification.summary}`.slice(0, 100),
    });
    await database.logActivity(
      'portal_status_alert',
      `Portal status requires review for ${caseData.case_name}: ${classification.summary}`,
      {
        case_id: caseData.id,
        actor_type: 'system',
        source_service: 'portal_status_monitor',
        portal_status_category: classification.category,
      }
    );
  }

  return classification;
}

async function checkCasePortalStatus(caseData, deps = {}) {
  const database = deps.db || db;
  const portalAgent = deps.skyvern || skyvern;

  if (!caseData?.id || !caseData?.portal_url) {
    return { success: false, skipped: true, reason: 'missing_case_or_portal' };
  }

  const releasePortalMonitorLock = typeof database.acquireAdvisoryLock === 'function'
    ? await database.acquireAdvisoryLock(`portal-status-monitor:${caseData.id}`)
    : async () => {};

  if (!releasePortalMonitorLock) {
    return { success: false, skipped: true, reason: 'status_check_locked' };
  }

  try {
    const result = await portalAgent.checkPortalStatus(caseData, caseData.portal_url, { maxSteps: 15 });
    if (!result?.success) {
      const failureSummary = collapseWhitespace(result?.error || 'Portal status check failed');
      const failureKind = classifyPortalCheckFailure(failureSummary);
      const shouldPauseMonitoring = ['totp_missing', 'login_failure', 'reset_flow'].includes(failureKind);
      let portalAccount = null;

      if (shouldPauseMonitoring && typeof database.getPortalAccountByUrl === 'function') {
        try {
          portalAccount = await database.getPortalAccountByUrl(caseData.portal_url, caseData.user_id || null, { includeInactive: true });
        } catch (_) {}
      }

      const updatedStatus = shouldPauseMonitoring
        ? `Status monitoring paused: ${failureSummary}`.slice(0, 255)
        : `Status check failed: ${failureSummary}`.slice(0, 255);
      await database.updateCasePortalStatus(caseData.id, {
        last_portal_status: updatedStatus,
        last_portal_status_at: new Date(),
        last_portal_engine: 'skyvern',
        last_portal_run_id: result?.taskId || null,
        last_portal_details: result?.extracted_data || null,
        last_portal_recording_url: result?.recording_url || undefined,
      });

      if (shouldPauseMonitoring && portalAccount?.id && portalAccount.account_status === 'active' && typeof database.updatePortalAccountStatus === 'function') {
        try {
          await database.updatePortalAccountStatus(portalAccount.id, 'locked');
        } catch (_) {}
      }

      await database.logActivity(
        shouldPauseMonitoring ? 'portal_status_monitor_paused' : 'portal_status_check_failed',
        shouldPauseMonitoring
          ? `Portal status monitoring paused for ${caseData.case_name}: ${failureSummary}`
          : `Portal status check failed for ${caseData.case_name}: ${failureSummary}`,
        {
          case_id: caseData.id,
          actor_type: 'system',
          source_service: 'portal_status_monitor',
          portal_task_id: result?.taskId || null,
          portal_status_failure_kind: failureKind || null,
          portal_account_id: portalAccount?.id || null,
        }
      );
      return { success: false, error: failureSummary, paused: shouldPauseMonitoring, reason: failureKind || 'status_check_failed' };
    }

    const classification = await applyPortalStatusOutcome(caseData, result, { db: database });
    return { success: true, classification, result };
  } catch (error) {
    // No saved portal account — expected condition, not an error
    if (error?.message?.includes('No saved portal account')) {
      return { success: false, skipped: true, reason: 'no_portal_account' };
    }
    // HTTP 402 = billing/quota exceeded — don't retry, just log once and skip
    const statusCode = error?.response?.status || error?.status;
    if (statusCode === 402) {
      console.warn(`[portal-monitor] Skyvern 402 (billing) for case ${caseData.id} — skipping`);
      return { success: false, skipped: true, reason: 'billing_quota_exceeded' };
    }
    await errorTrackingService.captureException(error, {
      sourceService: 'portal_status_monitor',
      operation: 'check_case_portal_status',
      caseId: caseData.id,
      metadata: { portalUrl: caseData.portal_url },
    });
    throw error;
  } finally {
    try {
      await releasePortalMonitorLock();
    } catch (_) {}
  }
}

async function monitorSubmittedPortalCases({ limit = 5, db: database = db, skyvern: portalAgent = skyvern } = {}) {
  const candidateResult = await database.query(
    `SELECT c.id, c.case_name, c.portal_url, c.portal_provider, c.user_id, c.status
       FROM cases c
      WHERE c.portal_url IS NOT NULL
        AND c.status IN ('awaiting_response', 'portal_in_progress')
        AND EXISTS (
          SELECT 1
            FROM portal_submissions ps
           WHERE ps.case_id = c.id
        )
        AND COALESCE(c.last_portal_status, '') NOT ILIKE 'Status monitoring paused:%'
        AND NOT EXISTS (
          SELECT 1
            FROM activity_log al
           WHERE al.case_id = c.id
             AND al.event_type IN ('portal_status_checked', 'portal_status_check_failed', 'portal_status_monitor_paused')
             AND al.created_at >= NOW() - INTERVAL '24 hours'
        )
      ORDER BY COALESCE(c.last_portal_status_at, c.updated_at, c.created_at) ASC
      LIMIT $1`,
    [limit]
  );

  let checked = 0;
  let recordsReady = 0;
  let alerts = 0;
  let failures = 0;

  for (const caseData of candidateResult.rows) {
    try {
      const outcome = await checkCasePortalStatus(caseData, { db: database, skyvern: portalAgent });
      checked += 1;
      if (outcome.classification?.category === 'records_ready') recordsReady += 1;
      if (['denied', 'more_info_needed'].includes(outcome.classification?.category)) alerts += 1;
      if (!outcome.success) failures += 1;
    } catch (error) {
      failures += 1;
      logger.warn('Portal status monitor case check failed', {
        caseId: caseData.id,
        error: error.message,
      });
    }
  }

  return {
    checked,
    recordsReady,
    alerts,
    failures,
    candidateCount: candidateResult.rows.length,
  };
}

module.exports = {
  buildStatusSummary,
  classifyPortalStatus,
  applyPortalStatusOutcome,
  checkCasePortalStatus,
  monitorSubmittedPortalCases,
};
