/**
 * Draft Initial Request Step
 *
 * Port of langgraph/nodes/draft-initial-request.js
 * Generates the initial FOIA request, creates proposal.
 */

import db, { aiService, logger } from "../lib/db";
import type { AutopilotMode, ProposalRecord } from "../lib/types";

function generateInitialRequestProposalKey(caseId: number): string {
  return `${caseId}:initial:SEND_INITIAL_REQUEST:0`;
}

export interface InitialDraftResult {
  proposalId: number;
  proposalKey: string;
  subject: string;
  bodyText: string;
  bodyHtml: string;
  canAutoExecute: boolean;
  requiresHuman: boolean;
  reasoning: string[];
}

export async function draftInitialRequest(
  caseId: number,
  runId: number,
  autopilotMode: AutopilotMode
): Promise<InitialDraftResult> {
  const caseData = await db.getCaseById(caseId);
  if (!caseData) throw new Error(`Case ${caseId} not found`);

  const proposalKey = generateInitialRequestProposalKey(caseId);

  // Check for existing proposal (idempotency)
  // Only reuse if in a non-terminal state
  const existing = await db.getProposalByKey(proposalKey);
  if (existing) {
    const terminalStates = ["EXECUTED", "DISMISSED", "WITHDRAWN", "EXPIRED", "CANCELLED"];
    if (terminalStates.includes(existing.status)) {
      logger.info("Existing proposal in terminal state, creating new one", {
        caseId, proposalKey, status: existing.status,
      });
      // Fall through to create new proposal
    } else {
      return {
        proposalId: existing.id,
        proposalKey,
        subject: existing.draft_subject,
        bodyText: existing.draft_body_text,
        bodyHtml: existing.draft_body_html,
        canAutoExecute: existing.can_auto_execute,
        requiresHuman: existing.requires_human,
        reasoning: existing.reasoning || [],
      };
    }
  }

  // Generate request using AI service
  const draftResult = await aiService.generateFOIARequest(caseData);
  if (!draftResult || typeof draftResult !== "object") {
    throw new Error(`AI returned null/invalid result for case ${caseId}`);
  }

  const subject =
    draftResult.subject ||
    `Public Records Request - ${caseData.subject_name || "Records Request"}`;
  const bodyText = draftResult.body || draftResult.requestText || draftResult.request_text;

  if (!bodyText || typeof bodyText !== "string" || !bodyText.trim()) {
    throw new Error(
      `AI returned empty body for case ${caseId} — keys: ${Object.keys(draftResult).join(", ")}`
    );
  }

  // Convert markdown to HTML when generating fallback HTML
  const markdownToHtml = (text: string) => text
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>')
    .replace(/\n/g, '<br>');

  const bodyHtml =
    draftResult.body_html ||
    `<div style="font-family: Arial, sans-serif;">${markdownToHtml(bodyText)}</div>`;

  const canAutoExecute = autopilotMode === "AUTO";
  const requiresHuman = !canAutoExecute;

  const reasoning = [
    `Generated initial FOIA request for ${caseData.agency_name}`,
    `Subject: ${caseData.subject_name || "N/A"}`,
    `Records: ${(caseData.requested_records || []).join(", ") || "Various records"}`,
    `Autopilot: ${autopilotMode}`,
  ];

  const proposal = await db.upsertProposal({
    proposalKey,
    caseId,
    runId,
    triggerMessageId: null,
    actionType: "SEND_INITIAL_REQUEST",
    draftSubject: subject,
    draftBodyText: bodyText,
    draftBodyHtml: bodyHtml,
    reasoning,
    canAutoExecute,
    requiresHuman,
    status: requiresHuman ? "PENDING_APPROVAL" : "DRAFT",
  });

  return {
    proposalId: proposal.id,
    proposalKey,
    subject,
    bodyText,
    bodyHtml,
    canAutoExecute,
    requiresHuman,
    reasoning,
  };
}
