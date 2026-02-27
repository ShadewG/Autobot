/**
 * Decide Next Action Step
 *
 * AI-first routing with strict policy validation.
 * Falls back to deterministic routing when AI fails or is rejected.
 */

import { generateObject } from "ai";
import { decisionModel, decisionOptions } from "../lib/ai";
import { decisionSchema, type DecisionOutput } from "../lib/schemas";
import db, { logger } from "../lib/db";
// @ts-ignore
import { createPortalTask } from "../../services/executor-adapter";
import { tasks } from "@trigger.dev/sdk";
import { hasAutomatablePortal } from "../lib/portal-utils";
import type {
  DecisionResult,
  Classification,
  AutopilotMode,
  ActionType,
  HumanDecision,
} from "../lib/types";

const FEE_AUTO_APPROVE_MAX = parseFloat(process.env.FEE_AUTO_APPROVE_MAX || "100");
const FEE_NEGOTIATE_THRESHOLD = parseFloat(process.env.FEE_NEGOTIATE_THRESHOLD || "500");
const MAX_FOLLOWUPS = parseInt(process.env.MAX_FOLLOWUPS || "2", 10);
const AI_ROUTER_V2 = process.env.AI_ROUTER_V2 || "false";

// ─── AI Router v2 ───────────────────────────────────────────────────────────

const ALL_ACTION_TYPES: ActionType[] = [
  "SEND_INITIAL_REQUEST", "SEND_FOLLOWUP", "SEND_REBUTTAL", "SEND_CLARIFICATION",
  "SEND_APPEAL", "SEND_FEE_WAIVER_REQUEST", "SEND_STATUS_UPDATE",
  "RESPOND_PARTIAL_APPROVAL", "ACCEPT_FEE", "NEGOTIATE_FEE", "DECLINE_FEE",
  "ESCALATE", "NONE", "CLOSE_CASE", "WITHDRAW", "RESEARCH_AGENCY",
  "REFORMULATE_REQUEST", "SUBMIT_PORTAL",
];

const ALWAYS_GATE_ACTIONS: ActionType[] = [
  "CLOSE_CASE", "ESCALATE", "SEND_APPEAL", "SEND_FEE_WAIVER_REQUEST", "WITHDRAW",
];

function useAIRouter(caseId: number): boolean {
  if (AI_ROUTER_V2 === "true") return true;
  if (AI_ROUTER_V2 === "false") return false;
  const pct = parseInt(AI_ROUTER_V2, 10);
  if (isNaN(pct)) return false;
  return (caseId % 100) < pct;
}

function removeAction(actions: ActionType[], action: ActionType): void {
  const idx = actions.indexOf(action);
  if (idx !== -1) actions.splice(idx, 1);
}

function buildAllowedActions(params: {
  classification: Classification;
  denialSubtype: string | null;
  constraints: string[];
  followupCount: number;
  maxFollowups: number;
  hasAutomatablePortal: boolean;
  triggerType: string;
  dismissedActionCounts: Record<string, number>;
}): ActionType[] {
  const {
    classification, denialSubtype, constraints, followupCount,
    maxFollowups, hasAutomatablePortal: hasPortal, triggerType, dismissedActionCounts,
  } = params;

  // Hard constraints — AI cannot override these
  if (classification === "HOSTILE" || classification === "UNKNOWN") return ["ESCALATE"];
  if (classification === "WRONG_AGENCY") return ["RESEARCH_AGENCY", "ESCALATE"];
  if (classification === "PARTIAL_APPROVAL") return ["RESPOND_PARTIAL_APPROVAL", "ESCALATE"];
  if (classification === "RECORDS_READY") return ["NONE", "CLOSE_CASE"];
  if (classification === "ACKNOWLEDGMENT") return ["NONE"];
  if (classification === "PARTIAL_DELIVERY") return ["NONE", "SEND_FOLLOWUP"];
  if (followupCount >= maxFollowups) return ["ESCALATE"];

  // Citizenship/residency restriction — force escalate for human handling
  const CITIZENSHIP_CONSTRAINTS = ["AL_CITIZENSHIP_REQUIRED", "CITIZENSHIP_REQUIRED", "RESIDENCY_REQUIRED"];
  if (constraints.some(c => CITIZENSHIP_CONSTRAINTS.includes(c))) return ["ESCALATE"];

  // Broad set for classifications with many valid actions
  const base: ActionType[] = [...ALL_ACTION_TYPES];

  // Remove SEND_INITIAL_REQUEST from inbound context
  if (triggerType !== "INITIAL_REQUEST") {
    removeAction(base, "SEND_INITIAL_REQUEST");
  }

  // Remove SUBMIT_PORTAL if no automatable portal
  if (!hasPortal) {
    removeAction(base, "SUBMIT_PORTAL");
  }

  // Remove SEND_PDF_EMAIL (not in the standard action set for AI routing)
  removeAction(base, "SEND_PDF_EMAIL" as ActionType);

  // Remove actions dismissed 2+ times
  for (const [action, count] of Object.entries(dismissedActionCounts)) {
    if (count >= 2) removeAction(base, action as ActionType);
  }

  // Classification-specific narrowing
  if (classification === "FEE_QUOTE") {
    // Fee quotes should use fee actions primarily
    return base.filter(a =>
      ["ACCEPT_FEE", "NEGOTIATE_FEE", "DECLINE_FEE", "SEND_FEE_WAIVER_REQUEST",
       "SEND_REBUTTAL", "ESCALATE", "NONE"].includes(a)
    );
  }

  if (classification === "PORTAL_REDIRECT") {
    return base.filter(a =>
      ["SUBMIT_PORTAL", "NONE", "ESCALATE", "RESEARCH_AGENCY"].includes(a)
    );
  }

  return base;
}

interface PreComputedContext {
  denialStrength: "strong" | "medium" | "weak" | null;
  unansweredClarificationMsgId: number | null;
  bodycamResearchNeeded: boolean;
  followupCount: number;
  dismissedActionCounts: Record<string, number>;
  dismissedProposals: any[];
  humanDirectives: any[];
  phoneNotes: any[];
  latestAnalysis: any;
  caseData: any;
  threadMessages: any[];
}

async function preComputeDecisionContext(
  caseId: number,
  classification: Classification,
  denialSubtype: string | null,
  constraints: string[],
  inlineKeyPoints?: string[]
): Promise<PreComputedContext> {
  const [
    caseData,
    threadMessages,
    latestAnalysis,
    dismissedProposalsResult,
    humanDirectivesResult,
    phoneNotesResult,
    followupSchedule,
  ] = await Promise.all([
    db.getCaseById(caseId),
    db.getMessagesByCaseId(caseId),
    db.getLatestResponseAnalysis(caseId),
    db.query(
      `SELECT action_type, reasoning, human_decision, created_at FROM proposals
       WHERE case_id = $1 AND status = 'DISMISSED'
       ORDER BY created_at DESC LIMIT 5`,
      [caseId]
    ).then((r: any) => r.rows),
    db.query(
      `SELECT event_type, metadata, created_at FROM activity_log
       WHERE case_id = $1
         AND event_type IN ('human_decision', 'phone_call_completed')
       ORDER BY created_at DESC LIMIT 10`,
      [caseId]
    ).then((r: any) => r.rows),
    db.query(
      `SELECT notes, call_outcome, ai_briefing, updated_at FROM phone_call_queue
       WHERE case_id = $1 AND (notes IS NOT NULL AND notes != '')
       ORDER BY updated_at DESC LIMIT 3`,
      [caseId]
    ).then((r: any) => r.rows),
    db.getFollowUpScheduleByCaseId(caseId),
  ]);

  // Pre-compute denial strength
  let denialStrength: "strong" | "medium" | "weak" | null = null;
  if (classification === "DENIAL" && denialSubtype) {
    denialStrength = await assessDenialStrength(caseId, denialSubtype, inlineKeyPoints);
  }

  // Pre-compute unanswered clarification
  const unansweredClarificationMsgId = await checkUnansweredClarification(caseId);

  // Pre-compute bodycam research flag
  const bodycamResearchNeeded = shouldPrioritizeBodycamCustodianResearch(caseData, latestAnalysis, constraints);

  // Count dismissed actions
  const dismissedActionCounts: Record<string, number> = {};
  for (const p of dismissedProposalsResult) {
    dismissedActionCounts[p.action_type] = (dismissedActionCounts[p.action_type] || 0) + 1;
  }

  return {
    denialStrength,
    unansweredClarificationMsgId,
    bodycamResearchNeeded,
    followupCount: followupSchedule?.followup_count || 0,
    dismissedActionCounts,
    dismissedProposals: dismissedProposalsResult,
    humanDirectives: humanDirectivesResult,
    phoneNotes: phoneNotesResult,
    latestAnalysis,
    caseData,
    threadMessages: Array.isArray(threadMessages) ? threadMessages : [],
  };
}

function buildEnrichedDecisionPrompt(params: {
  caseData: any;
  classification: Classification;
  classificationConfidence: number | null;
  constraints: string[];
  scopeItems: any[];
  extractedFeeAmount: number | null;
  sentiment: string;
  autopilotMode: AutopilotMode;
  threadMessages: any[];
  denialSubtype?: string | null;
  jurisdictionLevel?: string | null;
  dismissedProposals?: any[];
  humanDirectives?: any[];
  phoneNotes?: any[];
  latestAnalysis?: any;
  allowedActions: ActionType[];
  preComputed: PreComputedContext;
  customInstruction?: string | null;
  inlineKeyPoints?: string[];
}): string {
  const {
    caseData, classification, classificationConfidence, constraints, scopeItems,
    extractedFeeAmount, sentiment, autopilotMode, threadMessages,
    allowedActions, preComputed, customInstruction, inlineKeyPoints,
  } = params;

  const requestedRecords = Array.isArray(caseData?.requested_records)
    ? caseData.requested_records.join(", ")
    : caseData?.requested_records || "Various records";

  const threadSummary = threadMessages
    .slice(0, 10)
    .reverse()
    .map((m: any) => {
      const body = (m.body_text || m.body_html || "").replace(/\s+/g, " ").trim().substring(0, 600);
      const label = m.portal_notification
        ? `PORTAL_NOTIFICATION:${(m.portal_notification_provider || "unknown").toUpperCase()}`
        : String(m.direction || "unknown").toUpperCase();
      const date = m.sent_at || m.received_at || m.created_at;
      const dateStr = date ? new Date(date).toISOString().split("T")[0] : "unknown";
      const sender = m.direction === "inbound" ? (m.from_email || "unknown") : (m.to_email || "unknown");
      return `[${label} | ${dateStr} | ${sender}] ${m.subject || "(no subject)"}\n${body}`;
    })
    .join("\n---\n");

  const denialSubtype = params.denialSubtype || null;
  const jurisdictionLevel = params.jurisdictionLevel || null;

  // Human directives section
  const humanDirectivesSection = buildHumanDirectivesSection(
    params.dismissedProposals, params.humanDirectives, params.phoneNotes
  );

  // Research context
  const research = caseData?.research_context_jsonb;
  let researchSection = "";
  if (research) {
    const parts: string[] = [];
    if (research.state_law_notes) parts.push(`State Law Notes:\n${String(research.state_law_notes).substring(0, 1500)}`);
    if (research.rebuttal_support_points?.length) parts.push(`Rebuttal Support Points:\n${research.rebuttal_support_points.map((p: string) => `- ${p}`).join("\n")}`);
    if (research.likely_record_custodians?.length) parts.push(`Likely Record Custodians:\n${research.likely_record_custodians.map((c: string) => `- ${c}`).join("\n")}`);
    if (research.official_records_submission_methods?.length) parts.push(`Official Submission Methods:\n${research.official_records_submission_methods.map((m: string) => `- ${m}`).join("\n")}`);
    if (research.record_type_handoff_notes) parts.push(`Record Type Notes: ${String(research.record_type_handoff_notes).substring(0, 500)}`);
    if (parts.length) researchSection = `\n## Research Context (previously gathered)\n${parts.join("\n\n")}`;
  }

  // Fee context
  const feeQuote = caseData?.fee_quote_jsonb;
  const feeSection = feeQuote ? `\n## Fee Quote Details\n${JSON.stringify(feeQuote, null, 2)}` : "";

  // Portal context
  let portalSection = "";
  if (caseData?.portal_url || caseData?.last_portal_status) {
    portalSection = `\n## Portal Status\n- Portal URL: ${caseData.portal_url || "none"}\n- Provider: ${caseData.portal_provider || "none"}\n- Last portal status: ${caseData.last_portal_status || "none"}\n- Portal request #: ${caseData.portal_request_number || "none"}`;
  }

  // Timing
  let timingSection = "";
  const timingParts: string[] = [];
  if (caseData?.deadline_date) timingParts.push(`Deadline: ${new Date(caseData.deadline_date).toISOString().split("T")[0]}`);
  if (caseData?.days_overdue > 0) timingParts.push(`Days overdue: ${caseData.days_overdue}`);
  if (caseData?.send_date) timingParts.push(`Initial request sent: ${new Date(caseData.send_date).toISOString().split("T")[0]}`);
  if (caseData?.last_response_date) timingParts.push(`Last agency response: ${new Date(caseData.last_response_date).toISOString().split("T")[0]}`);
  if (caseData?.incident_date) timingParts.push(`Incident date: ${caseData.incident_date}`);
  if (caseData?.incident_location) timingParts.push(`Incident location: ${caseData.incident_location}`);
  if (timingParts.length) timingSection = `\n## Timing & Deadlines\n${timingParts.map(p => `- ${p}`).join("\n")}`;

  // Latest analysis key points (DB analysis preferred, fall back to inline classifier key points)
  const keyPointsSource = preComputed.latestAnalysis?.key_points?.length
    ? preComputed.latestAnalysis.key_points
    : (inlineKeyPoints?.length ? inlineKeyPoints : []);
  const latestAnalysisSection = keyPointsSource.length
    ? `\n## Latest Analysis Key Points\n${keyPointsSource.map((p: string) => `- ${p}`).join("\n")}`
    : "";

  // Pre-computed analysis section
  const preComputedSection = `
## Pre-computed Analysis
- Denial strength: ${preComputed.denialStrength || "N/A"}
- Unanswered agency clarification: ${preComputed.unansweredClarificationMsgId ? `msg #${preComputed.unansweredClarificationMsgId}` : "none"}
- Bodycam custodian research needed: ${preComputed.bodycamResearchNeeded ? "yes" : "no"}
- Follow-up count: ${preComputed.followupCount}/${MAX_FOLLOWUPS}
- Portal automatable: ${caseData?.portal_url ? "yes" : "no"}`;

  // Decision history section
  let decisionHistorySection = "";
  if (preComputed.dismissedProposals?.length > 0 || preComputed.humanDirectives?.length > 0) {
    const dismissed = preComputed.dismissedProposals.map((p: any) => {
      const date = new Date(p.created_at).toISOString().slice(0, 16);
      const reason = p.human_decision?.reason || p.human_decision?.instruction || "";
      return `- ${p.action_type} [${date}]${reason ? ` — "${reason}"` : ""}`;
    }).join("\n");
    if (dismissed) {
      decisionHistorySection = `\n## Decision History (dismissed proposals)\n${dismissed}`;
    }
  }

  // Allowed actions section
  const actionDescriptions: Record<string, string> = {
    SEND_INITIAL_REQUEST: "Send the initial FOIA request to the agency",
    SEND_FOLLOWUP: "Send a follow-up message to the agency",
    SEND_REBUTTAL: "Challenge the agency's denial with legal arguments",
    SEND_CLARIFICATION: "Respond to agency's request for additional information",
    SEND_APPEAL: "File a formal appeal (requires human approval)",
    SEND_FEE_WAIVER_REQUEST: "Request fee waiver citing public interest (requires human approval)",
    SEND_STATUS_UPDATE: "Send a status inquiry to the agency",
    RESPOND_PARTIAL_APPROVAL: "Accept released records, challenge withheld portions",
    ACCEPT_FEE: "Accept the quoted fee amount",
    NEGOTIATE_FEE: "Propose a lower fee or narrower scope",
    DECLINE_FEE: "Decline the fee and explain why",
    ESCALATE: "Escalate to human review (requires human approval)",
    NONE: "No action needed — wait or acknowledge",
    CLOSE_CASE: "Close the case (requires human approval)",
    WITHDRAW: "Withdraw the records request entirely",
    RESEARCH_AGENCY: "Research the correct agency/custodian for these records",
    REFORMULATE_REQUEST: "Narrow or reformulate the original request",
    SUBMIT_PORTAL: "Submit through the agency's web portal",
  };

  const allowedActionsSection = allowedActions
    .map(a => `- **${a}**: ${actionDescriptions[a] || a}`)
    .join("\n");

  // Custom instruction
  const customSection = customInstruction
    ? `\n## CUSTOM INSTRUCTION FROM HUMAN\n${customInstruction}\nFollow this instruction. Choose the most appropriate action from the allowed set.`
    : "";

  return `You are the decision engine for a FOIA (public records) automation system.
${humanDirectivesSection}${customSection}
${preComputedSection}

## Case Context
- Agency: ${caseData?.agency_name || "Unknown"}
- Agency email: ${caseData?.agency_email || "Unknown"}
- State: ${caseData?.state || "Unknown"}
- Subject: ${caseData?.subject_name || "Unknown"}
- Records requested: ${requestedRecords}
- Additional details: ${caseData?.additional_details || "none"}
- Current status: ${caseData?.status || "Unknown"}
- Substatus: ${caseData?.substatus || "none"}
- Jurisdiction: ${jurisdictionLevel || "unknown"}
${timingSection}

## Classifier Result
- Classification: ${classification}
- Confidence: ${classificationConfidence ?? "unknown"}
- Sentiment: ${sentiment}
- Fee amount: ${extractedFeeAmount ?? "none"}
- Denial subtype: ${denialSubtype || "none"}
${latestAnalysisSection}
${decisionHistorySection}

## Constraints
${JSON.stringify(constraints || [], null, 2)}

## Scope Items
${JSON.stringify(scopeItems || [], null, 2)}

## Autopilot Mode: ${autopilotMode}
${feeSection}${portalSection}${researchSection}

## Thread Summary
IMPORTANT: Messages labeled [PORTAL_NOTIFICATION:*] are automated emails from records portals (NextRequest, GovQA, etc.) and reflect ONLY the portal track status. A portal marked "closed" or "completed" does NOT mean the case is resolved — there may be active direct email correspondence with the agency that still needs a response. Base your decision on the classifier result and direct agency correspondence.
${threadSummary || "No thread messages available. IMPORTANT: When thread messages are unavailable, rely on the Classifier Result and Latest Analysis Key Points above to make your decision. Do NOT escalate solely because thread messages are missing — the classifier has already analyzed the message content and its findings are trustworthy. Choose the action that best matches the classification, denial subtype, and key points."}

## ALLOWED ACTIONS (you MUST choose from this list)
${allowedActionsSection}

## Policy Guidelines

### Fee Routing
- Fee <= $${FEE_AUTO_APPROVE_MAX} in AUTO mode → ACCEPT_FEE (auto-execute)
- Fee $${FEE_AUTO_APPROVE_MAX}-$${FEE_NEGOTIATE_THRESHOLD} → ACCEPT_FEE (requires human)
- Fee > $${FEE_NEGOTIATE_THRESHOLD} → NEGOTIATE_FEE (requires human)
- If agency also denied records in same message → SEND_REBUTTAL first, handle fee later
- If fee seems excessive → SEND_FEE_WAIVER_REQUEST (requires human)

### Denial Routing by Subtype
- no_records (no verified custodian) → RESEARCH_AGENCY, researchLevel=deep
- no_records (has verified custodian) → SEND_REBUTTAL, researchLevel=medium
- wrong_agency → RESEARCH_AGENCY, researchLevel=medium
- overly_broad → REFORMULATE_REQUEST
- ongoing_investigation (strong) → CLOSE_CASE; (weak/medium) → SEND_REBUTTAL
- privacy_exemption (strong) → CLOSE_CASE; (weak/medium) → SEND_REBUTTAL
- excessive_fees → NEGOTIATE_FEE or SEND_FEE_WAIVER_REQUEST
- glomar_ncnd → SEND_APPEAL, researchLevel=medium
- not_reasonably_described → SEND_CLARIFICATION, researchLevel=light
- juvenile_records, sealed_court_order → CLOSE_CASE
- third_party_confidential → SEND_REBUTTAL (accept redactions)
- records_not_yet_created → SEND_STATUS_UPDATE

### Unanswered Clarification
- If there is an unanswered agency clarification (see pre-computed analysis), strongly prefer SEND_CLARIFICATION

### Bodycam Custodian Research
- If bodycam custodian research is flagged as needed AND classification is CLARIFICATION_REQUEST, prefer RESEARCH_AGENCY with researchLevel=deep

### requiresHuman Rules
- ALWAYS require human for: CLOSE_CASE, ESCALATE, SEND_APPEAL, SEND_FEE_WAIVER_REQUEST, WITHDRAW
- Require human when confidence < 0.7
- Require human in SUPERVISED mode for any email-sending action

### researchLevel Guidance
- "none" = skip research (acks, records ready, simple followups)
- "light" = verify contacts/portal only
- "medium" = contacts + state law research
- "deep" = full custodian chain research

Choose exactly one action from the ALLOWED ACTIONS list. Provide concise reasoning. Set researchLevel appropriately.`;
}

async function makeAIDecisionV2(params: {
  caseId: number;
  classification: Classification;
  constraints: string[];
  extractedFeeAmount: number | null;
  sentiment: string;
  autopilotMode: AutopilotMode;
  denialSubtype?: string | null;
  jurisdictionLevel?: string | null;
  inlineKeyPoints?: string[];
  allowedActions: ActionType[];
  preComputed: PreComputedContext;
  customInstruction?: string | null;
}): Promise<DecisionResult> {
  const {
    caseId, classification, constraints, extractedFeeAmount, sentiment,
    autopilotMode, allowedActions, preComputed, customInstruction,
  } = params;

  const scopeItems = Array.isArray(preComputed.caseData?.scope_items_jsonb)
    ? preComputed.caseData.scope_items_jsonb
    : Array.isArray(preComputed.caseData?.scope_items)
      ? preComputed.caseData.scope_items
      : [];

  const prompt = buildEnrichedDecisionPrompt({
    caseData: preComputed.caseData,
    classification,
    classificationConfidence: preComputed.latestAnalysis?.confidence_score ?? null,
    constraints,
    scopeItems,
    extractedFeeAmount,
    sentiment,
    autopilotMode,
    threadMessages: preComputed.threadMessages,
    denialSubtype: params.denialSubtype,
    jurisdictionLevel: params.jurisdictionLevel,
    dismissedProposals: preComputed.dismissedProposals,
    humanDirectives: preComputed.humanDirectives,
    phoneNotes: preComputed.phoneNotes,
    latestAnalysis: preComputed.latestAnalysis,
    allowedActions,
    preComputed,
    customInstruction,
    inlineKeyPoints: params.inlineKeyPoints,
  });

  // 3-attempt self-repair loop
  let lastError: string | null = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const repairHint = lastError
        ? `\n\nPREVIOUS ATTEMPT FAILED: ${lastError}\nFix the issue and try again. You MUST choose from the ALLOWED ACTIONS list.`
        : "";

      const { object } = await generateObject({
        model: decisionModel,
        schema: decisionSchema,
        prompt: prompt + repairHint,
        providerOptions: decisionOptions,
      });

      // Validate structure
      const validation = validateStructureV2(object, allowedActions, extractedFeeAmount, autopilotMode);
      if (!validation.valid) {
        lastError = validation.reason!;
        logger.warn("AI Router v2 decision failed structure validation", {
          caseId, attempt, reason: validation.reason, action: object.action,
        });
        continue;
      }

      // Apply post-decision flags
      const requiresHuman = ALWAYS_GATE_ACTIONS.includes(object.action as ActionType)
        ? true
        : object.confidence < 0.7
          ? true
          : object.requiresHuman;

      const canAutoExecute =
        autopilotMode === "AUTO" &&
        !requiresHuman &&
        !ALWAYS_GATE_ACTIONS.includes(object.action as ActionType);

      // Bodycam custodian research override
      if (
        classification === "CLARIFICATION_REQUEST" &&
        object.action !== "RESEARCH_AGENCY" &&
        preComputed.bodycamResearchNeeded
      ) {
        return decision("RESEARCH_AGENCY", {
          pauseReason: "DENIAL",
          researchLevel: "deep",
          canAutoExecute: false,
          requiresHuman: true,
          reasoning: [
            "Body-cam/video is still a top requested record.",
            "Inbound message appears limited to 911/dispatch form workflow.",
            "Researching additional custodians for body-cam/video before continuing 911-only track.",
          ],
        });
      }

      // Fee threshold override
      const fee = extractedFeeAmount != null ? Number(extractedFeeAmount) : null;
      let finalRequiresHuman = requiresHuman;
      if (fee != null && isFinite(fee) && fee > FEE_AUTO_APPROVE_MAX && object.action === "ACCEPT_FEE") {
        finalRequiresHuman = true;
      }

      logger.info("AI Router v2 decision made", {
        caseId, classification, action: object.action, confidence: object.confidence,
        attempt, requiresHuman: finalRequiresHuman,
      });

      return decision(object.action as ActionType, {
        canAutoExecute: autopilotMode === "AUTO" && !finalRequiresHuman && !ALWAYS_GATE_ACTIONS.includes(object.action as ActionType),
        requiresHuman: finalRequiresHuman,
        pauseReason: finalRequiresHuman ? (object.pauseReason || "SENSITIVE") : null,
        reasoning: object.reasoning,
        adjustmentInstruction: object.adjustmentInstruction,
        isComplete: object.action === "NONE",
        researchLevel: (object as any).researchLevel || "none",
        overrideMessageId: (object as any).overrideMessageId || undefined,
      });
    } catch (error: any) {
      lastError = error.message;
      logger.warn("AI Router v2 attempt failed", {
        caseId, attempt, error: error.message,
      });
    }
  }

  // All 3 attempts failed — escalate
  logger.error("AI Router v2 exhausted all attempts", { caseId, classification, lastError });
  return decision("ESCALATE", {
    pauseReason: "SENSITIVE",
    reasoning: [`AI Router v2 failed after 3 attempts: ${lastError}`, "Escalating to human review"],
  });
}

function validateStructureV2(
  aiResult: DecisionOutput,
  allowedActions: ActionType[],
  extractedFeeAmount: number | null,
  autopilotMode: AutopilotMode
): { valid: boolean; reason?: string } {
  // 1. Confidence floor
  if (aiResult.confidence < 0.5) {
    return { valid: false, reason: `Confidence too low (${aiResult.confidence})` };
  }

  // 2. Action must be in the allowed set
  if (!allowedActions.includes(aiResult.action as ActionType)) {
    return { valid: false, reason: `Action ${aiResult.action} not in allowed set [${allowedActions.join(", ")}]` };
  }

  // 3. ALWAYS_GATE actions must have requiresHuman=true
  if (ALWAYS_GATE_ACTIONS.includes(aiResult.action as ActionType) && !aiResult.requiresHuman) {
    return { valid: false, reason: `${aiResult.action} must require human review` };
  }

  // 4. Fee threshold check
  const fee = extractedFeeAmount != null ? Number(extractedFeeAmount) : null;
  if (fee != null && isFinite(fee) && fee > FEE_NEGOTIATE_THRESHOLD && aiResult.action !== "NEGOTIATE_FEE" && aiResult.action !== "SEND_FEE_WAIVER_REQUEST" && aiResult.action !== "ESCALATE") {
    return { valid: false, reason: `Fee $${fee} exceeds negotiate threshold $${FEE_NEGOTIATE_THRESHOLD}; must use NEGOTIATE_FEE or SEND_FEE_WAIVER_REQUEST` };
  }

  // 5. Reasoning must be non-empty
  if (!aiResult.reasoning || aiResult.reasoning.length === 0) {
    return { valid: false, reason: "Reasoning must be non-empty" };
  }

  return { valid: true };
}

async function assessDenialStrength(caseId: number, denialSubtype?: string | null, inlineKeyPoints?: string[]): Promise<"strong" | "medium" | "weak"> {
  const analysis = await db.getLatestResponseAnalysis(caseId);
  // Use DB key_points when available; fall back to inline key_points from classification (e.g. mock/simulator context)
  const keyPoints: string[] = analysis?.key_points?.length ? analysis.key_points : (inlineKeyPoints || []);

  // Also check the original message body — key_points may paraphrase and lose indicator phrases
  const latestMessage = await db.query(
    `SELECT body_text FROM messages WHERE case_id = $1 AND direction = 'inbound' ORDER BY created_at DESC LIMIT 1`,
    [caseId]
  );
  const messageBody = latestMessage?.rows?.[0]?.body_text || "";

  // Combine key_points + message body for indicator scanning
  const allTextSources = [...keyPoints, messageBody];
  const fullText = allTextSources.join(" ").toLowerCase();

  // Legally unappealable: citizen/residency restrictions (McBurney v. Young)
  const citizenRestriction = /\bavailable only to [\w ]*(citizen|resident)\b|\bcitizen[- ]only\b|\bresidency restriction\b|\bmcburney v\.?\s*young\b|\bonly [\w ]*citizens\b may/i.test(fullText);
  if (citizenRestriction) return "strong";

  const strongIndicators = [
    // Criminal/investigation language — requires explicit enforcement context
    "law enforcement", "ongoing investigation", "federal investigation",
    "enforcement proceedings", "active prosecution", "active case", "pending case",
    // Court/legal
    "in court", "sealed", "court order",
    // Withholding language
    "cannot be provided", "nothing can be provided", "prohibited from disclosing",
    "confidential",
    // Statutory exemptions (specific enough to indicate strong denial)
    "552(b)(7)", "exemption 7(a)", "exemption 7a",
  ];

  // Count unique strong indicators found across all text sources (not per-source)
  let strongCount = strongIndicators.filter((ind) =>
    fullText.includes(ind)
  ).length;
  // Cap at a reasonable max to avoid over-counting from message body repeating phrases
  strongCount = Math.min(strongCount, 4);

  // The classifier's denial_subtype is itself strong evidence — it already analyzed the message
  if (denialSubtype === "ongoing_investigation" || denialSubtype === "sealed_court_order") {
    strongCount += 1; // Subtype adds weight but requires a corroborating indicator to reach "strong"
  } else if (denialSubtype === "privacy_exemption") {
    strongCount += 1; // Privacy exemption requires concrete language to reach "strong"
  }

  if (strongCount >= 2) return "strong";
  if (strongCount === 1) return "medium";
  return "weak";
}

async function checkUnansweredClarification(caseId: number): Promise<number | null> {
  const threadMessages = await db.getMessagesByCaseId(caseId);
  const inboundAnalyses = await db.query(
    `SELECT ra.message_id, ra.intent FROM response_analysis ra
     JOIN messages m ON m.id = ra.message_id
     WHERE ra.case_id = $1 AND m.direction = 'inbound'
     ORDER BY ra.created_at ASC`,
    [caseId]
  );
  const clarificationMsgIds = inboundAnalyses.rows
    .filter((a: any) => a.intent === "question" || a.intent === "more_info_needed")
    .map((a: any) => a.message_id);

  if (clarificationMsgIds.length > 0) {
    const lastClarificationId = clarificationMsgIds[clarificationMsgIds.length - 1];
    const outboundAfter = threadMessages.filter(
      (m: any) => m.direction === "outbound" && m.id > lastClarificationId
    );
    if (outboundAfter.length === 0) return lastClarificationId;
  }
  return null;
}

function decision(
  actionType: ActionType,
  overrides: Partial<DecisionResult> = {}
): DecisionResult {
  return {
    actionType,
    canAutoExecute: false,
    requiresHuman: true,
    pauseReason: null,
    reasoning: [],
    adjustmentInstruction: null,
    isComplete: false,
    researchLevel: "none",
    ...overrides,
  };
}

function noAction(reasoning: string[]): DecisionResult {
  return decision("NONE", { isComplete: true, requiresHuman: false, reasoning });
}

function shouldPrioritizeBodycamCustodianResearch(
  caseData: any,
  latestAnalysis: any,
  constraints: string[] = []
): boolean {
  const requested = Array.isArray(caseData?.requested_records)
    ? caseData.requested_records.join(" ")
    : caseData?.requested_records || "";
  const scopeText = Array.isArray(caseData?.scope_items_jsonb)
    ? caseData.scope_items_jsonb.map((s: any) => s?.name || "").join(" ")
    : "";
  const detailsText = String(caseData?.additional_details || "");
  const corpus = `${requested} ${scopeText} ${detailsText}`.toLowerCase();
  const bodycamSignal = /body.?cam|bodycam|bwc|body.?worn|dash.?cam|officer video|video footage/.test(corpus);

  const caseConstraints = [
    ...(Array.isArray(caseData?.constraints_jsonb) ? caseData.constraints_jsonb : []),
    ...(Array.isArray(constraints) ? constraints : []),
  ];
  const wrongAgencyTo911Signal = caseConstraints.some((c: string) =>
    [
      "WRONG_AGENCY",
      "WRONG_AGENCY_REDIRECT",
      "REFERRED_TO_911_CENTER",
      "REFERRED_TO_OTHER_CUSTODIAN",
      "REFERRED_TO_OTHER_AGENCY",
      "REFERRAL_OTHER_AGENCY",
    ].includes(c)
  );

  const analysisBlob = [
    ...(latestAnalysis?.key_points || []),
    JSON.stringify(latestAnalysis?.full_analysis_json || {}),
  ].join(" ").toLowerCase();

  const is911Scoped = /911|dispatch|central communications|audio/.test(analysisBlob);
  const formGate = /request form|apra\/foia request form|complete (the )?form|mailing address/.test(analysisBlob);
  const mentionsBodycamHandling = /body.?cam|body.?worn|bwc|dash.?cam/.test(analysisBlob);

  // Trigger when agency guidance is clearly scoped to 911/form workflow and
  // does not address where body-cam/video custody is held.
  // We allow either explicit body-cam signals OR wrong-agency->911 handoff signals.
  return is911Scoped && formGate && !mentionsBodycamHandling && (bodycamSignal || wrongAgencyTo911Signal);
}

function buildHumanDirectivesSection(
  dismissedProposals?: any[],
  humanDirectives?: any[],
  phoneNotes?: any[]
): string {
  const sections: string[] = [];

  // 1. Recent human decisions (review resolutions, instructions)
  if (humanDirectives && humanDirectives.length > 0) {
    const decisions = humanDirectives
      .filter((d: any) => d.action === "human_decision")
      .map((d: any) => {
        const details = d.details || {};
        const action = details.review_action || "unknown";
        const instruction = details.instruction;
        const date = new Date(d.created_at).toISOString().slice(0, 16);
        return instruction
          ? `- [${date}] Human chose "${action}" with instruction: "${instruction}"`
          : `- [${date}] Human chose "${action}"`;
      });
    if (decisions.length > 0) {
      sections.push(`### Human Review Decisions\n${decisions.join("\n")}`);
    }
  }

  // 2. Phone call notes
  if (phoneNotes && phoneNotes.length > 0) {
    const calls = phoneNotes.map((p: any) => {
      const date = new Date(p.updated_at).toISOString().slice(0, 16);
      const outcome = p.call_outcome || "unknown";
      return `- [${date}] Call outcome: ${outcome}. Notes: ${(p.notes || "").trim().substring(0, 500)}`;
    });
    sections.push(`### Phone Call Notes\n${calls.join("\n")}`);
  }

  // 3. Dismissed proposals (with reasons)
  if (dismissedProposals && dismissedProposals.length > 0) {
    const dismissed = dismissedProposals.map((p: any) => {
      const date = new Date(p.created_at).toISOString().slice(0, 16);
      const hd = p.human_decision;
      const reason = hd?.reason || hd?.instruction || null;
      return reason
        ? `- ${p.action_type} [${date}] — Human said: "${reason}"`
        : `- ${p.action_type} [${date}]`;
    });
    sections.push(`### Previously Rejected Proposals\nDo NOT repeat these action types:\n${dismissed.join("\n")}`);
  }

  if (sections.length === 0) return "";

  const warning = (dismissedProposals?.length || 0) >= 3
    ? "\nCRITICAL: 3+ proposals rejected. Strongly consider ESCALATE.\n"
    : "";

  return `
## HUMAN DIRECTIVES (HIGHEST PRIORITY)
The following are decisions, instructions, and notes from the human operator.
These OVERRIDE your own analysis. If a human said to do something, do it.
Do NOT propose an action the human already rejected.

${sections.join("\n\n")}
${warning}`;
}

function buildDecisionPrompt(params: {
  caseData: any;
  classification: Classification;
  classificationConfidence: number | null;
  constraints: string[];
  scopeItems: any[];
  extractedFeeAmount: number | null;
  sentiment: string;
  autopilotMode: AutopilotMode;
  threadMessages: any[];
  denialSubtype?: string | null;
  jurisdictionLevel?: string | null;
  dismissedProposals?: any[];
  humanDirectives?: any[];
  phoneNotes?: any[];
  latestAnalysis?: any;
}): string {
  const {
    caseData,
    classification,
    classificationConfidence,
    constraints,
    scopeItems,
    extractedFeeAmount,
    sentiment,
    autopilotMode,
    threadMessages,
  } = params;

  const requestedRecords = Array.isArray(caseData?.requested_records)
    ? caseData.requested_records.join(", ")
    : caseData?.requested_records || "Various records";

  const threadSummary = threadMessages
    .slice(0, 10)
    .reverse()
    .map((m: any) => {
      const body = (m.body_text || m.body_html || "").replace(/\s+/g, " ").trim().substring(0, 600);
      const label = m.portal_notification
        ? `PORTAL_NOTIFICATION:${(m.portal_notification_provider || "unknown").toUpperCase()}`
        : String(m.direction || "unknown").toUpperCase();
      const date = m.sent_at || m.received_at || m.created_at;
      const dateStr = date ? new Date(date).toISOString().split("T")[0] : "unknown";
      const sender = m.direction === "inbound" ? (m.from_email || "unknown") : (m.to_email || "unknown");
      return `[${label} | ${dateStr} | ${sender}] ${m.subject || "(no subject)"}\n${body}`;
    })
    .join("\n---\n");

  const denialSubtype = params.denialSubtype || null;
  const jurisdictionLevel = params.jurisdictionLevel || null;

  // Build human directives section (highest priority — placed before all other context)
  const humanDirectivesSection = buildHumanDirectivesSection(
    params.dismissedProposals, params.humanDirectives, params.phoneNotes
  );

  // Build research context summary
  const research = caseData?.research_context_jsonb;
  let researchSection = "";
  if (research) {
    const parts: string[] = [];
    if (research.state_law_notes) parts.push(`State Law Notes:\n${String(research.state_law_notes).substring(0, 1500)}`);
    if (research.rebuttal_support_points?.length) parts.push(`Rebuttal Support Points:\n${research.rebuttal_support_points.map((p: string) => `- ${p}`).join("\n")}`);
    if (research.likely_record_custodians?.length) parts.push(`Likely Record Custodians:\n${research.likely_record_custodians.map((c: string) => `- ${c}`).join("\n")}`);
    if (research.official_records_submission_methods?.length) parts.push(`Official Submission Methods:\n${research.official_records_submission_methods.map((m: string) => `- ${m}`).join("\n")}`);
    if (research.record_type_handoff_notes) parts.push(`Record Type Notes: ${String(research.record_type_handoff_notes).substring(0, 500)}`);
    if (parts.length) researchSection = `\n## Research Context (previously gathered)\n${parts.join("\n\n")}`;
  }

  // Build fee context
  const feeQuote = caseData?.fee_quote_jsonb;
  const feeSection = feeQuote ? `\n## Fee Quote Details\n${JSON.stringify(feeQuote, null, 2)}` : "";

  // Build portal context
  let portalSection = "";
  if (caseData?.portal_url || caseData?.last_portal_status) {
    portalSection = `\n## Portal Status\n- Portal URL: ${caseData.portal_url || "none"}\n- Provider: ${caseData.portal_provider || "none"}\n- Last portal status: ${caseData.last_portal_status || "none"}\n- Portal request #: ${caseData.portal_request_number || "none"}`;
  }

  // Build deadline/timing context
  let timingSection = "";
  const timingParts: string[] = [];
  if (caseData?.deadline_date) timingParts.push(`Deadline: ${new Date(caseData.deadline_date).toISOString().split("T")[0]}`);
  if (caseData?.days_overdue > 0) timingParts.push(`Days overdue: ${caseData.days_overdue}`);
  if (caseData?.send_date) timingParts.push(`Initial request sent: ${new Date(caseData.send_date).toISOString().split("T")[0]}`);
  if (caseData?.last_response_date) timingParts.push(`Last agency response: ${new Date(caseData.last_response_date).toISOString().split("T")[0]}`);
  if (caseData?.incident_date) timingParts.push(`Incident date: ${caseData.incident_date}`);
  if (caseData?.incident_location) timingParts.push(`Incident location: ${caseData.incident_location}`);
  if (timingParts.length) timingSection = `\n## Timing & Deadlines\n${timingParts.map(p => `- ${p}`).join("\n")}`;

  // Build latest analysis context (key points from the classifier)
  const latestAnalysisSection = params.latestAnalysis?.key_points?.length
    ? `\n## Latest Analysis Key Points\n${params.latestAnalysis.key_points.map((p: string) => `- ${p}`).join("\n")}`
    : "";

  return `You are the decision engine for a FOIA (public records) automation system. Choose the single best next action.
${humanDirectivesSection}
## Case Context
- Agency: ${caseData?.agency_name || "Unknown"}
- Agency email: ${caseData?.agency_email || "Unknown"}
- State: ${caseData?.state || "Unknown"}
- Subject: ${caseData?.subject_name || "Unknown"}
- Records requested: ${requestedRecords}
- Additional details: ${caseData?.additional_details || "none"}
- Current status: ${caseData?.status || "Unknown"}
- Substatus: ${caseData?.substatus || "none"}
- Jurisdiction: ${jurisdictionLevel || "unknown"}
${timingSection}
## Classifier Result
- Classification: ${classification}
- Confidence: ${classificationConfidence ?? "unknown"}
- Sentiment: ${sentiment}
- Fee amount: ${extractedFeeAmount ?? "none"}
- Denial subtype: ${denialSubtype || "none"}
${latestAnalysisSection}
## Constraints
${JSON.stringify(constraints || [], null, 2)}

## Scope Items
${JSON.stringify(scopeItems || [], null, 2)}

## Autopilot Mode: ${autopilotMode}
${feeSection}${portalSection}${researchSection}
## Thread Summary
IMPORTANT: Messages labeled [PORTAL_NOTIFICATION:*] are automated emails from records portals (NextRequest, GovQA, etc.) and reflect ONLY the portal track status. A portal marked "closed" or "completed" does NOT mean the case is resolved — there may be active direct email correspondence with the agency that still needs a response. Base your decision on the classifier result and direct agency correspondence.
${threadSummary || "No thread messages available."}

## Policy Rulebook (follow these rules strictly)

### Fee Routing
- Fee <= $100 in AUTO mode → ACCEPT_FEE (auto-execute)
- Fee $100-$500 → ACCEPT_FEE (requires human)
- Fee > $500 → NEGOTIATE_FEE (requires human)
- If agency also denied records in same message → SEND_REBUTTAL first, handle fee later
- If fee seems excessive for the request → SEND_FEE_WAIVER_REQUEST (requires human)

### Denial Routing by Subtype
- no_records (no verified custodian) → RESEARCH_AGENCY, researchLevel=deep
- no_records (has verified custodian) → SEND_REBUTTAL, researchLevel=medium
- wrong_agency → RESEARCH_AGENCY, researchLevel=medium
- overly_broad → REFORMULATE_REQUEST
- ongoing_investigation → SEND_REBUTTAL (request segregable portions), researchLevel=medium
- privacy_exemption → SEND_REBUTTAL (accept redactions, request segregable), researchLevel=medium
- excessive_fees → NEGOTIATE_FEE or SEND_FEE_WAIVER_REQUEST
- retention_expired → SEND_REBUTTAL (request proof), researchLevel=medium
- glomar_ncnd → SEND_APPEAL (requires human), researchLevel=medium
- not_reasonably_described → SEND_CLARIFICATION, researchLevel=light
- no_duty_to_create → RESEARCH_AGENCY, researchLevel=medium
- privilege_attorney_work_product → SEND_APPEAL (requires human), researchLevel=medium
- juvenile_records → CLOSE_CASE (requires human)
- sealed_court_order → CLOSE_CASE (requires human)
- third_party_confidential → SEND_REBUTTAL (accept redactions), researchLevel=medium
- records_not_yet_created → SEND_STATUS_UPDATE, schedule followup

### Clarification Routing
- If agency asked an identifier question (case number, date, name) → SEND_CLARIFICATION, researchLevel=light
- If agency asked to narrow scope → REFORMULATE_REQUEST
- If agency asked us to use a portal → treat as PORTAL_REDIRECT

### RECORDS_READY Safety
- Check for payment-required language → may need ACCEPT_FEE first
- Check for mixed withholdings → RESPOND_PARTIAL_APPROVAL
- Check for portal pickup instructions → NONE with note

### requiresHuman Rules
- ALWAYS require human for: CLOSE_CASE, ESCALATE, SEND_APPEAL, SEND_FEE_WAIVER_REQUEST, WITHDRAW
- Require human when confidence < 0.7
- Require human in SUPERVISED mode for any email-sending action

### researchLevel Guidance
- Set researchLevel to guide the research step that runs before drafting
- "none" = skip research (acks, records ready, simple followups)
- "light" = verify contacts/portal only (portal redirects, simple clarifications)
- "medium" = contacts + state law research (most denials, complex clarifications)
- "deep" = full custodian chain research (no_records without verified custodian, wrong_agency)

Choose exactly one action. Provide concise reasoning. Set researchLevel appropriately.`;
}

async function validateDecision(
  aiDecisionResult: DecisionOutput,
  context: {
    caseId: number;
    classification: Classification;
    extractedFeeAmount: number | null;
    autopilotMode: AutopilotMode;
    denialSubtype?: string | null;
    dismissedProposals?: any[];
    constraints?: string[];
    inlineKeyPoints?: string[];
  }
): Promise<{ valid: boolean; reason?: string }> {
  const { caseId, classification, extractedFeeAmount, autopilotMode, denialSubtype, dismissedProposals, constraints, inlineKeyPoints } = context;

  if (aiDecisionResult.confidence < 0.5) {
    return { valid: false, reason: `AI decision confidence too low (${aiDecisionResult.confidence})` };
  }

  // Citizenship/residency restrictions: reject ALL AI decisions, force deterministic id_state handling
  const CITIZENSHIP_CONSTRAINTS = ["AL_CITIZENSHIP_REQUIRED", "CITIZENSHIP_REQUIRED", "RESIDENCY_REQUIRED"];
  const hasCitizenshipRestriction = (constraints || []).some(c => CITIZENSHIP_CONSTRAINTS.includes(c));
  if (hasCitizenshipRestriction) {
    return {
      valid: false,
      reason: `Citizenship/residency restriction detected — marking as ID State for human handling`,
    };
  }

  // Reject actions that have been dismissed 2+ times for this case
  if (dismissedProposals && dismissedProposals.length > 0) {
    const dismissedActionCounts: Record<string, number> = {};
    for (const p of dismissedProposals) {
      dismissedActionCounts[p.action_type] = (dismissedActionCounts[p.action_type] || 0) + 1;
    }
    const thisActionDismissals = dismissedActionCounts[aiDecisionResult.action] || 0;
    if (thisActionDismissals >= 2) {
      return {
        valid: false,
        reason: `${aiDecisionResult.action} has been dismissed ${thisActionDismissals} times for this case — must try a different approach`,
      };
    }
  }

  // SEND_INITIAL_REQUEST is only valid for process-initial-request, not inbound routing
  if (aiDecisionResult.action === "SEND_INITIAL_REQUEST") {
    return { valid: false, reason: "SEND_INITIAL_REQUEST is not valid for inbound message routing" };
  }

  if (classification === "HOSTILE" && aiDecisionResult.action !== "ESCALATE") {
    return { valid: false, reason: "HOSTILE classification must escalate" };
  }

  if (classification === "UNKNOWN" && aiDecisionResult.action !== "ESCALATE") {
    return { valid: false, reason: "UNKNOWN classification must escalate" };
  }

  // WRONG_AGENCY must always route to RESEARCH_AGENCY — never follow up with the wrong agency
  if (classification === "WRONG_AGENCY" && aiDecisionResult.action !== "RESEARCH_AGENCY") {
    return { valid: false, reason: "WRONG_AGENCY classification must route to RESEARCH_AGENCY" };
  }

  // PORTAL_REDIRECT is handled entirely by deterministic portal-task creation — reject ALL AI decisions
  if (classification === "PORTAL_REDIRECT") {
    return { valid: false, reason: "PORTAL_REDIRECT is handled by deterministic portal-task creation (always falls to deterministic)" };
  }

  // PARTIAL_APPROVAL must always use RESPOND_PARTIAL_APPROVAL — don't let AI override with SEND_REBUTTAL or SEND_APPEAL
  if (classification === "PARTIAL_APPROVAL" && aiDecisionResult.action !== "RESPOND_PARTIAL_APPROVAL") {
    return { valid: false, reason: "PARTIAL_APPROVAL classification must use RESPOND_PARTIAL_APPROVAL" };
  }

  // RECORDS_READY means records are already here — no follow-up needed
  if (classification === "RECORDS_READY" && aiDecisionResult.action !== "NONE") {
    return { valid: false, reason: "RECORDS_READY classification must use NONE (records already delivered)" };
  }

  // FEE_QUOTE must use a fee-handling action — SEND_CLARIFICATION and SEND_FOLLOWUP are not appropriate
  // (deterministic routing handles null-fee edge cases correctly via the fee sanity check and unansweredQ logic)
  if (classification === "FEE_QUOTE" && (aiDecisionResult.action === "SEND_CLARIFICATION" || aiDecisionResult.action === "SEND_FOLLOWUP")) {
    return { valid: false, reason: "FEE_QUOTE classification must use a fee action (ACCEPT_FEE, NEGOTIATE_FEE, SEND_FEE_WAIVER_REQUEST), not SEND_CLARIFICATION/SEND_FOLLOWUP" };
  }

  // DENIAL with a known specific subtype should not use SEND_CLARIFICATION (only not_reasonably_described warrants it)
  if (
    classification === "DENIAL" &&
    context.denialSubtype &&
    context.denialSubtype !== "not_reasonably_described" &&
    aiDecisionResult.action === "SEND_CLARIFICATION"
  ) {
    return { valid: false, reason: `DENIAL with subtype ${context.denialSubtype} should not use SEND_CLARIFICATION` };
  }

  // Vague denials (no subtype) should not route to RESEARCH_AGENCY or SEND_CLARIFICATION
  if (classification === "DENIAL" && !context.denialSubtype &&
      (aiDecisionResult.action === "RESEARCH_AGENCY" || aiDecisionResult.action === "SEND_CLARIFICATION")) {
    return { valid: false, reason: "DENIAL without a specific subtype should use SEND_REBUTTAL or CLOSE_CASE, not RESEARCH_AGENCY/SEND_CLARIFICATION" };
  }

  if (aiDecisionResult.action === "CLOSE_CASE" && !aiDecisionResult.requiresHuman) {
    return { valid: false, reason: "CLOSE_CASE must require human review" };
  }

  // Strong ongoing_investigation, sealed_court_order, or privacy_exemption denials should close, not rebuttal
  if (
    classification === "DENIAL" &&
    (denialSubtype === "ongoing_investigation" || denialSubtype === "sealed_court_order" || denialSubtype === "privacy_exemption") &&
    aiDecisionResult.action === "SEND_REBUTTAL"
  ) {
    const strength = await assessDenialStrength(caseId, denialSubtype, inlineKeyPoints);
    if (strength === "strong") {
      return {
        valid: false,
        reason: `Strong ${denialSubtype} denial — should CLOSE_CASE, not SEND_REBUTTAL`,
      };
    }
  }

  // SEND_APPEAL and SEND_FEE_WAIVER_REQUEST always require human
  if (aiDecisionResult.action === "SEND_APPEAL" && !aiDecisionResult.requiresHuman) {
    return { valid: false, reason: "SEND_APPEAL must require human review" };
  }
  if (aiDecisionResult.action === "SEND_FEE_WAIVER_REQUEST" && !aiDecisionResult.requiresHuman) {
    return { valid: false, reason: "SEND_FEE_WAIVER_REQUEST must require human review" };
  }

  const fee = extractedFeeAmount != null ? Number(extractedFeeAmount) : null;
  if (classification === "FEE_QUOTE" && fee != null && isFinite(fee) && fee >= 0) {
    if (fee > FEE_NEGOTIATE_THRESHOLD && aiDecisionResult.action !== "NEGOTIATE_FEE") {
      return {
        valid: false,
        reason: `Fee $${fee} exceeds negotiate threshold $${FEE_NEGOTIATE_THRESHOLD}; must negotiate`,
      };
    }

    if (
      fee > FEE_AUTO_APPROVE_MAX &&
      aiDecisionResult.action === "ACCEPT_FEE" &&
      autopilotMode === "AUTO" &&
      !aiDecisionResult.requiresHuman
    ) {
      return {
        valid: false,
        reason: `Fee $${fee} exceeds auto-approve max $${FEE_AUTO_APPROVE_MAX}; cannot auto-accept`,
      };
    }
  }

  return { valid: true };
}

async function aiDecision(params: {
  caseId: number;
  classification: Classification;
  constraints: string[];
  extractedFeeAmount: number | null;
  sentiment: string;
  autopilotMode: AutopilotMode;
  denialSubtype?: string | null;
  jurisdictionLevel?: string | null;
  inlineKeyPoints?: string[];
}): Promise<DecisionResult | null> {
  try {
    const [caseData, threadMessages, latestAnalysis, dismissedProposals, humanDirectives, phoneNotes] = await Promise.all([
      db.getCaseById(params.caseId),
      db.getMessagesByCaseId(params.caseId),
      db.getLatestResponseAnalysis(params.caseId),
      db.query(
        `SELECT action_type, reasoning, human_decision, created_at FROM proposals
         WHERE case_id = $1 AND status = 'DISMISSED'
         ORDER BY created_at DESC LIMIT 5`,
        [params.caseId]
      ).then((r: any) => r.rows),
      // Fetch recent human decisions from activity log (review resolutions, instructions)
      db.query(
        `SELECT event_type, metadata, created_at FROM activity_log
         WHERE case_id = $1
           AND event_type IN ('human_decision', 'phone_call_completed')
         ORDER BY created_at DESC LIMIT 10`,
        [params.caseId]
      ).then((r: any) => r.rows),
      // Fetch phone call notes for this case
      db.query(
        `SELECT notes, call_outcome, ai_briefing, updated_at FROM phone_call_queue
         WHERE case_id = $1 AND (notes IS NOT NULL AND notes != '')
         ORDER BY updated_at DESC LIMIT 3`,
        [params.caseId]
      ).then((r: any) => r.rows),
    ]);

    const constraints = Array.isArray(params.constraints) ? params.constraints : [];
    const scopeItems = Array.isArray(caseData?.scope_items_jsonb)
      ? caseData.scope_items_jsonb
      : Array.isArray(caseData?.scope_items)
        ? caseData.scope_items
        : [];

    const prompt = buildDecisionPrompt({
      caseData,
      classification: params.classification,
      classificationConfidence: latestAnalysis?.confidence_score ?? null,
      constraints,
      scopeItems,
      extractedFeeAmount: params.extractedFeeAmount,
      sentiment: params.sentiment,
      autopilotMode: params.autopilotMode,
      threadMessages: Array.isArray(threadMessages) ? threadMessages : [],
      denialSubtype: params.denialSubtype,
      jurisdictionLevel: params.jurisdictionLevel,
      dismissedProposals,
      humanDirectives,
      phoneNotes,
      latestAnalysis,
    });

    const { object } = await generateObject({
      model: decisionModel,
      schema: decisionSchema,
      prompt,
      providerOptions: decisionOptions,
    });

    const validation = await validateDecision(object, {
      caseId: params.caseId,
      classification: params.classification,
      extractedFeeAmount: params.extractedFeeAmount,
      autopilotMode: params.autopilotMode,
      denialSubtype: params.denialSubtype,
      dismissedProposals,
      constraints: params.constraints,
      inlineKeyPoints: params.inlineKeyPoints,
    });

    if (!validation.valid) {
      logger.warn("AI decision rejected by policy validator; using deterministic fallback", {
        caseId: params.caseId,
        classification: params.classification,
        proposedAction: object.action,
        reason: validation.reason,
      });
      return null;
    }

    const requiresHuman = object.action === "CLOSE_CASE"
      ? true
      : object.action === "ESCALATE"
        ? true
        : object.requiresHuman;

    const canAutoExecute =
      params.autopilotMode === "AUTO" &&
      !requiresHuman &&
      object.action !== "ESCALATE";

    // Guardrail: if body-cam is requested but inbound guidance is only 911/form
    // process, force custodian research rather than staying in a 911-only loop.
    if (
      params.classification === "CLARIFICATION_REQUEST" &&
      object.action !== "RESEARCH_AGENCY" &&
      shouldPrioritizeBodycamCustodianResearch(caseData, latestAnalysis, params.constraints)
    ) {
      return decision("RESEARCH_AGENCY", {
        pauseReason: "DENIAL",
        researchLevel: "deep",
        canAutoExecute: false,
        requiresHuman: true,
        reasoning: [
          "Body-cam/video is still a top requested record.",
          "Inbound message appears limited to 911/dispatch form workflow.",
          "Researching additional custodians for body-cam/video before continuing 911-only track.",
        ],
      });
    }

    return decision(object.action, {
      canAutoExecute,
      requiresHuman,
      pauseReason: requiresHuman ? (object.pauseReason || "SENSITIVE") : null,
      reasoning: object.reasoning,
      adjustmentInstruction: object.adjustmentInstruction,
      isComplete: object.action === "NONE",
      researchLevel: (object as any).researchLevel || "none",
    });
  } catch (error: any) {
    logger.warn("AI decision failed; using deterministic fallback", {
      caseId: params.caseId,
      classification: params.classification,
      error: error.message,
    });
    return null;
  }
}

async function deterministicRouting(
  caseId: number,
  classification: Classification,
  extractedFeeAmount: number | null,
  sentiment: string,
  autopilotMode: AutopilotMode,
  triggerType: string,
  requiresResponse: boolean | undefined,
  portalUrl: string | null,
  denialSubtype: string | null,
  inlineKeyPoints?: string[]
): Promise<DecisionResult> {
  const reasoning: string[] = [];
  const isFollowupTrigger = ["SCHEDULED_FOLLOWUP", "time_based_followup", "followup_trigger"].includes(triggerType);

  // Citizenship/residency restriction: mark as ID State regardless of classification
  const caseDataForConstraints = await db.getCaseById(caseId);
  const topConstraints = caseDataForConstraints?.constraints_jsonb || caseDataForConstraints?.constraints || [];
  const CITIZEN_CONSTRAINTS_TOP = ["AL_CITIZENSHIP_REQUIRED", "CITIZENSHIP_REQUIRED", "RESIDENCY_REQUIRED"];
  if (CITIZEN_CONSTRAINTS_TOP.some((c: string) => topConstraints.includes(c))) {
    await db.updateCaseStatus(caseId, "id_state", {
      substatus: "Citizenship/residency restriction — requires in-state identity",
      requires_human: true,
    });
    logger.info("Marked case as ID State due to citizenship restriction", { caseId, classification });
    return noAction(["Citizenship/residency restriction — marked as ID State for human handling"]);
  }

  // FEE QUOTE
  if (classification === "FEE_QUOTE") {
    const fee = extractedFeeAmount != null ? Number(extractedFeeAmount) : null;
    if (fee === null || !isFinite(fee) || fee < 0) {
      // No actual fee amount quoted — check if agency is asking a question
      // (e.g., "Do you want to proceed? We'll send an estimate.")
      const feeAnalysis = await db.getLatestResponseAnalysis(caseId);
      const unansweredQ = feeAnalysis?.full_analysis_json?.unanswered_agency_question;
      if (unansweredQ) {
        return decision("SEND_FOLLOWUP", {
          pauseReason: "FEE_QUOTE",
          reasoning: [
            `Fee mentioned but no specific amount quoted`,
            `Agency is asking: "${unansweredQ}"`,
          ],
        });
      }
      return decision("NEGOTIATE_FEE", {
        pauseReason: "FEE_QUOTE",
        reasoning: [`Fee amount invalid/missing (${extractedFeeAmount})`],
      });
    }
    reasoning.push(`Fee quote received: $${fee}`);

    // BWC denial check alongside fee
    const latestAnalysis = await db.getLatestResponseAnalysis(caseId);
    const kp = (latestAnalysis?.key_points || []).join(" ").toLowerCase();
    const caseData = await db.getCaseById(caseId);
    const rr = (Array.isArray(caseData?.requested_records)
      ? caseData.requested_records.join(" ")
      : (caseData?.requested_records || "")).toLowerCase();
    const bwcRequested = /body.?cam|bodycam|bwc|body.?worn|video/.test(rr);
    const bwcDenied = /body.?cam|bodycam|bwc|body.?worn|video/.test(kp) &&
      /not disclos|denied|withheld|exempt|not subject|not available|unable to release/.test(kp);

    if (bwcRequested && bwcDenied) {
      return decision("SEND_REBUTTAL", {
        pauseReason: "DENIAL",
        reasoning: [...reasoning, "BWC denied alongside fee - challenge denial before paying"],
      });
    }

    if (fee <= FEE_AUTO_APPROVE_MAX && autopilotMode === "AUTO") {
      return decision("ACCEPT_FEE", {
        canAutoExecute: true,
        requiresHuman: false,
        reasoning: [...reasoning, `Fee under $${FEE_AUTO_APPROVE_MAX}, auto-approving`],
      });
    }
    if (fee <= FEE_NEGOTIATE_THRESHOLD) {
      return decision("ACCEPT_FEE", {
        pauseReason: "FEE_QUOTE",
        reasoning: [...reasoning, "Fee within acceptable range, gating for review"],
      });
    }
    return decision("NEGOTIATE_FEE", {
      pauseReason: "FEE_QUOTE",
      reasoning: [...reasoning, `Fee exceeds $${FEE_NEGOTIATE_THRESHOLD}, recommending negotiation`],
    });
  }

  // DENIAL
  if (classification === "DENIAL") {
    reasoning.push("Denial received from agency");
    const caseData = await db.getCaseById(caseId);

    // Check for unanswered clarification
    const unansweredMsgId = await checkUnansweredClarification(caseId);
    if (unansweredMsgId) {
      return decision("SEND_CLARIFICATION", {
        pauseReason: "DENIAL",
        reasoning: [...reasoning, `Unanswered clarification (msg #${unansweredMsgId}) - answering original question`],
        overrideMessageId: unansweredMsgId,
      });
    }

    const resolvedSubtype = denialSubtype || (await db.getLatestResponseAnalysis(caseId))?.full_analysis_json?.denial_subtype || null;

    switch (resolvedSubtype) {
      case "no_records":
        if (!caseData?.contact_research_notes) {
          return decision("RESEARCH_AGENCY", { pauseReason: "DENIAL", researchLevel: "deep", reasoning: [...reasoning, "No records - researching correct agency (deep)"] });
        }
        return decision("REFORMULATE_REQUEST", { pauseReason: "DENIAL", researchLevel: "medium", reasoning: [...reasoning, "Already researched - reformulating request"] });
      case "wrong_agency": {
        // Atomic WRONG_AGENCY handling: cancel portal tasks, dismiss proposals, add constraint
        await Promise.all([
          db.query(
            `UPDATE portal_tasks SET status = 'CANCELLED', completed_at = NOW()
             WHERE case_id = $1 AND status IN ('PENDING', 'IN_PROGRESS')`,
            [caseId]
          ),
          db.query(
            `UPDATE proposals SET status = 'DISMISSED', updated_at = NOW()
             WHERE case_id = $1 AND status IN ('PENDING_APPROVAL', 'BLOCKED', 'PENDING_PORTAL')
             AND action_type IN ('SUBMIT_PORTAL', 'SEND_INITIAL_REQUEST', 'SEND_FOLLOWUP')`,
            [caseId]
          ),
        ]);
        const currentConstraints = caseData?.constraints_jsonb || caseData?.constraints || [];
        if (!currentConstraints.includes("WRONG_AGENCY")) {
          await db.updateCase(caseId, {
            constraints_jsonb: JSON.stringify([...currentConstraints, "WRONG_AGENCY"]),
          });
        }
        return decision("RESEARCH_AGENCY", { pauseReason: "DENIAL", researchLevel: "medium", reasoning: [...reasoning, "Wrong agency - researching correct one"] });
      }
      case "overly_broad":
        return decision("REFORMULATE_REQUEST", { pauseReason: "DENIAL", reasoning: [...reasoning, "Overly broad - narrowing scope"] });
      case "ongoing_investigation":
      case "privacy_exemption": {
        const strength = await assessDenialStrength(caseId, resolvedSubtype, inlineKeyPoints);
        if (strength === "strong") {
          return decision("CLOSE_CASE", {
            pauseReason: "DENIAL",
            gateOptions: ["APPROVE", "ADJUST", "DISMISS"],
            reasoning: [...reasoning, `Strong ${resolvedSubtype} denial - recommending closure`],
          });
        }
        const canAuto = autopilotMode === "AUTO" && strength === "weak";
        return decision("SEND_REBUTTAL", {
          canAutoExecute: canAuto,
          requiresHuman: !canAuto,
          pauseReason: canAuto ? null : "DENIAL",
          researchLevel: "medium",
          reasoning: [...reasoning, `${resolvedSubtype} denial (${strength}) - drafting rebuttal`],
        });
      }
      case "excessive_fees":
        return decision("NEGOTIATE_FEE", { pauseReason: "FEE_QUOTE", reasoning: [...reasoning, "Excessive fees denial - negotiating"] });
      case "retention_expired":
        return decision("SEND_REBUTTAL", { pauseReason: "DENIAL", researchLevel: "medium", reasoning: [...reasoning, "Retention expired - requesting proof of destruction"] });
      case "glomar_ncnd":
        return decision("SEND_APPEAL", { pauseReason: "DENIAL", researchLevel: "medium", reasoning: [...reasoning, "Glomar/NCND response - filing formal appeal"] });
      case "not_reasonably_described":
        return decision("SEND_CLARIFICATION", {
          pauseReason: "DENIAL",
          researchLevel: "light",
          reasoning: [...reasoning, "Request not reasonably described - providing additional details"],
        });
      case "no_duty_to_create":
        return decision("RESEARCH_AGENCY", { pauseReason: "DENIAL", researchLevel: "medium", reasoning: [...reasoning, "No duty to create - verifying records actually exist"] });
      case "privilege_attorney_work_product":
        return decision("SEND_APPEAL", { pauseReason: "DENIAL", researchLevel: "medium", reasoning: [...reasoning, "Privilege claim - filing formal appeal requesting privilege log"] });
      case "juvenile_records":
        return decision("CLOSE_CASE", {
          pauseReason: "DENIAL",
          gateOptions: ["APPROVE", "ADJUST", "DISMISS"],
          reasoning: [...reasoning, "Juvenile records protection - recommending closure (strong exemption)"],
        });
      case "sealed_court_order":
        return decision("CLOSE_CASE", {
          pauseReason: "DENIAL",
          gateOptions: ["APPROVE", "ADJUST", "DISMISS"],
          reasoning: [...reasoning, "Sealed by court order - recommending closure (strong exemption)"],
        });
      case "third_party_confidential": {
        const canAuto3p = autopilotMode === "AUTO";
        return decision("SEND_REBUTTAL", {
          canAutoExecute: canAuto3p,
          requiresHuman: !canAuto3p,
          pauseReason: canAuto3p ? null : "DENIAL",
          researchLevel: "medium",
          reasoning: [...reasoning, "Third-party confidential - rebutting with redaction offer"],
        });
      }
      case "records_not_yet_created": {
        const canAutoStatus = autopilotMode === "AUTO";
        return decision("SEND_STATUS_UPDATE", {
          canAutoExecute: canAutoStatus,
          requiresHuman: !canAutoStatus,
          pauseReason: canAutoStatus ? null : "DENIAL",
          reasoning: [...reasoning, "Records not yet created - sending status inquiry and scheduling followup"],
        });
      }
      default: {
        const strength = await assessDenialStrength(caseId, resolvedSubtype, inlineKeyPoints);
        if (strength === "strong" && autopilotMode !== "AUTO") {
          return decision("CLOSE_CASE", {
            pauseReason: "DENIAL",
            gateOptions: ["APPROVE", "ADJUST", "DISMISS"],
            reasoning: [...reasoning, "Strong denial - recommending closure"],
          });
        }
        const canAuto = autopilotMode === "AUTO" && strength === "weak";
        return decision("SEND_REBUTTAL", {
          canAutoExecute: canAuto,
          requiresHuman: !canAuto,
          pauseReason: canAuto ? null : "DENIAL",
          researchLevel: "medium",
          reasoning: [...reasoning, `Denial (${strength}) - ${canAuto ? "auto-" : ""}drafting rebuttal`],
        });
      }
    }
  }

  // PARTIAL_APPROVAL
  if (classification === "PARTIAL_APPROVAL") {
    return decision("RESPOND_PARTIAL_APPROVAL", {
      pauseReason: "SCOPE",
      reasoning: ["Partial approval - accept released + challenge withheld"],
    });
  }

  // CLARIFICATION_REQUEST
  if (classification === "CLARIFICATION_REQUEST") {
    const caseData = await db.getCaseById(caseId);
    const latestAnalysis = await db.getLatestResponseAnalysis(caseId);
    if (shouldPrioritizeBodycamCustodianResearch(caseData, latestAnalysis, topConstraints)) {
      return decision("RESEARCH_AGENCY", {
        pauseReason: "DENIAL",
        researchLevel: "deep",
        reasoning: [
          "Clarification response is scoped to 911/form process only.",
          "Case still prioritizes body-cam/video records.",
          "Researching additional custodians for body-cam/video records.",
        ],
      });
    }

    const canAuto = autopilotMode === "AUTO" && sentiment !== "hostile";
    return decision("SEND_CLARIFICATION", {
      canAutoExecute: canAuto,
      requiresHuman: !canAuto,
      pauseReason: canAuto ? null : "SCOPE",
      reasoning: ["Agency requested clarification"],
    });
  }

  // RECORDS_READY
  if (classification === "RECORDS_READY") {
    await db.updateCaseStatus(caseId, "completed", { substatus: "records_received" });
    await db.updateCase(caseId, { outcome_type: "full_approval", outcome_recorded: true });
    return noAction(["Records ready - case completed"]);
  }

  // ACKNOWLEDGMENT
  if (classification === "ACKNOWLEDGMENT") {
    await db.updateCaseStatus(caseId, "awaiting_response");
    return noAction(["Acknowledgment received - status reset to awaiting_response"]);
  }

  // PORTAL_REDIRECT
  if (classification === "PORTAL_REDIRECT") {
    await db.updateCasePortalStatus(caseId, { portal_url: portalUrl });
    await db.updateCaseStatus(caseId, "portal_in_progress", { substatus: "portal_redirect" });
    try {
      const caseData = await db.getCaseById(caseId);
      const effectiveUrl = portalUrl || caseData?.portal_url;
      const task = await createPortalTask({
        caseId,
        portalUrl: effectiveUrl,
        actionType: "SUBMIT_VIA_PORTAL",
        subject: caseData?.request_summary || "FOIA Request",
        bodyText: "Agency requires portal submission.",
        status: "PENDING",
        instructions: `Submit through portal at: ${effectiveUrl || "their website"}`,
      });
      await tasks.trigger("submit-portal", {
        caseId,
        portalUrl: effectiveUrl!,
        provider: caseData?.portal_provider || null,
        instructions: `Submit through portal at: ${effectiveUrl || "their website"}`,
        portalTaskId: task?.id || null,
      }, {
        idempotencyKey: `portal-redirect:${caseId}:${Date.now()}`,
        idempotencyKeyTTL: "1h",
      });
    } catch (e: any) {
      logger.error("Failed to create/trigger portal task", { caseId, error: e.message });
    }
    return noAction(["Portal redirect - task created and triggered"]);
  }

  // WRONG_AGENCY — cancel in-flight work, add constraint, then research
  if (classification === "WRONG_AGENCY") {
    await Promise.all([
      db.query(
        `UPDATE portal_tasks SET status = 'CANCELLED', completed_at = NOW()
         WHERE case_id = $1 AND status IN ('PENDING', 'IN_PROGRESS')`,
        [caseId]
      ),
      db.query(
        `UPDATE proposals SET status = 'DISMISSED', updated_at = NOW()
         WHERE case_id = $1 AND status IN ('PENDING_APPROVAL', 'BLOCKED', 'PENDING_PORTAL')
         AND action_type IN ('SUBMIT_PORTAL', 'SEND_INITIAL_REQUEST', 'SEND_FOLLOWUP')`,
        [caseId]
      ),
    ]);
    const caseData = await db.getCaseById(caseId);
    const currentConstraints = caseData?.constraints_jsonb || caseData?.constraints || [];
    if (!currentConstraints.includes("WRONG_AGENCY")) {
      await db.updateCase(caseId, {
        constraints_jsonb: JSON.stringify([...currentConstraints, "WRONG_AGENCY"]),
      });
    }
    return decision("RESEARCH_AGENCY", {
      pauseReason: "DENIAL",
      researchLevel: "deep",
      reasoning: ["Wrong agency - researching correct custodian"],
    });
  }

  // PARTIAL_DELIVERY
  if (classification === "PARTIAL_DELIVERY") {
    await db.updateCaseStatus(caseId, "awaiting_response");
    return noAction(["Partial delivery - waiting for remainder"]);
  }

  // HOSTILE
  if (classification === "HOSTILE") {
    return decision("ESCALATE", {
      pauseReason: "SENSITIVE",
      reasoning: ["Hostile response - escalating to human review"],
    });
  }

  // NO_RESPONSE / followup triggers
  if (classification === "NO_RESPONSE" || isFollowupTrigger) {
    const followupSchedule = await db.getFollowUpScheduleByCaseId(caseId);
    const followupCount = followupSchedule?.followup_count || 0;
    if (followupCount >= MAX_FOLLOWUPS) {
      return decision("ESCALATE", {
        canAutoExecute: true,
        pauseReason: "CLOSE_ACTION",
        reasoning: [`Max follow-ups reached (${followupCount}/${MAX_FOLLOWUPS})`],
      });
    }
    const canAuto = autopilotMode === "AUTO";
    return decision("SEND_FOLLOWUP", {
      canAutoExecute: canAuto,
      requiresHuman: !canAuto,
      reasoning: [`Preparing follow-up #${followupCount + 1}`],
    });
  }

  // UNKNOWN / hostile sentiment
  if (classification === "UNKNOWN" || sentiment === "hostile") {
    return decision("ESCALATE", {
      pauseReason: "SENSITIVE",
      reasoning: ["Uncertain classification or hostile sentiment"],
    });
  }

  return noAction(["No action required"]);
}

export async function decideNextAction(
  caseId: number,
  classification: Classification,
  constraints: string[],
  extractedFeeAmount: number | null,
  sentiment: string,
  autopilotMode: AutopilotMode,
  triggerType: string,
  requiresResponse: boolean | undefined,
  portalUrl: string | null,
  suggestedAction: string | null,
  reasonNoResponse: string | null,
  denialSubtype: string | null,
  reviewAction?: string | null,
  reviewInstruction?: string | null,
  humanDecision?: HumanDecision | null,
  jurisdictionLevel?: string | null,
  inlineKeyPoints?: string[]
): Promise<DecisionResult> {
  const reasoning: string[] = [];

  try {
    // === requires_response gate ===
    const isFollowupTrigger = ["SCHEDULED_FOLLOWUP", "time_based_followup", "followup_trigger"].includes(triggerType);
    const responseRequiringActions = ["send_rebuttal", "negotiate_fee", "pay_fee", "challenge"];
    const actionOverrides = responseRequiringActions.includes(suggestedAction || "") ||
      (suggestedAction === "respond" && classification === "DENIAL");

    if (requiresResponse === false && !actionOverrides && !(isFollowupTrigger || classification === "NO_RESPONSE" || classification === "DENIAL" || classification === "PARTIAL_APPROVAL" || classification === "FEE_QUOTE" || classification === "WRONG_AGENCY")) {
      reasoning.push(`No response needed: ${reasonNoResponse || "Analysis determined no email required"}`);

      // Check for unanswered clarification on denial
      // (classification guard above excludes DENIAL, but runtime data may differ from type narrowing)
      if ((classification as string) === "DENIAL") {
        const unansweredMsgId = await checkUnansweredClarification(caseId);
        if (unansweredMsgId) {
          return decision("SEND_CLARIFICATION", {
            requiresHuman: true,
            pauseReason: "DENIAL",
            reasoning: [
              `Denial received, but found unanswered clarification request (msg #${unansweredMsgId})`,
              "Agency likely closed due to no response - answering their original question instead",
            ],
            overrideMessageId: unansweredMsgId,
          });
        }
      }

      // Handle suggested actions for no-response cases
      if (suggestedAction === "use_portal") {
        await db.updateCasePortalStatus(caseId, { portal_url: portalUrl });
        await db.updateCaseStatus(caseId, "portal_in_progress", { substatus: "portal_required" });
        try {
          const caseData = await db.getCaseById(caseId);
          const effectiveUrl = portalUrl || caseData?.portal_url;
          const task = await createPortalTask({
            caseId,
            portalUrl: effectiveUrl,
            actionType: "SUBMIT_VIA_PORTAL",
            subject: caseData?.request_summary || "FOIA Request",
            bodyText: "Agency requires portal submission.",
            status: "PENDING",
            instructions: `Submit through agency portal at: ${effectiveUrl || "their website"}`,
          });
          await tasks.trigger("submit-portal", {
            caseId,
            portalUrl: effectiveUrl!,
            provider: caseData?.portal_provider || null,
            instructions: `Submit through agency portal at: ${effectiveUrl || "their website"}`,
            portalTaskId: task?.id || null,
          }, {
            idempotencyKey: `use-portal:${caseId}:${Date.now()}`,
            idempotencyKeyTTL: "1h",
          });
        } catch (e: any) {
          logger.error("Failed to create/trigger portal task", { caseId, error: e.message });
        }
        return noAction([...reasoning, "Portal redirect - task created and triggered"]);
      }
      if (suggestedAction === "download") {
        await db.updateCaseStatus(caseId, "completed", { substatus: "records_received" });
        await db.updateCase(caseId, { outcome_type: "full_approval", outcome_recorded: true });
        return noAction([...reasoning, "Records ready for download"]);
      }
      if (suggestedAction === "wait") {
        return noAction([...reasoning, "Acknowledgment received, waiting"]);
      }
      if (suggestedAction === "find_correct_agency") {
        // Cancel in-flight portal work + add WRONG_AGENCY constraint
        await Promise.all([
          db.query(
            `UPDATE portal_tasks SET status = 'CANCELLED', completed_at = NOW()
             WHERE case_id = $1 AND status IN ('PENDING', 'IN_PROGRESS')`,
            [caseId]
          ),
          db.query(
            `UPDATE proposals SET status = 'DISMISSED', updated_at = NOW()
             WHERE case_id = $1 AND status IN ('PENDING_APPROVAL', 'BLOCKED', 'PENDING_PORTAL')
             AND action_type IN ('SUBMIT_PORTAL', 'SEND_INITIAL_REQUEST', 'SEND_FOLLOWUP')`,
            [caseId]
          ),
        ]);
        const wrongAgencyCaseData = await db.getCaseById(caseId);
        const waConstraints = wrongAgencyCaseData?.constraints_jsonb || wrongAgencyCaseData?.constraints || [];
        if (!waConstraints.includes("WRONG_AGENCY")) {
          await db.updateCase(caseId, {
            constraints_jsonb: JSON.stringify([...waConstraints, "WRONG_AGENCY"]),
          });
        }
        return decision("RESEARCH_AGENCY", {
          pauseReason: "DENIAL",
          researchLevel: "deep",
          reasoning: [...reasoning, "Wrong agency - researching correct custodian"],
        });
      }
      return noAction([...reasoning, "No email response needed"]);
    }

    // === HUMAN_REVIEW_RESOLUTION ===
    if (triggerType === "HUMAN_REVIEW_RESOLUTION" && reviewAction) {
      reasoning.push(`Human review resolution: action=${reviewAction}`);
      const ri = reviewInstruction || null;
      const reviewActionRaw = String(reviewAction);

      // Block send_via_email if case is flagged as wrong agency
      const caseDataForReview = await db.getCaseById(caseId);
      const caseConstraints = caseDataForReview?.constraints_jsonb || caseDataForReview?.constraints || [];
      const isWrongAgency = caseConstraints.includes("WRONG_AGENCY") || classification === "WRONG_AGENCY";

      // Monitor/API decision approvals often arrive as reviewAction=APPROVE with the
      // selected proposal already moved to DECISION_RECEIVED. Resume that proposal action.
      if (reviewActionRaw === "APPROVE") {
        const approvedProposal = await db.query(
          `SELECT id, action_type
           FROM proposals
           WHERE case_id = $1
             AND status = 'DECISION_RECEIVED'
           ORDER BY updated_at DESC
           LIMIT 1`,
          [caseId]
        );
        const approvedAction = approvedProposal.rows[0]?.action_type;
        if (approvedAction) {
          return decision(approvedAction as any, {
            canAutoExecute: true,
            requiresHuman: false,
            reasoning: [...reasoning, `Approved proposal #${approvedProposal.rows[0].id} (${approvedAction})`],
          });
        }
      }

      const reviewMap: Record<string, () => Promise<DecisionResult>> = {
        send_via_email: async () => {
          if (isWrongAgency) {
            return decision("RESEARCH_AGENCY", {
              reasoning: [...reasoning, "Redirected: cannot send to wrong agency — researching correct one"],
              researchLevel: "deep",
            });
          }
          return decision("SEND_INITIAL_REQUEST", {
            adjustmentInstruction: ri || "Send the original FOIA request via email instead of portal",
            reasoning,
          });
        },
        appeal: async () => decision("SEND_REBUTTAL", {
          adjustmentInstruction: ri || "Draft an appeal citing legal grounds",
          reasoning,
        }),
        narrow_scope: async () => decision("SEND_CLARIFICATION", {
          adjustmentInstruction: ri || "Narrow the scope and resubmit",
          reasoning,
        }),
        negotiate_fee: async () => decision("NEGOTIATE_FEE", {
          adjustmentInstruction: ri || "Negotiate the quoted fee amount",
          reasoning,
        }),
        accept_fee: async () => decision("ACCEPT_FEE", {
          adjustmentInstruction: ri,
          reasoning,
        }),
        decline_fee: async () => decision("DECLINE_FEE", {
          adjustmentInstruction: ri || "Decline the quoted fee and explain why",
          reasoning,
        }),
        escalate: async () => decision("ESCALATE", { reasoning }),
        research_agency: async () => decision("RESEARCH_AGENCY", {
          adjustmentInstruction: ri || "Research the correct agency",
          reasoning,
        }),
        reformulate_request: async () => decision("REFORMULATE_REQUEST", {
          adjustmentInstruction: ri || "Reformulate with a different approach",
          reasoning,
        }),
        reprocess: async () => {
          // AI Router v2: single AI call with pre-filtered actions
          if (useAIRouter(caseId)) {
            const preComputed = await preComputeDecisionContext(
              caseId, classification, denialSubtype, constraints, inlineKeyPoints
            );
            const portalAvailable = hasAutomatablePortal(
              preComputed.caseData?.portal_url, preComputed.caseData?.portal_provider
            );
            const allowedActions = buildAllowedActions({
              classification, denialSubtype, constraints,
              followupCount: preComputed.followupCount,
              maxFollowups: MAX_FOLLOWUPS,
              hasAutomatablePortal: portalAvailable,
              triggerType: "INITIAL_REQUEST", // Allow full action set for reprocess
              dismissedActionCounts: preComputed.dismissedActionCounts,
            });
            const v2Result = await makeAIDecisionV2({
              caseId, classification, constraints, extractedFeeAmount,
              sentiment, autopilotMode, denialSubtype, jurisdictionLevel,
              inlineKeyPoints, allowedActions, preComputed,
            });
            return { ...v2Result, reasoning: [...reasoning, ...(v2Result.reasoning || [])] };
          }

          // Legacy: triple-path (AI → deterministic → escalate)
          const aiReprocess = await aiDecision({
            caseId,
            classification,
            constraints,
            extractedFeeAmount,
            sentiment,
            autopilotMode,
            denialSubtype,
            jurisdictionLevel: jurisdictionLevel || null,
            inlineKeyPoints,
          });

          if (aiReprocess && aiReprocess.actionType !== "ESCALATE") {
            return {
              ...aiReprocess,
              reasoning: [...reasoning, ...(aiReprocess.reasoning || [])],
            };
          }

          const deterministicReprocess = await deterministicRouting(
            caseId,
            classification,
            extractedFeeAmount,
            sentiment,
            autopilotMode,
            triggerType,
            requiresResponse,
            portalUrl,
            denialSubtype,
            inlineKeyPoints
          );
          if (deterministicReprocess.actionType !== "ESCALATE") {
            return {
              ...deterministicReprocess,
              reasoning: [...reasoning, ...(deterministicReprocess.reasoning || [])],
            };
          }

          const [latestInbound, lastPortalTask, recentDismissed] = await Promise.all([
            db.query(
              `SELECT subject, body_text
               FROM messages
               WHERE case_id = $1 AND direction = 'inbound'
               ORDER BY created_at DESC
               LIMIT 1`,
              [caseId]
            ),
            db.query(
              `SELECT status, completion_notes
               FROM portal_tasks
               WHERE case_id = $1
               ORDER BY updated_at DESC
               LIMIT 1`,
              [caseId]
            ),
            db.query(
              `SELECT action_type
               FROM proposals
               WHERE case_id = $1 AND status = 'DISMISSED'
               ORDER BY created_at DESC
               LIMIT 3`,
              [caseId]
            ),
          ]);

          const inboundSubject = latestInbound.rows[0]?.subject || null;
          const inboundPreview = (latestInbound.rows[0]?.body_text || "").replace(/\s+/g, " ").trim();
          const portalStatus = lastPortalTask.rows[0]?.status || null;
          const portalNote = lastPortalTask.rows[0]?.completion_notes || null;
          const dismissedActions = recentDismissed.rows
            .map((r: { action_type: string | null }) => r.action_type)
            .filter(Boolean) as string[];

          return decision("ESCALATE", {
            pauseReason: "SENSITIVE",
            reasoning: [
              ...reasoning,
              `Reprocess could not find a safe executable action for classification=${classification}.`,
              caseDataForReview?.status ? `Case status: ${caseDataForReview.status}` : "Case status unavailable.",
              caseDataForReview?.substatus ? `Case substatus: ${caseDataForReview.substatus}` : "Case substatus unavailable.",
              inboundSubject
                ? `Latest inbound subject: ${inboundSubject}`
                : inboundPreview
                ? `Latest inbound preview: ${inboundPreview.substring(0, 220)}`
                : "No inbound message context found on this case.",
              portalStatus ? `Last portal task status: ${portalStatus}` : "No portal task history found.",
              portalNote ? `Last portal note: ${portalNote}` : "No portal task note available.",
              dismissedActions.length > 0
                ? `Recently dismissed actions: ${dismissedActions.join(", ")}`
                : "No recently dismissed actions recorded.",
              "Provide explicit guidance (e.g., send_via_email, research_agency, appeal, narrow_scope).",
            ],
          });
        },
        custom: async () => {
          if (!ri) return noAction([...reasoning, "Custom action with no instruction"]);

          // AI Router v2: let AI interpret the custom instruction
          if (useAIRouter(caseId)) {
            const preComputed = await preComputeDecisionContext(
              caseId, classification, denialSubtype, constraints, inlineKeyPoints
            );
            const portalAvailable = hasAutomatablePortal(
              preComputed.caseData?.portal_url, preComputed.caseData?.portal_provider
            );
            const allowedActions = buildAllowedActions({
              classification, denialSubtype, constraints,
              followupCount: preComputed.followupCount,
              maxFollowups: MAX_FOLLOWUPS,
              hasAutomatablePortal: portalAvailable,
              triggerType: "INITIAL_REQUEST", // Allow full action set for custom instruction
              dismissedActionCounts: preComputed.dismissedActionCounts,
            });
            const v2Result = await makeAIDecisionV2({
              caseId, classification, constraints, extractedFeeAmount,
              sentiment, autopilotMode, denialSubtype, jurisdictionLevel,
              inlineKeyPoints, allowedActions, preComputed,
              customInstruction: ri,
            });
            return { ...v2Result, reasoning: [...reasoning, ...(v2Result.reasoning || [])] };
          }

          // Legacy: regex-based custom routing
          const text = ri.toLowerCase();
          if (/\bresearch\b|\bfind\b.*\bagency\b|\bwrong agency\b|\bcustodian\b/.test(text)) {
            return decision("RESEARCH_AGENCY", { adjustmentInstruction: ri, reasoning });
          }
          if (/\bappeal\b|\brebuttal\b|\bchallenge\b|\bdenial\b/.test(text)) {
            return decision("SEND_REBUTTAL", { adjustmentInstruction: ri, reasoning });
          }
          if (/\bclarif(y|ication)\b|\bnarrow\b|\bscope\b/.test(text)) {
            return decision("SEND_CLARIFICATION", { adjustmentInstruction: ri, reasoning });
          }
          if (/\bportal\b/.test(text)) {
            return decision("SUBMIT_PORTAL", { adjustmentInstruction: ri, reasoning });
          }
          return decision("SEND_FOLLOWUP", { adjustmentInstruction: ri, reasoning });
        },
        retry_portal: async () => {
          const caseData = await db.getCaseById(caseId);
          if (caseData?.portal_url && hasAutomatablePortal(caseData.portal_url, caseData.portal_provider)) {
            await db.updateCaseStatus(caseId, "portal_in_progress", { substatus: "Portal retry", requires_human: false });
            try {
              const task = await createPortalTask({
                caseId,
                portalUrl: caseData.portal_url,
                actionType: "SUBMIT_VIA_PORTAL",
                subject: caseData?.request_summary || "FOIA Request",
                bodyText: ri || "Retry portal submission",
                status: "PENDING",
                instructions: `Retry portal submission to ${caseData.agency_name || "agency"} at: ${caseData.portal_url}`,
              });
              // Trigger the actual portal submission task
              await tasks.trigger("submit-portal", {
                caseId,
                portalUrl: caseData.portal_url,
                provider: caseData.portal_provider || null,
                instructions: ri || "Retry portal submission",
                portalTaskId: task?.id || null,
              }, {
                idempotencyKey: `retry-portal:${caseId}:${Date.now()}`,
                idempotencyKeyTTL: "1h",
              });
              logger.info("Portal retry triggered", { caseId, portalTaskId: task?.id });
            } catch (e: any) {
              logger.error("Failed to create/trigger portal retry", { caseId, error: e.message });
            }
            return noAction([...reasoning, "Portal retry initiated"]);
          } else {
            logger.info("Skipped retry_portal: provider/url not automatable", {
              caseId,
              portalUrl: caseData?.portal_url || null,
              provider: caseData?.portal_provider || null,
            });

            // Portal cannot be automated; pivot to actionable next step instead of idling.
            if (caseData?.agency_email) {
              return decision("SEND_INITIAL_REQUEST", {
                adjustmentInstruction:
                  ri ||
                  `Portal is non-automatable; send via email to ${caseData.agency_email}`,
                reasoning: [...reasoning, "Portal is non-automatable; switching to email submission"],
              });
            }

            return decision("RESEARCH_AGENCY", {
              adjustmentInstruction:
                ri || "Portal is non-automatable and no agency email is available; research the right contact",
              reasoning: [...reasoning, "Portal is non-automatable and no email is on file"],
              researchLevel: "deep",
            });
          }
        },
        call_agency: async () => {
          try {
            // @ts-ignore
            const followupScheduler = require("../../services/followup-scheduler");
            await followupScheduler.escalateToPhoneQueue(caseId, ri ? "details_needed" : "complex_inquiry", {
              notes: ri || "Human reviewer requested phone call",
            });
          } catch (e: any) {
            logger.error("Failed to escalate to phone queue", { caseId, error: e.message });
          }
          return noAction([...reasoning, "Escalated to phone queue"]);
        },
      };

      const handler = reviewMap[reviewAction];
      logger.info("HUMAN_REVIEW_RESOLUTION routing", {
        caseId,
        classification,
        reviewAction,
        isWrongAgency,
        chosenHandler: handler ? reviewAction : "fallback_escalate_unknown_review_action",
      });
      if (handler) return handler();
      return decision("ESCALATE", { reasoning: [...reasoning, `Unknown review action: ${reviewAction}`] });
    }

    // === Human resume ===
    if (humanDecision) {
      let proposalActionType: ActionType | null = null;
      const pendingProposal = await db.getLatestPendingProposal(caseId);
      proposalActionType = pendingProposal?.action_type || null;

      switch (humanDecision.action) {
        case "APPROVE":
          return decision(proposalActionType || "NONE", {
            canAutoExecute: true,
            requiresHuman: false,
            reasoning: ["Human approved the proposal"],
          });
        case "ADJUST":
          return decision(proposalActionType || "SEND_FOLLOWUP", {
            adjustmentInstruction: humanDecision.instruction || null,
            reasoning: [`Human requested adjustment: ${humanDecision.instruction}`],
          });
        case "DISMISS":
          return noAction(["Human dismissed proposal"]);
        case "WITHDRAW":
          await db.updateCaseStatus(caseId, "cancelled", { substatus: "withdrawn_by_user" });
          await db.updateCase(caseId, { outcome_type: "withdrawn", outcome_recorded: true });
          return noAction(["Request withdrawn by user"]);
        default:
          return decision("ESCALATE", {
            pauseReason: "SENSITIVE",
            reasoning: [`Unknown human decision: ${humanDecision.action}`],
          });
      }
    }

    // === AI Router v2 vs Legacy routing ===
    if (useAIRouter(caseId)) {
      logger.info("AI Router v2 active", { caseId, classification });

      const preComputed = await preComputeDecisionContext(
        caseId, classification, denialSubtype, constraints, inlineKeyPoints
      );

      const portalAvailable = hasAutomatablePortal(
        preComputed.caseData?.portal_url, preComputed.caseData?.portal_provider
      );

      const allowedActions = buildAllowedActions({
        classification,
        denialSubtype,
        constraints,
        followupCount: preComputed.followupCount,
        maxFollowups: MAX_FOLLOWUPS,
        hasAutomatablePortal: portalAvailable,
        triggerType,
        dismissedActionCounts: preComputed.dismissedActionCounts,
      });

      // Special handling for classifications with side effects that happen at decision time
      // RECORDS_READY and ACKNOWLEDGMENT status updates
      if (classification === "RECORDS_READY") {
        await db.updateCaseStatus(caseId, "completed", { substatus: "records_received" });
        await db.updateCase(caseId, { outcome_type: "full_approval", outcome_recorded: true });
      }
      if (classification === "ACKNOWLEDGMENT") {
        await db.updateCaseStatus(caseId, "awaiting_response");
      }
      if (classification === "PARTIAL_DELIVERY") {
        await db.updateCaseStatus(caseId, "awaiting_response");
      }

      // PORTAL_REDIRECT: create portal task (this side effect must stay at decision time)
      if (classification === "PORTAL_REDIRECT") {
        await db.updateCasePortalStatus(caseId, { portal_url: portalUrl });
        await db.updateCaseStatus(caseId, "portal_in_progress", { substatus: "portal_redirect" });
        const effectiveUrl = portalUrl || preComputed.caseData?.portal_url;
        if (!effectiveUrl) {
          logger.warn("PORTAL_REDIRECT: no effective portal URL, skipping portal task (v2)", { caseId });
          return noAction(["Portal redirect but no portal URL available (v2)"]);
        }
        try {
          const task = await createPortalTask({
            caseId,
            portalUrl: effectiveUrl,
            actionType: "SUBMIT_VIA_PORTAL",
            subject: preComputed.caseData?.request_summary || "FOIA Request",
            bodyText: "Agency requires portal submission.",
            status: "PENDING",
            instructions: `Submit through portal at: ${effectiveUrl || "their website"}`,
          });
          await tasks.trigger("submit-portal", {
            caseId,
            portalUrl: effectiveUrl!,
            provider: preComputed.caseData?.portal_provider || null,
            instructions: `Submit through portal at: ${effectiveUrl || "their website"}`,
            portalTaskId: task?.id || null,
          }, {
            idempotencyKey: `portal-redirect:${caseId}:${Date.now()}`,
            idempotencyKeyTTL: "1h",
          });
        } catch (e: any) {
          logger.error("Failed to create/trigger portal task (v2)", { caseId, error: e.message });
        }
        return noAction(["Portal redirect - task created and triggered (v2)"]);
      }

      // Citizenship/residency restriction: mark as ID State
      const CITIZEN_CONSTRAINTS = ["AL_CITIZENSHIP_REQUIRED", "CITIZENSHIP_REQUIRED", "RESIDENCY_REQUIRED"];
      if (constraints.some(c => CITIZEN_CONSTRAINTS.includes(c))) {
        await db.updateCaseStatus(caseId, "id_state", {
          substatus: "Citizenship/residency restriction — requires in-state identity",
          requires_human: true,
        });
        return noAction(["Citizenship/residency restriction — marked as ID State for human handling (v2)"]);
      }

      const v2Result = await makeAIDecisionV2({
        caseId,
        classification,
        constraints,
        extractedFeeAmount,
        sentiment,
        autopilotMode,
        denialSubtype,
        jurisdictionLevel,
        inlineKeyPoints,
        allowedActions,
        preComputed,
      });

      logger.info("AI Router v2 decision", {
        caseId, classification,
        action: v2Result.actionType,
        requiresHuman: v2Result.requiresHuman,
      });

      return v2Result;
    }

    // === Legacy path: AI attempt → validateDecision → deterministic fallback ===
    const aiResult = await aiDecision({
      caseId,
      classification,
      constraints,
      extractedFeeAmount,
      sentiment,
      autopilotMode,
      denialSubtype,
      jurisdictionLevel: jurisdictionLevel || null,
      inlineKeyPoints,
    });

    if (aiResult) {
      logger.info("AI decision selected action", {
        caseId,
        classification,
        aiRecommendedAction: aiResult.actionType,
      });
      return aiResult;
    }

    const deterministicResult = await deterministicRouting(
      caseId,
      classification,
      extractedFeeAmount,
      sentiment,
      autopilotMode,
      triggerType,
      requiresResponse,
      portalUrl,
      denialSubtype,
      inlineKeyPoints
    );
    logger.info("Deterministic routing selected action", {
      caseId,
      classification,
      routedAction: deterministicResult.actionType,
    });
    return deterministicResult;
  } catch (error: any) {
    logger.error("decide_next_action step error", { caseId, error: error.message });
    return decision("ESCALATE", {
      pauseReason: "SENSITIVE",
      reasoning: [`Decision error: ${error.message}`, "Escalating to human review"],
    });
  }
}
