/**
 * Safety Check Step
 *
 * Runs regex-based checks and AI safety review, then merges results.
 */

import { generateObject } from "ai";
import { decisionModel, telemetry } from "../lib/ai";
import { safetyReviewSchema, type SafetyReviewOutput } from "../lib/schemas";
import { logger } from "../lib/db";
import type { SafetyResult, ScopeItem } from "../lib/types";

const CRITICAL_RISK_FLAGS = [
  "REQUESTS_EXEMPT_ITEM", "CONTRADICTS_FEE_ACCEPTANCE", "CONTAINS_PII",
  "LAW_JURISDICTION_MISMATCH", "CONTRADICTS_SCOPE_NARROWING", "INVALID_ACTION_DRAFT",
];

function hasExplicitSensitivePii(text: string): boolean {
  if (!text) return false;

  const ssnPattern = /\b\d{3}-\d{2}-\d{4}\b/;
  const creditCardPattern = /\b(?:\d[ -]*?){13,16}\b/;
  const ibanPattern = /\b[A-Z]{2}\d{2}[A-Z0-9]{11,30}\b/i;

  return ssnPattern.test(text) || creditCardPattern.test(text) || ibanPattern.test(text);
}

function isHeuristicPhoneOrAddressWarning(warning: string): boolean {
  return /(personal phone number|mailing address|physical address|releasable to others|concrete narrowing|narrower subset)/i.test(
    String(warning || "")
  );
}

function hasConcreteActionRequest(text: string): boolean {
  return /\b(?:please|kindly)\s+(?:treat|confirm|identify|provide|release|reopen|process|advise|explain)\b|\b(?:can|could|would)\s+you\b|\bi\s+(?:request|ask)\b/i.test(
    String(text || "")
  );
}

function hasRebuttalSubstance(text: string): boolean {
  return /legal basis|exemption|withhold|withheld|segregable|redact|retention|custodian|responsive records|non-exempt|district attorney|body[- ]worn camera|body camera|reopen|process/i.test(
    String(text || "")
  );
}

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
  if (/\b\d{3}-\d{2}-\d{4}\b/.test(draftBodyText)) {
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
    // Only flag explicit federal statute citation (5 USC 552), not general "Freedom of Information Act" phrases
    // which are commonly used as shorthand for state-level equivalents
    const citesFederalStatute = /5\s*U\.?S\.?C\.?\s*§?\s*552\b/.test(draftBodyText);
    if (citesFederalStatute) {
      const hasStateLaw = /\d+\s+(ILCS|Gov\.?\s*Code|C\.?R\.?S|O\.?R\.?S|R\.?C\.?W|M\.?G\.?L)/i.test(draftBodyText);
      if (!hasStateLaw) {
        riskFlags.push("LAW_JURISDICTION_MISMATCH");
        warnings.push(`Draft cites federal FOIA statute (5 USC 552) but agency is ${jurisdictionLevel}-level. Use state public records law instead.`);
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

  if (proposalActionType === "SEND_REBUTTAL") {
    const hasConcreteAsk = hasConcreteActionRequest(draftBodyText);
    const hasSubstantiveRebuttal = hasRebuttalSubstance(draftBodyText);
    const looksLikeAcknowledgmentOnly = /thank you/i.test(draftBodyText)
      && !/\b(?:please|kindly|however|but|confirm|identify|provide|release|reopen|process|withhold|retention|custodian)\b/i.test(draftBodyText);

    if (!hasConcreteAsk || !hasSubstantiveRebuttal || looksLikeAcknowledgmentOnly) {
      riskFlags.push("INVALID_ACTION_DRAFT");
      warnings.push("Rebuttal draft does not actually rebut the denial or make a concrete next-step ask.");
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
  jurisdictionLevel?: string | null;
  caseState?: string | null;
}): Promise<SafetyReviewOutput> {
  const { draftBodyText, proposalActionType, constraints, scopeItems, jurisdictionLevel, caseState } = params;

  const { object } = await generateObject({
    model: decisionModel,
    schema: safetyReviewSchema,
    experimental_telemetry: telemetry,
    prompt: `Review this outbound draft for safety before sending to a government agency.

## Action type
${proposalActionType}

## Draft text
${draftBodyText.substring(0, 6000)}

## Current constraints
${JSON.stringify(constraints, null, 2)}

## Scope items
${JSON.stringify(scopeItems, null, 2)}

## Jurisdiction context
- Jurisdiction level: ${jurisdictionLevel || "unknown"}
- State: ${caseState || "unknown"}

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

### 7. Action-Type Alignment
- If action type is SEND_REBUTTAL, verify the draft actually rebuts the denial and makes a concrete ask
- If the draft is just a thank-you note, acknowledgment, or placeholder shell, return risk flag INVALID_ACTION_DRAFT

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
      jurisdictionLevel,
      caseState,
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

  // Guardrail: AI can over-trigger jurisdiction mismatch from place names
  // (e.g., apartment complex names) even when statute/law checks are otherwise valid.
  // Keep explicit regex-detected law mismatch signals, but suppress heuristic-only
  // mismatch flags/warnings when they are not backed by concrete citation conflicts.
  const regexLawMismatch = regexResult.riskFlags.includes("LAW_JURISDICTION_MISMATCH");
  const hasHeuristicJurisdictionWarnings = mergedWarnings.some((w) =>
    /(possible agency mismatch|confirm the correct agency\/state|suggestive of)/i.test(String(w))
  );
  if (!regexLawMismatch && hasHeuristicJurisdictionWarnings) {
    const filteredFlags = mergedRiskFlags.filter(
      (f) => f !== "LAW_JURISDICTION_MISMATCH" && f !== "CONTRADICTS_JURISDICTION"
    );
    const filteredWarnings = mergedWarnings.filter(
      (w) => !/(possible agency mismatch|confirm the correct agency\/state|suggestive of)/i.test(String(w))
    );
    mergedRiskFlags.length = 0;
    mergedRiskFlags.push(...filteredFlags);
    mergedWarnings.length = 0;
    mergedWarnings.push(...filteredWarnings);
  }

  const regexPiiFlagged = regexResult.riskFlags.includes("CONTAINS_PII");
  if (!regexPiiFlagged && mergedRiskFlags.includes("CONTAINS_PII") && !hasExplicitSensitivePii(draftBodyText)) {
    const filteredFlags = mergedRiskFlags.filter((flag) => flag !== "CONTAINS_PII");
    const filteredWarnings = mergedWarnings.filter((warning) => !isHeuristicPhoneOrAddressWarning(warning));
    mergedRiskFlags.length = 0;
    mergedRiskFlags.push(...filteredFlags);
    mergedWarnings.length = 0;
    mergedWarnings.push(...filteredWarnings);
  }

  const regexInvalidActionDraft = regexResult.riskFlags.includes("INVALID_ACTION_DRAFT");
  const aiOnlyInvalidActionDraft = mergedRiskFlags.includes("INVALID_ACTION_DRAFT") && !regexInvalidActionDraft;
  const looksLikeAcknowledgmentOnly = /thank you/i.test(String(draftBodyText || ""))
    && !/\b(?:please|kindly|however|but|confirm|identify|provide|release|reopen|process|withhold|retention|custodian)\b/i.test(String(draftBodyText || ""));
  if (
    proposalActionType === "SEND_REBUTTAL"
    && aiOnlyInvalidActionDraft
    && hasConcreteActionRequest(draftBodyText)
    && hasRebuttalSubstance(draftBodyText)
    && !looksLikeAcknowledgmentOnly
  ) {
    const filteredFlags = mergedRiskFlags.filter((flag) => flag !== "INVALID_ACTION_DRAFT");
    const filteredWarnings = mergedWarnings.filter(
      (warning) => !/does not actually rebut the denial or make a concrete next-step ask/i.test(String(warning))
    );
    mergedRiskFlags.length = 0;
    mergedRiskFlags.push(...filteredFlags);
    mergedWarnings.length = 0;
    mergedWarnings.push(...filteredWarnings);
  }

  const hasCriticalRisk = mergedRiskFlags.some((flag) => CRITICAL_RISK_FLAGS.includes(flag));

  if (hasCriticalRisk) {
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
