/**
 * Load Context Step
 *
 * Port of langgraph/nodes/load-context.js
 * Fetches all context needed for decision-making.
 */

import db, { logger } from "../lib/db";
import type {
  CaseContext,
  AutopilotMode,
  ScopeItem,
  DecisionHistoryEntry,
  PortalTaskHistoryEntry,
  FeeEventEntry,
  DismissedProposalEntry,
} from "../lib/types";

export async function loadContext(
  caseId: number,
  messageId: number | null
): Promise<CaseContext> {
  const caseData = await db.getCaseById(caseId);
  if (!caseData) {
    throw new Error(`Case ${caseId} not found`);
  }

  const messages = await db.getMessagesByCaseId(caseId);
  const attachments = await db.getAttachmentsByCaseId(caseId);

  let analysis = null;
  if (messageId) {
    analysis = await db.getResponseAnalysisByMessageId(messageId);
  }

  const [followups, existingProposal, decisionHistoryResult, portalTaskHistoryResult, feeEventsResult, dismissedProposalsResult] = await Promise.all([
    db.getFollowUpScheduleByCaseId(caseId),
    db.getLatestPendingProposal(caseId),
    db.query(
      `SELECT action_taken, reasoning, outcome, created_at
       FROM agent_decisions
       WHERE case_id = $1
       ORDER BY created_at DESC
       LIMIT 10`,
      [caseId]
    ).catch(() => ({ rows: [] })),
    db.query(
      `SELECT status, completion_notes, portal_url, created_at
       FROM portal_tasks
       WHERE case_id = $1
       ORDER BY created_at DESC
       LIMIT 5`,
      [caseId]
    ).catch(() => ({ rows: [] })),
    db.query(
      `SELECT event_type, amount, notes, created_at
       FROM fee_events
       WHERE case_id = $1
       ORDER BY created_at DESC
       LIMIT 5`,
      [caseId]
    ).catch(() => ({ rows: [] })),
    db.query(
      `SELECT action_type, reasoning, human_decision, created_at,
              COUNT(*) OVER (PARTITION BY action_type) as dismiss_count
       FROM proposals
       WHERE case_id = $1 AND status = 'DISMISSED'
       ORDER BY created_at DESC
       LIMIT 10`,
      [caseId]
    ).catch(() => ({ rows: [] })),
  ]);

  const decisionHistory: DecisionHistoryEntry[] = decisionHistoryResult.rows;
  const portalTaskHistory: PortalTaskHistoryEntry[] = portalTaskHistoryResult.rows;
  const feeEvents: FeeEventEntry[] = feeEventsResult.rows;
  const dismissedProposals: DismissedProposalEntry[] = dismissedProposalsResult.rows;

  // Extract constraints and scope from case data (JSONB columns with fallbacks)
  const constraints: string[] =
    caseData.constraints_jsonb || caseData.constraints || [];
  let scopeItems: ScopeItem[] =
    caseData.scope_items_jsonb || caseData.scope_items || [];

  // Auto-generate scopeItems from requested_records if missing
  if ((!scopeItems || scopeItems.length === 0) && caseData.requested_records) {
    const records = Array.isArray(caseData.requested_records)
      ? caseData.requested_records
      : [caseData.requested_records];
    scopeItems = records.map((r: any) => ({
      name:
        typeof r === "string" ? r : r.name || r.description || JSON.stringify(r),
      status: "REQUESTED",
      reason: null,
      confidence: null,
    }));

    await db.updateCase(caseId, {
      scope_items_jsonb: JSON.stringify(scopeItems),
    });
    logger.info("Generated and persisted scope_items_jsonb from requested_records", {
      caseId,
      count: scopeItems.length,
    });
  }

  return {
    caseId,
    caseData,
    messages,
    attachments,
    analysis,
    followups,
    existingProposal,
    autopilotMode: (caseData.autopilot_mode as AutopilotMode) || "SUPERVISED",
    constraints,
    scopeItems,
    decisionHistory,
    portalTaskHistory,
    feeEvents,
    dismissedProposals,
  };
}
