/**
 * Load Context Step
 *
 * Port of langgraph/nodes/load-context.js
 * Fetches all context needed for decision-making.
 */

import db, { logger } from "../lib/db";
import type { CaseContext, AutopilotMode, ScopeItem } from "../lib/types";

export async function loadContext(
  caseId: number,
  messageId: number | null
): Promise<CaseContext> {
  const caseData = await db.getCaseById(caseId);
  if (!caseData) {
    throw new Error(`Case ${caseId} not found`);
  }

  const messages = await db.getMessagesByCaseId(caseId);

  let analysis = null;
  if (messageId) {
    analysis = await db.getResponseAnalysisByMessageId(messageId);
  }

  const followups = await db.getFollowUpScheduleByCaseId(caseId);
  const existingProposal = await db.getLatestPendingProposal(caseId);

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
    analysis,
    followups,
    existingProposal,
    autopilotMode: (caseData.autopilot_mode as AutopilotMode) || "SUPERVISED",
    constraints,
    scopeItems,
  };
}
