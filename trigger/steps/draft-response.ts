/**
 * Draft Response Step
 *
 * Port of langgraph/nodes/draft-response.js
 * Drafts email content based on proposalActionType.
 * Uses existing aiService methods (rewrite to Vercel AI SDK in Phase 2).
 */

import db, { aiService, decisionMemory, logger } from "../lib/db";
import type { DraftResult, ActionType, ResearchContext } from "../lib/types";

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

  // Fetch decision memory lessons
  let lessonsContext = "";
  try {
    const allMessages = await db.getMessagesByCaseId(caseId);
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
      const acceptFeeAmt = extractedFeeAmount || caseData.fee_amount || caseData.fee_quote_jsonb?.amount || 0;
      draft = await aiService.generateFeeResponse(caseData, {
        feeAmount: acceptFeeAmt,
        recommendedAction: "accept",
        instructions: adjustmentInstruction,
        lessonsContext,
        agencyMessage: latestInbound,
        agencyAnalysis: latestAnalysis,
      });
      break;
    }

    case "NEGOTIATE_FEE": {
      const negotiateFeeAmt = extractedFeeAmount || caseData.fee_amount || caseData.fee_quote_jsonb?.amount || 0;
      draft = await aiService.generateFeeResponse(caseData, {
        feeAmount: negotiateFeeAmt,
        recommendedAction: "negotiate",
        instructions: adjustmentInstruction,
        lessonsContext,
        agencyMessage: latestInbound,
        agencyAnalysis: latestAnalysis,
      });
      break;
    }

    case "DECLINE_FEE": {
      const declineFeeAmt = extractedFeeAmount || caseData.fee_amount || caseData.fee_quote_jsonb?.amount || 0;
      draft = await aiService.generateFeeResponse(caseData, {
        feeAmount: declineFeeAmt,
        recommendedAction: "decline",
        instructions: adjustmentInstruction,
        lessonsContext,
      });
      break;
    }

    case "RESPOND_PARTIAL_APPROVAL": {
      if (typeof aiService.generatePartialApprovalResponse === "function") {
        draft = await aiService.generatePartialApprovalResponse(
          latestInbound,
          latestAnalysis,
          caseData,
          { feeAmount: extractedFeeAmount, adjustmentInstruction, lessonsContext }
        );
      } else {
        draft = await aiService.generateDenialRebuttal(
          latestInbound,
          latestAnalysis,
          caseData,
          { scopeItems, adjustmentInstruction, lessonsContext }
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

    case "ESCALATE":
    case "CLOSE_CASE":
    case "NONE":
      return { subject: null, bodyText: null, bodyHtml: null, lessonsApplied };

    default:
      throw new Error(`Unknown action type for drafting: ${actionType}`);
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
