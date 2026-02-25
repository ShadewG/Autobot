/**
 * Research Context Step
 *
 * Gathers structured research (agency hierarchy, state laws, custodians)
 * between the decide and draft steps. Results are cached on the case row
 * and passed into the draft/rebuttal prompts to avoid redundant AI calls.
 */

import { generateObject } from "ai";
import { researchModel, researchOptions } from "../lib/ai";
import { researchContextSchema } from "../lib/schemas";
import db, { aiService, logger } from "../lib/db";
import type { ResearchContext, ResearchLevel, Classification, ReferralContact } from "../lib/types";
import { createHash } from "node:crypto";

export function emptyResearchContext(): ResearchContext {
  return {
    level: "none",
    agency_hierarchy_verified: false,
    likely_record_custodians: [],
    official_records_submission_methods: [],
    portal_url_verified: false,
    state_law_notes: null,
    record_type_handoff_notes: null,
    rebuttal_support_points: [],
    clarification_answer_support: null,
    cached_at: null,
  };
}

/**
 * Determine what research depth is needed based on context.
 */
export function determineResearchLevel(
  actionType: string,
  classification: Classification,
  denialSubtype: string | null,
  aiResearchLevel?: ResearchLevel,
  hasVerifiedCustodian?: boolean
): ResearchLevel {
  // If AI explicitly requested a level, respect it (unless we'd downgrade for time)
  if (aiResearchLevel && aiResearchLevel !== "none") {
    return aiResearchLevel;
  }

  // No research for simple ack/delivery cases
  if (["ACKNOWLEDGMENT", "RECORDS_READY", "PARTIAL_DELIVERY"].includes(classification)) {
    return "none";
  }

  // Light research for portal/fee
  if (classification === "PORTAL_REDIRECT" || classification === "FEE_QUOTE") {
    return "light";
  }

  // Wrong agency always needs research to find correct custodian
  if (classification === "WRONG_AGENCY") {
    return "medium";
  }

  // Clarification: medium (we need context to answer their question)
  if (classification === "CLARIFICATION_REQUEST") {
    return "medium";
  }

  // Denial routing by subtype
  if (classification === "DENIAL") {
    const deepDenials = ["no_records", "wrong_agency"];
    const mediumDenials = [
      "ongoing_investigation", "privacy_exemption", "glomar_ncnd",
      "privilege_attorney_work_product", "overly_broad", "excessive_fees",
      "not_reasonably_described", "no_duty_to_create", "third_party_confidential",
      "records_not_yet_created", "retention_expired",
    ];

    if (deepDenials.includes(denialSubtype || "")) {
      return hasVerifiedCustodian ? "medium" : "deep";
    }
    if (mediumDenials.includes(denialSubtype || "")) {
      return "medium";
    }
    // juvenile_records, sealed_court_order → escalate, minimal research
    if (denialSubtype === "juvenile_records" || denialSubtype === "sealed_court_order") {
      return "light";
    }
    return "medium"; // default for unknown denial subtypes
  }

  // UNKNOWN → medium
  if (classification === "UNKNOWN") {
    return "medium";
  }

  return "none";
}

/**
 * Build a cache key from the research inputs.
 */
function buildCacheKey(
  agencyName: string,
  state: string,
  classification: string,
  denialSubtype: string | null,
  requestedRecords: string
): string {
  const input = JSON.stringify({ agencyName, state, classification, denialSubtype, requestedRecords });
  return createHash("sha256").update(input).digest("hex").substring(0, 16);
}

/**
 * Check if cached research is still valid (< 24h old, same context hash).
 */
function isCacheValid(cached: any, cacheKey: string): boolean {
  if (!cached || !cached.cached_at || !cached._cache_key) return false;
  if (cached._cache_key !== cacheKey) return false;
  const age = Date.now() - new Date(cached.cached_at).getTime();
  return age < 24 * 60 * 60 * 1000; // 24 hours
}

/**
 * Execute the research step: light, medium, or deep.
 * Returns structured ResearchContext. Degrades gracefully on error.
 */
export async function researchContext(
  caseId: number,
  actionType: string,
  classification: Classification,
  denialSubtype: string | null,
  level: ResearchLevel,
  referralContact?: ReferralContact | null,
  messageId?: number | null
): Promise<ResearchContext> {
  if (level === "none") return emptyResearchContext();

  try {
    const caseData = await db.getCaseById(caseId);
    const agencyName = caseData?.agency_name || "Unknown";
    const state = caseData?.state || "Unknown";
    const requestedRecords = Array.isArray(caseData?.requested_records)
      ? caseData.requested_records.join(", ")
      : caseData?.requested_records || "";

    // If we have referral contact info from the classification, use it directly
    // This is the email/phone/agency that the responding agency explicitly told us to contact
    if (referralContact && (referralContact.email || referralContact.url)) {
      logger.info("Using referral contact from classification", {
        caseId, referralAgency: referralContact.agency_name, referralEmail: referralContact.email,
      });

      const result: ResearchContext = {
        level,
        agency_hierarchy_verified: true,
        likely_record_custodians: referralContact.agency_name
          ? [`${referralContact.agency_name}${referralContact.notes ? ` (${referralContact.notes})` : ""}`]
          : [],
        official_records_submission_methods: [
          ...(referralContact.email ? [`Email: ${referralContact.email}`] : []),
          ...(referralContact.url ? [`Portal/Website: ${referralContact.url}`] : []),
          ...(referralContact.phone ? [`Phone: ${referralContact.phone}`] : []),
        ],
        portal_url_verified: false,
        state_law_notes: null,
        record_type_handoff_notes: referralContact.notes,
        rebuttal_support_points: [],
        clarification_answer_support: null,
        cached_at: new Date().toISOString(),
      };

      // Store as contact_research_notes so execute-action can find the agency
      await db.updateCase(caseId, {
        contact_research_notes: JSON.stringify({
          contactResult: {
            contact_email: referralContact.email,
            portal_url: referralContact.url,
            contact_phone: referralContact.phone,
            notes: `Referral from ${agencyName}: ${referralContact.notes || "redirected to this agency"}`,
            source: "agency_referral",
            confidence: 0.95,
          },
          brief: {
            summary: `${agencyName} explicitly referred us to ${referralContact.agency_name || "another agency"}`,
            suggested_agencies: [{
              name: referralContact.agency_name || "Referred Agency",
              reason: referralContact.notes || `Referred by ${agencyName}`,
              confidence: 0.95,
            }],
          },
        }),
      });

      await persistResearch(caseId, result, "referral");
      return result;
    }

    // Check cache
    const cacheKey = buildCacheKey(agencyName, state, classification, denialSubtype, requestedRecords);
    const existing = caseData?.research_context_jsonb;
    if (existing && isCacheValid(existing, cacheKey)) {
      logger.info("Using cached research context", { caseId, level, cacheKey });
      const { _cache_key, ...rest } = existing;
      return rest as ResearchContext;
    }

    // Timeout budget: check if we've been running too long (180s of 300s limit)
    const taskStartTime = Date.now();

    // Fetch inbound message body for context (helps AI research find the right agency)
    let inboundMessageBody: string | null = null;
    if (messageId) {
      try {
        const msg = await db.getMessageById(messageId);
        if (msg?.body_text) {
          inboundMessageBody = msg.body_text.substring(0, 2000);
        }
      } catch (e: any) {
        logger.warn("Failed to fetch inbound message for research", { caseId, messageId, error: e.message });
      }
    }

    // === LIGHT: alternate contacts + portal verification ===
    let contactResult: any = null;
    try {
      // Pass inbound message body so AI can see referral info
      contactResult = await aiService.researchAlternateContacts(caseData, inboundMessageBody);
    } catch (e: any) {
      logger.warn("researchAlternateContacts failed", { caseId, error: e.message });
    }

    const result: ResearchContext = {
      level,
      agency_hierarchy_verified: !!contactResult?.contact_email,
      likely_record_custodians: contactResult?.notes ? [contactResult.notes] : [],
      official_records_submission_methods: contactResult?.portal_url
        ? [`Portal: ${contactResult.portal_url}`]
        : contactResult?.contact_email
          ? [`Email: ${contactResult.contact_email}`]
          : [],
      portal_url_verified: !!(contactResult?.portal_url && contactResult.confidence > 0.7),
      state_law_notes: null,
      record_type_handoff_notes: null,
      rebuttal_support_points: [],
      clarification_answer_support: null,
      cached_at: new Date().toISOString(),
    };

    if (level === "light") {
      await persistResearch(caseId, result, cacheKey);
      return result;
    }

    // Check timeout budget before medium research
    if (Date.now() - taskStartTime > 60_000) {
      logger.warn("Research timeout budget approaching, returning light results", { caseId, elapsed: Date.now() - taskStartTime });
      result.level = "light";
      await persistResearch(caseId, result, cacheKey);
      return result;
    }

    // === MEDIUM: light + state law research + structured context ===
    let lawResearch: string | null = null;
    try {
      lawResearch = await aiService.researchStateLaws(state, denialSubtype || classification.toLowerCase());
    } catch (e: any) {
      logger.warn("researchStateLaws failed", { caseId, error: e.message });
    }

    if (lawResearch) {
      result.state_law_notes = lawResearch;
    }

    // Use generateObject to extract structured research points
    try {
      const { object } = await generateObject({
        model: researchModel,
        schema: researchContextSchema,
        prompt: `Extract structured research context from the following data for a FOIA case.

## Case
- Agency: ${agencyName}
- State: ${state}
- Classification: ${classification}
- Denial subtype: ${denialSubtype || "none"}
- Records requested: ${requestedRecords}

## Alternate Contact Research
${contactResult ? JSON.stringify(contactResult, null, 2) : "No contact research available"}

## State Law Research
${lawResearch || "No law research available"}

Extract the most useful structured information for drafting a response.`,
        providerOptions: researchOptions,
      });

      // Merge structured output into result
      result.likely_record_custodians = object.likely_record_custodians.length > 0
        ? object.likely_record_custodians
        : result.likely_record_custodians;
      result.official_records_submission_methods = object.official_records_submission_methods.length > 0
        ? object.official_records_submission_methods
        : result.official_records_submission_methods;
      result.rebuttal_support_points = object.rebuttal_support_points;
      result.clarification_answer_support = object.clarification_answer_support;
      result.record_type_handoff_notes = object.record_type_handoff_notes;
      result.agency_hierarchy_verified = object.agency_hierarchy_verified || result.agency_hierarchy_verified;
      result.portal_url_verified = object.portal_url_verified || result.portal_url_verified;
    } catch (e: any) {
      logger.warn("Structured research extraction failed", { caseId, error: e.message });
    }

    if (level === "medium") {
      await persistResearch(caseId, result, cacheKey);
      return result;
    }

    // Check timeout budget before deep research
    if (Date.now() - taskStartTime > 120_000) {
      logger.warn("Research timeout budget exceeded for deep, returning medium results", { caseId, elapsed: Date.now() - taskStartTime });
      result.level = "medium";
      await persistResearch(caseId, result, cacheKey);
      return result;
    }

    // === DEEP: medium + full agency research brief ===
    try {
      const brief = await aiService.generateAgencyResearchBrief(caseData);
      if (brief?.suggested_agencies) {
        result.likely_record_custodians = brief.suggested_agencies.map(
          (a: any) => `${a.name} (${a.reason || "suggested custodian"})`
        );
      }
      if (brief?.summary) {
        result.record_type_handoff_notes = brief.summary;
      }
      result.agency_hierarchy_verified = true;
    } catch (e: any) {
      logger.warn("generateAgencyResearchBrief failed", { caseId, error: e.message });
    }

    await persistResearch(caseId, result, cacheKey);
    return result;
  } catch (error: any) {
    logger.error("Research context step failed, returning empty", { caseId, error: error.message });
    return emptyResearchContext();
  }
}

async function persistResearch(caseId: number, result: ResearchContext, cacheKey: string): Promise<void> {
  try {
    await db.updateCase(caseId, {
      research_context_jsonb: { ...result, _cache_key: cacheKey },
    });
  } catch (e: any) {
    logger.warn("Failed to persist research context", { caseId, error: e.message });
  }
}
