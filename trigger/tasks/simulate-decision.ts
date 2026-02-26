/**
 * Simulate Decision Task
 *
 * Runs the full inbound decision pipeline in dry_run mode:
 * classify → decide → draft → return
 *
 * NO side effects: does not save to DB, send emails, create proposals,
 * or update case status. Pure read + AI inference.
 */

import { task } from "@trigger.dev/sdk/v3";
import { loadContext } from "../steps/load-context";
import { classifyMessageContent } from "../steps/classify-inbound";
import { decideNextAction } from "../steps/decide-next-action";
import { draftResponse } from "../steps/draft-response";
import { logger } from "../lib/db";
import type { CaseContext, ActionType } from "../lib/types";

// Actions that produce a draft reply
const DRAFT_ACTIONS = new Set<ActionType>([
  "SEND_FOLLOWUP",
  "SEND_REBUTTAL",
  "SEND_CLARIFICATION",
  "SEND_APPEAL",
  "SEND_FEE_WAIVER_REQUEST",
  "SEND_STATUS_UPDATE",
  "RESPOND_PARTIAL_APPROVAL",
  "ACCEPT_FEE",
  "NEGOTIATE_FEE",
  "DECLINE_FEE",
  "REFORMULATE_REQUEST",
]);

export interface SimulationPayload {
  messageBody: string;
  fromEmail: string;
  subject: string;
  caseId?: number;
  hasAttachments?: boolean;
  isPortalNotification?: boolean;
}

export interface SimulationResult {
  classification: {
    messageType: string;
    confidence: number;
    sentiment: string;
    extractedFeeAmount: number | null;
    extractedDeadline: string | null;
    denialSubtype: string | null;
    requiresResponse: boolean;
    portalUrl: string | null;
    suggestedAction: string | null;
    unansweredAgencyQuestion: string | null;
    exemptionCitations: string[];
    evidenceQuotes: string[];
    referralContact: any;
  };
  decision: {
    action: ActionType;
    classificationConfidence: number;
    reasoning: string[];
    requiresHuman: boolean;
    canAutoExecute: boolean;
    pauseReason: string | null;
  };
  draftReply: {
    to: string;
    subject: string | null;
    body: string | null;
  } | null;
  simulationLog: Array<{
    step: string;
    result?: string;
    skipped: boolean;
    details?: string;
  }>;
}

function buildMockContext(): CaseContext {
  return {
    caseId: 0,
    caseData: {
      id: 0,
      agency_name: "Simulated Agency",
      state: "CA",
      subject_name: "Simulation Subject",
      status: "active",
      requested_records: "Body camera footage and incident report",
      agency_email: null,
      autopilot_mode: "SUPERVISED",
    },
    messages: [],
    attachments: [],
    analysis: null,
    followups: null,
    existingProposal: null,
    autopilotMode: "SUPERVISED",
    constraints: [],
    scopeItems: [],
  };
}

export const simulateDecision = task({
  id: "simulate-decision",
  maxDuration: 120,
  retry: { maxAttempts: 1 },

  run: async (payload: SimulationPayload): Promise<SimulationResult> => {
    const log: SimulationResult["simulationLog"] = [];

    // ── Step 1: Load context ──────────────────────────────────────────────────
    let context: CaseContext;
    if (payload.caseId) {
      context = await loadContext(payload.caseId, null);
      log.push({
        step: "load_context",
        result: `Real case #${payload.caseId}: ${context.caseData?.agency_name || "unknown agency"}`,
        skipped: false,
      });
    } else {
      context = buildMockContext();
      log.push({
        step: "load_context",
        result: "Mock context (no case selected)",
        skipped: false,
      });
    }

    // ── Step 2: Classify message (no DB write) ────────────────────────────────
    const mockMessage = {
      from_email: payload.fromEmail,
      subject: payload.subject,
      body_text: payload.messageBody,
    };

    const classification = await classifyMessageContent(
      mockMessage,
      context.caseData,
      context.messages
    );

    log.push({
      step: "classify",
      result: `${classification.classification} (${Math.round(classification.confidence * 100)}% confidence, sentiment: ${classification.sentiment})`,
      skipped: false,
    });

    // Side effects that ARE skipped
    log.push({
      step: "save_response_analysis",
      skipped: true,
      details: `Would save classification to response_analysis table`,
    });
    if (classification.extractedFeeAmount) {
      log.push({
        step: "log_fee_event",
        skipped: true,
        details: `Would log fee_quote: $${classification.extractedFeeAmount}`,
      });
    }

    // ── Step 3: Decide next action ────────────────────────────────────────────
    const decision = await decideNextAction(
      context.caseId,
      classification.classification,
      context.constraints,
      classification.extractedFeeAmount,
      classification.sentiment,
      context.autopilotMode,
      "INBOUND_MESSAGE",
      classification.requiresResponse,
      classification.portalUrl,
      classification.suggestedAction,
      null,
      classification.denialSubtype
    );

    log.push({
      step: "decide_next_action",
      result: `${decision.actionType}${decision.requiresHuman ? " (requires human review)" : ""}${decision.canAutoExecute ? " (can auto-execute)" : ""}`,
      skipped: false,
    });

    log.push({
      step: "create_proposal",
      skipped: true,
      details: `Would create proposal with action ${decision.actionType}`,
    });

    log.push({
      step: "update_case_status",
      skipped: true,
      details: decision.requiresHuman
        ? "Would set case status → needs_human_review"
        : `Would set pause_reason → ${decision.pauseReason || "none"}`,
    });

    // ── Step 4: Draft reply (if action produces one) ──────────────────────────
    let draftReply: SimulationResult["draftReply"] = null;

    if (DRAFT_ACTIONS.has(decision.actionType)) {
      if (!context.caseId) {
        // draftResponse requires a real DB case — skip gracefully for mock context
        log.push({
          step: "draft_response",
          skipped: true,
          details: `Would draft ${decision.actionType} (skipped: no real case selected — draft generation requires case DB record)`,
        });
      } else try {
        const draft = await draftResponse(
          context.caseId,
          decision.actionType,
          context.constraints,
          context.scopeItems,
          classification.extractedFeeAmount,
          decision.adjustmentInstruction,
          null
        );

        if (draft.bodyText || draft.subject) {
          draftReply = {
            to: context.caseData?.agency_email || payload.fromEmail,
            subject: draft.subject,
            body: draft.bodyText,
          };
        }

        log.push({
          step: "draft_response",
          result: draftReply
            ? `Generated ${decision.actionType} draft (${(draft.bodyText || "").length} chars)`
            : `Draft generation returned empty content`,
          skipped: false,
        });
      } catch (draftErr: any) {
        logger.warn("simulate-decision: draft generation failed", {
          caseId: context.caseId,
          action: decision.actionType,
          error: draftErr.message,
        });
        log.push({
          step: "draft_response",
          result: `Draft generation failed: ${draftErr.message}`,
          skipped: false,
        });
      }

      if (draftReply) {
        log.push({
          step: "send_email",
          skipped: true,
          details: `Would send to: ${draftReply.to}, subject: "${draftReply.subject}"`,
        });
        log.push({
          step: "create_execution",
          skipped: true,
          details: `Would log execution record for ${decision.actionType}`,
        });
      }
    }

    log.push({
      step: "log_activity",
      skipped: true,
      details: `Would log agent_decision activity`,
    });

    // ── Return result ─────────────────────────────────────────────────────────
    return {
      classification: {
        messageType: classification.classification,
        confidence: classification.confidence,
        sentiment: classification.sentiment,
        extractedFeeAmount: classification.extractedFeeAmount,
        extractedDeadline: classification.extractedDeadline,
        denialSubtype: classification.denialSubtype,
        requiresResponse: classification.requiresResponse,
        portalUrl: classification.portalUrl,
        suggestedAction: classification.suggestedAction,
        unansweredAgencyQuestion: classification.unansweredAgencyQuestion,
        exemptionCitations: classification.detected_exemption_citations || [],
        evidenceQuotes: classification.decision_evidence_quotes || [],
        referralContact: classification.referralContact || null,
      },
      decision: {
        action: decision.actionType,
        classificationConfidence: classification.confidence,
        reasoning: decision.reasoning,
        requiresHuman: decision.requiresHuman,
        canAutoExecute: decision.canAutoExecute,
        pauseReason: decision.pauseReason,
      },
      draftReply,
      simulationLog: log,
    };
  },
});
