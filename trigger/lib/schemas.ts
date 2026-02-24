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
    .describe("Fee amount if quoted (in dollars, or null)"),

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
    ])
    .nullable()
    .describe("If intent is 'denial', the specific subtype"),

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

export type DraftOutput = z.infer<typeof draftSchema>;
