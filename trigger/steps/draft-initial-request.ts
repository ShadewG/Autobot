/**
 * Draft Initial Request Step
 *
 * Port of langgraph/nodes/draft-initial-request.js
 * Generates the initial FOIA request, creates proposal.
 */

import db, { aiService, logger } from "../lib/db";
import type { AutopilotMode, ProposalRecord, AIModelMetadata } from "../lib/types";
import { hasAutomatablePortal } from "../lib/portal-utils";
const { pickSafeSubjectDescriptor } = require("../../utils/request-normalization");

function generateInitialRequestProposalKey(caseId: number, hasPortal: boolean): string {
  const action = hasPortal ? "SUBMIT_PORTAL" : "SEND_INITIAL_REQUEST";
  return `${caseId}:initial:${action}:0`;
}

export interface InitialDraftResult {
  proposalId: number;
  proposalKey: string;
  proposalStatus: string;
  actionType: "SEND_INITIAL_REQUEST" | "SUBMIT_PORTAL";
  subject: string;
  bodyText: string;
  bodyHtml: string;
  canAutoExecute: boolean;
  requiresHuman: boolean;
  reasoning: string[];
  modelMetadata?: AIModelMetadata | null;
}

export async function draftInitialRequest(
  caseId: number,
  runId: number,
  autopilotMode: AutopilotMode,
  routeMode?: "email" | "portal"
): Promise<InitialDraftResult> {
  const caseData = await db.getCaseById(caseId);
  if (!caseData) throw new Error(`Case ${caseId} not found`);

  const effectiveCaseData = {
    ...caseData,
    portal_url: routeMode === "email" ? null : caseData.portal_url,
    portal_provider: routeMode === "email" ? null : caseData.portal_provider,
    last_portal_status: routeMode === "email" ? null : caseData.last_portal_status,
    agency_email: routeMode === "portal" ? null : caseData.agency_email,
  };

  const hasPortal = hasAutomatablePortal(
    effectiveCaseData.portal_url,
    effectiveCaseData.portal_provider,
    effectiveCaseData.last_portal_status
  );
  const actionType = hasPortal ? "SUBMIT_PORTAL" : "SEND_INITIAL_REQUEST";
  const proposalKey = generateInitialRequestProposalKey(caseId, hasPortal);

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
        proposalStatus: existing.status,
        actionType,
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
  const draftResult = await aiService.generateFOIARequest(effectiveCaseData);
  if (!draftResult || typeof draftResult !== "object") {
    throw new Error(`AI returned null/invalid result for case ${caseId}`);
  }

  const subjectDescriptor = pickSafeSubjectDescriptor(
    effectiveCaseData.subject_name,
    effectiveCaseData.case_name,
    effectiveCaseData.requested_records?.[0]
  );
  const subject =
    draftResult.subject ||
    `Public Records Request - ${subjectDescriptor}`;
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

  const deliveryMethod = hasPortal
    ? `Portal: ${effectiveCaseData.portal_url}`
    : `Email: ${effectiveCaseData.agency_email || "N/A"}`;
  const reasoning = [
    `Generated initial FOIA request for ${effectiveCaseData.agency_name}`,
    `Subject: ${subjectDescriptor || "N/A"}`,
    `Delivery: ${deliveryMethod}`,
    `Records: ${(effectiveCaseData.requested_records || []).join(", ") || "Various records"}`,
    `Autopilot: ${autopilotMode}`,
  ];

  const proposal = await db.upsertProposal({
    proposalKey,
    caseId,
    runId,
    triggerMessageId: null,
    actionType,
    draftSubject: subject,
    draftBodyText: bodyText,
    draftBodyHtml: bodyHtml,
    draftModelId: draftResult?.modelMetadata?.modelId || null,
    draftPromptTokens: draftResult?.modelMetadata?.promptTokens ?? null,
    draftCompletionTokens: draftResult?.modelMetadata?.completionTokens ?? null,
    draftLatencyMs: draftResult?.modelMetadata?.latencyMs ?? null,
    reasoning,
    canAutoExecute,
    requiresHuman,
    status: requiresHuman ? "PENDING_APPROVAL" : "DRAFT",
  });

  return {
    proposalId: proposal.id,
    proposalKey,
    proposalStatus: proposal.status,
    actionType,
    subject,
    bodyText,
    bodyHtml,
    canAutoExecute: !!proposal.can_auto_execute,
    requiresHuman: !!proposal.requires_human,
    reasoning,
    modelMetadata: draftResult?.modelMetadata || null,
  };
}
