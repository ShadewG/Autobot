/**
 * Reconcile case flags after a proposal is dismissed.
 *
 * When a human dismisses a proposal, requires_human and pause_reason may be
 * left stale if no other active proposal exists. This helper clears them and
 * sets the case status to an appropriate non-review status.
 */

import db, { logger } from "./db";

const REVIEW_STATUSES = [
  "needs_human_review",
  "needs_phone_call",
  "needs_contact_info",
  "needs_human_fee_approval",
];

export async function reconcileCaseAfterDismiss(caseId: number): Promise<void> {
  // Check if any other active proposal still exists
  const remaining = await db.query(
    `SELECT 1 FROM proposals WHERE case_id = $1 AND status IN ('PENDING_APPROVAL','BLOCKED') LIMIT 1`,
    [caseId]
  );
  if (remaining.rows.length > 0) return; // Another proposal still active — stay paused

  const caseRow = await db.getCaseById(caseId);
  if (!caseRow?.requires_human) return; // Already cleared

  if (REVIEW_STATUSES.includes(caseRow.status)) {
    // Determine target status: if case has inbound messages → responded, otherwise awaiting_response
    const hasInbound = await db.query(
      `SELECT 1 FROM messages WHERE case_id = $1 AND direction = 'inbound' LIMIT 1`,
      [caseId]
    );
    const targetStatus = hasInbound.rows.length > 0 ? "responded" : "awaiting_response";
    await db.updateCaseStatus(caseId, targetStatus, { requires_human: false, pause_reason: null });
    logger.info("Reconciled case after dismiss: cleared review state", {
      caseId, from: caseRow.status, to: targetStatus,
    });
  } else {
    // Status is already non-review (responded, awaiting_response, etc.) — just clear flags
    await db.updateCaseStatus(caseId, caseRow.status, { requires_human: false, pause_reason: null });
    logger.info("Reconciled case after dismiss: cleared stale flags", {
      caseId, status: caseRow.status,
    });
  }
}
