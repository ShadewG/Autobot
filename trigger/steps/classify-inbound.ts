/**
 * Classify Inbound Step
 *
 * REWRITTEN: Uses Vercel AI SDK generateObject() + Zod schema.
 * Replaces aiService.analyzeResponse() JSON.parse with guaranteed structured output.
 *
 * Falls back to existing aiService for compatibility during transition.
 */

import { generateObject } from "ai";
import { classifyModel } from "../lib/ai";
import { classificationSchema, type ClassificationOutput } from "../lib/schemas";
import db, { aiService, logger } from "../lib/db";
import type { ClassificationResult, CaseContext, Classification } from "../lib/types";

const CLASSIFICATION_MAP: Record<string, Classification> = {
  fee_request: "FEE_QUOTE",
  question: "CLARIFICATION_REQUEST",
  more_info_needed: "CLARIFICATION_REQUEST",
  hostile: "HOSTILE",
  denial: "DENIAL",
  partial_denial: "PARTIAL_APPROVAL",
  partial_approval: "PARTIAL_APPROVAL",
  partial_release: "PARTIAL_APPROVAL",
  portal_redirect: "PORTAL_REDIRECT",
  acknowledgment: "ACKNOWLEDGMENT",
  records_ready: "RECORDS_READY",
  delivery: "RECORDS_READY",
  partial_delivery: "PARTIAL_DELIVERY",
  wrong_agency: "WRONG_AGENCY",
  other: "UNKNOWN",
};

function buildClassificationPrompt(
  message: any,
  caseData: any,
  threadMessages: any[]
): string {
  const threadContext = threadMessages
    .slice(-10)
    .map(
      (m: any) =>
        `[${m.direction?.toUpperCase()}] ${m.subject || ""}\n${(m.body_text || "").substring(0, 500)}`
    )
    .join("\n---\n");

  const requestedRecords = Array.isArray(caseData.requested_records)
    ? caseData.requested_records.join(", ")
    : caseData.requested_records || "Various records";

  return `You are analyzing an agency response to a FOIA (Freedom of Information Act) request.

## Case Context
- **Agency**: ${caseData.agency_name || "Unknown"}
- **State**: ${caseData.state || "Unknown"}
- **Subject**: ${caseData.subject_name || "Unknown"}
- **Records Requested**: ${requestedRecords}
- **Current Status**: ${caseData.status || "Unknown"}

## Thread History (most recent last)
${threadContext || "No prior messages."}

## Message to Classify
**From**: ${message.from_email || message.sender_email || "Unknown"}
**Subject**: ${message.subject || "No subject"}
**Body**:
${(message.body_text || message.body_html || "").substring(0, 3000)}

## Instructions
Classify this agency response. Consider:
1. What is the primary intent? (fee request, denial, acknowledgment, etc.)
2. Does this require an email response from us?
3. Are there any fees mentioned? Extract the exact dollar amount if so.
4. Is there a portal URL we should use instead?
5. What constraints should we track? (e.g., BWC_EXEMPT, FEE_REQUIRED)
6. What's the status of each requested record item?
7. If this is a denial, what specific subtype is it?

Be precise with fee amounts — extract the exact number, not a range.
If the agency asked a question we haven't answered, note it in unanswered_agency_question.`;
}

export async function classifyInbound(
  context: CaseContext,
  messageId: number,
  triggerType: string
): Promise<ClassificationResult> {
  // Skip classification for time-based/scheduled triggers
  if (
    triggerType === "time_based_followup" ||
    triggerType === "SCHEDULED_FOLLOWUP" ||
    triggerType === "followup_trigger"
  ) {
    return {
      classification: "NO_RESPONSE",
      confidence: 1.0,
      sentiment: "neutral",
      extractedFeeAmount: null,
      extractedDeadline: null,
      denialSubtype: null,
      requiresResponse: false,
      portalUrl: null,
      suggestedAction: null,
      reasonNoResponse: "Scheduled followup trigger",
      unansweredAgencyQuestion: null,
    };
  }

  // Skip for human review resolution
  if (triggerType === "HUMAN_REVIEW_RESOLUTION") {
    return {
      classification: "HUMAN_REVIEW_RESOLUTION",
      confidence: 1.0,
      sentiment: "neutral",
      extractedFeeAmount: null,
      extractedDeadline: null,
      denialSubtype: null,
      requiresResponse: false,
      portalUrl: null,
      suggestedAction: null,
      reasonNoResponse: null,
      unansweredAgencyQuestion: null,
    };
  }

  if (!messageId) {
    return {
      classification: "NO_RESPONSE",
      confidence: 1.0,
      sentiment: "neutral",
      extractedFeeAmount: null,
      extractedDeadline: null,
      denialSubtype: null,
      requiresResponse: false,
      portalUrl: null,
      suggestedAction: null,
      reasonNoResponse: "No inbound message ID",
      unansweredAgencyQuestion: null,
    };
  }

  const message = await db.getMessageById(messageId);
  if (!message) {
    throw new Error(`Message ${messageId} not found`);
  }

  // Pre-check: detect automated portal system emails
  const fromAddr = (message.from_email || message.sender_email || "").toLowerCase();
  const subjectLower = (message.subject || "").toLowerCase();
  const bodySnippet = ((message.body_text || message.body_html || "").substring(0, 500)).toLowerCase();
  const portalSystems = ["justfoia", "nextrequest", "govqa", "jotform", "smartsheet"];
  const isPortalSystem = portalSystems.some((p: string) => fromAddr.includes(p) || subjectLower.includes(p));
  const isNoReply = /no.?reply|do.?not.?reply/.test(fromAddr);
  const isConfirmation =
    subjectLower.includes("verify") || subjectLower.includes("confirm your") ||
    subjectLower.includes("submission confirmation") || subjectLower.includes("request confirmation") ||
    subjectLower.includes("request received") || subjectLower.includes("thank you for submitting") ||
    bodySnippet.includes("verify your email") || bodySnippet.includes("confirm your email") ||
    bodySnippet.includes("confirm your account") || bodySnippet.includes("thank you for submitting") ||
    bodySnippet.includes("request has been received") || bodySnippet.includes("your request has been submitted") ||
    bodySnippet.includes("submission confirmation");

  if ((isPortalSystem || isNoReply) && isConfirmation) {
    logger.info("Auto-classified as portal confirmation/verification email", {
      caseId: context.caseId,
      from: fromAddr,
    });
    await db.saveResponseAnalysis({
      messageId,
      caseId: context.caseId,
      intent: "acknowledgment",
      confidenceScore: 0.99,
      sentiment: "neutral",
      keyPoints: ["Automated portal confirmation/verification email - no action needed"],
      requiresAction: false,
      suggestedAction: "wait",
      fullAnalysisJson: { auto_classified: true, reason: "portal_verification_email" },
    });
    return {
      classification: "ACKNOWLEDGMENT",
      confidence: 0.99,
      sentiment: "neutral",
      extractedFeeAmount: null,
      extractedDeadline: null,
      denialSubtype: null,
      requiresResponse: false,
      portalUrl: null,
      suggestedAction: "wait",
      reasonNoResponse: "Automated portal confirmation email",
      unansweredAgencyQuestion: null,
    };
  }

  // Load thread messages for context
  const threadMessages = await db.getMessagesByCaseId(context.caseId);

  // === Vercel AI SDK: generateObject with Zod schema ===
  let aiResult: ClassificationOutput;
  try {
    const { object } = await generateObject({
      model: classifyModel,
      schema: classificationSchema,
      prompt: buildClassificationPrompt(message, context.caseData, threadMessages),
    });
    aiResult = object;
  } catch (aiError: any) {
    // Fallback to existing aiService if Vercel AI SDK fails
    logger.warn("Vercel AI SDK classification failed, falling back to aiService", {
      caseId: context.caseId,
      error: aiError.message,
    });
    const legacyAnalysis = await aiService.analyzeResponse(message, context.caseData, {
      threadMessages,
    });
    // Map legacy result to our format
    aiResult = {
      intent: legacyAnalysis.intent || "other",
      confidence_score: legacyAnalysis.confidence_score || legacyAnalysis.confidence || 0.8,
      sentiment: legacyAnalysis.sentiment || "neutral",
      key_points: legacyAnalysis.key_points || [],
      extracted_deadline: legacyAnalysis.extracted_deadline || legacyAnalysis.deadline || null,
      fee_amount: legacyAnalysis.fee_amount != null ? Number(legacyAnalysis.fee_amount) : null,
      requires_response: legacyAnalysis.requires_response !== undefined
        ? legacyAnalysis.requires_response
        : legacyAnalysis.requires_action !== false,
      portal_url: legacyAnalysis.portal_url || null,
      suggested_action: legacyAnalysis.suggested_action || null,
      reason_no_response: legacyAnalysis.reason_no_response || null,
      unanswered_agency_question: legacyAnalysis.unanswered_agency_question || null,
      denial_subtype: legacyAnalysis.denial_subtype || null,
      constraints_to_add: legacyAnalysis.constraints_to_add || [],
      scope_updates: legacyAnalysis.scope_updates || [],
      fee_breakdown: legacyAnalysis.fee_breakdown || null,
    } as ClassificationOutput;
  }

  // Map intent to classification enum
  const classification: Classification = CLASSIFICATION_MAP[aiResult.intent] || "UNKNOWN";
  const feeAmount = aiResult.fee_amount != null ? Number(aiResult.fee_amount) : null;

  // Save analysis to DB
  await db.saveResponseAnalysis({
    messageId,
    caseId: context.caseId,
    intent: aiResult.intent,
    confidenceScore: aiResult.confidence_score,
    sentiment: aiResult.sentiment,
    keyPoints: aiResult.key_points,
    extractedDeadline: aiResult.extracted_deadline,
    extractedFeeAmount: feeAmount,
    requiresAction: aiResult.requires_response,
    suggestedAction: aiResult.suggested_action,
    portalUrl: aiResult.portal_url,
    fullAnalysisJson: aiResult,
  });

  // Log fee event
  if (feeAmount != null) {
    try {
      await db.logFeeEvent(
        context.caseId,
        "quote_received",
        feeAmount,
        "Fee quote detected in inbound message",
        messageId
      );
    } catch (feeErr: any) {
      logger.warn("Failed to log fee event", { caseId: context.caseId, error: feeErr.message });
    }
  }

  // Override requires_response if unanswered question detected
  let requiresResponse = aiResult.requires_response;
  if (aiResult.unanswered_agency_question && !requiresResponse) {
    logger.info("Unanswered agency question detected - overriding requires_response to true", {
      caseId: context.caseId,
    });
    requiresResponse = true;
  }

  // Normalize freeform suggestedAction
  let suggestedAction = aiResult.suggested_action;
  if (suggestedAction && suggestedAction.length > 30) {
    const sa = suggestedAction.toLowerCase();
    if (sa.includes("rebuttal") || sa.includes("challenge") || sa.includes("appeal")) suggestedAction = "send_rebuttal";
    else if (sa.includes("portal") || sa.includes("submit")) suggestedAction = "use_portal";
    else if (sa.includes("negotiate") || sa.includes("fee")) suggestedAction = "negotiate_fee";
    else if (sa.includes("wait") || sa.includes("monitor")) suggestedAction = "wait";
    else if (sa.includes("respond") || sa.includes("reply")) suggestedAction = "respond";
    else suggestedAction = "respond";
  }

  return {
    classification,
    confidence: aiResult.confidence_score,
    sentiment: aiResult.sentiment,
    extractedFeeAmount: feeAmount,
    extractedDeadline: aiResult.extracted_deadline,
    denialSubtype: aiResult.denial_subtype || null,
    requiresResponse,
    portalUrl: aiResult.portal_url,
    suggestedAction,
    reasonNoResponse: aiResult.reason_no_response,
    unansweredAgencyQuestion: aiResult.unanswered_agency_question,
  };
}
