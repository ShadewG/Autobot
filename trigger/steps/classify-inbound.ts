/**
 * Classify Inbound Step
 *
 * REWRITTEN: Uses Vercel AI SDK generateObject() + Zod schema.
 * Replaces aiService.analyzeResponse() JSON.parse with guaranteed structured output.
 *
 * Falls back to existing aiService for compatibility during transition.
 */

import { generateObject } from "ai";
import { classifyModel, classifyOptions } from "../lib/ai";
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
  threadMessages: any[],
  attachments: any[] = []
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

  return `You are an expert FOIA analyst classifying an agency response to a public records request.

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
${attachments.length > 0 ? `
**Attachments** (${attachments.length} file${attachments.length > 1 ? "s" : ""}):
${attachments.map((a: any) => `- ${a.filename} (${a.content_type}, ${Math.round((a.size_bytes || 0) / 1024)}KB)`).join("\n")}
${attachments.filter((a: any) => a.extracted_text).map((a: any) => `
### Extracted text from "${a.filename}":
${a.extracted_text.substring(0, 4000)}${a.extracted_text.length > 4000 ? "\n[...truncated]" : ""}`).join("\n")}

IMPORTANT: If attachments include PDFs or documents and the message references them as records/responses, classify as "records_ready" or "delivery", NOT as "acknowledgment" or "other". Use the extracted text from attachments to inform your classification — it may contain fee quotes, denial letters, records, or other substantive content.` : ""}

## Intent Definitions (choose the BEST match)
- **fee_request**: Agency quotes a cost/fee for records production. Look for dollar amounts, invoices, cost estimates, payment instructions.
- **question / more_info_needed**: Agency asks the requester to clarify, narrow scope, provide ID, or answer a question before proceeding.
- **hostile**: Agency response is threatening, abusive, or overtly adversarial beyond normal bureaucratic friction.
- **denial**: Agency explicitly refuses to produce some or all records. Includes claims of exemption, no responsive records, etc.
- **partial_denial**: Agency releases some records but denies/withholds others citing an exemption.
- **partial_approval**: Agency approves part of the request with conditions (redactions, fee for remainder, etc.).
- **partial_release / partial_delivery**: Agency provides some records with more to follow later.
- **portal_redirect**: Agency says to use an online portal (GovQA, NextRequest, JustFOIA, etc.) instead of email.
- **acknowledgment**: Agency confirms receipt of the request and says they are working on it. No records or fees yet.
- **records_ready**: Agency says records are ready for pickup/download/delivery. Includes links, attachments, or portal notifications.
- **delivery**: Records are attached to or delivered in this message.
- **wrong_agency**: Agency says they are not the correct custodian and may redirect to another agency.
- **other**: Does not clearly fit any category above.

## Denial Subtype Definitions (only if intent is "denial" or "partial_denial")
- **no_records**: Agency claims no responsive records exist
- **wrong_agency**: Agency says records are held by a different entity
- **overly_broad**: Agency says request is too broad or unduly burdensome
- **ongoing_investigation**: Records withheld due to active investigation/litigation
- **privacy_exemption**: Records withheld citing privacy of individuals
- **excessive_fees**: Denial is effectively a prohibitive cost barrier
- **retention_expired**: Records destroyed per retention schedule
- **glomar_ncnd**: Agency neither confirms nor denies the existence of records
- **not_reasonably_described**: Agency claims request is too vague to search
- **no_duty_to_create**: Agency claims it would need to create records to fulfill request
- **privilege_attorney_work_product**: Records withheld claiming attorney-client privilege or work product
- **juvenile_records**: Records withheld due to juvenile protections
- **sealed_court_order**: Records sealed by court order
- **third_party_confidential**: Records withheld to protect third-party confidential information
- **records_not_yet_created**: Records don't exist yet (pending processing, future report)

## Jurisdiction Detection
- **federal**: Agency is a federal entity (e.g., FBI, DEA, federal court). Look for mentions of 5 USC 552, FOIA (federal), federal department names.
- **state**: Agency is a state-level entity (e.g., state police, state AG, state department). Look for state statute citations.
- **local**: Agency is a city, county, or municipal entity (e.g., city PD, county sheriff, municipal court).

## Response Nature
- **substantive**: Addresses the actual records request (approval, denial, fee quote, records delivery)
- **procedural**: About the process (acknowledgment, timeline, portal redirect, request for clarification)
- **administrative**: Internal/automated (confirmation emails, ticket numbers, auto-replies)
- **mixed**: Contains both substantive and procedural elements

## Extraction Instructions
1. **Intent**: Choose the single best-fit intent from the definitions above.
2. **Fee amount**: Extract the amount ONLY if the agency is explicitly charging a processing fee for fulfilling this public records request (e.g., "processing fee of $X", "your cost to produce these records is $X", "we require a $X deposit before we can begin processing"). Do NOT extract incidental dollar amounts that appear in the records or correspondence content itself — such as prices of equipment, bail amounts, fines, damages, settlements, salaries, or any figure that is part of the subject matter of the records rather than a charge for the FOIA request itself. When in doubt, return null.
3. **Portal URL**: Extract any URL that appears to be an online records portal.
4. **Denial subtype**: Only populate if intent is "denial" or "partial_denial".
5. **Exemption citations**: Extract any statute numbers, legal codes, or exemption names cited by the agency (e.g., "5 ILCS 140/7(1)(c)", "FOIA Exemption 7(A)").
6. **Evidence quotes**: Copy 1-3 short verbatim quotes (under 100 chars each) from the message that most clearly support your classification.
7. **Unanswered question**: If the agency asked a question we haven't answered, state the question.
8. **Jurisdiction**: Determine if agency is federal, state, or local.
9. **Response nature**: Determine if response is substantive, procedural, administrative, or mixed.
10. **Referral contact**: If intent is "wrong_agency" or "portal_redirect" and the agency provides contact info for the correct custodian (email, phone, name, URL), extract it into referral_contact. This is critical — we need the exact email/phone they provide so we can contact the right agency.`;
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

  // Get attachments for this specific message
  const messageAttachments = (context.attachments || []).filter(
    (a: any) => a.message_id === messageId
  );

  // === Vercel AI SDK: generateObject with Zod schema ===
  let aiResult: ClassificationOutput;
  try {
    const { object } = await generateObject({
      model: classifyModel,
      schema: classificationSchema,
      prompt: buildClassificationPrompt(message, context.caseData, threadMessages, messageAttachments),
      providerOptions: classifyOptions,
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
  let feeAmount = aiResult.fee_amount != null ? Number(aiResult.fee_amount) : null;
  if (feeAmount !== null && isNaN(feeAmount)) {
    feeAmount = null;
  }

  // Fee sanity check: flag suspiciously low fees (likely parsing errors)
  if (feeAmount !== null && feeAmount > 0 && feeAmount < 1) {
    logger.warn("Suspiciously low fee detected — likely a parsing error", {
      caseId: context.caseId,
      extractedAmount: feeAmount,
    });
    feeAmount = null; // Discard unreliable extraction
  }

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
    jurisdiction_level: (aiResult as any).jurisdiction_level || null,
    response_nature: (aiResult as any).response_nature || null,
    detected_exemption_citations: (aiResult as any).detected_exemption_citations || [],
    decision_evidence_quotes: (aiResult as any).decision_evidence_quotes || [],
    referralContact: (aiResult as any).referral_contact || null,
  };
}
