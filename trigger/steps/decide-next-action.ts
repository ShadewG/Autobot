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

async function assessDenialStrength(caseId: number): Promise<"strong" | "medium" | "weak"> {
  const analysis = await db.getLatestResponseAnalysis(caseId);
  const keyPoints: string[] = analysis?.key_points || [];
  const strongIndicators = [
    "exemption", "statute", "law enforcement", "ongoing investigation",
    "privacy", "confidential", "sealed", "court", "pending litigation", "active case",
  ];
  const strongCount = keyPoints.filter((p: string) =>
    strongIndicators.some((ind) => p.toLowerCase().includes(ind))
  ).length;
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
    ...overrides,
  };
}

function noAction(reasoning: string[]): DecisionResult {
  return decision("NONE", { isComplete: true, requiresHuman: false, reasoning });
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
    .slice(-8)
    .map((m: any) => {
      const body = (m.body_text || m.body_html || "").replace(/\s+/g, " ").trim().substring(0, 240);
      return `[${String(m.direction || "unknown").toUpperCase()}] ${m.subject || "(no subject)"} | ${body}`;
    })
    .join("\n");

  return `You are deciding the next action for a public-records request workflow.

## Case context
- Agency: ${caseData?.agency_name || "Unknown"}
- State: ${caseData?.state || "Unknown"}
- Subject: ${caseData?.subject_name || "Unknown"}
- Records requested: ${requestedRecords}
- Current status: ${caseData?.status || "Unknown"}

## Current classifier result
- Classification: ${classification}
- Classification confidence: ${classificationConfidence ?? "unknown"}
- Sentiment: ${sentiment}
- Fee amount: ${extractedFeeAmount ?? "none"}

## Constraints
${JSON.stringify(constraints || [], null, 2)}

## Scope items
${JSON.stringify(scopeItems || [], null, 2)}

## Mode
- Autopilot mode: ${autopilotMode}

## Thread summary (recent first-to-last)
${threadSummary || "No thread messages available."}

Given this classification and context, what is the best next action?
Choose exactly one action from the schema and provide concise reasoning.
Use requiresHuman=true when confidence is low or case is sensitive.`;
}

function validateDecision(
  aiDecisionResult: DecisionOutput,
  context: {
    classification: Classification;
    extractedFeeAmount: number | null;
    autopilotMode: AutopilotMode;
  }
): { valid: boolean; reason?: string } {
  const { classification, extractedFeeAmount, autopilotMode } = context;

  if (aiDecisionResult.confidence < 0.5) {
    return { valid: false, reason: `AI decision confidence too low (${aiDecisionResult.confidence})` };
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

  if (aiDecisionResult.action === "CLOSE_CASE" && !aiDecisionResult.requiresHuman) {
    return { valid: false, reason: "CLOSE_CASE must require human review" };
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
}): Promise<DecisionResult | null> {
  try {
    const [caseData, threadMessages, latestAnalysis] = await Promise.all([
      db.getCaseById(params.caseId),
      db.getMessagesByCaseId(params.caseId),
      db.getLatestResponseAnalysis(params.caseId),
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
    });

    const { object } = await generateObject({
      model: decisionModel,
      schema: decisionSchema,
      prompt,
      providerOptions: decisionOptions,
    });

    const validation = validateDecision(object, {
      classification: params.classification,
      extractedFeeAmount: params.extractedFeeAmount,
      autopilotMode: params.autopilotMode,
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

    return decision(object.action, {
      canAutoExecute,
      requiresHuman,
      pauseReason: requiresHuman ? (object.pauseReason || "SENSITIVE") : null,
      reasoning: object.reasoning,
      adjustmentInstruction: object.adjustmentInstruction,
      isComplete: object.action === "NONE",
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
  denialSubtype: string | null
): Promise<DecisionResult> {
  const reasoning: string[] = [];
  const isFollowupTrigger = ["SCHEDULED_FOLLOWUP", "time_based_followup", "followup_trigger"].includes(triggerType);

  // FEE QUOTE
  if (classification === "FEE_QUOTE") {
    const fee = extractedFeeAmount != null ? Number(extractedFeeAmount) : null;
    if (fee === null || !isFinite(fee) || fee < 0) {
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
        if (!caseData.contact_research_notes) {
          return decision("RESEARCH_AGENCY", { pauseReason: "DENIAL", reasoning: [...reasoning, "No records - researching correct agency"] });
        }
        return decision("REFORMULATE_REQUEST", { pauseReason: "DENIAL", reasoning: [...reasoning, "Already researched - reformulating request"] });
      case "wrong_agency":
        return decision("RESEARCH_AGENCY", { pauseReason: "DENIAL", reasoning: [...reasoning, "Wrong agency - researching correct one"] });
      case "overly_broad":
        return decision("REFORMULATE_REQUEST", { pauseReason: "DENIAL", reasoning: [...reasoning, "Overly broad - narrowing scope"] });
      case "ongoing_investigation":
      case "privacy_exemption": {
        const strength = await assessDenialStrength(caseId);
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
          reasoning: [...reasoning, `${resolvedSubtype} denial (${strength}) - drafting rebuttal`],
        });
      }
      case "excessive_fees":
        return decision("NEGOTIATE_FEE", { pauseReason: "FEE_QUOTE", reasoning: [...reasoning, "Excessive fees denial - negotiating"] });
      case "retention_expired":
        return decision("ESCALATE", { pauseReason: "DENIAL", reasoning: [...reasoning, "Retention expired - escalating"] });
      default: {
        const strength = await assessDenialStrength(caseId);
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
    await db.updateCaseStatus(caseId, "pending", { substatus: "portal_required" });
    try {
      const caseData = await db.getCaseById(caseId);
      await createPortalTask({
        caseId,
        portalUrl: portalUrl || caseData?.portal_url,
        actionType: "SUBMIT_VIA_PORTAL",
        subject: caseData?.request_summary || "FOIA Request",
        bodyText: "Agency requires portal submission.",
        status: "PENDING",
        instructions: `Submit through portal at: ${portalUrl || "their website"}`,
      });
    } catch (e: any) {
      logger.error("Failed to create portal task", { caseId, error: e.message });
    }
    return noAction(["Portal redirect - task created"]);
  }

  // WRONG_AGENCY
  if (classification === "WRONG_AGENCY") {
    if (requiresResponse) {
      return decision("RESEARCH_AGENCY", {
        pauseReason: "DENIAL",
        reasoning: ["Wrong agency with redirect info - researching correct custodian"],
      });
    }
    await db.updateCaseStatus(caseId, "pending", { substatus: "wrong_agency" });
    return noAction(["Wrong agency - flagged for redirect"]);
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
  humanDecision?: HumanDecision | null
): Promise<DecisionResult> {
  const reasoning: string[] = [];

  try {
    // === requires_response gate ===
    const isFollowupTrigger = ["SCHEDULED_FOLLOWUP", "time_based_followup", "followup_trigger"].includes(triggerType);
    const responseRequiringActions = ["send_rebuttal", "negotiate_fee", "pay_fee", "challenge"];
    const actionOverrides = responseRequiringActions.includes(suggestedAction || "") ||
      (suggestedAction === "respond" && classification === "DENIAL");

    if (requiresResponse === false && !actionOverrides && !(isFollowupTrigger || classification === "NO_RESPONSE")) {
      reasoning.push(`No response needed: ${reasonNoResponse || "Analysis determined no email required"}`);

      // Check for unanswered clarification on denial
      if (classification === "DENIAL") {
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
        await db.updateCaseStatus(caseId, "pending", { substatus: "portal_required" });
        try {
          const caseData = await db.getCaseById(caseId);
          await createPortalTask({
            caseId,
            portalUrl: portalUrl || caseData?.portal_url,
            actionType: "SUBMIT_VIA_PORTAL",
            subject: caseData?.request_summary || "FOIA Request",
            bodyText: "Agency requires portal submission.",
            status: "PENDING",
            instructions: `Submit through agency portal at: ${portalUrl || "their website"}`,
          });
        } catch (e: any) {
          logger.error("Failed to create portal task", { caseId, error: e.message });
        }
        return noAction([...reasoning, "Portal redirect - task created"]);
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
        await db.updateCaseStatus(caseId, "pending", { substatus: "wrong_agency" });
        return noAction([...reasoning, "Wrong agency - flagged for redirect"]);
      }
      return noAction([...reasoning, "No email response needed"]);
    }

    // === HUMAN_REVIEW_RESOLUTION ===
    if (triggerType === "HUMAN_REVIEW_RESOLUTION" && reviewAction) {
      reasoning.push(`Human review resolution: action=${reviewAction}`);
      const ri = reviewInstruction || null;

      const reviewMap: Record<string, () => Promise<DecisionResult>> = {
        send_via_email: async () => decision("SEND_FOLLOWUP", {
          adjustmentInstruction: ri || "Send the original FOIA request via email instead of portal",
          reasoning,
        }),
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
        reprocess: async () => decision("ESCALATE", { reasoning }),
        custom: async () => {
          if (!ri) return noAction([...reasoning, "Custom action with no instruction"]);
          return decision("SEND_FOLLOWUP", { adjustmentInstruction: ri, reasoning });
        },
        retry_portal: async () => {
          const caseData = await db.getCaseById(caseId);
          if (caseData?.portal_url) {
            await db.updateCaseStatus(caseId, "portal_in_progress", { substatus: "Portal retry", requires_human: false });
            try {
              await createPortalTask({
                caseId,
                portalUrl: caseData.portal_url,
                actionType: "SUBMIT_VIA_PORTAL",
                subject: caseData?.request_summary || "FOIA Request",
                bodyText: ri || "Retry portal submission",
                status: "PENDING",
              });
            } catch (e: any) { /* non-fatal */ }
          }
          return noAction([...reasoning, "Portal retry initiated"]);
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

    const aiResult = await aiDecision({
      caseId,
      classification,
      constraints,
      extractedFeeAmount,
      sentiment,
      autopilotMode,
    });

    if (aiResult) {
      return aiResult;
    }

    return await deterministicRouting(
      caseId,
      classification,
      extractedFeeAmount,
      sentiment,
      autopilotMode,
      triggerType,
      requiresResponse,
      portalUrl,
      denialSubtype
    );
  } catch (error: any) {
    logger.error("decide_next_action step error", { caseId, error: error.message });
    return decision("ESCALATE", {
      pauseReason: "SENSITIVE",
      reasoning: [`Decision error: ${error.message}`, "Escalating to human review"],
    });
  }
}
