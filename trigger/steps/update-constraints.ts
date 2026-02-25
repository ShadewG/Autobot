/**
 * Update Constraints Step
 *
 * Port of langgraph/nodes/update-constraints.js
 * Updates constraints and scope based on agency response analysis.
 */

import { generateObject } from "ai";
import { decisionModel } from "../lib/ai";
import { constraintExtractionSchema } from "../lib/schemas";
import db, { logger } from "../lib/db";
import type { ScopeItem } from "../lib/types";

function normalizeItemName(name: string): string {
  if (!name) return "";
  return name.replace(/^\d+\.\s*/, "").toLowerCase().trim();
}

function mergeScopeUpdates(existing: ScopeItem[], updates: any[]): ScopeItem[] {
  const byItem = new Map<string, ScopeItem>(
    existing.map((s) => {
      const itemName = normalizeItemName(s.name || (s as any).item);
      return [itemName, { ...s, name: s.name || (s as any).item }];
    })
  );

  for (const update of updates) {
    const rawName = update.name || update.item || "";
    const itemName = normalizeItemName(rawName);
    if (!itemName) continue;

    if (byItem.has(itemName)) {
      const existingItem = byItem.get(itemName)!;
      byItem.set(itemName, {
        ...existingItem,
        status: update.status || existingItem.status,
        reason: update.reason || existingItem.reason,
        confidence: update.confidence || existingItem.confidence,
        name: existingItem.name,
      });
    } else {
      const cleanName = rawName.replace(/^\d+\.\s*/, "");
      byItem.set(itemName, { ...update, name: cleanName });
    }
  }

  return Array.from(byItem.values());
}

export async function updateConstraints(
  caseId: number,
  classification: string,
  extractedFeeAmount: number | null,
  messageId: number | null,
  currentConstraints: string[],
  currentScopeItems: ScopeItem[]
): Promise<{ constraints: string[]; scopeItems: ScopeItem[] }> {
  if (!messageId) {
    return { constraints: currentConstraints, scopeItems: currentScopeItems };
  }

  const analysis = await db.getResponseAnalysisByMessageId(messageId);
  if (!analysis?.full_analysis_json) {
    return { constraints: currentConstraints, scopeItems: currentScopeItems };
  }

  const parsed =
    typeof analysis.full_analysis_json === "string"
      ? JSON.parse(analysis.full_analysis_json)
      : analysis.full_analysis_json;

  const caseData = await db.getCaseById(caseId);
  const constraints = [
    ...(caseData.constraints_jsonb || caseData.constraints || currentConstraints),
  ];
  const scopeItems =
    caseData.scope_items_jsonb || caseData.scope_items || currentScopeItems;

  let extractedConstraints: string[] = Array.isArray(parsed.constraints_to_add)
    ? parsed.constraints_to_add
    : [];
  let extractedScopeUpdates: any[] = Array.isArray(parsed.scope_updates)
    ? parsed.scope_updates
    : [];

  if (extractedConstraints.length === 0) {
    try {
      const message = await db.getMessageById(messageId);
      const { object } = await generateObject({
        model: decisionModel,
        schema: constraintExtractionSchema,
        prompt: `Extract constraints and scope updates from this agency response.

## Classification
${classification}

## Existing analysis JSON
${JSON.stringify(parsed, null, 2)}

## Agency message
Subject: ${message?.subject || "No subject"}
Body:
${(message?.body_text || message?.body_html || "").substring(0, 4000)}

Return constraint tags and scope item updates only when supported by the message content.`,
      });

      extractedConstraints = object.constraintsToAdd;
      extractedScopeUpdates = object.scopeUpdates;
    } catch (error: any) {
      logger.warn("AI constraint extraction failed, using fallback pattern matching", {
        caseId,
        messageId,
        error: error.message,
      });
    }
  }

  // Add constraints from AI analysis
  if (extractedConstraints.length > 0) {
    for (const constraint of extractedConstraints) {
      if (!constraints.includes(constraint)) {
        constraints.push(constraint);
      }
    }
  }

  // Fallback: extract from key_points
  if (extractedConstraints.length === 0 && parsed.key_points) {
    for (const point of parsed.key_points) {
      const pl = point.toLowerCase();
      if (
        (pl.includes("body camera") || pl.includes("bwc")) &&
        (pl.includes("exempt") || pl.includes("not available") || pl.includes("cannot provide") || pl.includes("withheld"))
      ) {
        if (!constraints.includes("BWC_EXEMPT")) constraints.push("BWC_EXEMPT");
      }
      if (
        (pl.includes("fee") || pl.includes("cost") || pl.includes("payment")) &&
        !constraints.includes("FEE_REQUIRED") &&
        extractedFeeAmount != null && extractedFeeAmount > 0
      ) {
        constraints.push("FEE_REQUIRED");
      }
      if (
        (pl.includes("identification") || pl.includes("verify identity") || pl.includes("proof of") || pl.includes("notarized")) &&
        !constraints.includes("ID_REQUIRED")
      ) {
        constraints.push("ID_REQUIRED");
      }
      if (
        (pl.includes("ongoing investigation") || pl.includes("active case") || pl.includes("pending litigation")) &&
        !constraints.includes("INVESTIGATION_ACTIVE")
      ) {
        constraints.push("INVESTIGATION_ACTIVE");
      }
    }
  }

  if (classification === "DENIAL" && !constraints.includes("DENIAL_RECEIVED")) {
    constraints.push("DENIAL_RECEIVED");
  }

  // Merge scope updates
  const updatedScopeItems =
    extractedScopeUpdates.length > 0
      ? mergeScopeUpdates(scopeItems, extractedScopeUpdates)
      : scopeItems;

  // Build fee quote update
  let feeQuoteUpdate: any = null;
  if (parsed.fee_breakdown || extractedFeeAmount) {
    const currentFeeQuote = caseData.fee_quote_jsonb || {};
    feeQuoteUpdate = {
      ...currentFeeQuote,
      amount: extractedFeeAmount || currentFeeQuote.amount,
      quoted_at: new Date().toISOString(),
      status: "QUOTED",
    };
    if (parsed.fee_breakdown) {
      feeQuoteUpdate.hourly_rate = parsed.fee_breakdown.hourly_rate || currentFeeQuote.hourly_rate;
      feeQuoteUpdate.estimated_hours = parsed.fee_breakdown.estimated_hours || currentFeeQuote.estimated_hours;
      feeQuoteUpdate.breakdown = parsed.fee_breakdown.items || currentFeeQuote.breakdown;
      feeQuoteUpdate.deposit_required = parsed.fee_breakdown.deposit_required || currentFeeQuote.deposit_required;
    }
  }

  // Persist changes
  const updatePayload: Record<string, any> = {};
  const currentStr = JSON.stringify((caseData.constraints_jsonb || []).sort());
  const newStr = JSON.stringify([...constraints].sort());
  if (newStr !== currentStr) updatePayload.constraints_jsonb = JSON.stringify(constraints);
  if (JSON.stringify(updatedScopeItems) !== JSON.stringify(scopeItems)) {
    updatePayload.scope_items_jsonb = JSON.stringify(updatedScopeItems);
  }
  if (feeQuoteUpdate) updatePayload.fee_quote_jsonb = JSON.stringify(feeQuoteUpdate);

  if (Object.keys(updatePayload).length > 0) {
    await db.updateCase(caseId, updatePayload);
  }

  return { constraints, scopeItems: updatedScopeItems };
}
