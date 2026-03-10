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

function generateInitialRequestProposalKey(caseId: number, hasPortal: boolean, caseAgencyId?: number | null): string {
  const action = hasPortal ? "SUBMIT_PORTAL" : "SEND_INITIAL_REQUEST";
  const normalizedCaseAgencyId = Number.isInteger(caseAgencyId) && Number(caseAgencyId) > 0
    ? Number(caseAgencyId)
    : null;
  const agencyScope = normalizedCaseAgencyId ? `:ca${normalizedCaseAgencyId}` : "";
  return `${caseId}:initial${agencyScope}:${action}:0`;
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
  routeMode?: "email" | "portal",
  caseAgencyId?: number | null
): Promise<InitialDraftResult> {
  const caseData = await db.getCaseById(caseId);
  if (!caseData) throw new Error(`Case ${caseId} not found`);

  const normalizedCaseAgencyId = Number.isInteger(caseAgencyId) && Number(caseAgencyId) > 0
    ? Number(caseAgencyId)
    : null;
  const caseAgency = normalizedCaseAgencyId
    ? await db.getCaseAgencyById(Number(caseAgencyId))
    : null;

  if (caseAgencyId && !caseAgency) {
    throw new Error(`Case agency ${caseAgencyId} not found for case ${caseId}`);
  }
  if (caseAgency && Number(caseAgency.case_id) !== Number(caseId)) {
    throw new Error(`Case agency ${caseAgencyId} does not belong to case ${caseId}`);
  }

  const effectiveCaseData = {
    ...caseData,
    agency_id: caseAgency ? (caseAgency.agency_id ?? null) : caseData.agency_id,
    agency_name: caseAgency?.agency_name || caseData.agency_name,
    agency_email: caseAgency ? (caseAgency.agency_email ?? null) : caseData.agency_email,
    portal_url: caseAgency ? (caseAgency.portal_url ?? null) : caseData.portal_url,
    portal_provider: caseAgency ? (caseAgency.portal_provider ?? null) : caseData.portal_provider,
    case_agency_id: caseAgency?.id ?? null,
    last_portal_status: caseData.last_portal_status,
  };

  if (routeMode === "email") {
    effectiveCaseData.portal_url = null;
    effectiveCaseData.portal_provider = null;
    effectiveCaseData.last_portal_status = null;
  }
  if (routeMode === "portal") {
    effectiveCaseData.agency_email = null;
  }

  const hasPortal = hasAutomatablePortal(
    effectiveCaseData.portal_url,
    effectiveCaseData.portal_provider,
    effectiveCaseData.last_portal_status
  );
  const actionType = hasPortal ? "SUBMIT_PORTAL" : "SEND_INITIAL_REQUEST";
  const proposalKey = generateInitialRequestProposalKey(caseId, hasPortal, caseAgency?.id ?? null);

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
    caseAgencyId: caseAgency?.id ?? null,
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
