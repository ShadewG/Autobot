/**
 * Safety Check Step
 *
 * Port of langgraph/nodes/safety-check.js
 * Validates draft against constraints. Prevents contradictory requests.
 */

import type { SafetyResult, ScopeItem } from "../lib/types";

export async function safetyCheck(
  draftBodyText: string | null,
  draftSubject: string | null,
  proposalActionType: string,
  constraints: string[],
  scopeItems: ScopeItem[]
): Promise<SafetyResult> {
  const riskFlags: string[] = [];
  const warnings: string[] = [];

  if (!draftBodyText) {
    return {
      riskFlags: ["NO_DRAFT"],
      warnings: [],
      canAutoExecute: true,
      requiresHuman: false,
      pauseReason: null,
    };
  }

  const draftLower = draftBodyText.toLowerCase();

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

  // === Constraint Violations ===

  // BWC exempt check
  if (safeConstraints.includes("BWC_EXEMPT")) {
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
  if (safeConstraints.includes("FEE_ACCEPTED")) {
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
  const deliveredItems = safeScope.filter(
    (s: ScopeItem) => s.status === "DELIVERED"
  );
  for (const item of deliveredItems) {
    const itemName = (item.name || (item as any).item || "").toLowerCase();
    if (itemName && draftLower.includes(itemName)) {
      if (!draftLower.includes("received") && !draftLower.includes("thank")) {
        warnings.push(`Draft may be re-requesting already-delivered item: ${item.name}`);
      }
    }
  }

  // Investigation-active rebuttal warning
  if (safeConstraints.includes("INVESTIGATION_ACTIVE")) {
    if (proposalActionType === "SEND_REBUTTAL") {
      warnings.push("Rebuttal sent while investigation is active - may be futile");
    }
  }

  // === Tone/Content Checks ===
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

  // === Determine if safe ===
  const hasCriticalRisk = riskFlags.some((f) =>
    ["REQUESTS_EXEMPT_ITEM", "CONTRADICTS_FEE_ACCEPTANCE", "CONTAINS_PII"].includes(f)
  );

  if (hasCriticalRisk) {
    return {
      riskFlags,
      warnings,
      canAutoExecute: false,
      requiresHuman: true,
      pauseReason: "SENSITIVE",
    };
  }

  return {
    riskFlags,
    warnings,
    canAutoExecute: true,  // Safety check passed, doesn't override decision's setting
    requiresHuman: false,
    pauseReason: null,
  };
}
