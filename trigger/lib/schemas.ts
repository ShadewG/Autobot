import { z } from "zod";

/**
 * Zod schema for inbound message classification.
 * Used with Vercel AI SDK generateObject() — guarantees valid structured output.
 */
export const classificationSchema = z.object({
  intent: z.enum([
    "fee_request",
    "question",
    "more_info_needed",
    "hostile",
    "denial",
    "partial_denial",
    "partial_approval",
    "partial_release",
    "portal_redirect",
    "acknowledgment",
    "records_ready",
    "delivery",
    "partial_delivery",
    "wrong_agency",
    "other",
  ]).describe("The primary intent of the agency's response"),

  confidence_score: z
    .number()
    .min(0)
    .max(1)
    .describe("Confidence in the classification (0-1)"),

  sentiment: z.enum(["positive", "neutral", "negative", "hostile"])
    .describe("Overall sentiment of the response"),

  key_points: z
    .array(z.string())
    .describe("Key factual points extracted from the response"),

  extracted_deadline: z
    .string()
    .nullable()
    .describe("Any deadline mentioned in the response (ISO date string or null)"),

  fee_amount: z
    .number()
    .nullable()
    .describe("The FOIA processing fee the agency is charging to produce records (in dollars). Only populate if the agency explicitly requires payment to fulfill this records request. Return null if the dollar amount is incidental content within the records (e.g., prices, bail, damages) rather than a charge for records production."),

  requires_response: z
    .boolean()
    .describe("Whether this message requires an email response from us"),

  portal_url: z
    .string()
    .nullable()
    .describe("Portal URL if agency redirects to a web portal"),

  suggested_action: z
    .string()
    .nullable()
    .describe("Recommended next action (e.g., 'wait', 'respond', 'use_portal', 'send_rebuttal', 'negotiate_fee')"),

  reason_no_response: z
    .string()
    .nullable()
    .describe("If requires_response is false, explain why no response is needed"),

  unanswered_agency_question: z
    .string()
    .nullable()
    .describe("If the agency asked a question we haven't answered, state the question here"),

  denial_subtype: z
    .enum([
      "no_records",
      "wrong_agency",
      "overly_broad",
      "ongoing_investigation",
      "privacy_exemption",
      "excessive_fees",
      "retention_expired",
      "glomar_ncnd",
      "not_reasonably_described",
      "no_duty_to_create",
      "privilege_attorney_work_product",
      "juvenile_records",
      "sealed_court_order",
      "third_party_confidential",
      "records_not_yet_created",
      "format_issue",
    ])
    .nullable()
    .describe("If intent is 'denial', the specific subtype"),

  jurisdiction_level: z
    .enum(["federal", "state", "local"])
    .nullable()
    .describe("Jurisdiction level of the responding agency"),

  response_nature: z
    .enum(["substantive", "procedural", "administrative", "mixed"])
    .nullable()
    .describe("Whether the response addresses the substance of the request or is procedural/administrative"),

  detected_exemption_citations: z
    .array(z.string())
    .describe("Any specific legal exemptions or statutes cited by the agency in their response"),

  decision_evidence_quotes: z
    .array(z.string())
    .describe("Key verbatim quotes from the agency response that support the classification decision"),

  constraints_to_add: z
    .array(z.string())
    .describe("Constraints to add based on this response (e.g., 'BWC_EXEMPT', 'FEE_REQUIRED')"),

  scope_updates: z
    .array(
      z.object({
        name: z.string().describe("Record item name"),
        status: z.enum(["REQUESTED", "DELIVERED", "DENIED", "PARTIAL", "EXEMPT"])
          .describe("Updated status for this record item"),
        reason: z.string().nullable().describe("Reason for status change"),
        confidence: z.number().min(0).max(1).nullable().describe("Confidence in this status assessment"),
      })
    )
    .describe("Updates to individual scope/record items based on this response"),

  fee_breakdown: z
    .object({
      hourly_rate: z.number().nullable(),
      estimated_hours: z.number().nullable(),
      items: z.array(z.string()).nullable(),
      deposit_required: z.number().nullable(),
    })
    .nullable()
    .describe("Detailed fee breakdown if available"),
}).strict();

export type ClassificationOutput = z.infer<typeof classificationSchema>;

/**
 * Schema for draft quality validation (used after AI generates a draft).
 * Not used with generateObject — used for post-generation validation.
 */
export const draftSchema = z.object({
  subject: z.string().min(1, "Subject cannot be empty"),
  body_text: z.string().min(10, "Body text too short"),
  body_html: z.string().nullable(),
});

// Decision schema - what action to take for an inbound message
export const decisionSchema = z.object({
  action: z.enum([
    "SEND_INITIAL_REQUEST", "SEND_FOLLOWUP", "SEND_REBUTTAL", "SEND_CLARIFICATION",
    "SEND_APPEAL", "SEND_FEE_WAIVER_REQUEST", "SEND_STATUS_UPDATE",
    "RESPOND_PARTIAL_APPROVAL", "ACCEPT_FEE", "NEGOTIATE_FEE", "DECLINE_FEE",
    "ESCALATE", "NONE", "CLOSE_CASE", "WITHDRAW", "RESEARCH_AGENCY",
    "REFORMULATE_REQUEST", "SUBMIT_PORTAL", "SEND_PDF_EMAIL",
  ]).describe("The best next action to take for this case"),
  reasoning: z.array(z.string()).describe("Step-by-step reasoning for this decision"),
  requiresHuman: z.boolean().describe("Whether this action needs human approval before execution"),
  pauseReason: z.enum(["FEE_QUOTE", "SCOPE", "DENIAL", "ID_REQUIRED", "SENSITIVE", "CLOSE_ACTION"]).nullable()
    .describe("Why human review is needed. Must be one of the allowed values."),
  confidence: z.number().min(0).max(1).describe("Confidence in this decision (0-1)"),
  adjustmentInstruction: z.string().nullable().describe("Specific instructions for drafting (e.g., 'negotiate fee down to $50')"),
  researchLevel: z.enum(["none", "light", "medium", "deep"])
    .describe("How much research to do before drafting (none=skip, light=contacts, medium=+laws, deep=+full custodian chain)"),
}).strict();

export type DecisionOutput = z.infer<typeof decisionSchema>;

// Constraint extraction schema - what constraints to add/update from an agency response
export const constraintExtractionSchema = z.object({
  constraintsToAdd: z.array(z.string()).describe("Constraint tags to add (e.g., 'BWC_EXEMPT', 'FEE_REQUIRED', 'ID_REQUIRED', 'INVESTIGATION_ACTIVE', 'DENIAL_RECEIVED')"),
  scopeUpdates: z.array(z.object({
    name: z.string().describe("Record item name"),
    status: z.enum(["REQUESTED", "DELIVERED", "DENIED", "PARTIAL", "EXEMPT"]).describe("Updated status"),
    reason: z.string().nullable().describe("Reason for status change"),
    confidence: z.number().min(0).max(1).nullable().describe("Confidence in this assessment"),
  })).describe("Updates to individual record items"),
  reasoning: z.string().describe("Explanation of what constraints were extracted and why"),
}).strict();

export type ConstraintExtractionOutput = z.infer<typeof constraintExtractionSchema>;

// Safety review schema - is the draft safe to send
export const safetyReviewSchema = z.object({
  safe: z.boolean().describe("Whether the draft is safe to send as-is"),
  riskFlags: z.array(z.string()).describe("Critical risk flags (e.g., 'REQUESTS_EXEMPT_ITEM', 'CONTRADICTS_FEE_ACCEPTANCE', 'CONTAINS_PII')"),
  warnings: z.array(z.string()).describe("Non-critical warnings about the draft"),
  reasoning: z.string().describe("Explanation of the safety assessment"),
  law_fit_valid: z.boolean()
    .describe("Whether the legal citations match the jurisdiction (e.g., not citing federal FOIA for a state agency)"),
  law_fit_issues: z.array(z.string())
    .describe("Specific law-jurisdiction mismatches found"),
  requester_consistency_valid: z.boolean()
    .describe("Whether the draft is consistent with prior requester positions (e.g., not negotiating after accepting fee)"),
  requester_consistency_issues: z.array(z.string())
    .describe("Specific consistency issues with prior requester actions"),
}).strict();

// Research context schema - structured output from research step
export const researchContextSchema = z.object({
  level: z.enum(["none", "light", "medium", "deep"]).describe("Research depth level executed"),
  agency_hierarchy_verified: z.boolean().describe("Whether the agency hierarchy was verified"),
  likely_record_custodians: z.array(z.string()).describe("Agencies/units likely holding the requested records"),
  official_records_submission_methods: z.array(z.string()).describe("Official ways to submit records requests to this agency"),
  portal_url_verified: z.boolean().describe("Whether any portal URL was verified as working"),
  state_law_notes: z.string().nullable().describe("Relevant state law notes for the denial type and jurisdiction"),
  record_type_handoff_notes: z.string().nullable().describe("Notes about which record types are held by which custodians"),
  rebuttal_support_points: z.array(z.string()).describe("Specific legal/factual points supporting a rebuttal"),
  clarification_answer_support: z.string().nullable().describe("Research that helps answer the agency's clarification question"),
}).strict();

export type ResearchContextOutput = z.infer<typeof researchContextSchema>;

export type SafetyReviewOutput = z.infer<typeof safetyReviewSchema>;

export type DraftOutput = z.infer<typeof draftSchema>;
