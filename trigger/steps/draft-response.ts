/**
 * Draft Response Step
 *
 * Port of langgraph/nodes/draft-response.js
 * Drafts email content based on proposalActionType.
 * Uses existing aiService methods (rewrite to Vercel AI SDK in Phase 2).
 */

import db, { aiService, decisionMemory, logger } from "../lib/db";
import type { DraftResult, ActionType, ResearchContext } from "../lib/types";
import { textClaimsAttachment, stripAttachmentClaimLines } from "../lib/text-sanitize";

export async function draftResponse(
  caseId: number,
  actionType: ActionType,
  constraints: string[],
  scopeItems: any[],
  extractedFeeAmount: number | null,
  adjustmentInstruction: string | null,
  messageId: number | null,
  researchCtx?: ResearchContext
): Promise<DraftResult> {
  const caseData = await db.getCaseById(caseId);
  const lessonsApplied: any[] = [];

  // Fetch the inbound message that triggered this
  let latestInbound: any = null;
  let latestAnalysis: any = null;
  if (messageId) {
    latestInbound = await db.getMessageById(messageId);
    latestAnalysis = latestInbound
      ? await db.getResponseAnalysisByMessageId(messageId)
      : null;
  }
  if (!latestInbound) {
    const messages = await db.getMessagesByCaseId(caseId);
    latestInbound = messages.find((m: any) => m.direction === "inbound") || null;
    latestAnalysis = latestInbound
      ? await db.getResponseAnalysisByMessageId(latestInbound.id)
      : null;
  }

  // Build correspondence context for AI grounding (last 15 messages)
  let correspondenceContext = "";
  let lessonsContext = "";
  try {
    const allMessages = await db.getMessagesByCaseId(caseId);
    const recentMessages = allMessages.slice(0, 15).reverse();

    // Build case brief — gives every ai-service method full context
    const briefParts: string[] = [];
    briefParts.push(`## Case Brief`);
    briefParts.push(`- Agency: ${caseData.agency_name || "Unknown"} (${caseData.agency_email || "no email"})`);
    briefParts.push(`- State: ${caseData.state || "Unknown"}`);
    briefParts.push(`- Subject: ${caseData.subject_name || "Unknown"}`);
    briefParts.push(`- Status: ${caseData.status || "Unknown"} (${caseData.substatus || "none"})`);
    if (caseData.incident_date) briefParts.push(`- Incident date: ${caseData.incident_date}`);
    if (caseData.incident_location) briefParts.push(`- Incident location: ${caseData.incident_location}`);
    if (caseData.send_date) briefParts.push(`- Initial request sent: ${new Date(caseData.send_date).toISOString().split("T")[0]}`);
    if (caseData.deadline_date) briefParts.push(`- Deadline: ${new Date(caseData.deadline_date).toISOString().split("T")[0]}`);
    if (caseData.days_overdue > 0) briefParts.push(`- Days overdue: ${caseData.days_overdue}`);

    // Constraints
    const constraints = caseData.constraints_jsonb || caseData.constraints || [];
    if (Array.isArray(constraints) && constraints.length > 0) {
      briefParts.push(`- Constraints: ${constraints.join(", ")}`);
    }

    // Scope items
    const scopeItems = caseData.scope_items_jsonb || caseData.scope_items || [];
    if (Array.isArray(scopeItems) && scopeItems.length > 0) {
      briefParts.push(`- Scope items: ${scopeItems.map((s: any) => `${s.name || s.description || JSON.stringify(s)} [${s.status || "REQUESTED"}]`).join("; ")}`);
    }

    // Fee info
    const feeQuote = caseData.fee_quote_jsonb;
    if (feeQuote) {
      briefParts.push(`- Fee quote: $${feeQuote.amount || feeQuote.fee_amount || "unknown"} (${feeQuote.status || "quoted"})`);
    } else if (caseData.fee_amount) {
      briefParts.push(`- Fee on file: $${caseData.fee_amount}`);
    }

    // Portal info
    if (caseData.portal_url || caseData.last_portal_status) {
      briefParts.push(`- Portal: ${caseData.portal_provider || "unknown"} — ${caseData.last_portal_status || "unknown"} (${caseData.portal_url || "no URL"})`);
    }

    // Research context
    const research = caseData.research_context_jsonb;
    if (research) {
      if (research.state_law_notes) briefParts.push(`- State law notes: ${String(research.state_law_notes).substring(0, 500)}`);
      if (research.rebuttal_support_points?.length) {
        briefParts.push(`- Rebuttal points: ${research.rebuttal_support_points.slice(0, 5).join("; ")}`);
      }
    }

    const caseBrief = briefParts.join("\n");

    correspondenceContext = recentMessages
      .map((m: any) => {
        let dir: string;
        if (m.portal_notification) {
          dir = `PORTAL NOTIFICATION (${m.portal_notification_provider || "unknown"})`;
        } else {
          dir = m.direction === "inbound" ? "AGENCY REPLY" : "OUR MESSAGE";
        }
        const date = m.sent_at || m.received_at || m.created_at;
        const dateStr = date ? new Date(date).toISOString().split("T")[0] : "unknown";
        const sender = m.direction === "inbound" ? (m.from_email || "") : (m.to_email || "");
        return `[${dir} | ${dateStr} | ${sender}] ${m.subject || ""}\n${(m.body_text || "").substring(0, 800)}`;
      })
      .join("\n---\n");

    // Prepend case brief so all ai-service methods get full context
    correspondenceContext = `${caseBrief}\n\n## Correspondence Thread (most recent last)\n${correspondenceContext}`;

    logger.info("Draft correspondence context prepared", {
      caseId,
      messageCount: recentMessages.length,
      briefLength: caseBrief.length,
      preview: correspondenceContext.substring(0, 200),
    });

    const priorProposals = await db.getAllProposalsByCaseId(caseId);
    const followupSchedule = await db.getFollowUpScheduleByCaseId(caseId);
    const enrichedCaseData = {
      ...caseData,
      followup_count: followupSchedule?.followup_count || 0,
    };
    const lessons = await decisionMemory.getRelevantLessons(enrichedCaseData, {
      messages: allMessages,
      priorProposals,
    });
    if (lessons.length > 0) {
      lessonsContext = decisionMemory.formatLessonsForPrompt(lessons);
      lessonsApplied.push(
        ...lessons.map((l: any) => ({
          id: l.id,
          category: l.category,
          trigger: l.trigger_pattern,
          lesson: l.lesson,
          score: l.relevance_score,
          priority: l.priority,
        }))
      );
    }
  } catch (err: any) {
    logger.warn("Failed to fetch decision lessons", { caseId, error: err.message });
  }

  let draft: any = {
    subject: null,
    body_text: null,
    body_html: null,
  };

  switch (actionType) {
    case "SEND_FOLLOWUP": {
      const followupSchedule = await db.getFollowUpScheduleByCaseId(caseId);
      const attemptNumber = (followupSchedule?.followup_count || 0) + 1;
      draft = await aiService.generateFollowUp(caseData, attemptNumber, {
        adjustmentInstruction,
        lessonsContext,
        correspondenceContext,
      });
      break;
    }

    case "SEND_REBUTTAL": {
      const exemptItems = (constraints || []).filter((c: string) => c.endsWith("_EXEMPT"));
      let rebuttalAdjust = adjustmentInstruction || "";
      if (extractedFeeAmount) {
        const feeNote = `The agency also quoted a fee of $${extractedFeeAmount}. In your rebuttal, make clear that we are willing to pay the fee ONLY once BWC/video footage is confirmed to be included. Do NOT accept the fee unconditionally.`;
        rebuttalAdjust = rebuttalAdjust ? `${rebuttalAdjust}\n${feeNote}` : feeNote;
      }
      draft = await aiService.generateDenialRebuttal(
        latestInbound,
        latestAnalysis,
        caseData,
        {
          excludeItems: exemptItems,
          scopeItems,
          adjustmentInstruction: rebuttalAdjust || undefined,
          lessonsContext,
          correspondenceContext,
          legalResearchOverride: researchCtx?.state_law_notes || undefined,
          rebuttalSupportPoints: researchCtx?.rebuttal_support_points?.length
            ? researchCtx.rebuttal_support_points
            : undefined,
        }
      );
      break;
    }

    case "SEND_CLARIFICATION": {
      if (typeof aiService.generateClarificationResponse === "function") {
        draft = await aiService.generateClarificationResponse(
          latestInbound,
          latestAnalysis,
          caseData,
          {
            adjustmentInstruction,
            lessonsContext,
            correspondenceContext,
            clarificationResearch: researchCtx?.clarification_answer_support || undefined,
          }
        );
      } else {
        draft = await aiService.generateAutoReply(latestInbound, latestAnalysis, caseData);
      }
      break;
    }

    case "ACCEPT_FEE":
    case "APPROVE_FEE" as any: {
      const acceptFeeAmt = extractedFeeAmount || caseData.fee_amount || caseData.fee_quote_jsonb?.amount || null;
      draft = await aiService.generateFeeResponse(caseData, {
        feeAmount: acceptFeeAmt,
        recommendedAction: "accept",
        instructions: adjustmentInstruction,
        lessonsContext,
        correspondenceContext,
        agencyMessage: latestInbound,
        agencyAnalysis: latestAnalysis,
      });
      break;
    }

    case "NEGOTIATE_FEE": {
      const negotiateFeeAmt = extractedFeeAmount || caseData.fee_amount || caseData.fee_quote_jsonb?.amount || null;
      draft = await aiService.generateFeeResponse(caseData, {
        feeAmount: negotiateFeeAmt,
        recommendedAction: "negotiate",
        instructions: adjustmentInstruction,
        lessonsContext,
        correspondenceContext,
        agencyMessage: latestInbound,
        agencyAnalysis: latestAnalysis,
      });
      break;
    }

    case "DECLINE_FEE": {
      const declineFeeAmt = extractedFeeAmount || caseData.fee_amount || caseData.fee_quote_jsonb?.amount || null;
      draft = await aiService.generateFeeResponse(caseData, {
        feeAmount: declineFeeAmt,
        recommendedAction: "decline",
        instructions: adjustmentInstruction,
        lessonsContext,
        correspondenceContext,
      });
      break;
    }

    case "RESPOND_PARTIAL_APPROVAL": {
      if (typeof aiService.generatePartialApprovalResponse === "function") {
        draft = await aiService.generatePartialApprovalResponse(
          latestInbound,
          latestAnalysis,
          caseData,
          { feeAmount: extractedFeeAmount, adjustmentInstruction, lessonsContext, correspondenceContext }
        );
      } else {
        draft = await aiService.generateDenialRebuttal(
          latestInbound,
          latestAnalysis,
          caseData,
          { scopeItems, adjustmentInstruction, lessonsContext, correspondenceContext }
        );
      }
      break;
    }

    case "SEND_APPEAL": {
      if (typeof aiService.generateAppealLetter === "function") {
        draft = await aiService.generateAppealLetter(
          latestInbound,
          latestAnalysis,
          caseData,
          {
            adjustmentInstruction,
            lessonsContext,
            correspondenceContext,
            legalResearchOverride: researchCtx?.state_law_notes || undefined,
            rebuttalSupportPoints: researchCtx?.rebuttal_support_points?.length
              ? researchCtx.rebuttal_support_points
              : undefined,
          }
        );
      } else {
        // Fallback: use rebuttal generator with appeal instruction
        draft = await aiService.generateDenialRebuttal(
          latestInbound,
          latestAnalysis,
          caseData,
          {
            scopeItems,
            adjustmentInstruction: (adjustmentInstruction || "") + "\nFrame this as a formal administrative appeal, not just a rebuttal. Cite appeal procedures and deadlines.",
            lessonsContext,
            correspondenceContext,
            legalResearchOverride: researchCtx?.state_law_notes || undefined,
          }
        );
      }
      break;
    }

    case "SEND_FEE_WAIVER_REQUEST": {
      draft = await aiService.generateFeeResponse(caseData, {
        feeAmount: extractedFeeAmount || null,
        recommendedAction: "waiver",
        instructions: adjustmentInstruction,
        lessonsContext,
        correspondenceContext,
        agencyMessage: latestInbound,
        agencyAnalysis: latestAnalysis,
      });
      break;
    }

    case "SEND_STATUS_UPDATE": {
      const followupSchedule = await db.getFollowUpScheduleByCaseId(caseId);
      draft = await aiService.generateFollowUp(caseData, 0, {
        adjustmentInstruction: (adjustmentInstruction || "") + "\nThis is a brief status inquiry, not a follow-up. Keep it under 100 words. Ask for an update on when records will be available.",
        lessonsContext,
        correspondenceContext,
      });
      break;
    }

    case "RESEARCH_AGENCY": {
      // Check if research step already stored referral data (from agency redirect)
      let existingReferral: any = null;
      try {
        const freshCase = await db.getCaseById(caseId);
        if (freshCase?.contact_research_notes) {
          const parsed = typeof freshCase.contact_research_notes === "string"
            ? JSON.parse(freshCase.contact_research_notes)
            : freshCase.contact_research_notes;
          if (parsed.contactResult?.source === "agency_referral") {
            existingReferral = parsed;
          }
        }
      } catch (e: any) { /* non-fatal */ }

      if (existingReferral) {
        // Referral data already present from research step — don't overwrite
        logger.info("Using existing referral data for RESEARCH_AGENCY draft", { caseId });
        return {
          subject: null,
          bodyText: null,
          bodyHtml: null,
          lessonsApplied,
          researchContactResult: existingReferral.contactResult,
          researchBrief: existingReferral.brief,
        };
      }

      // No referral — fall back to PD lookup + AI research
      // @ts-ignore
      let contactResult = null;
      try {
        // @ts-ignore
        const pdContactService = require("../../services/pd-contact-service");
        contactResult = await pdContactService.lookupContact(
          caseData.agency_name,
          caseData.state || caseData.incident_location
        );
      } catch (e: any) {
        /* PD-contact lookup unavailable */
      }
      const brief = await aiService.generateAgencyResearchBrief(caseData);
      await db.updateCase(caseId, {
        contact_research_notes: JSON.stringify({ contactResult, brief }),
        last_contact_research_at: new Date(),
      });
      return {
        subject: null,
        bodyText: null,
        bodyHtml: null,
        lessonsApplied,
        researchContactResult: contactResult,
        researchBrief: brief,
      };
    }

    case "REFORMULATE_REQUEST": {
      const analysis = await db.getLatestResponseAnalysis(caseId);
      const reformulated = await aiService.generateReformulatedRequest(caseData, analysis);
      return {
        subject: reformulated.subject,
        bodyText: reformulated.body_text,
        bodyHtml: reformulated.body_html || null,
        lessonsApplied,
      };
    }

    case "SEND_INITIAL_REQUEST":
    case "SUBMIT_PORTAL": {
      let enrichedCaseData = { ...caseData };

      // When re-drafting with an adjustment, check for a referral agency in
      // contact_research_notes. This data is set by RESEARCH_AGENCY/WRONG_AGENCY
      // steps and tells us who actually holds the records.
      if (adjustmentInstruction) {
        try {
          const contactNotes = caseData.contact_research_notes
            ? (typeof caseData.contact_research_notes === "string"
              ? JSON.parse(caseData.contact_research_notes)
              : caseData.contact_research_notes)
            : null;
          if (contactNotes?.contactResult?.contact_email) {
            const referralName = contactNotes.brief?.suggested_agencies?.[0]?.name
              || researchCtx?.likely_record_custodians?.[0]?.split(" (")[0]
              || enrichedCaseData.agency_name;
            logger.info("Overriding agency for FOIA re-draft from referral", {
              caseId, from: enrichedCaseData.agency_name, to: referralName,
              email: contactNotes.contactResult.contact_email,
            });
            enrichedCaseData.agency_name = referralName;
            enrichedCaseData.agency_email = contactNotes.contactResult.contact_email;
            enrichedCaseData.portal_url = contactNotes.contactResult.portal_url || null;

            // Persist override to DB so executeAction sends to the right address
            await db.updateCase(caseId, {
              agency_name: referralName,
              agency_email: contactNotes.contactResult.contact_email,
              portal_url: contactNotes.contactResult.portal_url || null,
            });
          }
        } catch (e: any) {
          logger.warn("Failed to parse contact_research_notes for agency override", { caseId, error: e.message });
        }

        enrichedCaseData.additional_details = `${enrichedCaseData.additional_details || ''}\n\nCRITICAL ADJUSTMENT INSTRUCTION: ${adjustmentInstruction}`.trim();
      }

      const foiaResult = await aiService.generateFOIARequest(enrichedCaseData);
      const foiaText = foiaResult?.request_text || foiaResult?.body || foiaResult?.requestText;
      if (!foiaText) throw new Error(`AI returned empty FOIA request for case ${caseId}`);
      draft = {
        subject: `Public Records Request - ${enrichedCaseData.subject_name || 'Records Request'}`,
        body_text: foiaText,
        body_html: null,
      };
      break;
    }

    case "ESCALATE":
    case "CLOSE_CASE":
    case "NONE":
      return { subject: null, bodyText: null, bodyHtml: null, lessonsApplied };

    default:
      throw new Error(`Unknown action type for drafting: ${actionType}`);
  }

  // Drafts are often reviewed before execution; sanitize attachment claims here
  // as well (execution-time sanitization is too late for gated proposals).
  if (textClaimsAttachment(draft.body_text) || textClaimsAttachment(draft.body_html)) {
    draft.body_text = draft.body_text ? stripAttachmentClaimLines(draft.body_text) : draft.body_text;
    draft.body_html = null; // Rebuild from sanitized text.
    logger.warn("Removed attachment claim from generated draft", { caseId, actionType });
  }

  // Convert text to HTML if missing, handling any markdown formatting
  if (!draft.body_html && draft.body_text) {
    const htmlBody = draft.body_text
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/\*([^*]+)\*/g, '<em>$1</em>')
      .replace(/\n\n/g, '</p><p>')
      .replace(/\n/g, '<br>');
    draft.body_html = `<p>${htmlBody}</p>`;
  }

  return {
    subject: draft.subject,
    bodyText: draft.body_text,
    bodyHtml: draft.body_html,
    lessonsApplied,
  };
}
