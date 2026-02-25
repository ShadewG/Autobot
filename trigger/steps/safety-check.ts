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

const CRITICAL_RISK_FLAGS = [
  "REQUESTS_EXEMPT_ITEM", "CONTRADICTS_FEE_ACCEPTANCE", "CONTAINS_PII",
  "LAW_JURISDICTION_MISMATCH", "CONTRADICTS_SCOPE_NARROWING",
];

function runRegexSafetyChecks(
  draftBodyText: string,
  proposalActionType: string,
  constraints: string[],
  scopeItems: ScopeItem[],
  jurisdictionLevel?: string | null,
  caseState?: string | null
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

  // Law-fit checks: detect federal FOIA citation when addressing local/state agency
  if (jurisdictionLevel && jurisdictionLevel !== "federal") {
    if (/5\s*U\.?S\.?C\.?\s*§?\s*552\b/.test(draftBodyText) || /freedom of information act/i.test(draftBodyText)) {
      // Check it's not just a general reference alongside state law
      const hasStateLaw = /\d+\s+(ILCS|Gov\.?\s*Code|C\.?R\.?S|O\.?R\.?S|R\.?C\.?W|M\.?G\.?L)/i.test(draftBodyText);
      if (!hasStateLaw) {
        riskFlags.push("LAW_JURISDICTION_MISMATCH");
        warnings.push(`Draft cites federal FOIA (5 USC 552) but agency is ${jurisdictionLevel}-level. Use state public records law instead.`);
      }
    }
  }

  // Requester consistency: FEE_ACCEPTED + negotiate language
  if (constraints.includes("FEE_ACCEPTED")) {
    if (draftLower.includes("excessive") || draftLower.includes("unreasonable") || draftLower.includes("too high")) {
      if (!riskFlags.includes("CONTRADICTS_FEE_ACCEPTANCE")) {
        riskFlags.push("CONTRADICTS_FEE_ACCEPTANCE");
        warnings.push("Draft challenges fee after already accepting it");
      }
    }
  }

  // Requester consistency: SCOPE_NARROWED + expansion language
  if (constraints.includes("SCOPE_NARROWED")) {
    if (draftLower.includes("all records") || draftLower.includes("expand") || draftLower.includes("additional records") || draftLower.includes("full scope")) {
      riskFlags.push("CONTRADICTS_SCOPE_NARROWING");
      warnings.push("Draft appears to re-expand scope after it was already narrowed");
    }
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
    prompt: `Review this outbound draft for safety before sending to a government agency.

## Action type
${proposalActionType}

## Draft text
${draftBodyText.substring(0, 6000)}

## Current constraints
${JSON.stringify(constraints, null, 2)}

## Scope items
${JSON.stringify(scopeItems, null, 2)}

## Safety Checks (evaluate ALL of these)

### 1. Constraint Contradictions
- Does the draft contradict any active constraints? (e.g., requesting BWC when BWC_EXEMPT, negotiating after FEE_ACCEPTED)

### 2. PII & Sensitive Content
- Does the draft contain SSNs, credit card numbers, or other PII?
- Does it reference internal system details that shouldn't be shared?

### 3. Tone & Professionalism
- Is the tone appropriate for the action type? (rebuttals can be firm; clarifications should be cooperative)
- Are there aggressive/threatening terms that could harm the relationship?

### 4. Re-requesting Exempt/Delivered Items
- Does it re-request items already marked as DELIVERED or EXEMPT?

### 5. Law-Jurisdiction Fit
- If citing specific statutes, do they match the agency's jurisdiction?
- Don't cite federal FOIA (5 USC 552) for state/local agencies unless appropriate
- Don't cite one state's law for an agency in a different state
- Set law_fit_valid=false and list issues in law_fit_issues if mismatches found

### 6. Requester Consistency
- Does the draft contradict prior positions? (e.g., FEE_ACCEPTED but now negotiating, SCOPE_NARROWED but now expanding)
- Set requester_consistency_valid=false and list issues in requester_consistency_issues if inconsistencies found

Return critical risk flags in riskFlags and non-critical issues in warnings.`,
  });

  return object as SafetyReviewOutput;
}

export async function safetyCheck(
  draftBodyText: string | null,
  draftSubject: string | null,
  proposalActionType: string,
  constraints: string[],
  scopeItems: ScopeItem[],
  jurisdictionLevel?: string | null,
  caseState?: string | null
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
    Promise.resolve(runRegexSafetyChecks(draftBodyText, proposalActionType, safeConstraints, safeScope, jurisdictionLevel, caseState)),
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

  // Merge law-fit and requester-consistency issues into risk flags
  if (aiResult) {
    if (aiResult.law_fit_valid === false && (aiResult.law_fit_issues?.length || 0) > 0) {
      mergedRiskFlags.push("LAW_JURISDICTION_MISMATCH");
      mergedWarnings.push(...(aiResult.law_fit_issues || []));
    }
    if (aiResult.requester_consistency_valid === false && (aiResult.requester_consistency_issues?.length || 0) > 0) {
      mergedWarnings.push(...(aiResult.requester_consistency_issues || []));
    }
  }

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
