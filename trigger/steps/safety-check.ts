/**
 * Safety Check Step
 *
 * Runs regex-based checks and AI safety review, then merges results.
 */

import { generateObject } from "ai";
import { decisionModel } from "../lib/ai";
import { safetyReviewSchema, type SafetyReviewOutput } from "../lib/schemas";
import { logger } from "../lib/db";
import type { SafetyResult, ScopeItem } from "../lib/types";

const CRITICAL_RISK_FLAGS = ["REQUESTS_EXEMPT_ITEM", "CONTRADICTS_FEE_ACCEPTANCE", "CONTAINS_PII"];

function runRegexSafetyChecks(
  draftBodyText: string,
  proposalActionType: string,
  constraints: string[],
  scopeItems: ScopeItem[]
): { riskFlags: string[]; warnings: string[]; hasCriticalRisk: boolean } {
  const riskFlags: string[] = [];
  const warnings: string[] = [];

  const draftLower = draftBodyText.toLowerCase();

  // BWC exempt check
  if (constraints.includes("BWC_EXEMPT")) {
    if (
      draftLower.includes("body camera") ||
      draftLower.includes("bwc") ||
      draftLower.includes("body worn")
    ) {
      if (
        !draftLower.includes("understand") &&
        !draftLower.includes("acknowledge") &&
        !draftLower.includes("noted")
      ) {
        riskFlags.push("REQUESTS_EXEMPT_ITEM");
        warnings.push("Draft requests body camera footage that agency has marked as exempt");
      }
    }
  }

  // Fee acceptance contradiction
  if (constraints.includes("FEE_ACCEPTED")) {
    if (
      draftLower.includes("negotiate") ||
      draftLower.includes("reduce") ||
      draftLower.includes("waive")
    ) {
      riskFlags.push("CONTRADICTS_FEE_ACCEPTANCE");
      warnings.push("Draft attempts to negotiate fee after already accepting");
    }
  }

  // Re-requesting delivered items
  const deliveredItems = scopeItems.filter((s: ScopeItem) => s.status === "DELIVERED");
  for (const item of deliveredItems) {
    const itemName = (item.name || (item as any).item || "").toLowerCase();
    if (itemName && draftLower.includes(itemName)) {
      if (!draftLower.includes("received") && !draftLower.includes("thank")) {
        warnings.push(`Draft may be re-requesting already-delivered item: ${item.name}`);
      }
    }
  }

  // Investigation-active rebuttal warning
  if (constraints.includes("INVESTIGATION_ACTIVE") && proposalActionType === "SEND_REBUTTAL") {
    warnings.push("Rebuttal sent while investigation is active - may be futile");
  }

  // Tone checks
  const aggressiveTerms = ["demand", "lawsuit", "attorney", "legal action", "violation", "sue"];
  const aggressiveFound = aggressiveTerms.filter((t) => draftLower.includes(t));
  if (aggressiveFound.length > 0 && proposalActionType !== "SEND_REBUTTAL") {
    warnings.push(`Draft contains potentially aggressive language: ${aggressiveFound.join(", ")}`);
  }

  // PII check
  const ssnPattern = /\d{3}-\d{2}-\d{4}/;
  if (ssnPattern.test(draftBodyText)) {
    riskFlags.push("CONTAINS_PII");
    warnings.push("Draft may contain SSN - review before sending");
  }

  // Email check
  const emailPattern = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
  const emails = draftBodyText.match(emailPattern) || [];
  const requesterEmail = process.env.REQUESTER_EMAIL || "";
  const suspiciousEmails = emails.filter(
    (e) => !e.includes(requesterEmail) && !e.includes("agency") && !e.includes("gov")
  );
  if (suspiciousEmails.length > 0) {
    warnings.push(`Draft contains email addresses: ${suspiciousEmails.join(", ")}`);
  }

  return {
    riskFlags,
    warnings,
    hasCriticalRisk: riskFlags.some((f) => CRITICAL_RISK_FLAGS.includes(f)),
  };
}

async function runAiSafetyReview(params: {
  draftBodyText: string;
  proposalActionType: string;
  constraints: string[];
  scopeItems: ScopeItem[];
}): Promise<SafetyReviewOutput> {
  const { draftBodyText, proposalActionType, constraints, scopeItems } = params;

  const { object } = await generateObject({
    model: decisionModel,
    schema: safetyReviewSchema,
    prompt: `Review this outbound draft for safety.

## Action type
${proposalActionType}

## Draft text
${draftBodyText.substring(0, 6000)}

## Current constraints
${JSON.stringify(constraints, null, 2)}

## Scope items
${JSON.stringify(scopeItems, null, 2)}

Is this draft safe to send?
Check for contradictions with constraints, PII, aggressive tone, re-requesting exempt items, and internal inconsistency.
Return critical risk flags only in riskFlags and non-critical issues in warnings.`,
  });

  return object as SafetyReviewOutput;
}

export async function safetyCheck(
  draftBodyText: string | null,
  draftSubject: string | null,
  proposalActionType: string,
  constraints: string[],
  scopeItems: ScopeItem[]
): Promise<SafetyResult> {
  if (!draftBodyText) {
    return {
      riskFlags: ["NO_DRAFT"],
      warnings: [],
      canAutoExecute: true,
      requiresHuman: false,
      pauseReason: null,
    };
  }

  // Parse constraints/scopeItems if they came as strings
  const safeConstraints = Array.isArray(constraints)
    ? constraints
    : typeof constraints === "string"
      ? (() => { try { return JSON.parse(constraints); } catch { return []; } })()
      : [];

  const safeScope = Array.isArray(scopeItems)
    ? scopeItems
    : typeof scopeItems === "string"
      ? (() => { try { return JSON.parse(scopeItems); } catch { return []; } })()
      : [];

  const [regexResult, aiResult] = await Promise.all([
    Promise.resolve(runRegexSafetyChecks(draftBodyText, proposalActionType, safeConstraints, safeScope)),
    runAiSafetyReview({
      draftBodyText,
      proposalActionType,
      constraints: safeConstraints,
      scopeItems: safeScope,
    }).catch((error: any) => {
      logger.warn("AI safety review failed, continuing with regex safety checks", {
        error: error.message,
        proposalActionType,
      });
      return null;
    }),
  ]);

  const mergedRiskFlags = Array.from(new Set([
    ...regexResult.riskFlags,
    ...(aiResult?.riskFlags || []),
  ]));
  const mergedWarnings = Array.from(new Set([
    ...regexResult.warnings,
    ...(aiResult?.warnings || []),
  ]));

  const aiHasCriticalRisk = aiResult
    ? (!aiResult.safe || aiResult.riskFlags.length > 0)
    : false;

  if (regexResult.hasCriticalRisk || aiHasCriticalRisk) {
    return {
      riskFlags: mergedRiskFlags,
      warnings: mergedWarnings,
      canAutoExecute: false,
      requiresHuman: true,
      pauseReason: "SENSITIVE",
    };
  }

  return {
    riskFlags: mergedRiskFlags,
    warnings: mergedWarnings,
    canAutoExecute: true,
    requiresHuman: false,
    pauseReason: null,
  };
}
