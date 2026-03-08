/**
 * Classify Inbound Step
 *
 * REWRITTEN: Uses Vercel AI SDK generateObject() + Zod schema.
 * Replaces aiService.analyzeResponse() JSON.parse with guaranteed structured output.
 *
 * Falls back to existing aiService for compatibility during transition.
 */

import { generateObject } from "ai";
import { classifyModel, classifyOptions, telemetry } from "../lib/ai";
import { classificationSchema, type ClassificationOutput } from "../lib/schemas";
import db, { aiService, logger } from "../lib/db";
import type { ClassificationResult, CaseContext, Classification } from "../lib/types";
// @ts-ignore
const { buildModelMetadata } = require("../../utils/ai-model-metadata");

export const CLASSIFICATION_MAP: Record<string, Classification> = {
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

const REQUEST_FORM_CLARIFICATION_OVERRIDE_INTENTS = new Set([
  "records_ready",
  "delivery",
  "acknowledgment",
  "other",
]);

function normalizeClassificationText(input: any): string {
  if (!input) return "";
  return String(input)
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

export function looksLikeRequestFormClarification(message: any, attachments: any[] = []): boolean {
  const corpus = [
    message?.subject,
    message?.body_text,
    message?.body_html,
    ...(Array.isArray(attachments)
      ? attachments.flatMap((attachment: any) => [
          attachment?.filename,
          attachment?.extracted_text,
        ])
      : []),
  ]
    .map(normalizeClassificationText)
    .filter(Boolean)
    .join("\n");

  if (!corpus) return false;

  const requestFormSignals =
    /request form|apra\/foia request form|public records request form|new foia request form|attached a blank copy|blank copy of (?:our )?(?:apra\/foia )?request form|complete (?:this|the|our|attached)?\s*(?:pdf|form)|completed (?:public )?records request form/.test(
      corpus
    );
  const deliveryMethodSignals =
    /too large to send via email|files are too large to email|method to send the records|mailing address|physical mailing address|mail a cd|delivery method/.test(
      corpus
    );

  return requestFormSignals || deliveryMethodSignals;
}

function applyDeterministicClassificationOverrides(
  aiResult: ClassificationOutput,
  message: any,
  attachments: any[] = []
): ClassificationOutput {
  const normalizedIntent = String(aiResult?.intent || "").toLowerCase();
  if (!REQUEST_FORM_CLARIFICATION_OVERRIDE_INTENTS.has(normalizedIntent)) {
    return aiResult;
  }

  if (!looksLikeRequestFormClarification(message, attachments)) {
    return aiResult;
  }

  return {
    ...aiResult,
    intent: "question",
    requires_response: true,
    suggested_action: "respond",
    reason_no_response: null,
  };
}

export function buildClassificationPrompt(
  message: any,
  caseData: any,
  threadMessages: any[],
  attachments: any[] = [],
  enrichment?: {
    constraints?: string[];
    scopeItems?: any[];
    priorProposals?: any[];
    feeQuote?: any;
    research?: any;
  }
): string {
  const toPromptText = (input: any): string => {
    if (!input) return "";
    const raw = String(input);
    // Keep prompt context readable when only HTML is stored.
    return raw.replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/gi, " ")
      .replace(/\s+/g, " ")
      .trim();
  };

  const threadContext = threadMessages
    .slice(0, 10)
    .reverse()
    .map((m: any) => {
      const label = m.portal_notification
        ? `PORTAL_NOTIFICATION:${(m.portal_notification_provider || "unknown").toUpperCase()}`
        : m.direction?.toUpperCase();
      const date = m.sent_at || m.received_at || m.created_at;
      const dateStr = date ? new Date(date).toISOString().split("T")[0] : "unknown";
      const sender = m.direction === "inbound" ? (m.from_email || "unknown") : (m.to_email || "unknown");
      const messageText = toPromptText(m.body_text || m.body_html || m.summary || "");
      return `[${label} | ${dateStr} | ${sender}] ${m.subject || ""}\n${messageText.substring(0, 800)}`;
    })
    .join("\n---\n");

  const requestedRecords = Array.isArray(caseData.requested_records)
    ? caseData.requested_records.join(", ")
    : caseData.requested_records || "Various records";

  // Build enriched context sections
  const constraints = enrichment?.constraints || caseData?.constraints_jsonb || [];
  const constraintsSection = constraints.length > 0
    ? `- **Known Constraints**: ${constraints.join(", ")}`
    : "";

  const scopeItems = enrichment?.scopeItems || caseData?.scope_items_jsonb || [];
  const scopeSection = Array.isArray(scopeItems) && scopeItems.length > 0
    ? `- **Scope Items**: ${scopeItems.map((s: any) => `${s.name || s.description || JSON.stringify(s)} (${s.status || "REQUESTED"})`).join("; ")}`
    : "";

  // Fee context
  const feeQuote = enrichment?.feeQuote || caseData?.fee_quote_jsonb;
  const feeSection = feeQuote
    ? `- **Fee Quote**: $${feeQuote.amount || feeQuote.fee_amount || "unknown"} (${feeQuote.status || "quoted"})`
    : caseData?.fee_amount ? `- **Fee on File**: $${caseData.fee_amount}` : "";

  // Portal context
  let portalSection = "";
  if (caseData?.portal_url || caseData?.last_portal_status) {
    portalSection = `- **Portal**: ${caseData.portal_provider || "unknown"} — status: ${caseData.last_portal_status || "unknown"}`;
  }

  // Timing
  const timingParts: string[] = [];
  if (caseData?.send_date) timingParts.push(`sent ${new Date(caseData.send_date).toISOString().split("T")[0]}`);
  if (caseData?.deadline_date) timingParts.push(`deadline ${new Date(caseData.deadline_date).toISOString().split("T")[0]}`);
  if (caseData?.days_overdue > 0) timingParts.push(`${caseData.days_overdue} days overdue`);
  const timingSection = timingParts.length > 0 ? `- **Timing**: ${timingParts.join(", ")}` : "";

  // Prior proposals (what we've already tried)
  const proposals = enrichment?.priorProposals || [];
  const proposalSection = proposals.length > 0
    ? `- **Prior Actions Tried**: ${proposals.map((p: any) => `${p.action_type} (${p.status})`).join(", ")}`
    : "";

  // Incident details
  const incidentParts: string[] = [];
  if (caseData?.incident_date) incidentParts.push(`date: ${caseData.incident_date}`);
  if (caseData?.incident_location) incidentParts.push(`location: ${caseData.incident_location}`);
  const incidentSection = incidentParts.length > 0 ? `- **Incident**: ${incidentParts.join(", ")}` : "";

  // Research context summary
  const research = enrichment?.research || caseData?.research_context_jsonb;
  let researchSection = "";
  if (research?.state_law_notes) {
    researchSection = `- **State Law Notes**: ${String(research.state_law_notes).substring(0, 300)}`;
  }

  const extraSections = [incidentSection, constraintsSection, scopeSection, feeSection, portalSection, timingSection, proposalSection, researchSection].filter(Boolean).join("\n");

  return `You are an expert FOIA analyst classifying an agency response to a public records request.

## Case Context
- **Agency**: ${caseData.agency_name || "Unknown"}
- **Agency Email**: ${caseData.agency_email || "Unknown"}
- **State**: ${caseData.state || "Unknown"}
- **Subject**: ${caseData.subject_name || "Unknown"}
- **Records Requested**: ${requestedRecords}
- **Current Status**: ${caseData.status || "Unknown"}
- **Substatus**: ${caseData.substatus || "none"}
${extraSections}

## Thread History (most recent last)
NOTE: Messages labeled [PORTAL_NOTIFICATION:*] are automated system emails from records portals (NextRequest, GovQA, etc.). These reflect the STATUS OF THE PORTAL TRACK ONLY, not the overall case status. A portal showing "closed" or "completed" does NOT mean the direct email correspondence with the agency is resolved. Classify based on the TRIGGER MESSAGE below, not portal status notifications.
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

IMPORTANT: Use the extracted text from attachments to inform your classification — the attachment content often determines the true intent. Attachments may contain fee quotes, denial letters, acknowledgments, forms, or actual records. Classify based on the CONTENT of the attachment, not merely its presence. See "Attached Letters & Documents" section below for specific patterns.` : ""}

## Intent Definitions (choose the BEST match)
- **fee_request**: Agency quotes a cost/fee for records production. Look for dollar amounts, invoices, cost estimates, payment instructions, or conditional authorization requests (e.g., "authorize fees up to $X before we proceed"). Also includes cases where the agency asks the requester to confirm willingness to pay before sending a formal estimate, even if no dollar amount is yet specified.
- **question / more_info_needed**: Agency asks the requester to clarify, provide ID, narrow scope, or answer a question before proceeding — without formally refusing the request. Use when the agency is INVITING a modified/narrowed resubmission or asking for more info to proceed (e.g., "Please narrow to 3 years so we can process it"). Do NOT use when the agency explicitly says the request is **overly burdensome**, mentions large numbers (e.g., "50,000 pages"), uses strong refusal language ("cannot be processed"), or formally refuses and merely suggests narrowing as an alternative — those are **denial/overly_broad**. KEY DISTINCTION: "Please narrow to X so we CAN help" = clarification. "Request covers 50,000 pages and IS overly burdensome" = denial/overly_broad.
- **hostile**: Agency response is threatening, abusive, or overtly adversarial beyond normal bureaucratic friction.
- **denial**: Agency explicitly refuses to produce some or all records. Includes claims of exemption, no responsive records, ongoing internal review that functions as a hold, or any indication that records will be withheld (even conditionally or due to a pending review process). Also use **denial** when an agency states that some information "may be withheld" or will be withheld citing an exemption, even if no records are being released in this response. If a denial exemption is combined with a separate fee for other records, classify as **denial** (not partial_approval) and address the fee issue second.
- **partial_denial**: Agency releases some records but denies/withholds others citing an exemption. NOTE: partial_denial and partial_approval REQUIRE that records are actually being delivered or released in this response. If no records are released but some are mentioned as withheld alongside a fee, denial, or conditional statement, classify as **denial** or **fee_request** instead.
- **partial_approval**: Agency approves part of the request with conditions (redactions, fee for remainder, etc.). NOTE: Requires actual delivery of at least some records. A message mentioning redactions without releasing any records is not partial_approval — it is a **denial**. If records are attached or explicitly released with redactions noted, this is partial_approval.
- **partial_release / partial_delivery**: Agency provides some records with more to follow later AND explicitly says more records are coming. CRITICAL: Records must be ACTUALLY ATTACHED or DELIVERED in this message AND the agency must indicate more will follow. If the agency delivers some records but DENIES/WITHHOLDS others citing an exemption, that is **partial_denial** (not partial_delivery). If the agency says "we will release X records once you pay" or "records available after payment", this is a **fee_request**. KEY DISTINCTION: partial_delivery = interim release with more coming; partial_denial = final determination releasing some, withholding others.
- **portal_redirect**: Agency says to use an online portal (GovQA, NextRequest, JustFOIA, etc.) instead of email.
- **acknowledgment**: Agency confirms receipt of the request and says they are working on it. No records or fees yet. NOTE: If the agency says records are unavailable now but WILL be available in the future (e.g., "not yet created", "will exist after the event"), classify as **denial** with subtype **records_not_yet_created**, NOT acknowledgment. CRITICAL DISTINCTION: If the agency says the MATTER or CASE is "under review" or "under internal review" (not the REQUEST), this is a **denial** with subtype **ongoing_investigation** — they are using the review as a reason to withhold records. Only classify as acknowledgment when the agency says the REQUEST itself is being processed (e.g., "we received your request and are working on it", "your request has been assigned tracking number X").
- **records_ready**: Agency says records are ready for pickup/download/delivery. Includes links, attachments, or portal notifications.
- **delivery**: Records are attached to or delivered in this message. CRITICAL: The message must contain actual record files or data — not just a fee schedule, appointment instructions, or procedural response. If the attachment is a fee letter, cost estimate, or instructions for in-person review, classify as **fee_request** instead. A "formal response" that is actually a fee schedule or procedural letter is NOT a delivery.
- **wrong_agency**: Agency says they are not the correct custodian and may redirect to another agency. When classifying as wrong_agency, set suggested_action to **find_correct_agency** (not "respond").
- **other**: Does not clearly fit any category above. NOTE: Automated portal system emails that say "your request has been closed" or "record request #X has been closed" from GovQA, NextRequest, or similar portals are NOT denials — they are administrative closure notifications. Classify these as **other** (or **records_ready** if records were actually provided). Do NOT classify portal closure system emails as denial.

## Denial Subtype Definitions (only if intent is "denial" or "partial_denial")
- **no_records**: Agency claims no responsive records exist. If the agency also offers clarification help alongside the no_records claim (e.g., "if you provide an incident number we can search more specifically"), use subtype **not_reasonably_described** instead.
- **wrong_agency**: Agency says records are held by a different entity
- **overly_broad**: Agency says request is too broad, unduly burdensome, covers too many records/pages/years, or cannot be processed as written. Use even when paired with a suggestion to narrow — the refusal is the primary action.
- **ongoing_investigation**: Records withheld due to active investigation/litigation, or an internal review process that is being used to withhold records
- **privacy_exemption**: Records withheld citing privacy of specific individuals (PII, personnel records, medical records, etc.). Requires explicit mention of individual privacy rights or personal identifying information — do NOT use for vague "internal policy" or "departmental policy" restrictions that don't specifically mention personal privacy
- **excessive_fees**: Denial is effectively a prohibitive cost barrier
- **retention_expired**: Records destroyed per retention schedule
- **glomar_ncnd**: Agency neither confirms nor denies the existence of records
- **not_reasonably_described**: Agency claims the request itself lacks sufficient identifiers for a meaningful search (e.g., no date range, no names, no incident numbers, too vague to locate records). Use ONLY when the REQUEST is vague/undescribed. Do NOT use when the agency cites internal policies, departmental restrictions, legal exemptions, or other reasons for denial — those have a different subtype or no specific subtype.
- **no_duty_to_create**: Agency claims it would need to create records to fulfill request. If the message also emphasizes that the request is overly broad or that data does not exist in the requested form due to scope, prefer **overly_broad** as the subtype instead.
- **privilege_attorney_work_product**: Records withheld claiming attorney-client privilege or work product
- **juvenile_records**: Records withheld due to juvenile protections
- **sealed_court_order**: Records sealed by court order
- **third_party_confidential**: Records withheld to protect third-party confidential information
- **records_not_yet_created**: Records don't exist yet (pending processing, future report)
- **format_issue**: Agency cannot process the request in its current format (missing required form, needs to be resubmitted via specific channel, improper request format). Do NOT use for substantive exemptions or policy-based denials — only for procedural/format problems with the submission itself

## Jurisdiction Detection
- **federal**: Agency is a federal entity (e.g., FBI, DEA, federal court). Look for mentions of 5 USC 552, FOIA (federal), federal department names.
- **state**: Agency is a state-level entity (e.g., state police, state AG, state department). Look for state statute citations.
- **local**: Agency is a city, county, or municipal entity (e.g., city PD, county sheriff, municipal court).

## Response Nature
- **substantive**: Addresses the actual records request (approval, denial, fee quote, records delivery)
- **procedural**: About the process (acknowledgment, timeline, portal redirect, request for clarification)
- **administrative**: Internal/automated (confirmation emails, ticket numbers, auto-replies)
- **mixed**: Contains both substantive and procedural elements

## Mixed Message Guidance
When a message contains MULTIPLE actionable elements (e.g., fee + denial, partial release + withholding, portal notice + human instruction), follow these priority rules:
1. **Fee + denial in same message**: Classify as **denial**. The fee is secondary — address the denial first.
2. **Partial release + withholding**: Classify as **partial_denial** if records ARE delivered but others are withheld. Classify as **denial** if no records are actually delivered.
3. **Portal notification + human instruction**: If a human officer wrote substantive content alongside an automated portal notice, classify based on the HUMAN content, not the portal automation.
4. **Acknowledgment + conditions**: If the agency acknowledges the request but imposes conditions (fees, scope narrowing, ID requirements), classify based on the condition — e.g., fee_request, question, or denial — not acknowledgment.

## Closure & Administrative Messages
- "Your request has been closed" or "case closed" from a portal system (GovQA, NextRequest, JustFOIA) WITHOUT denial language → **other** (administrative closure), NOT denial.
- "We did not receive a response from you, so your request has been closed" → **other** (closure due to inactivity), NOT denial.
- If the closure message ALSO contains substantive denial language or exemption citations → **denial**.

## Request Forms & Mailing Address Workflows
- If the agency sends a blank request form, asks the requester to fill out a specific form, or asks for a mailing address to send physical records → classify as **question** / **more_info_needed** (they need info to proceed), NOT as **delivery** or **records_ready**.
- A message saying "please complete the attached form" is a process blocker, not a record delivery.

## Attached Letters & Documents
Attached letters (PDFs, Word docs, images) may be ANY of: acknowledgments, denials, fee notices, formal responses, or actual records. Do NOT assume an attachment = records delivery. Classify based on the CONTENT of the attachment (using extracted text), not merely its presence. Key patterns:
- Attachment is a fee schedule or cost estimate → **fee_request**
- Attachment is a formal denial letter citing exemptions → **denial**
- Attachment is an acknowledgment letter with a tracking number → **acknowledgment**
- Attachment is actual responsive records (incident reports, body camera logs, dispatch records, etc.) → **delivery** or **records_ready**

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
10. **Referral contact**: If the agency's response explicitly names, references, or redirects to a DIFFERENT agency, department, or custodian that may hold the requested records, extract their contact info into referral_contact (email, phone, name, URL). This applies to ANY intent — not just wrong_agency or portal_redirect. Look for concrete signals such as: "contact [agency name]", "those records are maintained by [department]", "we forwarded your request to [entity]", "try [office] for that". Only extract when the agency provides specific identifying details — do NOT infer a referral from vague language like "check with the appropriate office".`;
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

  // Pre-check: detect internal/synthetic messages that shouldn't be classified
  const fromAddr = (message.from_email || message.sender_email || "").toLowerCase();
  const subjectLower = (message.subject || "").toLowerCase();
  const bodySnippet = ((message.body_text || message.body_html || "").substring(0, 500)).toLowerCase();

  // Phone call updates and manual notes are internal records, not agency responses
  const isInternalNote =
    (message as any).message_type === "phone_call" ||
    /phone\s*call\s*(update|log|note)/i.test(message.subject || "") ||
    /manual\s*phone\s*call/i.test(message.subject || "");

  if (isInternalNote) {
    logger.info("Auto-classified as internal note (phone call/manual entry)", {
      caseId: context.caseId,
      subject: message.subject,
    });
    await db.saveResponseAnalysis({
      messageId,
      caseId: context.caseId,
      intent: "none",
      confidenceScore: 0.99,
      sentiment: "neutral",
      keyPoints: ["Internal phone call/manual note - not an agency response"],
      requiresAction: false,
      suggestedAction: null,
      fullAnalysisJson: { auto_classified: true, reason: "internal_note" },
    });
    return {
      classification: "NO_RESPONSE",
      confidence: 0.99,
      sentiment: "neutral",
      extractedFeeAmount: null,
      extractedDeadline: null,
      denialSubtype: null,
      requiresResponse: false,
      portalUrl: null,
      suggestedAction: null,
      reasonNoResponse: "Internal phone call/manual note",
      unansweredAgencyQuestion: null,
    };
  }

  // Pre-check: detect automated portal system emails
  const portalSystems = ["justfoia", "nextrequest", "govqa", "civicplus", "jotform", "smartsheet"];
  const isPortalSystem = portalSystems.some((p: string) => fromAddr.includes(p) || subjectLower.includes(p));
  const isNoReply = /no.?reply|do.?not.?reply/.test(fromAddr);

  // Detect portal account management emails (password reset, welcome, unlock)
  const isAccountManagement =
    subjectLower.includes("password reset") || subjectLower.includes("reset your password") ||
    subjectLower.includes("unlock your account") || subjectLower.includes("account unlock") ||
    subjectLower.includes("activate your account") || subjectLower.includes("account created") ||
    (subjectLower.includes("welcome to") && isPortalSystem);

  if (isPortalSystem && isAccountManagement) {
    logger.info("Auto-classified as portal account management email", {
      caseId: context.caseId,
      from: fromAddr,
      subject: message.subject,
    });
    await db.saveResponseAnalysis({
      messageId,
      caseId: context.caseId,
      intent: "none",
      confidenceScore: 0.99,
      sentiment: "neutral",
      keyPoints: ["Automated portal account management email - no action needed"],
      requiresAction: false,
      suggestedAction: null,
      fullAnalysisJson: { auto_classified: true, reason: "portal_account_management_email" },
    });
    return {
      classification: "NO_RESPONSE",
      confidence: 0.99,
      sentiment: "neutral",
      extractedFeeAmount: null,
      extractedDeadline: null,
      denialSubtype: null,
      requiresResponse: false,
      portalUrl: null,
      suggestedAction: null,
      reasonNoResponse: "Automated portal account management email",
      unansweredAgencyQuestion: null,
    };
  }

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

  // Load thread messages and enrichment data in parallel
  const [threadMessages, priorProposalsResult] = await Promise.all([
    db.getMessagesByCaseId(context.caseId),
    db.query(
      `SELECT action_type, status FROM proposals
       WHERE case_id = $1 ORDER BY created_at DESC LIMIT 10`,
      [context.caseId]
    ),
  ]);

  // Get attachments for this specific message
  const messageAttachments = (context.attachments || []).filter(
    (a: any) => a.message_id === messageId
  );

  // Build enrichment context for the classifier
  const enrichment = {
    constraints: context.caseData?.constraints_jsonb || context.caseData?.constraints || [],
    scopeItems: context.caseData?.scope_items_jsonb || context.caseData?.scope_items || [],
    priorProposals: priorProposalsResult.rows,
    feeQuote: context.caseData?.fee_quote_jsonb,
    research: context.caseData?.research_context_jsonb,
  };

  // === Vercel AI SDK: generateObject with Zod schema ===
  let aiResult: ClassificationOutput;
  let modelMetadata: any = null;
  try {
    const startedAt = Date.now();
    const { object, usage, response } = await generateObject({
      model: classifyModel,
      schema: classificationSchema,
      prompt: buildClassificationPrompt(message, context.caseData, threadMessages, messageAttachments, enrichment),
      providerOptions: classifyOptions,
      experimental_telemetry: telemetry,
    });
    aiResult = object;
    modelMetadata = buildModelMetadata({ response, usage, startedAt });
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

  const normalizedAiResult = applyDeterministicClassificationOverrides(aiResult, message, messageAttachments);
  if (normalizedAiResult.intent !== aiResult.intent) {
    logger.info("Deterministic classification override applied for request-form clarification", {
      caseId: context.caseId,
      messageId,
      originalIntent: aiResult.intent,
      overriddenIntent: normalizedAiResult.intent,
    });
  }
  aiResult = normalizedAiResult;

  // Map intent to classification enum
  const classification: Classification = CLASSIFICATION_MAP[aiResult.intent] || "UNKNOWN";
  let feeAmount = aiResult.fee_amount != null ? Number(aiResult.fee_amount) : null;
  if (feeAmount !== null && isNaN(feeAmount)) {
    feeAmount = null;
  }

  // Fee sanity check: flag suspiciously low fees (likely parsing errors)
  if (feeAmount !== null && feeAmount > 0 && feeAmount < 0.10) {
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
    modelId: modelMetadata?.modelId || null,
    promptTokens: modelMetadata?.promptTokens ?? null,
    completionTokens: modelMetadata?.completionTokens ?? null,
    latencyMs: modelMetadata?.latencyMs ?? null,
  });

  // Update Notion with AI summary (non-blocking)
  if (aiResult.summary || (aiResult.key_points && aiResult.key_points.length > 0)) {
    try {
      const notionService = require("../../services/notion-service");
      const summary = aiResult.summary || aiResult.key_points.join("; ");
      await notionService.addAISummaryToNotion(context.caseId, summary);
    } catch (err: any) {
      logger.warn("Failed to update Notion with AI summary", { caseId: context.caseId, error: err.message });
    }
  }

  // Notify Discord about response received (non-blocking)
  try {
    const discordService = require("../../services/discord-service");
    const caseData = await db.getCaseById(context.caseId);
    if (caseData) {
      await discordService.notifyResponseReceived(caseData, {
        intent: aiResult.intent,
        sentiment: aiResult.sentiment,
        summary: aiResult.summary,
        requires_action: aiResult.requires_response,
      });
    }
  } catch (err: any) {
    logger.warn("Failed to notify Discord", { caseId: context.caseId, error: err.message });
  }

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

  // Consistency validation: if requiresResponse is true, suggestedAction must be set
  if (requiresResponse && !suggestedAction) {
    logger.warn("requires_response=true but suggested_action is null — defaulting to 'respond'", {
      caseId: context.caseId,
      classification,
    });
    suggestedAction = "respond";
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
    keyPoints: aiResult.key_points || [],
    modelMetadata,
  };
}

/**
 * Classify message content directly without saving to DB.
 * Used by the simulate-decision task for dry-run simulation.
 */
export async function classifyMessageContent(
  message: { from_email?: string; subject?: string; body_text?: string },
  caseData: any,
  priorMessages: any[],
  attachments: any[] = []
): Promise<ClassificationResult> {
  let aiResult: ClassificationOutput;
  let modelMetadata: any = null;
  try {
    const startedAt = Date.now();
    const { object, usage, response } = await generateObject({
      model: classifyModel,
      schema: classificationSchema,
      prompt: buildClassificationPrompt(message, caseData, priorMessages, attachments),
      providerOptions: classifyOptions,
      experimental_telemetry: telemetry,
    });
    aiResult = object;
    modelMetadata = buildModelMetadata({ response, usage, startedAt });
  } catch (aiError: any) {
    logger.warn("classifyMessageContent: Vercel AI SDK failed, falling back to aiService", {
      error: aiError.message,
    });
    const legacyAnalysis = await aiService.analyzeResponse(message, caseData, {
      threadMessages: priorMessages,
    });
    aiResult = {
      intent: legacyAnalysis.intent || "other",
      confidence_score: legacyAnalysis.confidence_score || legacyAnalysis.confidence || 0.8,
      sentiment: legacyAnalysis.sentiment || "neutral",
      key_points: legacyAnalysis.key_points || [],
      extracted_deadline: legacyAnalysis.extracted_deadline || null,
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

  aiResult = applyDeterministicClassificationOverrides(aiResult, message, attachments);
  const classification: Classification = CLASSIFICATION_MAP[aiResult.intent] || "UNKNOWN";
  let feeAmount = aiResult.fee_amount != null ? Number(aiResult.fee_amount) : null;
  if (feeAmount !== null && (isNaN(feeAmount) || feeAmount < 0.10)) feeAmount = null;

  let requiresResponse = aiResult.requires_response;
  if (aiResult.unanswered_agency_question && !requiresResponse) requiresResponse = true;

  return {
    classification,
    confidence: aiResult.confidence_score,
    sentiment: aiResult.sentiment,
    extractedFeeAmount: feeAmount,
    extractedDeadline: aiResult.extracted_deadline,
    denialSubtype: aiResult.denial_subtype || null,
    requiresResponse,
    portalUrl: aiResult.portal_url,
    suggestedAction: aiResult.suggested_action,
    reasonNoResponse: aiResult.reason_no_response,
    unansweredAgencyQuestion: aiResult.unanswered_agency_question,
    jurisdiction_level: (aiResult as any).jurisdiction_level || null,
    response_nature: (aiResult as any).response_nature || null,
    detected_exemption_citations: (aiResult as any).detected_exemption_citations || [],
    decision_evidence_quotes: (aiResult as any).decision_evidence_quotes || [],
    referralContact: (aiResult as any).referral_contact || null,
    keyPoints: aiResult.key_points || [],
    modelMetadata,
  };
}
