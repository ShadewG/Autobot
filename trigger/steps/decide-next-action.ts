/**
 * Decide Next Action Step
 *
 * AI-first routing with strict policy validation.
 * Falls back to deterministic routing when AI fails or is rejected.
 */

import { generateObject } from "ai";
import { decisionModel, decisionOptions, telemetry } from "../lib/ai";
import { decisionSchema, type DecisionOutput } from "../lib/schemas";
import db, { logger, caseRuntime, decisionMemory, successfulExamples } from "../lib/db";
// @ts-ignore
import { createPortalTask } from "../../services/executor-adapter";
import { hasAutomatablePortal } from "../lib/portal-utils";
import type {
  DecisionResult,
  Classification,
  AutopilotMode,
  ActionType,
  HumanDecision,
} from "../lib/types";
// @ts-ignore
const { detectCaseMetadataAgencyMismatch } = require("../../utils/request-normalization");
// Inline model metadata extraction — avoids CJS require() bundling issues in Trigger.dev
function extractModelMetadata(response: any, usage: any, startedAt: number) {
  return {
    modelId: response?.modelId || response?.model || null,
    promptTokens: usage?.promptTokens ?? usage?.inputTokens ?? usage?.prompt_tokens ?? usage?.input_tokens ?? null,
    completionTokens: usage?.completionTokens ?? usage?.outputTokens ?? usage?.completion_tokens ?? usage?.output_tokens ?? null,
    latencyMs: startedAt ? Math.max(0, Date.now() - startedAt) : null,
  };
}

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
  "CLOSE_CASE", "ESCALATE", "SEND_REBUTTAL", "SEND_APPEAL", "SEND_FEE_WAIVER_REQUEST", "WITHDRAW",
];

// Valid action chain pairs: primary → allowed follow-ups
const VALID_CHAINS: Record<string, ActionType[]> = {
  DECLINE_FEE: ["REFORMULATE_REQUEST", "SEND_INITIAL_REQUEST"],
  RESPOND_PARTIAL_APPROVAL: ["SEND_FOLLOWUP", "RESEARCH_AGENCY"],
  SEND_REBUTTAL: ["RESEARCH_AGENCY"],
  SEND_FOLLOWUP: ["RESEARCH_AGENCY"],
  SEND_CLARIFICATION: ["RESEARCH_AGENCY"],
  REFORMULATE_REQUEST: ["RESEARCH_AGENCY"],
};

function validateFollowUpAction(
  primaryAction: ActionType,
  followUpAction: ActionType | null | undefined
): ActionType | undefined {
  if (!followUpAction || followUpAction === "NONE") return undefined;
  const allowed = VALID_CHAINS[primaryAction];
  if (!allowed || !allowed.includes(followUpAction)) return undefined;
  return followUpAction;
}

function useAIRouter(caseId: number): boolean {
  if (!Number.isFinite(caseId) || caseId <= 0) return false;
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

function normalizeEmail(value: any): string | null {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw || !raw.includes("@")) return null;
  return raw;
}

function looksLikeContractorCustodyDenial(inlineKeyPoints?: string[]): boolean {
  const text = (inlineKeyPoints || []).join(" ").toLowerCase();
  if (!text) return false;
  return /not (an?|federal) agency records|not .*subject to foia|custody and control of the contractor|held by the contractor|private contractor|proprietary work product/.test(text);
}

function emailDomain(value: string | null): string | null {
  if (!value) return null;
  const idx = value.lastIndexOf("@");
  if (idx === -1 || idx === value.length - 1) return null;
  return value.slice(idx + 1);
}

async function latestInboundRequestsEmailResend(caseId: number): Promise<boolean> {
  try {
    const latestInbound = await db.getLatestInboundMessage(caseId);
    const latestBody = String(latestInbound?.body_text || "");
    const latestSubject = String(latestInbound?.subject || "");
    const combined = `${latestSubject}\n${latestBody}`.toLowerCase();
    if (!combined.trim()) return false;
    const hasSendVerb = /\b(send|resend|re-send|submit|resubmit)\b/.test(combined);
    const hasEmailToken = /\b(email|e-mail|mailbox|address)\b/.test(combined);
    return hasSendVerb && hasEmailToken;
  } catch {
    return false;
  }
}

async function getStatusUpdateSubmissionEvidence(caseId: number, caseData?: any): Promise<{
  hasEvidence: boolean;
  reasons: string[];
  outboundCount: number;
  completedPortalCount: number;
}> {
  const resolvedCaseData = caseData || await db.getCaseById(caseId);
  const reasons: string[] = [];

  const hasSendDate = Boolean(resolvedCaseData?.send_date);
  if (hasSendDate) {
    reasons.push("Case has a recorded send date");
  }

  const outboundResult = await db.query(
    `SELECT COUNT(*)::int AS outbound_count
     FROM messages
     WHERE case_id = $1
       AND direction = 'outbound'`,
    [caseId]
  );
  const outboundCount = Number(outboundResult.rows?.[0]?.outbound_count || 0);
  if (outboundCount > 0) {
    reasons.push(`Prior outbound correspondence already exists (${outboundCount} message${outboundCount === 1 ? "" : "s"})`);
  }

  const completedPortalResult = await db.query(
    `SELECT COUNT(*)::int AS completed_count
     FROM portal_submissions
     WHERE case_id = $1
       AND status = 'completed'`,
    [caseId]
  );
  const completedPortalCount = Number(completedPortalResult.rows?.[0]?.completed_count || 0);

  const hasCompletedPortal = completedPortalCount > 0;
  if (hasCompletedPortal) {
    reasons.push("Case has a completed portal submission");
  }

  return {
    hasEvidence: hasSendDate || outboundCount > 0 || hasCompletedPortal,
    reasons,
    outboundCount,
    completedPortalCount,
  };
}

function clarificationLooksLikeRequestFormWorkflow(latestInbound: any, latestAnalysis: any): boolean {
  const corpus = [
    latestInbound?.subject || "",
    latestInbound?.body_text || "",
    latestInbound?.body_html || "",
    ...(Array.isArray(latestAnalysis?.key_points) ? latestAnalysis.key_points : []),
    latestAnalysis?.unanswered_question || "",
    latestAnalysis?.full_analysis_json ? JSON.stringify(latestAnalysis.full_analysis_json) : "",
  ]
    .join("\n")
    .toLowerCase();

  const asksForRequestForm = /request form|apra\/foia request form|public records request form|fill(?:ed)? out (?:the )?(?:attached )?(?:pdf|form)|complete (?:the )?(?:attached )?(?:pdf|form)|attached form|new foia request form/.test(corpus);
  const asksForMailingAddress = /mailing address|physical address|address \(for cd\)|for cd/.test(corpus);

  return asksForRequestForm || asksForMailingAddress;
}

async function getClarificationPdfRoutingDecision(
  caseId: number,
): Promise<DecisionResult | null> {
  const caseData = await db.getCaseById(caseId);
  if (!caseData) return null;

  const latestInbound = await db.getLatestInboundMessage(caseId);
  const latestAnalysis = latestInbound?.id
    ? await db.getResponseAnalysisByMessageId(latestInbound.id)
    : await db.getLatestResponseAnalysis(caseId);

  if (!clarificationLooksLikeRequestFormWorkflow(latestInbound, latestAnalysis)) {
    return null;
  }

  // @ts-ignore
  const pdfFormService = require("../../services/pdf-form-service");
  const sourceAttachment = await pdfFormService.findLatestRequestFormAttachment(caseId);
  if (!sourceAttachment) {
    return null;
  }

  const pdfReply = await pdfFormService.prepareInboundPdfFormReply(caseData);
  if (pdfReply?.success && caseData.agency_email) {
    return decision("SEND_PDF_EMAIL", {
      canAutoExecute: false,
      requiresHuman: true,
      pauseReason: "SCOPE",
      reasoning: [
        "Agency requested a completed records request form and/or mailing address.",
        `Prepared a filled PDF reply package from ${pdfReply.sourceFilename || sourceAttachment.filename || "the attached request form"}.`,
        "Proposing a PDF email response with the completed form attached.",
      ],
    });
  }

  if (pdfReply?.success && !caseData.agency_email) {
    return decision("ESCALATE", {
      pauseReason: "SCOPE",
      reasoning: [
        "Agency requested a completed records request form and/or mailing address.",
        `The attached PDF form was prepared from ${pdfReply.sourceFilename || sourceAttachment.filename || "the inbound attachment"}, but no agency email is on file.`,
        "Human should review the filled PDF and send it manually once the correct delivery channel is confirmed.",
      ],
    });
  }

  if (pdfReply?.manualRequired) {
    return decision("ESCALATE", {
      pauseReason: "SCOPE",
      reasoning: [
        "Agency requested a completed records request form and/or mailing address.",
        `Automatic PDF form preparation failed: ${pdfReply.error || "unknown error"}.`,
        `Human should complete ${pdfReply.sourceFilename || sourceAttachment.filename || "the attached PDF form"} manually and send it with the response.`,
      ],
    });
  }

  return null;
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
  canDirectWrongAgencySend?: boolean;
  researchAttemptCount?: number;
  hasValidResearchResults?: boolean;
}): ActionType[] {
  const {
    classification, denialSubtype, constraints, followupCount,
    maxFollowups, hasAutomatablePortal: hasPortal, triggerType, dismissedActionCounts,
  } = params;

  // Cap RESEARCH_AGENCY after 2 attempts to prevent infinite loop,
  // or after 1 attempt if valid research results already exist (operator dismissed means "stop researching")
  const researchAttempts = params.researchAttemptCount || 0;
  const researchDismissals = dismissedActionCounts["RESEARCH_AGENCY"] || 0;
  const researchCapped = researchAttempts >= 2
    || (params.hasValidResearchResults && researchDismissals >= 1);
  const maybeFilterResearch = (actions: ActionType[]): ActionType[] =>
    researchCapped ? actions.filter(a => a !== "RESEARCH_AGENCY") : actions;

  // Hard constraints — AI cannot override these
  if (classification === "HOSTILE" || classification === "UNKNOWN") return ["ESCALATE"];
  if (classification === "WRONG_AGENCY") {
    if (params.canDirectWrongAgencySend) {
      return maybeFilterResearch(hasPortal
        ? ["SUBMIT_PORTAL", "SEND_INITIAL_REQUEST", "RESEARCH_AGENCY", "ESCALATE"]
        : ["SEND_INITIAL_REQUEST", "RESEARCH_AGENCY", "ESCALATE"]);
    }
    const actions = maybeFilterResearch(["RESEARCH_AGENCY", "ESCALATE"]);
    return actions.length > 0 ? actions : ["ESCALATE"];
  }
  if (classification === "PARTIAL_APPROVAL") return maybeFilterResearch(["RESPOND_PARTIAL_APPROVAL", "RESEARCH_AGENCY", "ESCALATE"]);
  if (classification === "RECORDS_READY") return ["NONE", "CLOSE_CASE"];
  if (classification === "ACKNOWLEDGMENT") return ["NONE"];
  if (classification === "PARTIAL_DELIVERY") return maybeFilterResearch(["NONE", "SEND_FOLLOWUP", "RESEARCH_AGENCY"]);
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

  // Also apply research cap to the broad action set
  if (researchCapped) {
    removeAction(base, "RESEARCH_AGENCY");
  }

  // Classification-specific narrowing
  if (classification === "FEE_QUOTE") {
    // Fee quotes should use fee actions primarily
    // Include REFORMULATE_REQUEST and SEND_INITIAL_REQUEST as valid chain follow-ups for DECLINE_FEE
    return base.filter(a =>
      ["ACCEPT_FEE", "NEGOTIATE_FEE", "DECLINE_FEE", "SEND_FEE_WAIVER_REQUEST",
       "SEND_REBUTTAL", "ESCALATE", "NONE", "REFORMULATE_REQUEST", "SEND_INITIAL_REQUEST"].includes(a)
    );
  }

  if (classification === "PORTAL_REDIRECT") {
    return base.filter(a =>
      ["SUBMIT_PORTAL", "NONE", "ESCALATE", "RESEARCH_AGENCY"].includes(a)
    );
  }

  return base;
}

function hasVerifiedCustodianChannel(caseData: any): boolean {
  if (!caseData) return false;
  if (caseData.agency_email || caseData.portal_url || caseData.agency_id) {
    return true;
  }

  if (!caseData.contact_research_notes) {
    return false;
  }

  try {
    const notes = typeof caseData.contact_research_notes === "string"
      ? JSON.parse(caseData.contact_research_notes)
      : caseData.contact_research_notes;
    return !!(
      notes?.suggested_agency?.email ||
      notes?.suggested_agency?.phone ||
      notes?.email ||
      notes?.phone
    );
  } catch {
    return false;
  }
}

async function getWrongAgencyDirectAction(caseId: number): Promise<ActionType | null> {
  const [caseData, agencies, latestInbound] = await Promise.all([
    db.getCaseById(caseId),
    db.getCaseAgencies(caseId),
    db.getLatestInboundMessage(caseId),
  ]);
  if (!agencies?.length) return null;

  const inboundFrom = normalizeEmail(latestInbound?.from_email);
  const inboundDomain = emailDomain(inboundFrom || "");

  const sourceRank = (sourceRaw: string | null | undefined): number => {
    const source = String(sourceRaw || "").toLowerCase();
    if (source === "wrong_agency_referral") return 4;
    if (source === "research") return 3;
    if (source === "suggested_agency") return 2;
    return 1;
  };

  const candidates = agencies
    .map((agency: any) => {
      const agencyEmail = normalizeEmail(agency.agency_email);
      const agencyPortal = String(agency.portal_url || "").trim() || null;
      const agencyDomain = emailDomain(agencyEmail || "");
      const sameAsInbound =
        !!agencyEmail &&
        !!inboundFrom &&
        (agencyEmail === inboundFrom || (!!agencyDomain && !!inboundDomain && agencyDomain === inboundDomain));

      // Some case_agencies rows don't carry portal_provider. If this agency portal
      // matches the case portal, inherit case-level provider so paper-only portals
      // are correctly treated as non-automatable.
      const provider =
        agency.portal_provider ||
        ((caseData?.portal_url || "").trim() === (agencyPortal || "").trim() ? caseData?.portal_provider : null);
      const lastPortalStatus =
        (caseData?.portal_url || "").trim() === (agencyPortal || "").trim()
          ? caseData?.last_portal_status
          : null;

      return {
        agency,
        agencyEmail,
        agencyPortal,
        sameAsInbound,
        hasAutomatablePortal: hasAutomatablePortal(agencyPortal, provider, lastPortalStatus),
        rank: sourceRank(agency.added_source),
      };
    })
    .filter((c: any) => Boolean(c.agencyEmail || c.agencyPortal))
    // Keep strict same-sender guard only for weak/manual legacy rows.
    // Trusted reroute sources (wrong_agency_referral/research) can legitimately
    // point back to the same domain/mailbox and should not be discarded.
    .filter((c: any) => (c.rank >= 3 ? true : !c.sameAsInbound))
    .sort((a: any, b: any) => {
      if (b.rank !== a.rank) return b.rank - a.rank;
      const aCreated = new Date(a.agency.created_at || 0).getTime();
      const bCreated = new Date(b.agency.created_at || 0).getTime();
      if (bCreated !== aCreated) return bCreated - aCreated;
      return Number(b.agency.id || 0) - Number(a.agency.id || 0);
    });

  if (!candidates.length) return null;

  const best = candidates[0];
  if (best.hasAutomatablePortal) return "SUBMIT_PORTAL";
  if (best.agencyEmail) return "SEND_INITIAL_REQUEST";
  return null;
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
  canDirectWrongAgencySend: boolean;
  researchAttemptCount: number;
  hasValidResearchResults: boolean;
  agencyIntelligence: {
    total_cases: number;
    completed: number;
    denied: number;
    denial_rate: number;
    avg_response_days: number | null;
    fee_cases: number;
    top_denial_reasons: string[];
  } | null;
}

export async function getDecisionLessons(
  caseId: number,
  caseData: any,
  threadMessages: any[],
  priorProposals: any[],
): Promise<{ lessonsContext: string; lessonsApplied: any[] }> {
  try {
    const lessons = await decisionMemory.getRelevantLessons(caseData, {
      messages: threadMessages,
      priorProposals,
      limit: 8,
    });
    if (!Array.isArray(lessons) || lessons.length === 0) {
      return { lessonsContext: "", lessonsApplied: [] };
    }
    return {
      lessonsContext: decisionMemory.formatLessonsForPrompt(lessons),
      lessonsApplied: lessons.map((lesson: any) => ({
        id: lesson.id,
        category: lesson.category,
        trigger: lesson.trigger_pattern,
        lesson: lesson.lesson,
        score: lesson.relevance_score,
        priority: lesson.priority,
        source: lesson.source,
        phase: "decision",
      })),
    };
  } catch (error: any) {
    logger.warn("Failed to fetch decision lessons for routing", {
      caseId,
      error: error.message,
    });
    return { lessonsContext: "", lessonsApplied: [] };
  }
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
    researchAttemptResult,
  ] = await Promise.all([
    db.getCaseById(caseId),
    db.getMessagesByCaseId(caseId),
    db.getLatestResponseAnalysis(caseId),
    db.query(
      `SELECT action_type, reasoning, human_decision, created_at FROM proposals
       WHERE case_id = $1
         AND status = 'DISMISSED'
         AND human_decision IS NOT NULL
         AND COALESCE(human_decision->>'auto_dismiss_reason', '') = ''
         AND COALESCE(human_decision->>'dismissal_type', 'wrong_action') = 'wrong_action'
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
    db.query(
      `SELECT COUNT(*)::int AS cnt FROM proposals
       WHERE case_id = $1
         AND action_type = 'RESEARCH_AGENCY'
         AND status IN ('EXECUTED', 'DISMISSED')`,
      [caseId]
    ).then((r: any) => r.rows?.[0]?.cnt || 0),
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
  const [canDirectWrongAgencySend, agencyIntelligence] = await Promise.all([
    getWrongAgencyDirectAction(caseId).then((r: any) => !!r),
    db.getAgencyIntelligence(caseData?.agency_name, caseData?.agency_id),
  ]);

  // Count dismissed actions
  const dismissedActionCounts: Record<string, number> = {};
  for (const p of dismissedProposalsResult) {
    dismissedActionCounts[p.action_type] = (dismissedActionCounts[p.action_type] || 0) + 1;
  }

  // Check if contact research has already found actionable results
  let hasValidResearchResults = false;
  if (caseData?.contact_research_notes) {
    try {
      const notes = typeof caseData.contact_research_notes === 'string'
        ? JSON.parse(caseData.contact_research_notes)
        : caseData.contact_research_notes;
      hasValidResearchResults = !!(notes?.suggested_agency?.email || notes?.suggested_agency?.phone
        || notes?.email || notes?.phone);
    } catch { /* ignore parse errors */ }
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
    canDirectWrongAgencySend,
    researchAttemptCount: researchAttemptResult,
    hasValidResearchResults,
    agencyIntelligence,
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
  lessonsContext?: string;
  successfulExamplesContext?: string;
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
    if (research.case_context_notes) parts.push(`Case Context (web research):\n${String(research.case_context_notes).substring(0, 1000)}`);
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

  // Rich classifier evidence (from response_analysis.full_analysis_json)
  const la = preComputed.latestAnalysis;
  const faj = la?.full_analysis_json;
  const classifierEvidenceParts: string[] = [];

  // Evidence quotes
  if (faj?.decision_evidence_quotes?.length) {
    classifierEvidenceParts.push(`### Evidence Quotes\n${faj.decision_evidence_quotes.map((q: string) => `> "${q}"`).join("\n")}`);
  }

  // Exemption citations
  if (faj?.detected_exemption_citations?.length) {
    classifierEvidenceParts.push(`### Exemption Citations\nThe agency cited these legal exemptions:\n${faj.detected_exemption_citations.map((c: string) => `- ${c}`).join("\n")}`);
  }

  // Referral contact
  if (faj?.referral_contact && (faj.referral_contact.agency_name || faj.referral_contact.email || faj.referral_contact.url)) {
    const rc = faj.referral_contact;
    const rcParts: string[] = [];
    if (rc.agency_name) rcParts.push(`- Referred agency: ${rc.agency_name}`);
    if (rc.email) rcParts.push(`- Email: ${rc.email}`);
    if (rc.phone) rcParts.push(`- Phone: ${rc.phone}`);
    if (rc.url) rcParts.push(`- URL: ${rc.url}`);
    if (rc.notes) rcParts.push(`- Notes: ${rc.notes}`);
    classifierEvidenceParts.push(`### Referral Contact\nThe agency referenced another entity:\n${rcParts.join("\n")}`);
  }

  // Fee breakdown
  if (faj?.fee_breakdown && (faj.fee_breakdown.hourly_rate || faj.fee_breakdown.estimated_hours || faj.fee_breakdown.deposit_required || faj.fee_breakdown.items?.length)) {
    const fb = faj.fee_breakdown;
    const fbParts: string[] = [];
    if (fb.hourly_rate != null) fbParts.push(`- Hourly rate: $${fb.hourly_rate}`);
    if (fb.estimated_hours != null) fbParts.push(`- Estimated hours: ${fb.estimated_hours}`);
    if (fb.deposit_required != null) fbParts.push(`- Deposit required: $${fb.deposit_required}`);
    if (fb.items?.length) fbParts.push(`- Items: ${fb.items.join(", ")}`);
    classifierEvidenceParts.push(`### Fee Breakdown\n${fbParts.join("\n")}`);
  }

  // Response nature
  if (faj?.response_nature) {
    classifierEvidenceParts.push(`### Response Nature: ${faj.response_nature}`);
  }

  // Scope updates from this response
  if (faj?.scope_updates?.length) {
    const suLines = faj.scope_updates.map((su: any) =>
      `- ${su.name}: ${su.status}${su.reason ? ` (${su.reason})` : ""}${su.confidence != null ? ` [conf: ${su.confidence}]` : ""}`
    );
    classifierEvidenceParts.push(`### Scope Updates (from this response)\n${suLines.join("\n")}`);
  }

  const classifierEvidenceSection = classifierEvidenceParts.length
    ? `\n## Classifier Evidence\n${classifierEvidenceParts.join("\n\n")}`
    : "";

  // Pre-computed analysis section
  const preComputedSection = `
## Pre-computed Analysis
- Denial strength: ${preComputed.denialStrength || "N/A"}
- Unanswered agency clarification: ${preComputed.unansweredClarificationMsgId ? `msg #${preComputed.unansweredClarificationMsgId}` : "none"}
- Bodycam custodian research needed: ${preComputed.bodycamResearchNeeded ? "yes" : "no"}
- Follow-up count: ${preComputed.followupCount}/${MAX_FOLLOWUPS}
- Portal automatable: ${caseData?.portal_url ? "yes" : "no"}`;

  // Agency track record
  let agencyTrackRecord = "";
  if (preComputed.agencyIntelligence) {
    const ai = preComputed.agencyIntelligence;
    const parts = [`- Prior cases with this agency: ${ai.total_cases}`];
    if (ai.avg_response_days != null) parts.push(`- Average response time: ${ai.avg_response_days} days`);
    parts.push(`- Denial rate: ${ai.denial_rate}%`);
    if (ai.fee_cases > 0) parts.push(`- Cases involving fees: ${ai.fee_cases}`);
    if (ai.top_denial_reasons.length > 0) parts.push(`- Common denial reasons: ${ai.top_denial_reasons.join(", ")}`);
    agencyTrackRecord = `\n## Agency Track Record\n${parts.join("\n")}\nUse this history to calibrate your response — e.g., if this agency typically responds within ${ai.avg_response_days || "N/A"} days, don't send a follow-up too early. If denial rate is high, prepare stronger legal arguments.`;
  }

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
    RESPOND_PARTIAL_APPROVAL: "Acknowledge receipt of released records, request exemption citations for withheld records, ask about segregability and appeal rights",
    ACCEPT_FEE: "Accept the quoted fee amount",
    NEGOTIATE_FEE: "Request a written fee estimate, propose a not-to-exceed cap, or ask to be contacted before charges are incurred. Use when fees are mentioned without a specific dollar amount.",
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
${humanDirectivesSection}${customSection}${params.lessonsContext || ""}${params.successfulExamplesContext || ""}
${preComputedSection}${agencyTrackRecord}

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
${latestAnalysisSection}${classifierEvidenceSection}
${decisionHistorySection}

## Constraints
${JSON.stringify(constraints || [], null, 2)}

## Scope Items
${JSON.stringify(scopeItems || [], null, 2)}

## Autopilot Mode: ${autopilotMode}
${feeSection}${portalSection}${researchSection}

## Thread Summary
IMPORTANT: Messages labeled [PORTAL_NOTIFICATION:*] are automated emails from records portals (NextRequest, GovQA, etc.) and reflect ONLY the portal track status. A portal marked "closed" or "completed" does NOT mean the case is resolved — there may be active direct email correspondence with the agency that still needs a response. Base your decision on the classifier result and direct agency correspondence.
${threadSummary || "No thread messages available. IMPORTANT: When thread messages are unavailable, rely on the Classifier Result and Latest Analysis Key Points above to make your decision. Treat the classifier payload as the trigger message. Do NOT choose NONE or ESCALATE solely because thread messages are missing. For FEE_QUOTE, DENIAL, CLARIFICATION_REQUEST, PARTIAL_APPROVAL, PARTIAL_DELIVERY, RECORDS_READY, WRONG_AGENCY, and PORTAL_REDIRECT, choose the action that best matches the classification, denial subtype, and key points even when the thread is unavailable."}

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

### Cross-Classification RESEARCH_AGENCY
- If the agency response explicitly names or references a DIFFERENT agency, department, or custodian that may hold records, consider RESEARCH_AGENCY — either as primary or as followUpAction in a chain
- PARTIAL_APPROVAL mentioning another custodian → RESPOND_PARTIAL_APPROVAL + followUpAction=RESEARCH_AGENCY
- PARTIAL_DELIVERY referencing another agency → SEND_FOLLOWUP + followUpAction=RESEARCH_AGENCY
- DENIAL mentioning a specific other agency by name → SEND_REBUTTAL + followUpAction=RESEARCH_AGENCY (or standalone RESEARCH_AGENCY if rebuttal is not warranted)
- Only propose RESEARCH_AGENCY when the response provides concrete signals (agency name, department reference, contact info, or "try X for those records") — do NOT speculatively research without evidence in the agency's message
- RESEARCH_AGENCY should run automatically when selected unless there is an explicit safety risk

### requiresHuman Rules
- ALWAYS require human for: CLOSE_CASE, ESCALATE, SEND_APPEAL, SEND_FEE_WAIVER_REQUEST, WITHDRAW
- Require human when confidence < 0.7
- Require human in SUPERVISED mode for any email-sending action

### researchLevel Guidance
- "none" = skip research (acks, records ready, simple followups)
- "light" = verify contacts/portal only
- "medium" = contacts + state law research
- "deep" = full custodian chain research

### Action Chains (followUpAction)
When TWO sequential actions are clearly needed, set followUpAction to the second action. Both will be drafted, reviewed, and executed together.
Valid chains:
- DECLINE_FEE → REFORMULATE_REQUEST: Decline expensive fee AND submit a narrower request
- DECLINE_FEE → SEND_INITIAL_REQUEST: Decline fee AND send a fresh request to a different contact
- RESPOND_PARTIAL_APPROVAL → SEND_FOLLOWUP: Accept partial records AND follow up on missing ones
- SEND_REBUTTAL → RESEARCH_AGENCY: Rebut the denial AND research a different agency mentioned in the response
- RESPOND_PARTIAL_APPROVAL → RESEARCH_AGENCY: Accept partial records AND research another agency for the withheld portions
- SEND_FOLLOWUP → RESEARCH_AGENCY: Follow up on remaining records AND research another agency referenced
- SEND_CLARIFICATION → RESEARCH_AGENCY: Clarify with current agency AND research another entity they mentioned
- REFORMULATE_REQUEST → RESEARCH_AGENCY: Narrow the request AND research the correct custodian
Use followUpAction=null (default) when only one action is needed. Do NOT chain if the follow-up depends on the outcome of the first action.

### ESCALATE is a Last Resort
ESCALATE means you are giving up and handing to a human. Only use it when the situation is genuinely ambiguous, dangerous, or you truly cannot determine the right action. If the trigger message contains ANY of these, take the corresponding action instead of escalating:
- Agency denied the request (any reason) → SEND_REBUTTAL or SEND_APPEAL
- Agency asked to narrow scope / provide info → SEND_CLARIFICATION or REFORMULATE_REQUEST
- Agency quoted a fee → NEGOTIATE_FEE, ACCEPT_FEE, or DECLINE_FEE
- Agency referred to a different agency → RESEARCH_AGENCY
- Agency said records are ready → NONE or CLOSE_CASE
Examples:
- Terse denial ("request denied", "no responsive records") → SEND_REBUTTAL, NOT ESCALATE
- "Please narrow your request to 3 years" → SEND_CLARIFICATION or REFORMULATE_REQUEST, NOT ESCALATE
- "Contact State Police for those records" → RESEARCH_AGENCY, NOT ESCALATE
- "Please provide a case number or date range" → SEND_CLARIFICATION, NOT ESCALATE
- "We require identity verification" → SEND_CLARIFICATION, NOT ESCALATE

### SEND_REBUTTAL vs SEND_APPEAL
- SEND_REBUTTAL: for vague, informal, or procedural denials without cited legal authority.
- SEND_APPEAL: for FORMAL adverse determinations citing specific exemptions (FOIA exemptions, state statute exemptions, attorney-client privilege, work-product doctrine, Vaughn index). Appeals have legal deadlines — misclassifying as rebuttal risks missing them.
- Rule: If the denial cites a specific statute, exemption number, privilege, or provides a Vaughn index → SEND_APPEAL. If the denial is vague, informal, or cites only "policy" → SEND_REBUTTAL.

### No Trigger Message = No Action
If there is no trigger message (no new inbound email or event), strongly prefer NONE or CLOSE_CASE. Do NOT fabricate actions without a clear trigger. However, when thread messages are unavailable but the classifier has already analyzed a provided message (simulation/dry-run contexts), use that classifier payload as the trigger instead of defaulting to NONE.

### RESEARCH_AGENCY vs Direct Response
- Vague denials citing "policy" without statutory authority → SEND_REBUTTAL requesting the specific legal basis.
- "No duty to create" responses → RESEARCH_AGENCY to find what records the agency actually maintains.
- "No responsive records" with verified custodian → SEND_REBUTTAL. Without verified custodian → RESEARCH_AGENCY.

### Fee Actions Without Dollar Amounts
When fees are mentioned without a specific dollar amount, use NEGOTIATE_FEE to request a written estimate. Never use ACCEPT_FEE without a specific amount.

### Mixed Messages (fee + denial, partial release + withholding, etc.)
When the agency's message contains multiple elements:
- **Fee + denial**: Address the denial FIRST (SEND_REBUTTAL or SEND_APPEAL). Mention fees in reasoning but don't let them override the denial response.
- **Partial release + withholding**: Use RESPOND_PARTIAL_APPROVAL — acknowledge what was received, challenge what was withheld.
- **Portal notice + human instruction**: Act on the human instruction, not the automated notice.
- **Closure after inactivity**: If the agency closed the request because we didn't respond to their question, use SEND_CLARIFICATION to reopen — not CLOSE_CASE.

Choose exactly one primary action from the ALLOWED ACTIONS list. Optionally set followUpAction if a chain is appropriate. Provide concise reasoning. Set researchLevel appropriately.`;
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

  const { lessonsContext, lessonsApplied } = await getDecisionLessons(
    caseId,
    preComputed.caseData,
    preComputed.threadMessages,
    preComputed.dismissedProposals,
  );
  const decisionExamples = await successfulExamples.getRelevantExamples(preComputed.caseData, {
    classification,
    limit: 2,
  });
  const successfulExamplesContext = decisionExamples.length > 0
    ? successfulExamples.formatExamplesForPrompt(decisionExamples, {
        heading: "Similar approved decisions",
      })
    : "";

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
    lessonsContext,
    successfulExamplesContext,
  });

  // 3-attempt self-repair loop
  let lastError: string | null = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const repairHint = lastError
        ? `\n\nPREVIOUS ATTEMPT FAILED: ${lastError}\nFix the issue and try again. You MUST choose from the ALLOWED ACTIONS list.`
        : "";

      const startedAt = Date.now();
      const { object, usage, response } = await generateObject({
        model: decisionModel,
        schema: decisionSchema,
        prompt: prompt + repairHint,
        providerOptions: decisionOptions,
        experimental_telemetry: telemetry,
      });
      const modelMetadata = extractModelMetadata(response, usage, startedAt);

      // Validate structure
      const validation = validateStructureV2(object, allowedActions, extractedFeeAmount, autopilotMode);
      if (!validation.valid) {
        lastError = validation.reason!;
        logger.warn("AI Router v2 decision failed structure validation", {
          caseId, attempt, reason: validation.reason, action: object.action,
        });
        continue;
      }

      const policyValidation = await validateDecision(object, {
        caseId,
        classification,
        extractedFeeAmount,
        autopilotMode,
        denialSubtype: params.denialSubtype,
        dismissedProposals: preComputed.dismissedProposals,
        constraints,
        inlineKeyPoints: params.inlineKeyPoints,
      });
      if (!policyValidation.valid) {
        lastError = policyValidation.reason || "policy validation failed";
        logger.warn("AI Router v2 decision failed policy validation", {
          caseId, attempt, reason: policyValidation.reason, action: object.action,
        });
        continue;
      }

      // Apply post-decision flags
      const requiresHuman = (object.action as ActionType) === "RESEARCH_AGENCY"
        ? false
        : ALWAYS_GATE_ACTIONS.includes(object.action as ActionType)
        ? true
        : object.confidence < 0.7
          ? true
          : object.requiresHuman;

      const canAutoExecute =
        autopilotMode === "AUTO" &&
        !requiresHuman &&
        !ALWAYS_GATE_ACTIONS.includes(object.action as ActionType);

      // Bodycam custodian research override (capped at 2 attempts to prevent infinite loop)
      if (
        classification === "CLARIFICATION_REQUEST" &&
        object.action !== "RESEARCH_AGENCY" &&
        preComputed.bodycamResearchNeeded &&
        preComputed.researchAttemptCount < 2
      ) {
        return decision("RESEARCH_AGENCY", {
          pauseReason: "DENIAL",
          researchLevel: "deep",
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

      // Validate follow-up action chain
      const validatedFollowUp = validateFollowUpAction(
        object.action as ActionType,
        (object as any).followUpAction as ActionType | null
      );

      logger.info("AI Router v2 decision made", {
        caseId, classification, action: object.action, confidence: object.confidence,
        attempt, requiresHuman: finalRequiresHuman,
        followUpAction: validatedFollowUp || null,
      });

      // Chains always require human review
      const chainRequiresHuman = validatedFollowUp ? true : finalRequiresHuman;

      return decision(object.action as ActionType, {
        canAutoExecute: validatedFollowUp ? false : (autopilotMode === "AUTO" && !finalRequiresHuman && !ALWAYS_GATE_ACTIONS.includes(object.action as ActionType)),
        requiresHuman: chainRequiresHuman,
        pauseReason: chainRequiresHuman ? (object.pauseReason || "SENSITIVE") : null,
        reasoning: validatedFollowUp
          ? [...object.reasoning, `Action chain: ${object.action} → ${validatedFollowUp}`]
          : object.reasoning,
        adjustmentInstruction: object.adjustmentInstruction,
        isComplete: object.action === "NONE",
        researchLevel: (object as any).researchLevel || "none",
        overrideMessageId: (object as any).overrideMessageId || undefined,
        followUpAction: validatedFollowUp,
        modelMetadata,
        lessonsApplied,
      });
    } catch (error: any) {
      lastError = error.message;
      logger.warn("AI Router v2 attempt failed", {
        caseId, attempt, error: error.message,
      });
    }
  }

  // All 3 attempts failed — fall back to deterministic routing before escalating.
  logger.error("AI Router v2 exhausted all attempts; using deterministic fallback", {
    caseId,
    classification,
    lastError,
  });
  const deterministicFallback = await deterministicRouting(
    caseId,
    classification,
    extractedFeeAmount,
    sentiment,
    autopilotMode,
    "INBOUND_MESSAGE",
    true,
    preComputed.caseData?.portal_url || null,
    params.denialSubtype || null,
    params.inlineKeyPoints
  );
  return {
    ...deterministicFallback,
    reasoning: [
      `AI Router v2 failed after 3 attempts: ${lastError}`,
      ...(deterministicFallback.reasoning || []),
    ],
  };
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
  if (
    fee != null &&
    isFinite(fee) &&
    fee >= 0 &&
    autopilotMode === "AUTO" &&
    fee <= FEE_AUTO_APPROVE_MAX &&
    (aiResult.action !== "ACCEPT_FEE" || aiResult.requiresHuman)
  ) {
    return {
      valid: false,
      reason: `Fee $${fee} is within auto-approve max $${FEE_AUTO_APPROVE_MAX}; must auto-accept without human gating`,
    };
  }
  if (
    fee != null &&
    isFinite(fee) &&
    fee > FEE_AUTO_APPROVE_MAX &&
    fee <= FEE_NEGOTIATE_THRESHOLD &&
    aiResult.action !== "ACCEPT_FEE"
  ) {
    return {
      valid: false,
      reason: `Fee $${fee} is within the acceptable review band ($${FEE_AUTO_APPROVE_MAX}-$${FEE_NEGOTIATE_THRESHOLD}); must use ACCEPT_FEE`,
    };
  }
  if (fee != null && isFinite(fee) && fee > FEE_NEGOTIATE_THRESHOLD && aiResult.action !== "NEGOTIATE_FEE" && aiResult.action !== "SEND_FEE_WAIVER_REQUEST" && aiResult.action !== "ESCALATE") {
    return { valid: false, reason: `Fee $${fee} exceeds negotiate threshold $${FEE_NEGOTIATE_THRESHOLD}; must use NEGOTIATE_FEE or SEND_FEE_WAIVER_REQUEST` };
  }
  if (
    fee != null &&
    isFinite(fee) &&
    fee > FEE_AUTO_APPROVE_MAX &&
    aiResult.action === "ACCEPT_FEE" &&
    autopilotMode === "AUTO" &&
    !aiResult.requiresHuman
  ) {
    return {
      valid: false,
      reason: `Fee $${fee} exceeds auto-approve max $${FEE_AUTO_APPROVE_MAX}; cannot auto-accept`,
    };
  }

  // 5. Reasoning must be non-empty
  if (!aiResult.reasoning || aiResult.reasoning.length === 0) {
    return { valid: false, reason: "Reasoning must be non-empty" };
  }

  return { valid: true };
}

async function assessDenialStrength(caseId: number, denialSubtype?: string | null, inlineKeyPoints?: string[]): Promise<"strong" | "medium" | "weak"> {
  const hasRealCase = Number.isFinite(caseId) && caseId > 0;
  const analysis = hasRealCase ? await db.getLatestResponseAnalysis(caseId) : null;
  // Use DB key_points when available; fall back to inline key_points from classification (e.g. mock/simulator context)
  const keyPoints: string[] = analysis?.key_points?.length ? analysis.key_points : (inlineKeyPoints || []);

  // Also check the original message body — key_points may paraphrase and lose indicator phrases
  let messageBody = "";
  if (hasRealCase) {
    const latestMessage = await db.query(
      `SELECT body_text FROM messages WHERE case_id = $1 AND direction = 'inbound' ORDER BY created_at DESC LIMIT 1`,
      [caseId]
    );
    messageBody = latestMessage?.rows?.[0]?.body_text || "";
  }

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
    "confidential", "withheld in full", "no segregable", "mandatory exemption",
    "law enforcement privacy", "unwarranted invasion of personal privacy",
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

export async function checkUnansweredClarification(caseId: number): Promise<number | null> {
  const threadMessages = await db.getMessagesByCaseId(caseId);
  const inboundAnalyses = await db.query(
    `SELECT ra.message_id, ra.intent, m.created_at FROM response_analysis ra
     JOIN messages m ON m.id = ra.message_id
     WHERE ra.case_id = $1 AND m.direction = 'inbound'
     ORDER BY m.created_at DESC, ra.created_at DESC`,
    [caseId]
  );
  const latestInbound = inboundAnalyses.rows?.[0];
  if (!latestInbound) return null;

  const latestIntent = String(latestInbound.intent || "").toLowerCase();
  const latestIsClarification = latestIntent === "question" || latestIntent === "more_info_needed";
  if (!latestIsClarification) return null;

  const outboundAfter = threadMessages.filter((m: any) => {
    const direction = String(m.direction || "").toLowerCase();
    return direction === "outbound" && Number(m.id) > Number(latestInbound.message_id);
  });
  if (outboundAfter.length === 0) return latestInbound.message_id;

  return null;
}

function decision(
  actionType: ActionType,
  overrides: Partial<DecisionResult> = {}
): DecisionResult {
  const isResearchAgency = actionType === "RESEARCH_AGENCY";
  return {
    actionType,
    canAutoExecute: isResearchAgency,
    requiresHuman: !isResearchAgency,
    pauseReason: null,
    reasoning: [],
    adjustmentInstruction: null,
    isComplete: false,
    researchLevel: "none",
    lessonsApplied: [],
    modelMetadata: null,
    ...overrides,
  };
}

function noAction(reasoning: string[]): DecisionResult {
  return decision("NONE", { isComplete: true, requiresHuman: false, reasoning });
}

function portalRedirectFallbackDecision(
  reasoningPrefix: string[],
  portalUrl: string | null | undefined,
  provider: string | null | undefined,
  lastPortalStatus?: string | null
): DecisionResult | null {
  if (hasAutomatablePortal(portalUrl, provider, lastPortalStatus)) {
    return null;
  }
  return decision("RESEARCH_AGENCY", {
    requiresHuman: true,
    canAutoExecute: false,
    pauseReason: "SCOPE",
    researchLevel: "light",
    reasoning: [
      ...reasoningPrefix,
      "Portal submission was requested, but no automatable portal URL is available.",
      "Research the correct portal or alternate delivery channel instead of creating a placeholder portal task.",
    ],
  });
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

function shouldRebutPrivacyDenialForAccountabilityRecords(
  caseData: any,
  inlineKeyPoints: string[] = []
): boolean {
  const requested = Array.isArray(caseData?.requested_records)
    ? caseData.requested_records.join(" ")
    : caseData?.requested_records || "";
  const scopeText = Array.isArray(caseData?.scope_items_jsonb)
    ? caseData.scope_items_jsonb.map((s: any) => s?.name || "").join(" ")
    : Array.isArray(caseData?.scope_items)
      ? caseData.scope_items.map((s: any) => s?.name || "").join(" ")
      : "";
  const detailsText = String(caseData?.additional_details || "");
  const keyPointsText = Array.isArray(inlineKeyPoints) ? inlineKeyPoints.join(" ") : "";
  const corpus = `${requested} ${scopeText} ${detailsText} ${keyPointsText}`.toLowerCase();

  return /body.?cam|body.?worn|bwc|dash.?cam|dispatch audio|911 audio|911 call|radio traffic|cad audio|surveillance (?:video|footage)|cctv|security camera|camera footage|video footage|surveillance camera|interrogation footage/.test(corpus);
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
  lessonsContext?: string;
  successfulExamplesContext?: string;
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
    if (research.case_context_notes) parts.push(`Case Context (web research):\n${String(research.case_context_notes).substring(0, 1000)}`);
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
${humanDirectivesSection}${params.lessonsContext || ""}${params.successfulExamplesContext || ""}
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
${threadSummary || "No thread messages available. IMPORTANT: Treat the classifier payload as the trigger message in simulation/dry-run contexts. Do NOT default to NONE or ESCALATE solely because the thread is unavailable."}

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

### Cross-Classification RESEARCH_AGENCY
- If the agency response explicitly names or references a DIFFERENT agency, department, or custodian that may hold records, consider RESEARCH_AGENCY — either as primary or as followUpAction in a chain
- PARTIAL_APPROVAL mentioning another custodian → RESPOND_PARTIAL_APPROVAL + followUpAction=RESEARCH_AGENCY
- PARTIAL_DELIVERY referencing another agency → SEND_FOLLOWUP + followUpAction=RESEARCH_AGENCY
- DENIAL mentioning a specific other agency by name → SEND_REBUTTAL + followUpAction=RESEARCH_AGENCY (or standalone RESEARCH_AGENCY if rebuttal is not warranted)
- Only propose RESEARCH_AGENCY when the response provides concrete signals (agency name, department reference, contact info, or "try X for those records") — do NOT speculatively research without evidence in the agency's message
- RESEARCH_AGENCY should run automatically when selected unless there is an explicit safety risk

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

### Action Chains (followUpAction)
When TWO sequential actions are clearly needed, set followUpAction to the second action.
Valid chains:
- SEND_REBUTTAL → RESEARCH_AGENCY: Rebut the denial AND research a different agency mentioned in the response
- RESPOND_PARTIAL_APPROVAL → RESEARCH_AGENCY: Accept partial records AND research another agency for the withheld portions
- SEND_FOLLOWUP → RESEARCH_AGENCY: Follow up on remaining records AND research another agency referenced
- SEND_CLARIFICATION → RESEARCH_AGENCY: Clarify with current agency AND research another entity they mentioned
- REFORMULATE_REQUEST → RESEARCH_AGENCY: Narrow the request AND research the correct custodian
Use followUpAction=null (default) when only one action is needed. Do NOT chain if the follow-up depends on the outcome of the first action.

### ESCALATE is a Last Resort
ESCALATE means you are giving up and handing to a human. Only use it when the situation is genuinely ambiguous, dangerous, or you truly cannot determine the right action. If the trigger message contains ANY of these, take the corresponding action instead of escalating:
- Agency denied the request (any reason) → SEND_REBUTTAL or SEND_APPEAL
- Agency asked to narrow scope / provide info → SEND_CLARIFICATION or REFORMULATE_REQUEST
- Agency quoted a fee → NEGOTIATE_FEE, ACCEPT_FEE, or DECLINE_FEE
- Agency referred to a different agency → RESEARCH_AGENCY
- Agency said records are ready → NONE or CLOSE_CASE
Examples:
- Terse denial ("request denied", "no responsive records") → SEND_REBUTTAL, NOT ESCALATE
- "Please narrow your request to 3 years" → SEND_CLARIFICATION or REFORMULATE_REQUEST, NOT ESCALATE
- "Contact State Police for those records" → RESEARCH_AGENCY, NOT ESCALATE
- "Please provide a case number or date range" → SEND_CLARIFICATION, NOT ESCALATE
- "We require identity verification" → SEND_CLARIFICATION, NOT ESCALATE

### SEND_REBUTTAL vs SEND_APPEAL
- SEND_REBUTTAL: for vague, informal, or procedural denials without cited legal authority. The agency said "no" but didn't cite specific statutory exemptions.
- SEND_APPEAL: for FORMAL adverse determinations citing specific exemptions (FOIA exemptions, state statute exemptions, attorney-client privilege, work-product doctrine, Vaughn index, categorical withholding under privilege). Appeals have legal deadlines — misclassifying as rebuttal risks missing them.
- Rule: If the denial cites a specific statute, exemption number, privilege, or provides a Vaughn index → SEND_APPEAL. If the denial is vague, informal, or cites only "policy" → SEND_REBUTTAL.

### No Trigger Message = No Action
If there is no trigger message (no new inbound email or event to respond to), strongly prefer NONE or CLOSE_CASE. Do NOT fabricate actions or send emails without a clear trigger. Stale proposals and synthetic QA items with no trigger should be NONE. However, when thread messages are unavailable but the classifier has already analyzed a provided message (simulation/dry-run contexts), use that classifier payload as the trigger instead of defaulting to NONE.

### RESEARCH_AGENCY vs Direct Response
- For vague denials citing only "policy" without statutory authority → SEND_REBUTTAL requesting the specific legal basis. Do NOT research first.
- For "no duty to create" responses → RESEARCH_AGENCY to find what records the agency actually maintains, THEN reformulate. Do NOT send a rebuttal.
- For "no responsive records" with a verified custodian → SEND_REBUTTAL. For "no responsive records" without a verified custodian → RESEARCH_AGENCY.

### Fee Actions Without Dollar Amounts
When the agency mentions fees but has NOT provided a specific dollar amount or written estimate, use NEGOTIATE_FEE to request a written estimate. Never use ACCEPT_FEE without a specific amount to accept.

Choose exactly one action. Provide concise reasoning. Set researchLevel appropriately.`;
}

export async function validateDecision(
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

  // SEND_INITIAL_REQUEST is generally only valid for process-initial-request.
  // Exception: WRONG_AGENCY reroutes with a verified alternate custodian/contact.
  if (aiDecisionResult.action === "SEND_INITIAL_REQUEST" && classification !== "WRONG_AGENCY") {
    return { valid: false, reason: "SEND_INITIAL_REQUEST is not valid for inbound message routing" };
  }

  if (classification === "HOSTILE" && aiDecisionResult.action !== "ESCALATE") {
    return { valid: false, reason: "HOSTILE classification must escalate" };
  }

  if (classification === "UNKNOWN" && aiDecisionResult.action !== "ESCALATE") {
    return { valid: false, reason: "UNKNOWN classification must escalate" };
  }

  // WRONG_AGENCY: allow direct reroute actions only when we have a verified
  // alternate custodian/channel; otherwise require RESEARCH_AGENCY.
  if (classification === "WRONG_AGENCY") {
    const directAction = await getWrongAgencyDirectAction(caseId);
    const allowed = new Set<ActionType>(["RESEARCH_AGENCY"]);
    if (directAction) allowed.add(directAction);
    if (!allowed.has(aiDecisionResult.action as ActionType)) {
      return {
        valid: false,
        reason: `WRONG_AGENCY must route to ${Array.from(allowed).join(" or ")}`,
      };
    }
  }

  // PORTAL_REDIRECT is handled entirely by deterministic portal-task creation — reject ALL AI decisions
  if (classification === "PORTAL_REDIRECT") {
    return { valid: false, reason: "PORTAL_REDIRECT is handled by deterministic portal-task creation (always falls to deterministic)" };
  }

  // PARTIAL_APPROVAL must use RESPOND_PARTIAL_APPROVAL or RESEARCH_AGENCY — don't let AI override with SEND_REBUTTAL or SEND_APPEAL
  if (classification === "PARTIAL_APPROVAL" && aiDecisionResult.action !== "RESPOND_PARTIAL_APPROVAL" && aiDecisionResult.action !== "RESEARCH_AGENCY") {
    return { valid: false, reason: "PARTIAL_APPROVAL classification must use RESPOND_PARTIAL_APPROVAL or RESEARCH_AGENCY" };
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

  // Vague denials (no subtype) should not route to SEND_CLARIFICATION
  if (classification === "DENIAL" && !context.denialSubtype && aiDecisionResult.action === "SEND_CLARIFICATION") {
    return { valid: false, reason: "DENIAL without a specific subtype should use SEND_REBUTTAL or CLOSE_CASE, not SEND_CLARIFICATION" };
  }

  if (classification !== "DENIAL" && aiDecisionResult.action === "SEND_STATUS_UPDATE") {
    const caseData = await db.getCaseById(caseId);
    const submissionEvidence = await getStatusUpdateSubmissionEvidence(caseId, caseData);
    if (!submissionEvidence.hasEvidence) {
      return {
        valid: false,
        reason: "SEND_STATUS_UPDATE requires real submission evidence (send date, prior outbound, or completed portal submission) — imported request references alone are not sufficient",
      };
    }
  }

  if (ALWAYS_GATE_ACTIONS.includes(aiDecisionResult.action as ActionType) && !aiDecisionResult.requiresHuman) {
    return { valid: false, reason: `${aiDecisionResult.action} must require human review` };
  }

  // Strong ongoing_investigation or sealed_court_order denials should close, not rebuttal.
  // Privacy-exemption denials for body-cam / dispatch accountability records should stay rebuttable.
  if (
    classification === "DENIAL" &&
    (denialSubtype === "ongoing_investigation" || denialSubtype === "sealed_court_order" || denialSubtype === "privacy_exemption") &&
    aiDecisionResult.action === "SEND_REBUTTAL"
  ) {
    const caseData =
      denialSubtype === "privacy_exemption" && Number.isFinite(caseId) && caseId > 0
        ? await db.getCaseById(caseId)
        : null;
    const rebuttablePrivacyDenial =
      denialSubtype === "privacy_exemption" &&
      shouldRebutPrivacyDenialForAccountabilityRecords(caseData, inlineKeyPoints);
    if (rebuttablePrivacyDenial) {
      return { valid: true };
    }
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
    if (
      autopilotMode === "AUTO" &&
      fee <= FEE_AUTO_APPROVE_MAX &&
      (aiDecisionResult.action !== "ACCEPT_FEE" || aiDecisionResult.requiresHuman)
    ) {
      return {
        valid: false,
        reason: `Fee $${fee} is within auto-approve max $${FEE_AUTO_APPROVE_MAX}; must auto-accept without human gating`,
      };
    }
    if (
      fee > FEE_AUTO_APPROVE_MAX &&
      fee <= FEE_NEGOTIATE_THRESHOLD &&
      aiDecisionResult.action !== "ACCEPT_FEE"
    ) {
      return {
        valid: false,
        reason: `Fee $${fee} is within the acceptable review band ($${FEE_AUTO_APPROVE_MAX}-$${FEE_NEGOTIATE_THRESHOLD}); must use ACCEPT_FEE`,
      };
    }
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

  if (
    classification === "DENIAL" &&
    (denialSubtype === "juvenile_records" || denialSubtype === "sealed_court_order") &&
    aiDecisionResult.action !== "CLOSE_CASE"
  ) {
    return {
      valid: false,
      reason: `Strong ${denialSubtype} denial — should CLOSE_CASE`,
    };
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
         WHERE case_id = $1
           AND status = 'DISMISSED'
           AND human_decision IS NOT NULL
           AND COALESCE(human_decision->>'auto_dismiss_reason', '') = ''
           AND COALESCE(human_decision->>'dismissal_type', 'wrong_action') = 'wrong_action'
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

    const { lessonsContext, lessonsApplied } = await getDecisionLessons(
      params.caseId,
      caseData,
      Array.isArray(threadMessages) ? threadMessages : [],
      dismissedProposals,
    );
    const decisionExamples = await successfulExamples.getRelevantExamples(caseData, {
      classification: params.classification,
      limit: 2,
    });
    const successfulExamplesContext = decisionExamples.length > 0
      ? successfulExamples.formatExamplesForPrompt(decisionExamples, {
          heading: "Similar approved decisions",
        })
      : "";

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
      lessonsContext,
      successfulExamplesContext,
    });

    const startedAt = Date.now();
    const { object, usage, response } = await generateObject({
      model: decisionModel,
      schema: decisionSchema,
      prompt,
      providerOptions: decisionOptions,
      experimental_telemetry: telemetry,
    });
    const modelMetadata = extractModelMetadata(response, usage, startedAt);

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
        : object.action === "RESEARCH_AGENCY"
          ? false
        : object.requiresHuman;

    const canAutoExecute =
      params.autopilotMode === "AUTO" &&
      !requiresHuman &&
      object.action !== "ESCALATE";

    // Guardrail: if body-cam is requested but inbound guidance is only 911/form
    // process, force custodian research rather than staying in a 911-only loop.
    // Capped at 2 research attempts to prevent infinite loop.
    const v1ResearchCount = await db.query(
      `SELECT COUNT(*)::int AS cnt FROM proposals
       WHERE case_id = $1 AND action_type = 'RESEARCH_AGENCY' AND status IN ('EXECUTED', 'DISMISSED')`,
      [params.caseId]
    ).then((r: any) => r.rows?.[0]?.cnt || 0);
    if (
      params.classification === "CLARIFICATION_REQUEST" &&
      object.action !== "RESEARCH_AGENCY" &&
      v1ResearchCount < 2 &&
      shouldPrioritizeBodycamCustodianResearch(caseData, latestAnalysis, params.constraints)
    ) {
      return decision("RESEARCH_AGENCY", {
        pauseReason: "DENIAL",
        researchLevel: "deep",
        reasoning: [
          "Body-cam/video is still a top requested record.",
          "Inbound message appears limited to 911/dispatch form workflow.",
          "Researching additional custodians for body-cam/video before continuing 911-only track.",
        ],
      });
    }

    // Validate follow-up action chain (v1 path)
    const validatedFollowUp = validateFollowUpAction(
      object.action as ActionType,
      (object as any).followUpAction as ActionType | null
    );

    const chainRequiresHuman = validatedFollowUp ? true : requiresHuman;

    return decision(object.action, {
      canAutoExecute: validatedFollowUp ? false : canAutoExecute,
      requiresHuman: chainRequiresHuman,
      pauseReason: chainRequiresHuman ? (object.pauseReason || "SENSITIVE") : null,
      reasoning: validatedFollowUp
        ? [...object.reasoning, `Action chain: ${object.action} → ${validatedFollowUp}`]
        : object.reasoning,
      adjustmentInstruction: object.adjustmentInstruction,
      isComplete: object.action === "NONE",
      researchLevel: (object as any).researchLevel || "none",
      followUpAction: validatedFollowUp,
      modelMetadata,
      lessonsApplied,
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
  const hasRealCase = Number.isFinite(caseId) && caseId > 0;
  const reasoning: string[] = [];
  const isFollowupTrigger = ["SCHEDULED_FOLLOWUP", "time_based_followup", "followup_trigger"].includes(triggerType);

  // Citizenship/residency restriction: mark as ID State regardless of classification
  const caseDataForConstraints = hasRealCase ? await db.getCaseById(caseId) : null;
  const topConstraints = caseDataForConstraints?.constraints_jsonb || caseDataForConstraints?.constraints || [];
  const CITIZEN_CONSTRAINTS_TOP = ["AL_CITIZENSHIP_REQUIRED", "CITIZENSHIP_REQUIRED", "RESIDENCY_REQUIRED"];
  if (CITIZEN_CONSTRAINTS_TOP.some((c: string) => topConstraints.includes(c))) {
    if (hasRealCase) {
      await caseRuntime.transitionCaseRuntime(caseId, "CASE_ID_STATE", {
        substatus: "Citizenship/residency restriction — requires in-state identity",
      });
    }
    logger.info("Marked case as ID State due to citizenship restriction", { caseId, classification });
    return noAction(["Citizenship/residency restriction — marked as ID State for human handling"]);
  }

  // FEE QUOTE
  if (classification === "FEE_QUOTE") {
    const fee = extractedFeeAmount != null ? Number(extractedFeeAmount) : null;
    if (fee === null || !isFinite(fee) || fee < 0) {
      if (!hasRealCase) {
        return decision("NEGOTIATE_FEE", {
          pauseReason: "FEE_QUOTE",
          reasoning: [`Fee amount invalid/missing (${extractedFeeAmount})`],
        });
      }
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
    if (hasRealCase) {
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
    const caseData = hasRealCase ? await db.getCaseById(caseId) : null;

    // Check for unanswered clarification
    const unansweredMsgId = hasRealCase ? await checkUnansweredClarification(caseId) : null;
    if (unansweredMsgId) {
      return decision("SEND_CLARIFICATION", {
        pauseReason: "DENIAL",
        reasoning: [...reasoning, `Unanswered clarification (msg #${unansweredMsgId}) - answering original question`],
        overrideMessageId: unansweredMsgId,
      });
    }

    const resolvedSubtype = denialSubtype || (hasRealCase ? (await db.getLatestResponseAnalysis(caseId))?.full_analysis_json?.denial_subtype : null) || null;

    switch (resolvedSubtype) {
      case "no_records": {
        const metadataAgencyMismatch = detectCaseMetadataAgencyMismatch({
          currentAgencyName: caseData?.agency_name,
          additionalDetails: caseData?.additional_details,
        });
        if (metadataAgencyMismatch) {
          return decision("RESEARCH_AGENCY", {
            pauseReason: "DENIAL",
            researchLevel: "deep",
            reasoning: [
              ...reasoning,
              `No-records denial came from ${metadataAgencyMismatch.currentAgencyName}, but case metadata names ${metadataAgencyMismatch.expectedAgencyName}; researching the correct custodian instead of rebutting the wrong agency`,
            ],
          });
        }
        if (!hasVerifiedCustodianChannel(caseData)) {
          return decision("RESEARCH_AGENCY", { pauseReason: "DENIAL", researchLevel: "deep", reasoning: [...reasoning, "No records - researching correct agency (deep)"] });
        }
        return decision("SEND_REBUTTAL", {
          pauseReason: "DENIAL",
          researchLevel: "medium",
          reasoning: [...reasoning, "No responsive records from a verified custodian - rebutting the denial instead of re-researching"],
        });
      }
      case "wrong_agency": {
        // Atomically cancel portal tasks + dismiss portal-type proposals via the runtime
        if (hasRealCase) {
          await caseRuntime.transitionCaseRuntime(caseId, "CASE_WRONG_AGENCY", {});
          const currentConstraints = caseData?.constraints_jsonb || [];
          if (!currentConstraints.includes("WRONG_AGENCY")) {
            await db.updateCase(caseId, {
              constraints_jsonb: JSON.stringify([...currentConstraints, "WRONG_AGENCY"]),
            });
          }
        }
        const directAction = hasRealCase ? await getWrongAgencyDirectAction(caseId) : null;
        if (directAction) {
          return decision(directAction, {
            pauseReason: "DENIAL",
            reasoning: [...reasoning, `Wrong agency referral resolved - sending to routed custodian via ${directAction}`],
          });
        }
        return decision("RESEARCH_AGENCY", { pauseReason: "DENIAL", researchLevel: "medium", reasoning: [...reasoning, "Wrong agency - researching correct one"] });
      }
      case "overly_broad":
        return decision("REFORMULATE_REQUEST", { pauseReason: "DENIAL", reasoning: [...reasoning, "Overly broad - narrowing scope"] });
      case "ongoing_investigation": {
        const strength = await assessDenialStrength(caseId, resolvedSubtype, inlineKeyPoints);
        if (strength === "strong") {
          return decision("CLOSE_CASE", {
            pauseReason: "DENIAL",
            gateOptions: ["APPROVE", "ADJUST", "DISMISS"],
            reasoning: [...reasoning, `Strong ${resolvedSubtype} denial - recommending closure`],
          });
        }
        return decision("SEND_REBUTTAL", {
          canAutoExecute: false,
          requiresHuman: true,
          pauseReason: "DENIAL",
          researchLevel: "medium",
          reasoning: [...reasoning, `${resolvedSubtype} denial (${strength}) - drafting rebuttal for review`],
        });
      }
      case "privacy_exemption": {
        const rebuttablePrivacyDenial = shouldRebutPrivacyDenialForAccountabilityRecords(caseData, inlineKeyPoints);
        const strength = await assessDenialStrength(caseId, resolvedSubtype, inlineKeyPoints);
        if (!rebuttablePrivacyDenial && strength === "strong") {
          return decision("CLOSE_CASE", {
            pauseReason: "DENIAL",
            gateOptions: ["APPROVE", "ADJUST", "DISMISS"],
            reasoning: [...reasoning, `Strong ${resolvedSubtype} denial - recommending closure`],
          });
        }
        return decision("SEND_REBUTTAL", {
          canAutoExecute: false,
          requiresHuman: true,
          pauseReason: "DENIAL",
          researchLevel: "medium",
          reasoning: rebuttablePrivacyDenial
            ? [...reasoning, "Privacy denial targets body-camera/dispatch accountability records - drafting rebuttal for review"]
            : [...reasoning, `${resolvedSubtype} denial (${strength}) - drafting rebuttal for review`],
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
        if (looksLikeContractorCustodyDenial(inlineKeyPoints)) {
          return decision("RESEARCH_AGENCY", {
            pauseReason: "DENIAL",
            researchLevel: "medium",
            reasoning: [...reasoning, "Contractor-custody denial indicates the current agency may not be the actual custodian - researching the correct holder before rebutting"],
          });
        }
        return decision("SEND_REBUTTAL", {
          canAutoExecute: false,
          requiresHuman: true,
          pauseReason: "DENIAL",
          researchLevel: "medium",
          reasoning: [...reasoning, "Third-party confidential - drafting rebuttal with redaction offer for review"],
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
        return decision("SEND_REBUTTAL", {
          canAutoExecute: false,
          requiresHuman: true,
          pauseReason: "DENIAL",
          researchLevel: "medium",
          reasoning: [...reasoning, `Denial (${strength}) - drafting rebuttal for review`],
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
    const caseData = hasRealCase ? await db.getCaseById(caseId) : null;
    const latestAnalysis = hasRealCase ? await db.getLatestResponseAnalysis(caseId) : null;
    const detResearchCount = hasRealCase
      ? await db.query(
          `SELECT COUNT(*)::int AS cnt FROM proposals
           WHERE case_id = $1 AND action_type = 'RESEARCH_AGENCY' AND status IN ('EXECUTED', 'DISMISSED')`,
          [caseId]
        ).then((r: any) => r.rows?.[0]?.cnt || 0)
      : 0;
    if (hasRealCase && detResearchCount < 2 && shouldPrioritizeBodycamCustodianResearch(caseData, latestAnalysis, topConstraints)) {
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
    if (hasRealCase) {
      await caseRuntime.transitionCaseRuntime(caseId, "CASE_COMPLETED", { substatus: "records_received" });
      await db.updateCase(caseId, { outcome_type: "full_approval", outcome_recorded: true });
    }
    return noAction(["Records ready - case completed"]);
  }

  // ACKNOWLEDGMENT
  if (classification === "ACKNOWLEDGMENT") {
    if (hasRealCase) {
      await caseRuntime.transitionCaseRuntime(caseId, "ACKNOWLEDGMENT_RECEIVED", {});
    }
    return noAction(["Acknowledgment received - status reset to awaiting_response"]);
  }

  // PORTAL_REDIRECT
  if (classification === "PORTAL_REDIRECT") {
    if (!hasRealCase) {
      return noAction(["Portal redirect - task creation skipped in simulation (no real case)"]);
    }
    try {
      const caseData = await db.getCaseById(caseId);
      const effectiveUrl = portalUrl || caseData?.portal_url;
      const fallbackDecision = portalRedirectFallbackDecision(
        [],
        effectiveUrl,
        caseData?.portal_provider || null,
        caseData?.last_portal_status || null
      );
      if (fallbackDecision) {
        logger.warn("Portal redirect missing automatable portal URL; routing to research instead", {
          caseId,
          portalUrl: effectiveUrl || null,
          provider: caseData?.portal_provider || null,
        });
        return fallbackDecision;
      }
      await db.updateCasePortalStatus(caseId, { portal_url: effectiveUrl });
      await caseRuntime.transitionCaseRuntime(caseId, "PORTAL_STARTED", { substatus: "portal_redirect" });
      const task = await createPortalTask({
        caseId,
        portalUrl: effectiveUrl,
        actionType: "SUBMIT_VIA_PORTAL",
        subject: caseData?.request_summary || "FOIA Request",
        bodyText: "Agency requires portal submission.",
        status: "PENDING",
        instructions: `Submit through portal at: ${effectiveUrl || "their website"}`,
      });
      // submit-portal dispatched by Railway cron (avoids child task PENDING_VERSION)
    } catch (e: any) {
      logger.error("Failed to create portal task", { caseId, error: e.message });
    }
    return noAction(["Portal redirect - task created, cron will dispatch"]);
  }

  // WRONG_AGENCY — cancel in-flight work, add constraint, then research
  if (classification === "WRONG_AGENCY") {
    if (hasRealCase) {
      await caseRuntime.transitionCaseRuntime(caseId, "CASE_WRONG_AGENCY", {});
      const caseData = await db.getCaseById(caseId);
      const currentConstraints = caseData?.constraints_jsonb || [];
      if (!currentConstraints.includes("WRONG_AGENCY")) {
        await db.updateCase(caseId, {
          constraints_jsonb: JSON.stringify([...currentConstraints, "WRONG_AGENCY"]),
        });
      }
    }
    const directAction = hasRealCase ? await getWrongAgencyDirectAction(caseId) : null;
    if (directAction) {
      return decision(directAction, {
        pauseReason: "DENIAL",
        reasoning: [`Wrong agency referral already resolved - sending to routed custodian via ${directAction}`],
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
    if (hasRealCase) {
      await caseRuntime.transitionCaseRuntime(caseId, "PARTIAL_DELIVERY_RECEIVED", {});
    }
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
    if (await latestInboundRequestsEmailResend(caseId)) {
      return decision("SEND_FOLLOWUP", {
        requiresHuman: true,
        pauseReason: "SCOPE",
        reasoning: [
          "Latest inbound asks for resend/submit via email",
          "Prioritizing direct follow-up email over additional research/phone routing",
        ],
      });
    }
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
  const hasRealCase = Number.isFinite(caseId) && caseId > 0;
  const reasoning: string[] = [];

  try {
    // === requires_response gate ===
    const isFollowupTrigger = ["SCHEDULED_FOLLOWUP", "time_based_followup", "followup_trigger"].includes(triggerType);
    const isHumanReviewResolutionTrigger =
      triggerType === "HUMAN_REVIEW_RESOLUTION" && Boolean(reviewAction);
    const responseRequiringActions = ["send_rebuttal", "negotiate_fee", "pay_fee", "challenge"];
    const actionOverrides = responseRequiringActions.includes(suggestedAction || "") ||
      (suggestedAction === "respond" && classification === "DENIAL");

    if (requiresResponse === false && !actionOverrides && !(isFollowupTrigger || isHumanReviewResolutionTrigger || classification === "NO_RESPONSE" || classification === "DENIAL" || classification === "PARTIAL_APPROVAL" || classification === "PARTIAL_DELIVERY" || classification === "FEE_QUOTE" || classification === "WRONG_AGENCY")) {
      reasoning.push(`No response needed: ${reasonNoResponse || "Analysis determined no email required"}`);

      // Check for unanswered clarification on denial
      // (classification guard above excludes DENIAL, but runtime data may differ from type narrowing)
      if (hasRealCase && (classification as string) === "DENIAL") {
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
        if (!hasRealCase) {
          return noAction([...reasoning, "Portal redirect - task creation skipped in simulation (no real case)"]);
        }
        try {
          const caseData = await db.getCaseById(caseId);
          const effectiveUrl = portalUrl || caseData?.portal_url;
          const fallbackDecision = portalRedirectFallbackDecision(
            reasoning,
            effectiveUrl,
            caseData?.portal_provider || null,
            caseData?.last_portal_status || null
          );
          if (fallbackDecision) {
            logger.warn("Suggested portal redirect missing automatable portal URL; routing to research instead", {
              caseId,
              portalUrl: effectiveUrl || null,
              provider: caseData?.portal_provider || null,
            });
            return fallbackDecision;
          }
          await db.updateCasePortalStatus(caseId, { portal_url: effectiveUrl });
          await caseRuntime.transitionCaseRuntime(caseId, "PORTAL_STARTED", { substatus: "portal_required" });
          const task = await createPortalTask({
            caseId,
            portalUrl: effectiveUrl,
            actionType: "SUBMIT_VIA_PORTAL",
            subject: caseData?.request_summary || "FOIA Request",
            bodyText: "Agency requires portal submission.",
            status: "PENDING",
            instructions: `Submit through agency portal at: ${effectiveUrl || "their website"}`,
          });
          // submit-portal dispatched by Railway cron (avoids child task PENDING_VERSION)
        } catch (e: any) {
          logger.error("Failed to create portal task", { caseId, error: e.message });
        }
        return noAction([...reasoning, "Portal redirect - task created, cron will dispatch"]);
      }
      if (suggestedAction === "download") {
        if (!hasRealCase) {
          return noAction([...reasoning, "Records ready for download"]);
        }
        await caseRuntime.transitionCaseRuntime(caseId, "CASE_COMPLETED", { substatus: "records_received" });
        await db.updateCase(caseId, { outcome_type: "full_approval", outcome_recorded: true });
        return noAction([...reasoning, "Records ready for download"]);
      }
      if (suggestedAction === "wait") {
        return noAction([...reasoning, "Acknowledgment received, waiting"]);
      }
      if (suggestedAction === "find_correct_agency") {
        if (!hasRealCase) {
          return decision("RESEARCH_AGENCY", {
            pauseReason: "DENIAL",
            researchLevel: "deep",
            reasoning: [...reasoning, "Wrong agency - researching correct custodian"],
          });
        }
        // Atomically cancel portal tasks + dismiss portal-type proposals via the runtime
        await caseRuntime.transitionCaseRuntime(caseId, "CASE_WRONG_AGENCY", {});
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

    // Overdue / scheduled follow-up policy:
    // Route through research first so we can propose the best *new* channel
    // (new portal/new email/phone/fax) instead of repeatedly emailing stale contacts.
    if ((classification === "NO_RESPONSE" || isFollowupTrigger) && !isHumanReviewResolutionTrigger) {
      const [followupSchedule, caseSnapshot] = await Promise.all([
        db.getFollowUpScheduleByCaseId(caseId),
        db.getCaseById(caseId),
      ]);
      // If latest inbound asks to resend/submit by email, prioritize an email follow-up
      // over re-running research/phone fallback.
      if (await latestInboundRequestsEmailResend(caseId)) {
        return decision("SEND_FOLLOWUP", {
          requiresHuman: true,
          pauseReason: "SCOPE",
          reasoning: [
            "Latest inbound asks for resend/submit via email",
            "Prioritizing direct follow-up email over additional research/phone routing",
          ],
        });
      }
      const followupCount = followupSchedule?.followup_count || 0;
      if (followupCount >= MAX_FOLLOWUPS) {
        return decision("ESCALATE", {
          canAutoExecute: true,
          pauseReason: "CLOSE_ACTION",
          reasoning: [`Max follow-ups reached (${followupCount}/${MAX_FOLLOWUPS})`],
        });
      }

      const daysOverdue = Number(caseSnapshot?.days_overdue || 0);
      const deadlineTs = caseSnapshot?.deadline_date ? new Date(caseSnapshot.deadline_date).getTime() : null;
      const isPastDeadline = !!(deadlineTs && Number.isFinite(deadlineTs) && deadlineTs < Date.now());
      const isDueOrOverdue = isFollowupTrigger || daysOverdue > 0 || isPastDeadline;

      if (isDueOrOverdue) {
        const canAutoResearch = autopilotMode === "AUTO";
        return decision("RESEARCH_AGENCY", {
          canAutoExecute: canAutoResearch,
          requiresHuman: !canAutoResearch,
          pauseReason: "SCOPE",
          researchLevel: "light",
          reasoning: [
            `Follow-up due/overdue (${followupCount + 1}/${MAX_FOLLOWUPS})`,
            "Researching alternative channels before sending another follow-up",
          ],
        });
      }
    }

    // === HUMAN_REVIEW_RESOLUTION ===
    if (triggerType === "HUMAN_REVIEW_RESOLUTION" && reviewAction) {
      reasoning.push(`Human review resolution: action=${reviewAction}`);
      const ri = reviewInstruction || null;
      const reviewActionRaw = String(reviewAction).trim();
      const normalizedReviewAction = reviewActionRaw.toLowerCase();

      // Block send_via_email if case is flagged as wrong agency
      const caseDataForReview = await db.getCaseById(caseId);
      const caseConstraints = caseDataForReview?.constraints_jsonb || caseDataForReview?.constraints || [];
      const isWrongAgency = caseConstraints.includes("WRONG_AGENCY") || classification === "WRONG_AGENCY";

      // Monitor/API decision approvals often arrive as reviewAction=APPROVE with the
      // selected proposal already moved to DECISION_RECEIVED. Resume that proposal action.
      if (normalizedReviewAction === "approve") {
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
            const directAction = await getWrongAgencyDirectAction(caseId);
            if (directAction) {
              return decision(directAction, {
                reasoning: [...reasoning, `Wrong-agency reroute already configured - executing ${directAction}`],
              });
            }
            return decision("RESEARCH_AGENCY", {
              reasoning: [...reasoning, "Redirected: cannot send to wrong agency — researching correct one"],
              researchLevel: "deep",
            });
          }
          const submissionEvidence = await getStatusUpdateSubmissionEvidence(caseId, caseDataForReview);
          const hasPriorSubmission = submissionEvidence.hasEvidence;
          if (hasPriorSubmission) {
            return decision("RESEARCH_AGENCY", {
              adjustmentInstruction: ri || "Research updated contact info before sending another follow-up. If no better channel is found, create a phone-call handoff instead of emailing the same contact again.",
              researchLevel: "light",
              reasoning: [
                ...reasoning,
                ...(submissionEvidence.reasons.length > 0
                  ? submissionEvidence.reasons
                  : ["Case has prior submission evidence"]),
                "This is a follow-up, not a fresh initial request",
                "Researching updated contact info before sending another message to the same channel",
                "If research finds no better email or portal, hand off to a phone call instead of drafting a duplicate status email",
              ],
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
        send_status_update: async () => decision("SEND_STATUS_UPDATE", {
          adjustmentInstruction: ri || 'Send a short update confirming payment/asking the agency to proceed with the request',
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
        retry_research: async () => decision("RESEARCH_AGENCY", {
          adjustmentInstruction: ri || "Retry agency research from scratch",
          reasoning: [...reasoning, "Human explicitly requested another agency research pass."],
          researchLevel: "deep",
        }),
        reformulate_request: async () => decision("REFORMULATE_REQUEST", {
          adjustmentInstruction: ri || "Reformulate with a different approach",
          reasoning,
        }),
        reprocess: async () => {
          // If research already completed and yielded channels, deterministically
          // continue from that output instead of re-running broad routing.
          let parsedResearch: any = null;
          if (caseDataForReview?.contact_research_notes) {
            if (typeof caseDataForReview.contact_research_notes === "string") {
              try {
                parsedResearch = JSON.parse(caseDataForReview.contact_research_notes);
              } catch {
                parsedResearch = null;
              }
            } else {
              parsedResearch = caseDataForReview.contact_research_notes;
            }
          }
          const executionMeta = parsedResearch?.execution || {};
          const discovered = executionMeta?.new_channels || {};
          const hasResearchState =
            String(caseDataForReview?.substatus || "").includes("research_") ||
            !!executionMeta?.outcome;
          const discoveredPortal = discovered?.portal || null;
          const discoveredEmail = discovered?.email || null;
          const discoveredPhone = discovered?.phone || null;
          const discoveredFax = discovered?.fax || null;
          if (hasResearchState && (discoveredPortal || discoveredEmail || discoveredPhone || discoveredFax)) {
            if (discoveredPortal) {
              return decision("SUBMIT_PORTAL", {
                adjustmentInstruction: `Use researched portal channel (${discoveredPortal}) for next submission.`,
                reasoning: [...reasoning, "Reprocess fast-path: using researched portal channel"],
              });
            }
            if (discoveredEmail) {
              return decision("SEND_INITIAL_REQUEST", {
                adjustmentInstruction: `Use researched contact email (${discoveredEmail}) for next submission.`,
                reasoning: [...reasoning, "Reprocess fast-path: using researched email channel"],
              });
            }
            if (discoveredPhone || discoveredFax) {
              return decision("ESCALATE", {
                pauseReason: "RESEARCH_HANDOFF",
                reasoning: [
                  ...reasoning,
                  discoveredPhone ? "FOLLOWUP_CHANNEL:PHONE" : "FOLLOWUP_CHANNEL:FAX",
                  "Reprocess fast-path: no email/portal discovered; route to phone follow-up handoff",
                ],
              });
            }
          }

          if (classification === "WRONG_AGENCY") {
            const wrongAgencyDecision = await deterministicRouting(
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
            return {
              ...wrongAgencyDecision,
              reasoning: [...reasoning, ...(wrongAgencyDecision.reasoning || [])],
            };
          }

          // AI Router v2: single AI call with pre-filtered actions
          if (useAIRouter(caseId)) {
            const preComputed = await preComputeDecisionContext(
              caseId, classification, denialSubtype, constraints, inlineKeyPoints
            );
            const portalAvailable = hasAutomatablePortal(
              preComputed.caseData?.portal_url,
              preComputed.caseData?.portal_provider,
              preComputed.caseData?.last_portal_status
            );
            const allowedActions = buildAllowedActions({
              classification, denialSubtype, constraints,
              followupCount: preComputed.followupCount,
              maxFollowups: MAX_FOLLOWUPS,
              hasAutomatablePortal: portalAvailable,
              triggerType: "INITIAL_REQUEST", // Allow full action set for reprocess
              dismissedActionCounts: preComputed.dismissedActionCounts,
              canDirectWrongAgencySend: preComputed.canDirectWrongAgencySend,
              researchAttemptCount: preComputed.researchAttemptCount,
              hasValidResearchResults: preComputed.hasValidResearchResults,
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

          const lowerRi = ri.toLowerCase();
          const caseConstraintsForReview = caseDataForReview?.constraints_jsonb || caseDataForReview?.constraints || [];
          const metadataAgencyMismatch = detectCaseMetadataAgencyMismatch({
            currentAgencyName: caseDataForReview?.agency_name || null,
            additionalDetails: caseDataForReview?.additional_details || null,
          });
          const currentAgencyName = String(caseDataForReview?.agency_name || "").trim().toLowerCase();
          const explicitWrongAgencyDirective = (
            (!!currentAgencyName &&
              lowerRi.includes(currentAgencyName) &&
              (/\bwrong\b|do not use|do not route|not the correct|incorrect/i.test(lowerRi))) ||
            /\bwrong agency\b|\bwrong jurisdiction\b|\bwrong for this case\b|\bincorrect (agency|department|custodian)\b|do not use|do not route/i.test(lowerRi)
          );
          const humanWantsAgencyResearch = /\bresearch\b|\bcustodian\b|\bwrong agency\b|\bcorrect\s+(agency|custodian)\b|\bfind\b.*\bagency\b|\broute\b.*\b(correct|there)\b|\bverify\b.*\b(channel|portal|contact)\b|do not assume email/i.test(ri);

          if (classification === "WRONG_AGENCY" || (humanWantsAgencyResearch && (metadataAgencyMismatch || explicitWrongAgencyDirective))) {
            const currentConstraints = Array.isArray(caseConstraintsForReview) ? caseConstraintsForReview : [];
            if (!currentConstraints.includes("WRONG_AGENCY")) {
              await db.updateCase(caseId, {
                constraints_jsonb: JSON.stringify([...currentConstraints, "WRONG_AGENCY"]),
              });
            }
            return decision("RESEARCH_AGENCY", {
              adjustmentInstruction: ri,
              researchLevel: "deep",
              reasoning: [
                ...reasoning,
                metadataAgencyMismatch
                  ? `Case metadata names ${metadataAgencyMismatch.expectedAgencyName}; custom review is forcing a corrected-agency research pass.`
                  : "Custom review explicitly rejected the current agency/custodian; forcing a corrected-agency research pass.",
              ],
            });
          }

          // AI Router v2: let AI interpret the custom instruction
          if (useAIRouter(caseId)) {
            const preComputed = await preComputeDecisionContext(
              caseId, classification, denialSubtype, constraints, inlineKeyPoints
            );
            const portalAvailable = hasAutomatablePortal(
              preComputed.caseData?.portal_url,
              preComputed.caseData?.portal_provider,
              preComputed.caseData?.last_portal_status
            );
            const allowedActions = buildAllowedActions({
              classification, denialSubtype, constraints,
              followupCount: preComputed.followupCount,
              maxFollowups: MAX_FOLLOWUPS,
              hasAutomatablePortal: portalAvailable,
              triggerType: "INITIAL_REQUEST", // Allow full action set for custom instruction
              dismissedActionCounts: preComputed.dismissedActionCounts,
              canDirectWrongAgencySend: preComputed.canDirectWrongAgencySend,
              researchAttemptCount: preComputed.researchAttemptCount,
              hasValidResearchResults: preComputed.hasValidResearchResults,
            });
            // When a human provides explicit custom instructions, don't let an
            // UNKNOWN-only escalate lockout block obvious execution paths.
            // This keeps "resend by email" and similar directives actionable.
            if (ri && allowedActions.length === 1 && allowedActions[0] === "ESCALATE") {
              const lowerRi = ri.toLowerCase();
              const relaxed = new Set<ActionType>(allowedActions);
              if (/\b(send|resend|email|follow[\s-]?up)\b/.test(lowerRi)) {
                relaxed.add("SEND_FOLLOWUP");
              }
              if (/\bclarif(y|ication)?\b|\bnarrow\b|\bscope\b/.test(lowerRi)) {
                relaxed.add("SEND_CLARIFICATION");
              }
              if (/\bresearch\b|\bfind\b.*\bagency\b|\bwrong agency\b|\bcustodian\b/.test(lowerRi)) {
                relaxed.add("RESEARCH_AGENCY");
              }
              if (relaxed.size > allowedActions.length) {
                logger.info("Relaxed custom-review allowed actions from ESCALATE lockout", {
                  caseId,
                  classification,
                  customInstruction: ri.slice(0, 180),
                  allowedActions: Array.from(relaxed),
                });
                allowedActions.splice(0, allowedActions.length, ...Array.from(relaxed));
              }
            }
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
          if (
            caseData?.portal_url &&
            hasAutomatablePortal(caseData.portal_url, caseData.portal_provider, caseData?.last_portal_status)
          ) {
            await caseRuntime.transitionCaseRuntime(caseId, "PORTAL_STARTED", { substatus: "Portal retry" });
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
              // submit-portal dispatched by Railway cron (avoids child task PENDING_VERSION)
              logger.info("Portal retry task created, cron will dispatch", { caseId, portalTaskId: task?.id });
            } catch (e: any) {
              logger.error("Failed to create portal retry task", { caseId, error: e.message });
            }
            return noAction([...reasoning, "Portal retry task created, cron will dispatch"]);
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

      const handler = reviewMap[normalizedReviewAction];
      logger.info("HUMAN_REVIEW_RESOLUTION routing", {
        caseId,
        classification,
        reviewAction,
        isWrongAgency,
        chosenHandler: handler ? normalizedReviewAction : "fallback_escalate_unknown_review_action",
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
          await caseRuntime.transitionCaseRuntime(caseId, "CASE_CANCELLED", { substatus: "withdrawn_by_user" });
          await db.updateCase(caseId, { outcome_type: "withdrawn", outcome_recorded: true });
          return noAction(["Request withdrawn by user"]);
        default:
          return decision("ESCALATE", {
            pauseReason: "SENSITIVE",
            reasoning: [`Unknown human decision: ${humanDecision.action}`],
          });
      }
    }

    // WRONG_AGENCY is handled deterministically first so AI router cannot
    // deadlock on constrained action sets when we already have a verified reroute.
    if (classification === "WRONG_AGENCY") {
      return deterministicRouting(
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
    }

    if ((classification === "NO_RESPONSE" || isFollowupTrigger) && await latestInboundRequestsEmailResend(caseId)) {
      return decision("SEND_FOLLOWUP", {
        requiresHuman: true,
        pauseReason: "SCOPE",
        reasoning: [
          "Latest inbound asks for resend/submit via email",
          "Prioritizing direct follow-up email over additional research/phone routing",
        ],
      });
    }

    if (classification === "CLARIFICATION_REQUEST") {
      const pdfDecision = await getClarificationPdfRoutingDecision(caseId);
      if (pdfDecision) {
        return pdfDecision;
      }
    }

    if (classification === "DENIAL" && denialSubtype === "no_records") {
      await db.getLatestResponseAnalysis(caseId);
      const deterministicNoRecordsDecision = await deterministicRouting(
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
      if (
        deterministicNoRecordsDecision.actionType === "RESEARCH_AGENCY" &&
        deterministicNoRecordsDecision.reasoning.some((line) =>
          /case metadata names .*researching the correct custodian instead of rebutting the wrong agency/i.test(
            String(line)
          )
        )
      ) {
        return deterministicNoRecordsDecision;
      }
    }

    // === AI Router v2 vs Legacy routing ===
    if (useAIRouter(caseId)) {
      logger.info("AI Router v2 active", { caseId, classification });

      const preComputed = await preComputeDecisionContext(
        caseId, classification, denialSubtype, constraints, inlineKeyPoints
      );

      const portalAvailable = hasAutomatablePortal(
        preComputed.caseData?.portal_url,
        preComputed.caseData?.portal_provider,
        preComputed.caseData?.last_portal_status
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
        canDirectWrongAgencySend: preComputed.canDirectWrongAgencySend,
        researchAttemptCount: preComputed.researchAttemptCount,
        hasValidResearchResults: preComputed.hasValidResearchResults,
      });

      // Special handling for classifications with side effects that happen at decision time
      // RECORDS_READY and ACKNOWLEDGMENT status updates
      if (classification === "RECORDS_READY") {
        await caseRuntime.transitionCaseRuntime(caseId, "CASE_COMPLETED", { substatus: "records_received" });
        await db.updateCase(caseId, { outcome_type: "full_approval", outcome_recorded: true });
      }
      if (classification === "ACKNOWLEDGMENT") {
        await caseRuntime.transitionCaseRuntime(caseId, "ACKNOWLEDGMENT_RECEIVED", {});
      }
      if (classification === "PARTIAL_DELIVERY") {
        await caseRuntime.transitionCaseRuntime(caseId, "PARTIAL_DELIVERY_RECEIVED", {});
      }

      // PORTAL_REDIRECT: create portal task (this side effect must stay at decision time)
      if (classification === "PORTAL_REDIRECT") {
        const effectiveUrl = portalUrl || preComputed.caseData?.portal_url;
        const fallbackDecision = portalRedirectFallbackDecision(
          [],
          effectiveUrl,
          preComputed.caseData?.portal_provider || null,
          preComputed.caseData?.last_portal_status || null
        );
        if (fallbackDecision) {
          logger.warn("PORTAL_REDIRECT: no automatable portal URL, routing to research instead (v2)", {
            caseId,
            portalUrl: effectiveUrl || null,
            provider: preComputed.caseData?.portal_provider || null,
          });
          return fallbackDecision;
        }
        await db.updateCasePortalStatus(caseId, { portal_url: effectiveUrl });
        await caseRuntime.transitionCaseRuntime(caseId, "PORTAL_STARTED", { substatus: "portal_redirect" });
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
          // submit-portal dispatched by Railway cron (avoids child task PENDING_VERSION)
        } catch (e: any) {
          logger.error("Failed to create portal task (v2)", { caseId, error: e.message });
        }
        return noAction(["Portal redirect - task created, cron will dispatch (v2)"]);
      }

      // Citizenship/residency restriction: mark as ID State
      const CITIZEN_CONSTRAINTS = ["AL_CITIZENSHIP_REQUIRED", "CITIZENSHIP_REQUIRED", "RESIDENCY_REQUIRED"];
      if (constraints.some(c => CITIZEN_CONSTRAINTS.includes(c))) {
        await caseRuntime.transitionCaseRuntime(caseId, "CASE_ID_STATE", {
          substatus: "Citizenship/residency restriction — requires in-state identity",
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

      if (classification === "DENIAL") {
        const deterministicDenialResult = await deterministicRouting(
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
        const resolvedDenialSubtype = String(denialSubtype || "");
        const deterministicSpecificDenialActions = new Set<ActionType>([
          "SEND_REBUTTAL",
          "SEND_APPEAL",
          "CLOSE_CASE",
        ]);
        const preferDeterministicDenial =
          (deterministicDenialResult.actionType === "CLOSE_CASE" && v2Result.actionType !== "CLOSE_CASE") ||
          (["wrong_agency", "no_duty_to_create", "no_records"].includes(resolvedDenialSubtype) &&
            deterministicDenialResult.actionType === "RESEARCH_AGENCY" &&
            v2Result.actionType !== "RESEARCH_AGENCY") ||
          (resolvedDenialSubtype === "no_records" &&
            deterministicSpecificDenialActions.has(deterministicDenialResult.actionType) &&
            v2Result.actionType !== deterministicDenialResult.actionType) ||
          (["privacy_exemption", "third_party_confidential", "retention_expired", "glomar_ncnd", "privilege_attorney_work_product"].includes(resolvedDenialSubtype) &&
            v2Result.actionType === "ESCALATE" &&
            deterministicSpecificDenialActions.has(deterministicDenialResult.actionType)) ||
          (looksLikeContractorCustodyDenial(inlineKeyPoints) &&
            deterministicDenialResult.actionType === "RESEARCH_AGENCY" &&
            v2Result.actionType !== "RESEARCH_AGENCY");
        if (preferDeterministicDenial) {
          logger.info("Overriding AI Router v2 denial decision with deterministic denial routing", {
            caseId,
            classification,
            denialSubtype,
            aiAction: v2Result.actionType,
            deterministicAction: deterministicDenialResult.actionType,
          });
          return {
            ...deterministicDenialResult,
            reasoning: [
              `AI Router v2 suggested ${v2Result.actionType}, but deterministic denial routing preferred ${deterministicDenialResult.actionType}`,
              ...(deterministicDenialResult.reasoning || []),
            ],
          };
        }
      }

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
      if (classification === "PARTIAL_DELIVERY" && suggestedAction === "wait") {
        const deterministicPartialResult = await deterministicRouting(
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
        if (deterministicPartialResult.actionType === "NONE" && aiResult.actionType !== "NONE") {
          logger.info("Overriding AI partial-delivery decision with deterministic no-action", {
            caseId,
            classification,
            aiAction: aiResult.actionType,
          });
          return {
            ...deterministicPartialResult,
            reasoning: [
              `AI suggested ${aiResult.actionType}, but deterministic partial-delivery routing preferred NONE`,
              ...(deterministicPartialResult.reasoning || []),
            ],
          };
        }
      }
      if (classification === "DENIAL") {
        const deterministicDenialResult = await deterministicRouting(
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
        const resolvedDenialSubtype = String(denialSubtype || "");
        const deterministicSpecificDenialActions = new Set<ActionType>([
          "SEND_REBUTTAL",
          "SEND_APPEAL",
          "CLOSE_CASE",
        ]);
        const preferDeterministicDenial =
          (deterministicDenialResult.actionType === "CLOSE_CASE" && aiResult.actionType !== "CLOSE_CASE") ||
          (["wrong_agency", "no_duty_to_create", "no_records"].includes(resolvedDenialSubtype) &&
            deterministicDenialResult.actionType === "RESEARCH_AGENCY" &&
            aiResult.actionType !== "RESEARCH_AGENCY") ||
          (resolvedDenialSubtype === "no_records" &&
            deterministicSpecificDenialActions.has(deterministicDenialResult.actionType) &&
            aiResult.actionType !== deterministicDenialResult.actionType) ||
          (["privacy_exemption", "third_party_confidential", "retention_expired", "glomar_ncnd", "privilege_attorney_work_product"].includes(resolvedDenialSubtype) &&
            aiResult.actionType === "ESCALATE" &&
            deterministicSpecificDenialActions.has(deterministicDenialResult.actionType)) ||
          (looksLikeContractorCustodyDenial(inlineKeyPoints) &&
            deterministicDenialResult.actionType === "RESEARCH_AGENCY" &&
            aiResult.actionType !== "RESEARCH_AGENCY");
        if (preferDeterministicDenial) {
          logger.info("Overriding AI denial decision with deterministic denial routing", {
            caseId,
            classification,
            denialSubtype,
            aiAction: aiResult.actionType,
            deterministicAction: deterministicDenialResult.actionType,
          });
          return {
            ...deterministicDenialResult,
            reasoning: [
              `AI suggested ${aiResult.actionType}, but deterministic denial routing preferred ${deterministicDenialResult.actionType}`,
              ...(deterministicDenialResult.reasoning || []),
            ],
          };
        }
      }
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
    try {
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
      return {
        ...deterministicResult,
        reasoning: [
          `Decision error: ${error.message}`,
          "Falling back to deterministic routing",
          ...(deterministicResult.reasoning || []),
        ],
      };
    } catch (fallbackError: any) {
      logger.error("deterministic routing fallback failed", {
        caseId,
        error: fallbackError?.message || String(fallbackError),
      });
      return decision("ESCALATE", {
        pauseReason: "SENSITIVE",
        reasoning: [
          `Decision error: ${error.message}`,
          `Deterministic fallback failed: ${fallbackError?.message || String(fallbackError)}`,
          "Escalating to human review",
        ],
      });
    }
  }
}
