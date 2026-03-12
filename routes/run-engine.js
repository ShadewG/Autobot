/**
 * Run Engine Routes
 *
 * Phase 3: Public APIs for triggering and resuming agent runs.
 *
 * Routes:
 * - POST /cases/:id/run-initial   - Trigger initial FOIA request generation
 * - POST /cases/:id/run-inbound   - Process inbound message
 * - POST /proposals/:id/decision  - Submit human decision to resume
 *
 * Each route creates an agent_run record for auditability and enqueues
 * the appropriate worker job.
 */

const express = require('express');
const router = express.Router();
const db = require('../services/database');
const { wait: triggerWait } = require('@trigger.dev/sdk');
const triggerDispatch = require('../services/trigger-dispatch-service');
const logger = require('../services/logger');
const { emailExecutor } = require('../services/executor-adapter');
const {
  transitionCaseRuntime: transitionCaseRuntimeUnsafe,
  CaseLockContention,
} = require('../services/case-runtime');
const { HUMAN_REVIEW_PROPOSAL_STATUSES, buildCaseTruth } = require('../lib/case-truth');
const aiService = require('../services/ai-service');
const pdfFormService = require('../services/pdf-form-service');
const proposalLifecycle = require('../services/proposal-lifecycle');
const { autoCaptureEvalCase, captureDismissFeedback } = require('../services/proposal-feedback');
const { buildApprovalDraftUpdates } = require('../services/proposal-draft-history');
const { classifyOperatorActionError, buildOperatorActionErrorResponse } = require('../services/operator-action-errors');
const { isSupportedPortalUrl } = require('../utils/portal-utils');
const { buildHumanDecision } = proposalLifecycle;
const feeWorkflowService = require('../services/fee-workflow-service');

async function transitionCaseRuntime(caseId, event, context = {}, options = {}) {
  const maxAttempts = options.maxAttempts || 5;
  const baseDelayMs = options.baseDelayMs || 150;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await transitionCaseRuntimeUnsafe(caseId, event, context);
    } catch (error) {
      if (!(error instanceof CaseLockContention) || attempt === maxAttempts) {
        throw error;
      }
      logger.warn('Retrying case runtime transition after lock contention', {
        caseId,
        event,
        attempt,
        maxAttempts,
      });
      await new Promise(resolve => setTimeout(resolve, baseDelayMs * attempt));
    }
  }
}

// Trigger.dev queue + idempotency options for per-case concurrency control
function triggerOpts(caseId, taskType, uniqueId) {
  return {
    queue: `case-${caseId}`,
    idempotencyKey: `${taskType}:${caseId}:${uniqueId || Date.now()}`,
    idempotencyKeyTTL: "1h",
  };
}

// Trigger options with debounce for human review resolution paths
// NOTE: idempotency keys take precedence over debounce, so we omit them here
function triggerOptsDebounced(caseId, taskType, uniqueId) {
  return {
    queue: `case-${caseId}`,
    debounce: {
      key: `${taskType}:${caseId}`,
      delay: "5s",
      mode: "trailing",
    },
  };
}

function getTriggerRunId(run) {
  if (!run) return null;
  const metadata = (() => {
    if (!run.metadata) return {};
    if (typeof run.metadata === 'string') {
      try {
        return JSON.parse(run.metadata);
      } catch {
        return {};
      }
    }
    return run.metadata;
  })();
  return run.trigger_run_id || metadata.triggerRunId || metadata.trigger_run_id || null;
}

function canSupersedeForExplicitStart(existingRun) {
  if (!existingRun) return false;

  const status = String(existingRun.status || '').toLowerCase();
  const triggerType = String(existingRun.trigger_type || '').toLowerCase();
  const metadata = (() => {
    if (!existingRun.metadata) return {};
    if (typeof existingRun.metadata === 'string') {
      try {
        return JSON.parse(existingRun.metadata);
      } catch {
        return {};
      }
    }
    return existingRun.metadata;
  })();
  const currentNode = String(metadata.current_node || '').toLowerCase();

  if (!['waiting', 'paused', 'gated'].includes(status)) {
    return false;
  }

  return (
    triggerType === 'human_review_resolution' ||
    currentNode === 'wait_human_decision' ||
    currentNode === 'wait_human_review'
  );
}

async function supersedeActiveReviewRun(caseId, reason) {
  const tokensToComplete = await db.query(
    `SELECT id, waitpoint_token FROM proposals
     WHERE case_id = $1
       AND status IN ('PENDING_APPROVAL', 'BLOCKED')
       AND waitpoint_token IS NOT NULL`,
    [caseId]
  );

  for (const proposal of tokensToComplete.rows) {
    try {
      await triggerWait.completeToken(proposal.waitpoint_token, {
        action: 'DISMISS',
        reason,
      });
    } catch (error) {
      logger.warn('Failed to complete waitpoint token while superseding active review run', {
        caseId,
        proposalId: proposal.id,
        error: error.message,
      });
    }
  }

  await proposalLifecycle.dismissActiveCaseProposals(caseId, {
    humanDecision: {
      type: 'dismiss',
      decidedBy: 'human',
      reason,
      supersededByAction: 'start_request_for_agency',
    },
  });

  await db.query(
    `UPDATE agent_runs
     SET status = 'failed',
         ended_at = NOW(),
         error = COALESCE(error, $2)
     WHERE case_id = $1
       AND status IN ('created', 'queued', 'processing', 'running', 'paused', 'waiting', 'gated')`,
    [caseId, reason]
  );
}

function getProposalDecisionErrorCode(error) {
  return classifyOperatorActionError(error, 'PROPOSAL_DECISION_FAILED');
}

async function ensureCaseThread(caseId, subject, agencyEmail = null) {
  let thread = await db.getThreadByCaseId(caseId);
  if (thread) return thread;

  try {
    return await db.createEmailThread({
      case_id: caseId,
      subject,
      agency_email: agencyEmail || `case-${caseId}@local.invalid`,
    });
  } catch (error) {
    if (error?.code === '23505') {
      return db.getThreadByCaseId(caseId);
    }
    throw error;
  }
}

function isOrphanedWaitingRun(run) {
  if (!run) return false;
  if (!['waiting', 'paused'].includes(String(run.status || '').toLowerCase())) return false;
  return !getTriggerRunId(run);
}

function normalizeInboundAttachments(rawAttachments) {
  if (!Array.isArray(rawAttachments)) return [];
  return rawAttachments
    .map((attachment) => {
      if (!attachment || typeof attachment !== 'object') return null;
      const filename = String(attachment.filename || '').trim();
      if (!filename) return null;
      const contentType = String(
        attachment.content_type || attachment.type || 'application/octet-stream'
      ).trim();
      const extractedText = attachment.extracted_text == null
        ? null
        : String(attachment.extracted_text);
      const contentBase64 = attachment.content_base64 == null
        ? null
        : String(attachment.content_base64).trim();
      const sizeBytes = Number(attachment.size_bytes);
      return {
        filename,
        contentType,
        extractedText,
        contentBase64,
        sizeBytes: Number.isFinite(sizeBytes) && sizeBytes >= 0 ? sizeBytes : null,
      };
    })
    .filter(Boolean);
}

async function reconcileCaseAfterDismiss(caseId, proposal = null) {
  const remaining = await db.query(
    `SELECT 1 FROM proposals WHERE case_id = $1 AND status IN ('PENDING_APPROVAL','BLOCKED','PENDING_PORTAL') LIMIT 1`,
    [caseId]
  );
  if (remaining.rows.length > 0) return;

  const caseRow = await db.getCaseById(caseId);
  const REVIEW_STATUSES = ['needs_human_review', 'needs_phone_call', 'needs_contact_info', 'needs_human_fee_approval', 'needs_rebuttal', 'pending_fee_decision', 'id_state'];
  const shouldReconcile = Boolean(caseRow) && (
    Boolean(caseRow.requires_human) ||
    REVIEW_STATUSES.includes(String(caseRow.status || ''))
  );

  if (!shouldReconcile) return;

  const dismissMeansNoFurtherAction =
    Boolean(proposal?.trigger_message_id) &&
    ['SEND_REBUTTAL', 'ACCEPT_FEE', 'NEGOTIATE_FEE', 'SEND_FOLLOWUP', 'ESCALATE'].includes(String(proposal?.action_type || '').toUpperCase());

  if (dismissMeansNoFurtherAction) {
    await db.updateCase(caseId, {
      status: 'responded',
      requires_human: false,
      pause_reason: null,
      substatus: 'Proposal dismissed — no further action',
    });
    logger.info('Reconciled case after dismiss: cleared review state with no further action', {
      caseId,
      actionType: proposal.action_type,
    });
    return;
  }

  if (REVIEW_STATUSES.includes(String(caseRow.status || ''))) {
    const currentStatus = String(caseRow.status || '').toLowerCase();
    const manualTargetStatus =
      currentStatus === 'needs_phone_call'
        ? 'needs_phone_call'
        : currentStatus === 'pending_fee_decision'
        ? 'pending_fee_decision'
        : currentStatus === 'needs_rebuttal'
        ? 'needs_rebuttal'
        : 'needs_human_review';
    await transitionCaseRuntime(caseId, 'CASE_ESCALATED', {
      targetStatus: manualTargetStatus,
      pauseReason: 'EXECUTION_BLOCKED',
      substatus: 'Proposal dismissed — manual action required',
      escalationReason: 'proposal_dismissed_manual_takeover',
    });
    await db.updateCase(caseId, {
      status: manualTargetStatus,
      requires_human: true,
      pause_reason: 'EXECUTION_BLOCKED',
      substatus: 'Proposal dismissed — manual action required',
    });
    logger.info('Reconciled case after dismiss: moved case to manual review', {
      caseId,
      from: caseRow.status,
      to: manualTargetStatus,
    });
  } else {
    await transitionCaseRuntime(caseId, 'CASE_RECONCILED', { targetStatus: caseRow.status });
    logger.info('Reconciled case after dismiss: cleared stale flags', { caseId, status: caseRow.status });
  }
}

async function createAdjustedInitialRequestProposalLocally(proposal, humanDecision, existingRun) {
  const caseId = proposal.case_id;
  const caseData = await db.getCaseById(caseId);
  if (!caseData) {
    throw new Error(`Case ${caseId} not found for local adjustment`);
  }

  const adjustedCaseData = {
    ...caseData,
    additional_details: `${caseData.additional_details || ''}\n\nCRITICAL ADJUSTMENT INSTRUCTION: ${humanDecision.instruction || ''}`.trim(),
  };
  const generated = await aiService.generateFOIARequest(adjustedCaseData);
  const subject =
    generated.subject ||
    `Public Records Request - ${adjustedCaseData.subject_name || 'Records Request'}`;
  const bodyText = generated.body || generated.requestText || generated.request_text;
  if (!bodyText || typeof bodyText !== 'string' || !bodyText.trim()) {
    throw new Error(`Local adjustment generated an empty draft for case ${caseId}`);
  }

  await proposalLifecycle.applyHumanReviewDecision(proposal.id, {
    status: 'DISMISSED',
    humanDecision,
  });

  const adjustedProposal = await db.upsertProposal({
    proposalKey: `${caseId}:initial:${proposal.action_type}:adjust:${Date.now()}`,
    caseId,
    runId: existingRun?.id || proposal.run_id || null,
    triggerMessageId: null,
    actionType: proposal.action_type,
    draftSubject: subject,
    draftBodyText: bodyText,
    draftBodyHtml: generated.body_html || null,
    reasoning: [
      `Locally adjusted ${proposal.action_type} for ${adjustedCaseData.agency_name}`,
      `Adjustment instruction: ${humanDecision.instruction || 'none'}`,
    ],
    canAutoExecute: false,
    requiresHuman: true,
    status: 'PENDING_APPROVAL',
    gateOptions: Array.isArray(proposal.gate_options) && proposal.gate_options.length > 0
      ? proposal.gate_options
      : ['APPROVE', 'ADJUST', 'DISMISS', 'WITHDRAW'],
  });

  await db.updateProposal(adjustedProposal.id, {
    waitpoint_token: `local-ready-to-send-adjust:${caseId}:${adjustedProposal.id}`,
  });

  if (existingRun?.id) {
    await db.updateAgentRun(existingRun.id, {
      status: 'waiting',
      metadata: {
        ...(existingRun.metadata || {}),
        local_adjustment: true,
        proposalId: adjustedProposal.id,
      },
    });
  }

  await db.query(
    `UPDATE cases
     SET requires_human = true,
         pause_reason = 'PENDING_APPROVAL',
         status = 'needs_human_review',
         updated_at = NOW()
     WHERE id = $1`,
    [caseId]
  );

  return adjustedProposal;
}

async function createAdjustedClarificationProposalLocally(proposal, humanDecision, existingRun) {
  const caseId = proposal.case_id;
  const caseData = await db.getCaseById(caseId);
  if (!caseData) {
    throw new Error(`Case ${caseId} not found for local clarification adjustment`);
  }

  const triggerMessageId = proposal.trigger_message_id || existingRun?.message_id || null;
  const inboundMessage = triggerMessageId
    ? await db.getMessageById(triggerMessageId)
    : await db.getLatestInboundMessage(caseId);

  const revisionPrompt = `You are revising a clarification-response email for a public records request.

Original draft:
${proposal.draft_body_text || ''}

Human instruction for revision:
${humanDecision.instruction || ''}

Context:
- Agency: ${caseData.agency_name || 'Unknown agency'}
- Subject: ${caseData.subject_name || caseData.case_name || 'Public Records Request'}
- Inbound message subject: ${inboundMessage?.subject || 'N/A'}
- Inbound message body:
${(inboundMessage?.body_text || '').substring(0, 3000)}

Requirements:
- Follow the human instruction exactly.
- Keep the draft professional and concise.
- Preserve any already-known requester facts that belong in the draft.
- Return ONLY the revised email body text.`;

  let bodyText = await aiService.callAI(revisionPrompt, { effort: 'medium' });
  const userSignature = await aiService.getUserSignatureForCase(caseData);
  bodyText = aiService.normalizeGeneratedDraftSignature(bodyText, userSignature, {
    includeEmail: false,
    includeAddress: false,
  });
  bodyText = aiService.sanitizeClarificationDraft(bodyText, userSignature);

  if (!bodyText || typeof bodyText !== 'string' || !bodyText.trim()) {
    throw new Error(`Local clarification adjustment generated an empty draft for case ${caseId}`);
  }

  await proposalLifecycle.applyHumanReviewDecision(proposal.id, {
    status: 'DISMISSED',
    humanDecision,
  });

  const adjustedProposal = await db.upsertProposal({
    proposalKey: `${caseId}:clarification:${proposal.action_type}:adjust:${Date.now()}`,
    caseId,
    runId: existingRun?.id || proposal.run_id || null,
    triggerMessageId: triggerMessageId,
    actionType: proposal.action_type,
    draftSubject: proposal.draft_subject || inboundMessage?.subject || `RE: ${caseData.case_name || 'Public Records Request'}`,
    draftBodyText: bodyText,
    draftBodyHtml: null,
    reasoning: [
      `Locally adjusted ${proposal.action_type} for ${caseData.agency_name || 'agency'}`,
      `Adjustment instruction: ${humanDecision.instruction || 'none'}`,
    ],
    canAutoExecute: false,
    requiresHuman: true,
    status: 'PENDING_APPROVAL',
    gateOptions: Array.isArray(proposal.gate_options) && proposal.gate_options.length > 0
      ? proposal.gate_options
      : ['APPROVE', 'ADJUST', 'DISMISS', 'WITHDRAW'],
  });

  await db.updateProposal(adjustedProposal.id, {
    waitpoint_token: `local-inbound-adjust:${caseId}:${adjustedProposal.id}`,
  });

  if (existingRun?.id) {
    await db.updateAgentRun(existingRun.id, {
      status: 'waiting',
      metadata: {
        ...(existingRun.metadata || {}),
        local_adjustment: true,
        proposalId: adjustedProposal.id,
      },
    });
  }

  await db.query(
    `UPDATE cases
     SET requires_human = true,
         pause_reason = 'PENDING_APPROVAL',
         status = 'needs_human_review',
         updated_at = NOW()
     WHERE id = $1`,
    [caseId]
  );

  return adjustedProposal;
}

async function createAdjustedPdfEmailProposalLocally(proposal, humanDecision, existingRun) {
  const caseId = proposal.case_id;
  const caseData = await db.getCaseById(caseId);
  if (!caseData) {
    throw new Error(`Case ${caseId} not found for local PDF email adjustment`);
  }

  const prepared = await pdfFormService.prepareInboundPdfFormReply(caseData, {
    adjustmentInstruction: humanDecision.instruction || null,
  });

  if (!prepared?.success || !String(prepared.draftBodyText || '').trim()) {
    throw new Error(
      prepared?.error || `Local PDF email adjustment failed for case ${caseId}`
    );
  }

  await proposalLifecycle.applyHumanReviewDecision(proposal.id, {
    status: 'DISMISSED',
    humanDecision,
  });

  const adjustedProposal = await db.upsertProposal({
    proposalKey: `${caseId}:pdf:${proposal.action_type}:adjust:${Date.now()}`,
    caseId,
    runId: existingRun?.id || proposal.run_id || null,
    triggerMessageId: proposal.trigger_message_id || null,
    actionType: proposal.action_type,
    draftSubject: prepared.draftSubject || proposal.draft_subject || `Public Records Request - ${caseData.subject_name || 'Records Request'}`,
    draftBodyText: prepared.draftBodyText,
    draftBodyHtml: null,
    reasoning: [
      `Locally adjusted ${proposal.action_type} for ${caseData.agency_name || 'agency'}`,
      `Adjustment instruction: ${humanDecision.instruction || 'none'}`,
    ],
    canAutoExecute: false,
    requiresHuman: true,
    status: 'PENDING_APPROVAL',
    gateOptions: Array.isArray(proposal.gate_options) && proposal.gate_options.length > 0
      ? proposal.gate_options
      : ['APPROVE', 'ADJUST', 'DISMISS', 'WITHDRAW'],
  });

  await db.updateProposal(adjustedProposal.id, {
    waitpoint_token: `local-pdf-adjust:${caseId}:${adjustedProposal.id}`,
  });

  if (existingRun?.id) {
    await db.updateAgentRun(existingRun.id, {
      status: 'waiting',
      metadata: {
        ...(existingRun.metadata || {}),
        local_adjustment: true,
        proposalId: adjustedProposal.id,
      },
    });
  }

  await db.query(
    `UPDATE cases
     SET requires_human = true,
         pause_reason = 'PENDING_APPROVAL',
         status = 'needs_human_review',
         updated_at = NOW()
     WHERE id = $1`,
    [caseId]
  );

  return adjustedProposal;
}

function extractStubDraft(llmStubs, variant = 'draft') {
  const draft = llmStubs?.[variant];
  if (!draft || typeof draft !== 'object') return null;
  const subject = typeof draft.subject === 'string' && draft.subject.trim()
    ? draft.subject.trim()
    : null;
  const bodyText = typeof (draft.body_text || draft.body) === 'string' && String(draft.body_text || draft.body).trim()
    ? String(draft.body_text || draft.body).trim()
    : null;
  const bodyHtml = typeof draft.body_html === 'string' && draft.body_html.trim()
    ? draft.body_html.trim()
    : null;
  if (!subject && !bodyText && !bodyHtml) return null;
  return { subject, bodyText, bodyHtml };
}

function extractFeeAmountForLocalMaterialization(message, llmStubs) {
  const stubAmount = Number(llmStubs?.classify?.fee_amount);
  if (Number.isFinite(stubAmount) && stubAmount > 0) return stubAmount;
  const body = String(message?.body_text || message?.body || '');
  const match = body.match(/\$([\d,]+(?:\.\d{2})?)/);
  if (!match) return null;
  const parsed = Number(String(match[1] || '').replace(/,/g, ''));
  return Number.isFinite(parsed) ? parsed : null;
}

function shouldUseCurrentCheckoutInboundReplay(llmStubs) {
  return llmStubs?.current_checkout_replay === true;
}

async function inferInboundCurrentCheckoutDecision({ caseData, message, analysis, autopilotMode, llmStubs }) {
  require('tsx/cjs');
  const { decideNextAction } = require('../trigger/steps/decide-next-action.ts');

  const classifyStub = llmStubs?.classify || {};
  const classification = String(
    classifyStub.classification || analysis?.intent || analysis?.classification || ''
  ).trim().toUpperCase();
  if (!classification) {
    return null;
  }

  const constraints = Array.isArray(caseData?.constraints_jsonb)
    ? caseData.constraints_jsonb
    : Array.isArray(caseData?.constraints)
      ? caseData.constraints
      : [];
  const extractedFeeAmount =
    Number.isFinite(Number(classifyStub.fee_amount))
      ? Number(classifyStub.fee_amount)
      : (analysis?.extracted_fee_amount ?? extractFeeAmountForLocalMaterialization(message, llmStubs) ?? null);
  const sentiment = String(classifyStub.sentiment || analysis?.sentiment || 'neutral').trim().toLowerCase() || 'neutral';
  const requiresResponse = typeof classifyStub.requires_response === 'boolean'
    ? classifyStub.requires_response
    : typeof classifyStub.requires_action === 'boolean'
      ? classifyStub.requires_action
      : typeof analysis?.requires_response === 'boolean'
        ? analysis.requires_response
        : typeof analysis?.requires_action === 'boolean'
          ? analysis.requires_action
          : true;
  const portalUrl = classifyStub.portal_url || analysis?.full_analysis_json?.portal_url || caseData?.portal_url || null;
  const suggestedAction =
    classifyStub.suggested_action ||
    analysis?.suggested_action ||
    analysis?.full_analysis_json?.suggested_action ||
    null;
  const reasonNoResponse =
    classifyStub.reason_no_response ||
    analysis?.full_analysis_json?.reason_no_response ||
    null;
  const denialSubtype =
    classifyStub.denial_subtype ||
    analysis?.full_analysis_json?.denial_subtype ||
    null;
  const jurisdictionLevel =
    classifyStub.jurisdiction_level ||
    analysis?.full_analysis_json?.jurisdiction_level ||
    null;
  const keyPointsSource =
    classifyStub.key_points ||
    analysis?.key_points ||
    analysis?.full_analysis_json?.key_points ||
    [message?.body_text || ''];
  const inlineKeyPoints = Array.isArray(keyPointsSource)
    ? keyPointsSource.map((point) => String(point || '').trim()).filter(Boolean)
    : [String(keyPointsSource || '').trim()].filter(Boolean);

  const result = await decideNextAction(
    caseData.id,
    classification,
    constraints,
    extractedFeeAmount,
    sentiment,
    autopilotMode,
    'INBOUND_MESSAGE',
    requiresResponse,
    portalUrl,
    suggestedAction,
    reasonNoResponse,
    denialSubtype,
    null,
    null,
    null,
    jurisdictionLevel,
    inlineKeyPoints
  );

  return {
    actionType: result.actionType,
    requiresHuman: result.requiresHuman,
    pauseReason: result.pauseReason,
    gateOptions: result.gateOptions || [],
    canAutoExecute: result.canAutoExecute,
    reasoning: Array.isArray(result.reasoning) ? result.reasoning : [],
  };
}

function inferInboundLocalDecision({ classification, message, llmStubs, autopilotMode }) {
  const normalizedClassification = String(classification || '').trim().toUpperCase();
  const mode = String(autopilotMode || 'SUPERVISED').trim().toUpperCase();
  const body = String(message?.body_text || message?.body || '');
  const subject = String(message?.subject || '');
  const combinedText = `${subject}\n${body}`.toLowerCase();
  const sentiment = String(llmStubs?.classify?.sentiment || '').trim().toLowerCase();
  const keyPoints = Array.isArray(llmStubs?.classify?.key_points)
    ? llmStubs.classify.key_points.map((point) => String(point || '').toLowerCase())
    : [];

  if (normalizedClassification === 'CLARIFICATION_REQUEST') {
    return {
      actionType: 'SEND_CLARIFICATION',
      requiresHuman: true,
      pauseReason: 'SCOPE',
      gateOptions: ['APPROVE', 'ADJUST', 'DISMISS', 'WITHDRAW'],
    };
  }

  if (normalizedClassification === 'FEE_QUOTE') {
    const feeAmount = extractFeeAmountForLocalMaterialization(message, llmStubs);
    const requiresHuman = mode !== 'AUTO' || (feeAmount != null && feeAmount > 50);
    return {
      actionType: feeAmount != null && feeAmount >= 1000 ? 'NEGOTIATE_FEE' : 'ACCEPT_FEE',
      requiresHuman,
      pauseReason: requiresHuman ? 'FEE_QUOTE' : null,
      gateOptions: requiresHuman
        ? (feeAmount != null && feeAmount < 1000
            ? ['APPROVE', 'ADD_TO_INVOICING', 'WAIT_FOR_GOOD_TO_PAY', 'ADJUST', 'DISMISS', 'WITHDRAW']
            : ['APPROVE', 'ADJUST', 'DISMISS', 'WITHDRAW'])
        : [],
      feeAmount,
    };
  }

  if (normalizedClassification === 'DENIAL') {
    const hostile = sentiment === 'hostile' || /\b(final warning|do not contact|harassment|reported to law enforcement)\b/.test(combinedText);
    const strongDenialSignals = hostile || keyPoints.some((point) =>
      /(exemption|7\(a\)|ongoing investigation|sealed|law enforcement)/.test(point)
    ) || /\b(exemption|7\(a\)|ongoing investigation|sealed)\b/.test(combinedText);

    if (hostile) {
      return {
        actionType: 'ESCALATE',
        requiresHuman: true,
        pauseReason: 'SENSITIVE',
        gateOptions: ['ADJUST', 'DISMISS'],
      };
    }

    if (strongDenialSignals || mode !== 'AUTO') {
      return {
        actionType: 'SEND_REBUTTAL',
        requiresHuman: true,
        pauseReason: 'DENIAL',
        gateOptions: ['APPROVE', 'ADJUST', 'DISMISS', 'WITHDRAW'],
      };
    }

    return {
      actionType: 'SEND_REBUTTAL',
      requiresHuman: false,
      pauseReason: null,
      gateOptions: [],
    };
  }

  return null;
}

async function createAdjustedGenericEmailProposalLocally(proposal, humanDecision, existingRun) {
  const caseId = proposal.case_id;
  const caseData = await db.getCaseById(caseId);
  if (!caseData) {
    throw new Error(`Case ${caseId} not found for local email adjustment`);
  }

  const stubDraft = extractStubDraft(existingRun?.metadata?.local_llm_stubs || null, 'redraft');
  let bodyText = stubDraft?.bodyText || null;
  let subject = stubDraft?.subject || proposal.draft_subject || `RE: ${caseData.case_name || 'Public Records Request'}`;

  if (!bodyText) {
    const revisionPrompt = `You are revising a public-records response email.

Original draft:
${proposal.draft_body_text || ''}

Human instruction:
${humanDecision.instruction || ''}

Context:
- Agency: ${caseData.agency_name || 'Unknown agency'}
- Subject: ${caseData.subject_name || caseData.case_name || 'Public Records Request'}

Requirements:
- Follow the human instruction exactly.
- Keep the response professional and concise.
- Return ONLY the revised email body text.`;

    bodyText = await aiService.callAI(revisionPrompt, { effort: 'medium' });
  }

  bodyText = String(bodyText || '').trim();
  if (!bodyText) {
    throw new Error(`Local generic email adjustment generated an empty draft for case ${caseId}`);
  }

  await proposalLifecycle.applyHumanReviewDecision(proposal.id, {
    status: 'DISMISSED',
    humanDecision,
  });

  const adjustedProposal = await db.upsertProposal({
    proposalKey: `${caseId}:generic:${proposal.action_type}:adjust:${Date.now()}`,
    caseId,
    runId: existingRun?.id || proposal.run_id || null,
    triggerMessageId: proposal.trigger_message_id || null,
    actionType: proposal.action_type,
    draftSubject: subject,
    draftBodyText: bodyText,
    draftBodyHtml: null,
    reasoning: [
      `Locally adjusted ${proposal.action_type} for ${caseData.agency_name || 'agency'}`,
      `Adjustment instruction: ${humanDecision.instruction || 'none'}`,
    ],
    canAutoExecute: false,
    requiresHuman: true,
    status: 'PENDING_APPROVAL',
    gateOptions: Array.isArray(proposal.gate_options) && proposal.gate_options.length > 0
      ? proposal.gate_options
      : ['APPROVE', 'ADJUST', 'DISMISS', 'WITHDRAW'],
  });

  await db.updateProposal(adjustedProposal.id, {
    waitpoint_token: `local-email-adjust:${caseId}:${adjustedProposal.id}`,
  });

  if (existingRun?.id) {
    await db.updateAgentRun(existingRun.id, {
      status: 'waiting',
      metadata: {
        ...(existingRun.metadata || {}),
        local_adjustment: true,
        proposalId: adjustedProposal.id,
      },
    });
  }

  await db.query(
    `UPDATE cases
     SET requires_human = true,
         pause_reason = 'PENDING_APPROVAL',
         status = 'needs_human_review',
         updated_at = NOW()
     WHERE id = $1`,
    [caseId]
  );

  return adjustedProposal;
}

async function materializeInboundProposalLocally({ caseData, message, run, autopilotMode, llmStubs }) {
  if (process.env.NODE_ENV === 'production') {
    return null;
  }

  const thread = message?.thread_id ? await db.getThreadById(message.thread_id) : null;
  let resolvedCaseAgencyId = thread?.case_agency_id ? Number(thread.case_agency_id) : null;
  if (!resolvedCaseAgencyId && message?.from_email) {
    const caseAgencies = await db.getCaseAgencies(caseData.id, false);
    const inboundFrom = String(message.from_email || '').trim().toLowerCase();
    const matchedAgency = caseAgencies.find((agency) =>
      String(agency.agency_email || '').trim().toLowerCase() === inboundFrom
    );
    resolvedCaseAgencyId = matchedAgency?.id ? Number(matchedAgency.id) : null;
  }
  const resolvedCaseAgency = resolvedCaseAgencyId ? await db.getCaseAgencyById(resolvedCaseAgencyId) : null;
  const resolvedAgencyName = resolvedCaseAgency?.agency_name || caseData.agency_name || 'agency';

  const analysis = await db.getResponseAnalysisByMessageId(message.id);
  const intent = String(llmStubs?.classify?.classification || analysis?.intent || '').trim().toUpperCase();
  const localDecision = shouldUseCurrentCheckoutInboundReplay(llmStubs)
    ? await inferInboundCurrentCheckoutDecision({
        caseData,
        message,
        analysis,
        autopilotMode,
        llmStubs,
      })
    : inferInboundLocalDecision({
        classification: intent,
        message,
        llmStubs,
        autopilotMode,
      });
  if (!localDecision) {
    return null;
  }

  const stubDraft = extractStubDraft(llmStubs, 'draft');
  let draft = stubDraft;

  if (!draft && localDecision.actionType === 'SEND_CLARIFICATION') {
    const generatedDraft = await aiService.generateAutoReply(message, analysis, caseData);
    draft = {
      subject: generatedDraft?.subject || null,
      bodyText: generatedDraft?.body_text || generatedDraft?.body || null,
      bodyHtml: generatedDraft?.body_html || null,
    };
  }

  const fallbackSubject = message.subject || `RE: ${caseData.case_name || 'Public Records Request'}`;
  const fallbackBody =
    localDecision.actionType === 'ESCALATE'
      ? 'Agency response requires manual review before any reply is sent.'
      : caseData?.portal_url && ['ACCEPT_FEE', 'NEGOTIATE_FEE'].includes(localDecision.actionType)
        ? `Portal fee workflow requires manual portal handling for ${caseData.agency_name || 'this agency'}.`
        : shouldUseCurrentCheckoutInboundReplay(llmStubs)
          ? `Synthetic current-checkout replay placeholder for ${localDecision.actionType}.`
        : null;
  const draftSubject = draft?.subject || fallbackSubject;
  const draftBodyText = draft?.bodyText || fallbackBody;
  if (!draftBodyText || !String(draftBodyText).trim()) {
    throw new Error(`Local inbound materialization generated an empty ${localDecision.actionType} draft for case ${caseData.id}`);
  }

  const proposal = await db.upsertProposal({
    proposalKey: `${caseData.id}:inbound:${localDecision.actionType}:${message.id}`,
    caseId: caseData.id,
    runId: run.id,
    triggerMessageId: message.id,
    caseAgencyId: resolvedCaseAgencyId,
    actionType: localDecision.actionType,
    draftSubject,
    draftBodyText,
    draftBodyHtml: draft?.bodyHtml || null,
    reasoning: [
      ...(Array.isArray(localDecision.reasoning) && localDecision.reasoning.length > 0
        ? localDecision.reasoning
        : [
            `Locally materialized ${localDecision.actionType} response for ${resolvedAgencyName}`,
            `Inbound message ${message.id} classified as ${intent || 'UNKNOWN'}`,
            `Autopilot: ${autopilotMode || 'SUPERVISED'}`,
          ]),
    ],
    canAutoExecute: !localDecision.requiresHuman,
    requiresHuman: localDecision.requiresHuman,
    status: localDecision.requiresHuman ? 'PENDING_APPROVAL' : 'EXECUTED',
    gateOptions: localDecision.gateOptions,
  });

  if (localDecision.requiresHuman) {
    await db.updateProposal(proposal.id, {
      waitpoint_token: `local-inbound:${caseData.id}:${message.id}:${proposal.id}`,
    });
  } else {
    await db.updateProposal(proposal.id, {
      executionKey: `local-auto:${caseData.id}:${message.id}:${proposal.id}`,
      executedAt: new Date(),
    });
  }

  await db.updateAgentRun(run.id, {
    status: localDecision.requiresHuman ? 'waiting' : 'completed',
    started_at: new Date(),
    ended_at: localDecision.requiresHuman ? null : new Date(),
    metadata: {
      ...(run.metadata || {}),
      source: 'local_inbound_materialization',
      local_materialized_inbound: true,
      local_llm_stubs: llmStubs || null,
      proposalId: proposal.id,
      actionType: localDecision.actionType,
      messageId: message.id,
      classification: intent,
    },
  });
  await db.markMessageProcessed(message.id, run.id, null);
  await db.updateCase(caseData.id, {
    status: localDecision.requiresHuman ? 'needs_human_review' : 'awaiting_response',
    requires_human: localDecision.requiresHuman,
    pause_reason: localDecision.requiresHuman ? localDecision.pauseReason : null,
    substatus: localDecision.requiresHuman
      ? `Proposal #${proposal.id} pending review`
      : `Local ${localDecision.actionType} executed`,
  });

  return {
    proposalId: proposal.id,
    actionType: localDecision.actionType,
    runStatus: localDecision.requiresHuman ? 'waiting' : 'completed',
  };
}

async function materializeFollowupLocally({ caseData, run, autopilotMode, llmStubs }) {
  if (process.env.NODE_ENV === 'production') {
    return null;
  }

  const stubDraft = extractStubDraft(llmStubs, 'draft');
  const draftSubject = stubDraft?.subject || `Follow-up: ${caseData.subject_name || caseData.case_name || 'Public Records Request'}`;
  const draftBodyText = stubDraft?.bodyText || null;
  if (!draftBodyText) {
    return null;
  }

  const proposal = await db.upsertProposal({
    proposalKey: `${caseData.id}:followup:SEND_FOLLOWUP:local`,
    caseId: caseData.id,
    runId: run.id,
    triggerMessageId: null,
    actionType: 'SEND_FOLLOWUP',
    draftSubject,
    draftBodyText,
    draftBodyHtml: stubDraft?.bodyHtml || null,
    reasoning: [
      `Locally materialized follow-up for ${caseData.agency_name || 'agency'}`,
      `Autopilot: ${autopilotMode || 'AUTO'}`,
    ],
    canAutoExecute: true,
    requiresHuman: false,
    status: 'EXECUTED',
    gateOptions: [],
  });

  await db.updateProposal(proposal.id, {
    executionKey: `local-followup:${caseData.id}:${proposal.id}`,
    executedAt: new Date(),
  });

  await db.updateAgentRun(run.id, {
    status: 'completed',
    started_at: new Date(),
    ended_at: new Date(),
    metadata: {
      ...(run.metadata || {}),
      source: 'local_followup_materialization',
      local_llm_stubs: llmStubs || null,
      proposalId: proposal.id,
      actionType: 'SEND_FOLLOWUP',
    },
  });

  await db.updateCase(caseData.id, {
    status: 'awaiting_response',
    requires_human: false,
    pause_reason: null,
    substatus: 'Local SEND_FOLLOWUP executed',
  });

  return {
    proposalId: proposal.id,
    actionType: 'SEND_FOLLOWUP',
    runStatus: 'completed',
  };
}

async function materializeInitialRequestLocally({ caseData, run, autopilotMode, llmStubs, routeMode = null }) {
  if (process.env.NODE_ENV === 'production') {
    return null;
  }

  const effectiveCaseData = {
    ...caseData,
    portal_url: routeMode === 'email' ? null : caseData.portal_url,
    portal_provider: routeMode === 'email' ? null : caseData.portal_provider,
    last_portal_status: routeMode === 'email' ? null : caseData.last_portal_status,
    agency_email: routeMode === 'portal' ? null : caseData.agency_email,
  };
  const actionType = effectiveCaseData.portal_url ? 'SUBMIT_PORTAL' : 'SEND_INITIAL_REQUEST';
  const stubDraft = extractStubDraft(llmStubs, 'draft');
  let draftSubject = stubDraft?.subject || null;
  let draftBodyText = stubDraft?.bodyText || null;
  let draftBodyHtml = stubDraft?.bodyHtml || null;

  if (!draftBodyText) {
    const generated = await aiService.generateFOIARequest(effectiveCaseData);
    draftSubject = draftSubject || generated?.subject || `Public Records Request - ${effectiveCaseData.subject_name || 'Records Request'}`;
    draftBodyText = generated?.body || generated?.requestText || generated?.request_text || null;
    draftBodyHtml = draftBodyHtml || generated?.body_html || null;
  }

  if (!draftBodyText || !String(draftBodyText).trim()) {
    throw new Error(`Local initial request materialization generated an empty draft for case ${effectiveCaseData.id}`);
  }

  const proposal = await db.upsertProposal({
    proposalKey: `${effectiveCaseData.id}:initial:${actionType}:local`,
    caseId: effectiveCaseData.id,
    runId: run.id,
    triggerMessageId: null,
    actionType,
    draftSubject: draftSubject || `Public Records Request - ${effectiveCaseData.subject_name || 'Records Request'}`,
    draftBodyText,
    draftBodyHtml,
    reasoning: [
      `Locally materialized initial request for ${effectiveCaseData.agency_name || 'agency'}`,
      `Autopilot: ${autopilotMode || 'SUPERVISED'}`,
      `Route mode: ${routeMode || 'auto'}`,
    ],
    canAutoExecute: false,
    requiresHuman: true,
    status: 'PENDING_APPROVAL',
    gateOptions: ['APPROVE', 'ADJUST', 'DISMISS', 'WITHDRAW'],
  });

  await db.updateProposal(proposal.id, {
    waitpoint_token: `local-ready-to-send:${effectiveCaseData.id}:${proposal.id}`,
  });

  await db.updateAgentRun(run.id, {
    status: 'waiting',
    started_at: new Date(),
    metadata: {
      ...(run.metadata || {}),
      source: 'local_initial_materialization',
      local_llm_stubs: llmStubs || null,
      proposalId: proposal.id,
      actionType,
      route_mode: routeMode || null,
    },
  });

  await db.updateCase(effectiveCaseData.id, {
    status: 'needs_human_review',
    requires_human: true,
    pause_reason: 'PENDING_APPROVAL',
    substatus: `Proposal #${proposal.id} pending review`,
  });

  return {
    proposalId: proposal.id,
    actionType,
    runStatus: 'waiting',
  };
}

async function executeApprovedProposalEmailDirectly(proposal, humanDecision) {
  const caseId = proposal.case_id;
  const proposalId = proposal.id;
  const caseData = await db.getCaseById(caseId);
  const executionKey = proposal.execution_key || `direct-email:${proposalId}`;

  const targetAgency = proposal.case_agency_id
    ? await db.getCaseAgencyById(proposal.case_agency_id)
    : null;
  const effectiveTo =
    humanDecision?.recipient_override ||
    targetAgency?.agency_email ||
    caseData?.agency_email;
  if (!effectiveTo) {
    throw new Error(`Case ${caseId} has no agency_email — cannot send email directly`);
  }

  const claimed = await proposalLifecycle.markProposalDecisionReceived(proposalId, {
    humanDecision,
    allowedCurrentStatuses: ['PENDING_APPROVAL', 'BLOCKED', 'DECISION_RECEIVED'],
  });
  if (!claimed) {
    throw new Error('Proposal was already actioned by another request');
  }

  if (!proposal.execution_key) {
    const executionClaimed = await db.claimProposalExecution(proposalId, executionKey);
    if (!executionClaimed) {
      throw new Error('Proposal execution was already claimed by another request');
    }
  }

  const thread = proposal.case_agency_id
    ? await db.getThreadByCaseAgencyId(proposal.case_agency_id)
    : await db.getThreadByCaseId(caseId);
  const threadMessages = thread?.id ? await db.getMessagesByThreadId(thread.id) : [];
  const latestInbound = threadMessages.find((message) => message.direction === 'inbound')
    || await db.getLatestInboundMessage(caseId);
  const inboundFrom = String(latestInbound?.from_email || '').trim().toLowerCase();
  const targetTo = String(effectiveTo || '').trim().toLowerCase();
  const freshEmailActions = ['REFORMULATE_REQUEST', 'SEND_INITIAL_REQUEST'];
  const isFreshEmail = freshEmailActions.includes(proposal.action_type);
  const replyHeaders =
    !isFreshEmail && latestInbound?.message_id && inboundFrom && targetTo && inboundFrom === targetTo
      ? {
          'In-Reply-To': latestInbound.message_id,
          'References': latestInbound.message_id
        }
      : null;

  const emailResult = await emailExecutor.sendEmail({
    to: effectiveTo,
    subject: proposal.draft_subject,
    bodyText: proposal.draft_body_text,
    bodyHtml: proposal.draft_body_html || null,
    headers: replyHeaders,
    originalMessageId: latestInbound?.message_id || null,
    threadId: thread?.thread_id || thread?.initial_message_id || null,
    caseId,
    proposalId,
    runId: null,
    actionType: proposal.action_type,
    delayMs: 0,
    attachments: Array.isArray(humanDecision?.attachments) ? humanDecision.attachments : [],
  });

  if (!emailResult || emailResult.success !== true) {
    await proposalLifecycle.clearHumanReviewDecision(proposalId, {
      status: 'PENDING_APPROVAL',
      extraUpdates: { executionKey: null },
    });
    await db.query(
      `UPDATE cases
       SET requires_human = true,
           pause_reason = 'PENDING_APPROVAL',
           updated_at = NOW()
       WHERE id = $1`,
      [caseId]
    );
    throw new Error(emailResult?.error || 'Email send failed');
  }

  await proposalLifecycle.markProposalExecuted(proposalId, {
    humanDecision,
    executionKey,
    emailJobId: emailResult?.providerMessageId || emailResult?.messageId || null,
    allowedCurrentStatuses: ['DECISION_RECEIVED'],
  });
  await transitionCaseRuntime(caseId, 'CASE_RECONCILED', { targetStatus: 'awaiting_response', substatus: null });
  await db.logActivity('proposal_executed', `Proposal ${proposalId} approved and sent directly`, {
    case_id: caseId,
    proposal_id: proposalId,
    action_type: proposal.action_type,
    actor_type: 'human',
    source_service: 'dashboard',
  });

  logger.info('Proposal executed via direct email send fallback', { caseId, proposalId });
}

async function executeApprovedPortalActionLocally(proposal, humanDecision) {
  const caseId = proposal.case_id;
  const proposalId = proposal.id;

  await proposalLifecycle.markProposalExecuted(proposalId, {
    humanDecision,
    executionKey: `local-portal:${proposalId}:${Date.now()}`,
  });

  await db.updateCase(caseId, {
    status: 'awaiting_response',
    requires_human: false,
    pause_reason: null,
    substatus: 'Portal action approved locally',
  });

  return { executed: true };
}

async function executeApprovedProposalPdfEmailDirectly(proposal, humanDecision) {
  const caseId = proposal.case_id;
  const proposalId = proposal.id;
  const caseData = await db.getCaseById(caseId);
  const executionKey = proposal.execution_key || `direct-pdf-email:${proposalId}`;
  const targetAgency = proposal.case_agency_id
    ? await db.getCaseAgencyById(proposal.case_agency_id)
    : null;
  const effectiveTo =
    humanDecision?.recipient_override ||
    targetAgency?.agency_email ||
    caseData?.agency_email;

  if (!effectiveTo) {
    throw new Error(`Case ${caseId} has no agency_email — cannot send PDF email directly`);
  }

  const claimed = await proposalLifecycle.markProposalDecisionReceived(proposalId, {
    humanDecision,
    allowedCurrentStatuses: ['PENDING_APPROVAL', 'BLOCKED', 'DECISION_RECEIVED'],
  });
  if (!claimed) {
    throw new Error('Proposal was already actioned by another request');
  }

  if (!proposal.execution_key) {
    const executionClaimed = await db.claimProposalExecution(proposalId, executionKey);
    if (!executionClaimed) {
      throw new Error('Proposal execution was already claimed by another request');
    }
  }

  // Reuse the prepared PDF if one already exists; otherwise this proposal is
  // stale and must be regenerated before approval.
  const fs = require('fs');
  const pdfFormService = require('../services/pdf-form-service');
  const pdfAttachment = await pdfFormService.getLatestPreparedPdfAttachment(caseId);
  if (!pdfAttachment) {
    await proposalLifecycle.clearHumanReviewDecision(proposalId, {
      status: 'PENDING_APPROVAL',
      extraUpdates: { executionKey: null },
    });
    throw new Error('No prepared PDF attachment found for this proposal');
  }

  let pdfBuffer = null;
  if (pdfAttachment.storage_path && fs.existsSync(pdfAttachment.storage_path)) {
    pdfBuffer = fs.readFileSync(pdfAttachment.storage_path);
  } else {
    const fullAttachment = await db.getAttachmentById(pdfAttachment.id);
    if (fullAttachment?.file_data) {
      pdfBuffer = Buffer.isBuffer(fullAttachment.file_data)
        ? fullAttachment.file_data
        : Buffer.from(fullAttachment.file_data.data || fullAttachment.file_data);
    }
  }
  if (!pdfBuffer) {
    await proposalLifecycle.clearHumanReviewDecision(proposalId, {
      status: 'PENDING_APPROVAL',
      extraUpdates: { executionKey: null },
    });
    throw new Error('Prepared PDF file is unavailable for this proposal');
  }

  const thread = proposal.case_agency_id
    ? await db.getThreadByCaseAgencyId(proposal.case_agency_id)
    : await db.getThreadByCaseId(caseId);
  const threadMessages = thread?.id ? await db.getMessagesByThreadId(thread.id) : [];
  const latestInbound = threadMessages.find((message) => message.direction === 'inbound')
    || await db.getLatestInboundMessage(caseId);
  const inboundFrom = String(latestInbound?.from_email || '').trim().toLowerCase();
  const targetTo = String(effectiveTo || '').trim().toLowerCase();
  const replyHeaders =
    latestInbound?.message_id && inboundFrom && targetTo && inboundFrom === targetTo
      ? {
          inReplyTo: latestInbound.message_id,
          references: latestInbound.message_id,
        }
      : {};

  let emailResult;
  try {
    emailResult = await emailExecutor.sendEmail({
      to: effectiveTo,
      subject: proposal.draft_subject || `Public Records Request - ${caseData.subject_name || caseData.case_name}`,
      bodyText: proposal.draft_body_text,
      bodyHtml: proposal.draft_body_html || null,
      headers: Object.keys(replyHeaders).length > 0
        ? {
            'In-Reply-To': replyHeaders.inReplyTo || null,
            'References': replyHeaders.references || null,
          }
        : null,
      originalMessageId: latestInbound?.message_id || null,
      threadId: thread?.thread_id || thread?.initial_message_id || null,
      caseId,
      proposalId,
      runId: null,
      actionType: proposal.action_type,
      delayMs: 0,
      attachments: [
        {
          filename: pdfAttachment.filename,
          content: pdfBuffer,
          contentType: 'application/pdf',
        },
        ...(Array.isArray(humanDecision?.attachments) ? humanDecision.attachments : []),
      ],
    });
    if (!emailResult || emailResult.success !== true) {
      throw new Error(emailResult?.error || 'PDF email send failed');
    }
  } catch (error) {
    await proposalLifecycle.clearHumanReviewDecision(proposalId, {
      status: 'PENDING_APPROVAL',
      extraUpdates: { executionKey: null },
    });
    await db.query(
      `UPDATE cases
       SET requires_human = true,
           pause_reason = 'PENDING_APPROVAL',
           updated_at = NOW()
       WHERE id = $1`,
      [caseId]
    );
    throw error;
  }

  await proposalLifecycle.markProposalExecuted(proposalId, {
    humanDecision,
    executionKey,
    emailJobId: emailResult?.providerMessageId || emailResult?.messageId || null,
    allowedCurrentStatuses: ['DECISION_RECEIVED'],
  });
  await transitionCaseRuntime(caseId, 'CASE_RECONCILED', { targetStatus: 'awaiting_response', substatus: null });
  await db.logActivity('proposal_executed', `Proposal ${proposalId} approved and sent directly with PDF attachment`, {
    case_id: caseId,
    proposal_id: proposalId,
    action_type: proposal.action_type,
    attachment_id: pdfAttachment.id,
    actor_type: 'human',
    source_service: 'dashboard',
  });

  logger.info('Proposal executed via direct PDF email send fallback', { caseId, proposalId, attachmentId: pdfAttachment.id });
}

const FOLLOWUP_ELIGIBLE_STATUSES = new Set([
  'sent',
  'awaiting_response',
]);
const FOLLOWUP_RESEARCH_HANDOFF_STATUSES = new Set([
  'needs_human_review',
  'needs_phone_call',
  'needs_contact_info',
  'needs_human_fee_approval',
  'needs_rebuttal',
  'pending_fee_decision',
  'id_state',
]);

// Save Trigger.dev run ID in agent_run metadata for dashboard linking
async function saveTriggerRunId(runId, triggerRunId) {
  try {
    await db.query(
      `UPDATE agent_runs SET metadata = COALESCE(metadata, '{}'::jsonb) || $2::jsonb WHERE id = $1`,
      [runId, JSON.stringify({ triggerRunId })]
    );
  } catch (e) { /* best-effort */ }
}

/**
 * POST /cases/:id/run-initial
 *
 * Trigger initial FOIA request generation for a case.
 * Creates agent_run record and enqueues worker job.
 *
 * Body (optional):
 * - autopilotMode: 'AUTO' | 'SUPERVISED' (default: 'SUPERVISED')
 * - llmStubs: Object with stubbed LLM responses for testing
 */
router.post('/cases/:id/run-initial', async (req, res) => {
  const caseId = parseInt(req.params.id);
  const { autopilotMode = 'SUPERVISED', llmStubs, route_mode, force_restart = false, case_agency_id } = req.body || {};

  try {
    // Verify case exists
    const caseData = await db.getCaseById(caseId);
    if (!caseData) {
      return res.status(404).json({
        success: false,
        error: `Case ${caseId} not found`
      });
    }

    let selectedCaseAgencyId = Number.isFinite(Number(case_agency_id)) ? Number(case_agency_id) : null;
    let selectedCaseAgency = selectedCaseAgencyId
      ? await db.getCaseAgencyById(selectedCaseAgencyId)
      : null;
    if (selectedCaseAgency && Number(selectedCaseAgency.case_id) !== Number(caseId)) {
      return res.status(400).json({
        success: false,
        error: 'Selected case_agency_id does not belong to this case',
      });
    }
    if (!selectedCaseAgencyId) {
      const primaryCaseAgency = await db.getPrimaryCaseAgency(caseId).catch(() => null);
      if (primaryCaseAgency && Number(primaryCaseAgency.case_id) === Number(caseId)) {
        selectedCaseAgencyId = Number(primaryCaseAgency.id);
        selectedCaseAgency = primaryCaseAgency;
      }
    }

    const selectedPortalUrl = selectedCaseAgency?.portal_url || caseData.portal_url;
    const selectedEmail = selectedCaseAgency?.agency_email || caseData.agency_email;
    const hasPortal = !!selectedPortalUrl;
    const hasEmail = !!selectedEmail;
    const normalizedRouteMode = typeof route_mode === 'string' ? route_mode.toLowerCase() : null;

    if (normalizedRouteMode && !['email', 'portal'].includes(normalizedRouteMode)) {
      return res.status(400).json({
        success: false,
        error: 'route_mode must be one of: email, portal'
      });
    }

    if (normalizedRouteMode === 'portal' && !hasPortal) {
      return res.status(400).json({
        success: false,
        error: 'Selected agency/contact does not have a portal URL'
      });
    }

    if (normalizedRouteMode === 'email' && !hasEmail) {
      return res.status(400).json({
        success: false,
        error: 'Selected agency/contact does not have an email address'
      });
    }

    // Check for existing active run
    const existingRun = await db.getActiveRunForCase(caseId);
    if (existingRun) {
      if (force_restart && canSupersedeForExplicitStart(existingRun)) {
        await supersedeActiveReviewRun(
          caseId,
          'Superseded by explicit operator start request for selected agency/contact'
        );
      } else {
        return res.status(409).json({
          success: false,
          error: 'Case already has an active agent run',
          activeRun: {
            id: existingRun.id,
          status: existingRun.status,
          trigger_type: existingRun.trigger_type,
            started_at: existingRun.started_at
          }
        });
      }
    }

    // Create run record
    const run = await db.createAgentRunFull({
      case_id: caseId,
      trigger_type: 'initial_request',
      status: 'queued',
      autopilot_mode: autopilotMode,
      langgraph_thread_id: `initial:${caseId}:${Date.now()}`,
      metadata: {
        route_mode: normalizedRouteMode || null,
        case_agency_id: selectedCaseAgencyId || null,
      }
    });

    const localMaterialization = await materializeInitialRequestLocally({
      caseData: selectedCaseAgency
        ? {
            ...caseData,
            agency_id: selectedCaseAgency.agency_id || caseData.agency_id,
            agency_name: selectedCaseAgency.agency_name || caseData.agency_name,
            agency_email: selectedCaseAgency.agency_email || null,
            portal_url: selectedCaseAgency.portal_url || null,
            portal_provider: selectedCaseAgency.portal_provider || null,
          }
        : caseData,
      run,
      autopilotMode,
      llmStubs,
      routeMode: normalizedRouteMode,
    });
    if (localMaterialization) {
      return res.status(202).json({
        success: true,
        message: 'Initial request generation processed locally',
        fallback: 'local_initial_materialization',
        proposal_id: localMaterialization.proposalId,
        action_type: localMaterialization.actionType,
        route_mode: normalizedRouteMode || null,
        run: {
          id: run.id,
          status: localMaterialization.runStatus || 'waiting',
          thread_id: run.langgraph_thread_id
        }
      });
    }

    // Trigger Trigger.dev task (clean up orphaned run on failure)
    let handle;
    try {
      handle = (await triggerDispatch.triggerTask('process-initial-request', {
        runId: run.id,
        caseId,
        autopilotMode,
        routeMode: normalizedRouteMode || undefined,
        caseAgencyId: selectedCaseAgencyId || undefined,
      }, triggerOpts(caseId, 'initial', run.id))).handle;
    } catch (triggerError) {
      await db.updateAgentRun(run.id, { status: 'failed', ended_at: new Date(), error: `Trigger failed: ${triggerError.message}` });
      throw triggerError;
    }

    await saveTriggerRunId(run.id, handle.id);
    logger.info('Initial request task triggered', {
      runId: run.id,
      caseId,
      triggerRunId: handle.id
    });

    res.status(202).json({
      success: true,
      message: 'Initial request generation queued',
      route_mode: normalizedRouteMode || null,
      run: {
        id: run.id,
        status: run.status,
        thread_id: run.langgraph_thread_id
      },
      trigger_run_id: handle.id
    });

  } catch (error) {
    // Fix J: Handle unique constraint violation (concurrent run creation)
    if (error.code === '23505' && String(error.constraint || '').includes('one_active_per_case')) {
      return res.status(409).json({ success: false, error: 'Case already has an active agent run (constraint)' });
    }
    logger.error('Error creating initial request run', { caseId, error: error.message });
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * POST /cases/:id/run-inbound
 *
 * Trigger processing of an inbound message for a case.
 * Creates agent_run record and enqueues worker job.
 *
 * Body:
 * - messageId: (required) ID of the inbound message to process
 * - autopilotMode: 'AUTO' | 'SUPERVISED' (default: 'SUPERVISED')
 * - llmStubs: Object with stubbed LLM responses for testing
 */
router.post('/cases/:id/run-inbound', async (req, res) => {
  const caseId = parseInt(req.params.id);
  const { messageId, autopilotMode = 'SUPERVISED', llmStubs } = req.body || {};

  try {
    // Validate messageId
    if (!messageId) {
      return res.status(400).json({
        success: false,
        error: 'messageId is required'
      });
    }

    // Verify case exists
    const caseData = await db.getCaseById(caseId);
    if (!caseData) {
      return res.status(404).json({
        success: false,
        error: `Case ${caseId} not found`
      });
    }

    // Verify message exists and belongs to case
    const message = await db.getMessageById(messageId);
    if (!message) {
      return res.status(404).json({
        success: false,
        error: `Message ${messageId} not found`
      });
    }

    // Verify message belongs to this case
    if (message.case_id && String(message.case_id) !== String(caseId)) {
      return res.status(400).json({
        success: false,
        error: `Message ${messageId} belongs to case ${message.case_id}, not case ${caseId}`
      });
    }

    // Check message already processed
    if (message.processed_at) {
      return res.status(409).json({
        success: false,
        error: 'Message already processed',
        processed_at: message.processed_at,
        processed_run_id: message.processed_run_id
      });
    }

    // Check for existing active run for this case
    const existingRun = await db.getActiveRunForCase(caseId);
    if (existingRun) {
      return res.status(409).json({
        success: false,
        error: 'Case already has an active agent run',
        activeRun: {
          id: existingRun.id,
          status: existingRun.status,
          trigger_type: existingRun.trigger_type,
          started_at: existingRun.started_at
        }
      });
    }

    // Create run record
    const run = await db.createAgentRunFull({
      case_id: caseId,
      trigger_type: 'inbound_message',
      message_id: messageId,
      status: 'queued',
      autopilot_mode: autopilotMode,
      langgraph_thread_id: `case:${caseId}:msg-${messageId}`
    });

    let localMaterialization = null;
    try {
      localMaterialization = await materializeInboundProposalLocally({
        caseData,
        message,
        run,
        autopilotMode,
        llmStubs,
      });
    } catch (localMaterializationError) {
      await db.updateAgentRun(run.id, {
        status: 'failed',
        ended_at: new Date(),
        error: `Local inbound materialization failed: ${localMaterializationError.message}`,
      });
      throw localMaterializationError;
    }
    if (localMaterialization) {
      return res.status(202).json({
        success: true,
        message: 'Inbound message processed locally',
        fallback: 'local_inbound_materialization',
        proposal_id: localMaterialization.proposalId,
        action_type: localMaterialization.actionType,
        run: {
          id: run.id,
          status: localMaterialization.runStatus || 'waiting',
          message_id: messageId,
          thread_id: run.langgraph_thread_id
        }
      });
    }

    // Trigger Trigger.dev task (clean up orphaned run on failure)
    let handle;
    try {
      handle = (await triggerDispatch.triggerTask('process-inbound', {
        runId: run.id,
        caseId,
        messageId,
        autopilotMode,
      }, triggerOpts(caseId, 'inbound', run.id))).handle;
    } catch (triggerError) {
      await db.updateAgentRun(run.id, { status: 'failed', ended_at: new Date(), error: `Trigger failed: ${triggerError.message}` });
      throw triggerError;
    }

    await saveTriggerRunId(run.id, handle.id);
    logger.info('Inbound message task triggered', {
      runId: run.id,
      caseId,
      messageId,
      triggerRunId: handle.id
    });

    res.status(202).json({
      success: true,
      message: 'Inbound message processing queued',
      run: {
        id: run.id,
        status: run.status,
        message_id: messageId,
        thread_id: run.langgraph_thread_id
      },
      trigger_run_id: handle.id
    });

  } catch (error) {
    if (error.code === '23505' && String(error.constraint || '').includes('one_active_per_case')) {
      return res.status(409).json({ success: false, error: 'Case already has an active agent run (constraint)' });
    }
    logger.error('Error creating inbound message run', { caseId, error: error.message });
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * POST /proposals/:id/decision
 *
 * Submit a human decision for a pending proposal.
 * Updates proposal status and enqueues resume job.
 *
 * Body:
 * - action: 'APPROVE' | 'ADJUST' | 'DISMISS' | 'WITHDRAW' (required)
 * - instruction: Optional text instruction for ADJUST action
 * - reason: Optional reason for the decision
 */
router.post('/proposals/:id/decision', async (req, res) => {
  const proposalId = parseInt(req.params.id);
  const { action, instruction, reason, attachments: rawAttachments, recipient_override: rawRecipientOverride } = req.body || {};
  const validatedAttachments = Array.isArray(rawAttachments)
    ? rawAttachments.filter(a => a && typeof a.filename === 'string' && typeof a.content === 'string' && typeof a.type === 'string')
    : [];
  const recipientOverride = (typeof rawRecipientOverride === 'string' && rawRecipientOverride.includes('@'))
    ? rawRecipientOverride.trim()
    : undefined;

  try {
    // Validate action
    const validActions = ['APPROVE', 'ADJUST', 'DISMISS', 'WITHDRAW', 'MANUAL_SUBMIT', 'RETRY_RESEARCH', 'ADD_TO_INVOICING', 'WAIT_FOR_GOOD_TO_PAY'];
    if (!action || !validActions.includes(action)) {
      return res.status(400).json({
        success: false,
        error: `action must be one of: ${validActions.join(', ')}`
      });
    }

    // Fetch proposal
    let proposal = await db.getProposalById(proposalId);
    if (!proposal) {
      return res.status(404).json({
        success: false,
        error: `Proposal ${proposalId} not found`
      });
    }

    // Allow retrying a wedged DECISION_RECEIVED proposal as long as it has not executed.
    // This keeps the manual approval UX recoverable after transient Trigger/auth failures.
    if (!['PENDING_APPROVAL', 'BLOCKED', 'DECISION_RECEIVED'].includes(proposal.status)) {
      return res.status(409).json({
        success: false,
        error: `Proposal is not pending approval`,
        current_status: proposal.status
      });
    }

    if (proposal.gate_options && Array.isArray(proposal.gate_options) && !proposal.gate_options.includes(action)) {
      return res.status(400).json({
        success: false,
        error: `Action '${action}' is not allowed for this proposal. Allowed: ${proposal.gate_options.join(', ')}`
      });
    }

    const caseId = proposal.case_id;

    // Check for existing active run
    const existingRun = await db.getActiveRunForCase(caseId);
    const orphanedWaitingRun = isOrphanedWaitingRun(existingRun);
    if (existingRun) {
      // 'waiting' = Trigger.dev task waiting on the waitpoint token for this decision.
      // 'paused' = legacy state, same idea. Both should be allowed through.
      if (existingRun.status === 'waiting' || existingRun.status === 'paused') {
        logger.info('Run is waiting for this decision, proceeding', {
          runId: existingRun.id,
          status: existingRun.status,
          proposalId,
          triggerRunId: getTriggerRunId(existingRun),
          orphaned: orphanedWaitingRun
        });
        // For legacy 'paused' runs (no waitpoint), mark completed so we can proceed.
        if (existingRun.status === 'paused' || orphanedWaitingRun) {
          await db.updateAgentRun(existingRun.id, {
            status: 'completed',
            ended_at: new Date(),
            ...(orphanedWaitingRun ? { error: 'orphaned_waiting_run_recovered' } : {})
          });
        }
      } else {
        // Run is actually active (queued/running), block the decision
        return res.status(409).json({
          success: false,
          error: 'Case already has an active agent run',
          activeRun: {
            id: existingRun.id,
            status: existingRun.status,
            trigger_type: existingRun.trigger_type
          }
        });
      }
    }

    // Apply any inline edits to the draft before executing
    const { draft_body_text, draft_subject } = req.body;
    if (action === 'APPROVE' && (draft_body_text !== undefined || draft_subject !== undefined)) {
      const draftUpdates = buildApprovalDraftUpdates(proposal, {
        draft_body_text,
        draft_subject,
      });
      await db.updateProposal(proposalId, draftUpdates);
      proposal = await db.getProposalById(proposalId);
      logger.info('Applied inline draft edits before approval', { proposalId, fields: Object.keys(draftUpdates) });
    }

    // Apply chain follow-up draft edits (if user edited the chain step in the dashboard)
    const { chain_draft_body_text, chain_draft_subject } = req.body;
    if (action === 'APPROVE' && proposal.chain_id && (chain_draft_body_text !== undefined || chain_draft_subject !== undefined)) {
      try {
        const chainProposals = await db.getChainProposals(proposal.chain_id);
        const followUp = chainProposals.find(p => p.chain_step > 0);
        if (followUp) {
          const chainUpdates = buildApprovalDraftUpdates(followUp, {
            draft_body_text: chain_draft_body_text,
            draft_subject: chain_draft_subject,
          });
          if (Object.keys(chainUpdates).length > 0) {
            await db.updateProposal(followUp.id, chainUpdates);
            logger.info('Applied chain follow-up draft edits', { proposalId: followUp.id, chainId: proposal.chain_id, fields: Object.keys(chainUpdates) });
          }
        }
      } catch (chainErr) {
        logger.warn('Failed to apply chain draft edits (non-fatal)', { proposalId, chainId: proposal.chain_id, error: chainErr.message });
      }
    }

    // Build human decision object (full details for graph and DB)
    const humanDecision = buildHumanDecision(action, {
      proposalId,
      instruction: instruction || null,
      reason: reason || null,
      decidedBy: req.body.decidedBy || 'human',
      ...(validatedAttachments.length > 0 ? { attachments: validatedAttachments } : {}),
      ...(recipientOverride ? { recipient_override: recipientOverride } : {}),
    });

    const feeWorkflowResult = await feeWorkflowService.handleFeeProposalDecision(proposal, {
      action,
      humanDecision,
      reason: reason || null,
      decidedBy: req.body.decidedBy || 'human',
    });
    if (feeWorkflowResult.handled) {
      let waitpointCleanupError = null;
      try {
        await feeWorkflowService.completeFeeProposalWaitpoint(proposal, humanDecision);
      } catch (error) {
        waitpointCleanupError = error;
        logger.warn('Failed to complete fee workflow waitpoint after parking case', {
          proposalId,
          caseId,
          action,
          error: error.message,
        });
      }

      return res.json({
        ...feeWorkflowResult.response,
        ...(waitpointCleanupError ? { waitpoint_cleanup_error: waitpointCleanupError.message } : {}),
      });
    }

    // Auto-capture eval cases on human decisions (best-effort, non-blocking).
    if (action === 'DISMISS') {
      await captureDismissFeedback(proposal, {
        instruction: instruction || null,
        reason: reason || null,
        decidedBy: req.body.decidedBy || 'human',
      });
    } else if (action === 'APPROVE') {
      await autoCaptureEvalCase(proposal, {
        action,
        decidedBy: req.body.decidedBy || 'human',
      });
    } else if (action === 'ADJUST') {
      await autoCaptureEvalCase(proposal, {
        action,
        instruction: instruction || null,
        reason: reason || null,
        decidedBy: req.body.decidedBy || 'human',
      });
    }

    if (action === 'RETRY_RESEARCH') {
      const retryDecision = buildHumanDecision(action, {
        proposalId,
        instruction: null,
        reason: reason || 'User requested research retry',
        decidedBy: req.body.decidedBy || 'human',
      });

      await proposalLifecycle.applyHumanReviewDecision(proposalId, {
        status: 'DISMISSED',
        humanDecision: retryDecision,
      });

      await db.updateCase(caseId, {
        contact_research_notes: JSON.stringify({
          cleared: true,
          retryReason: 'user_retry',
          previouslyClearedAt: new Date().toISOString(),
        }),
      });

      const latestInbound = await db.query(
        `SELECT id
         FROM messages
         WHERE case_id = $1 AND direction = 'inbound'
         ORDER BY COALESCE(received_at, created_at) DESC
         LIMIT 1`,
        [caseId]
      );
      const messageId = latestInbound.rows[0]?.id || proposal.trigger_message_id || null;

      let handle;
      try {
        handle = (await triggerDispatch.triggerTask('process-inbound', {
          runId: 0,
          caseId,
          messageId,
          autopilotMode: proposal.autopilot_mode || 'SUPERVISED',
          triggerType: 'HUMAN_REVIEW_RESOLUTION',
          reviewAction: 'RETRY_RESEARCH',
          reviewInstruction: 'Research failed previously. Retry agency research from scratch.',
        }, triggerOpts(caseId, 'retry-research', proposalId))).handle;
      } catch (triggerError) {
        await proposalLifecycle.clearHumanReviewDecision(proposalId, {
          status: 'PENDING_APPROVAL',
        });
        await db.logActivity('proposal_dispatch_failed', `Retry research for proposal #${proposalId} failed to dispatch: ${triggerError.message}`, {
          case_id: caseId,
          proposal_id: proposalId,
          error: triggerError.message,
          actor_type: 'human',
          source_service: 'dashboard',
        });
        throw triggerError;
      }

      await db.logActivity('proposal_retry_research', `Research retry triggered for proposal #${proposalId} — re-processing case ${caseId}`, {
        case_id: caseId,
        proposal_id: proposalId,
        trigger_run_id: handle.id,
        actor_type: 'human',
        source_service: 'dashboard',
      });

      return res.json({
        success: true,
        message: 'Research retry started. A new research proposal will be generated.',
        proposal_id: proposalId,
        action,
        trigger_run_id: handle.id,
      });
    }

    // === MANUAL_SUBMIT: user filled the portal form manually ===
    if (action === 'MANUAL_SUBMIT') {
      await proposalLifecycle.markProposalExecuted(proposalId, {
        humanDecision,
      });
      await transitionCaseRuntime(caseId, 'CASE_SENT', {
        sendDate: new Date().toISOString(),
        substatus: 'Manually submitted via portal',
      });
      await db.logActivity('proposal_manual_submit', `Proposal ${proposalId} manually submitted via portal`, {
        case_id: caseId,
        proposal_id: proposalId,
        actor_type: 'human',
        source_service: 'dashboard',
      });

      // Complete the waiting Trigger.dev run if one exists
      if (proposal.waitpoint_token?.startsWith('waitpoint_')) {
        try {
          const triggerApiUrl = process.env.TRIGGER_API_URL || 'https://api.trigger.dev';
          await fetch(
            `${triggerApiUrl}/api/v1/waitpoints/tokens/${proposal.waitpoint_token}/complete`,
            {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${process.env.TRIGGER_SECRET_KEY}`,
              },
              body: JSON.stringify({ data: { action: 'MANUAL_SUBMIT' } }),
            }
          );
        } catch (tokenErr) {
          logger.warn('Failed to complete waitpoint token for manual submit (non-fatal)', {
            proposalId, error: tokenErr.message,
          });
        }
      }

      logger.info('Proposal manually submitted via portal', { caseId, proposalId });
      return res.json({
        success: true,
        message: 'Marked as manually submitted',
        proposal_id: proposalId,
        action: 'MANUAL_SUBMIT',
      });
    }

    const isLocalDirectApprovalEligible =
      process.env.NODE_ENV !== 'production' &&
      action === 'APPROVE' &&
      Boolean(proposal.waitpoint_token) &&
      (
        (proposal.action_type === 'SEND_PDF_EMAIL') ||
        (proposal.draft_body_text && proposal.draft_subject)
      );

    const isLocalDirectAdjustEligible =
      process.env.NODE_ENV !== 'production' &&
      action === 'ADJUST' &&
      Boolean(proposal.waitpoint_token) &&
      ['SEND_INITIAL_REQUEST', 'SEND_CLARIFICATION', 'SEND_PDF_EMAIL', 'SEND_REBUTTAL', 'ACCEPT_FEE', 'NEGOTIATE_FEE', 'SEND_FOLLOWUP'].includes(proposal.action_type) &&
      Boolean(instruction);

    if (isLocalDirectAdjustEligible) {
      logger.info('Local dev adjustment bypassing waitpoint and re-drafting directly', {
        proposalId,
        caseId,
        actionType: proposal.action_type,
      });

      const finalAdjustedProposal = proposal.action_type === 'SEND_CLARIFICATION'
        ? await createAdjustedClarificationProposalLocally(
            proposal,
            humanDecision,
            existingRun
          )
        : proposal.action_type === 'SEND_PDF_EMAIL'
          ? await createAdjustedPdfEmailProposalLocally(
              proposal,
              humanDecision,
              existingRun
            )
          : proposal.action_type === 'SEND_INITIAL_REQUEST'
            ? await createAdjustedInitialRequestProposalLocally(
                proposal,
                humanDecision,
                existingRun
              )
            : await createAdjustedGenericEmailProposalLocally(
                proposal,
                humanDecision,
                existingRun
              );

      return res.json({
        success: true,
        message: `${proposal.action_type} adjusted locally`,
        proposal_id: finalAdjustedProposal.id,
        action,
        fallback: 'local_direct_adjustment',
      });
    }

    if (isLocalDirectApprovalEligible) {
      logger.info('Local dev approval bypassing waitpoint and executing directly', {
        proposalId,
        caseId,
        actionType: proposal.action_type,
      });

      const caseDataForLocalApproval = await db.getCaseById(caseId);
      const shouldUsePortalLocalApproval =
        Boolean(caseDataForLocalApproval?.portal_url) &&
        ['ACCEPT_FEE', 'NEGOTIATE_FEE'].includes(proposal.action_type);

      if (shouldUsePortalLocalApproval) {
        await executeApprovedPortalActionLocally(proposal, humanDecision);
      } else if (proposal.action_type === 'SEND_PDF_EMAIL') {
        await executeApprovedProposalPdfEmailDirectly(proposal, humanDecision);
      } else {
        await executeApprovedProposalEmailDirectly(proposal, humanDecision);
      }

      if (existingRun?.id && ['waiting', 'paused'].includes(existingRun.status)) {
        await db.updateAgentRun(existingRun.id, {
          status: 'completed',
          ended_at: new Date(),
          error: 'local_direct_approval_bypass',
        });
      }

      return res.json({
        success: true,
        message: shouldUsePortalLocalApproval
          ? 'Portal action completed directly via local approval path'
          : proposal.action_type === 'SEND_PDF_EMAIL'
            ? 'PDF email sent directly via local approval path'
            : 'Email sent directly via local approval path',
        proposal_id: proposalId,
        action,
        fallback: 'local_direct_approval',
      });
    }

    const canResumeWaitpoint =
      Boolean(proposal.waitpoint_token)
      && Boolean(existingRun)
      && !orphanedWaitingRun
      && Boolean(getTriggerRunId(existingRun));

    // === Trigger.dev path: complete waitpoint token ===
    if (canResumeWaitpoint) {
      if (action === 'DISMISS' || action === 'WITHDRAW') {
        const nextProposalStatus = action === 'WITHDRAW' ? 'WITHDRAWN' : 'DISMISSED';
        await proposalLifecycle.applyHumanReviewDecision(proposalId, {
          status: nextProposalStatus,
          humanDecision,
        });

        if (action === 'WITHDRAW') {
          await transitionCaseRuntime(caseId, 'PROPOSAL_WITHDRAWN', { proposalId });
          await transitionCaseRuntime(caseId, 'CASE_CANCELLED', { substatus: 'withdrawn_by_user' });
        } else {
          await reconcileCaseAfterDismiss(caseId, proposal);
        }

        if (existingRun?.id) {
          await db.updateAgentRun(existingRun.id, {
            status: 'completed',
            ended_at: new Date(),
            error: action === 'WITHDRAW'
              ? 'waitpoint_withdraw_resolved_locally'
              : 'waitpoint_dismiss_resolved_locally',
          });
        }

        let waitpointCleanupError = null;
        try {
          const triggerApiUrl = process.env.TRIGGER_API_URL || 'https://api.trigger.dev';
          const cleanupResp = await fetch(
            `${triggerApiUrl}/api/v1/waitpoints/tokens/${proposal.waitpoint_token}/complete`,
            {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${process.env.TRIGGER_SECRET_KEY}`,
              },
              body: JSON.stringify({ data: { action, instruction: instruction || null, reason: reason || null, attachments: validatedAttachments.length > 0 ? validatedAttachments : undefined, recipient_override: recipientOverride || undefined } }),
            }
          );

          if (!cleanupResp.ok) {
            const errorBody = await cleanupResp.text();
            throw new Error(`Failed to complete waitpoint token ${proposal.waitpoint_token}: ${cleanupResp.status} ${errorBody}`);
          }
        } catch (error) {
          waitpointCleanupError = error;
          logger.warn('Waitpoint cleanup failed after local dismiss/withdraw resolution', {
            proposalId,
            caseId,
            action,
            error: error.message,
          });
        }

        return res.json({
          success: true,
          message: action === 'WITHDRAW'
            ? 'Proposal withdrawn and case cancelled'
            : 'Proposal dismissed',
          proposal_id: proposalId,
          action,
          ...(waitpointCleanupError ? { waitpoint_cleanup_error: waitpointCleanupError.message } : {}),
        });
      }

      // Resolve token ID: gate-or-execute stores a UUID idempotencyKey initially,
      // waitForHumanDecision overwrites with real waitpoint_xxx ID.
      // Handle both formats for robustness.
      let tokenId = proposal.waitpoint_token;
      if (!tokenId.startsWith('waitpoint_')) {
        // Stored value is the UUID idempotencyKey — resolve to real Trigger.dev token
        const token = await triggerWait.createToken({ idempotencyKey: tokenId, timeout: '30d' });
        tokenId = token.id;
        logger.info('Resolved UUID idempotencyKey to real token', {
          proposalId, idempotencyKey: proposal.waitpoint_token, resolvedTokenId: tokenId,
        });
      }

      // Update DB first so the task sees DECISION_RECEIVED when it resumes
      await proposalLifecycle.markProposalDecisionReceived(proposalId, {
        humanDecision,
      });
      await db.query(
        `UPDATE cases SET requires_human = false, pause_reason = NULL, updated_at = NOW() WHERE id = $1`,
        [caseId]
      );

      // Complete the waitpoint token via direct HTTP (SDK completeToken is unreliable
      // for tokens created inside running tasks — returns sporadic 500 errors)
      const triggerApiUrl = process.env.TRIGGER_API_URL || 'https://api.trigger.dev';
      let waitpointError = null;
      try {
        const completeResp = await fetch(
          `${triggerApiUrl}/api/v1/waitpoints/tokens/${tokenId}/complete`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${process.env.TRIGGER_SECRET_KEY}`,
            },
            body: JSON.stringify({ data: { action, instruction: instruction || null, reason: reason || null, attachments: validatedAttachments.length > 0 ? validatedAttachments : undefined, recipient_override: recipientOverride || undefined } }),
          }
        );

        if (!completeResp.ok) {
          const errorBody = await completeResp.text();
          throw new Error(`Failed to complete waitpoint token ${tokenId}: ${completeResp.status} ${errorBody}`);
        }
      } catch (error) {
        waitpointError = error;
      }

      if (waitpointError) {
        const refreshedProposal = await db.getProposalById(proposalId).catch(() => null);
        const fallbackProposal = refreshedProposal || proposal;
        const canFallbackToDirectEmail =
          action === 'APPROVE' &&
          fallbackProposal?.draft_body_text &&
          fallbackProposal?.draft_subject;
        const canFallbackToDirectPdfEmail =
          action === 'APPROVE' &&
          fallbackProposal?.action_type === 'SEND_PDF_EMAIL';

        if (canFallbackToDirectPdfEmail || canFallbackToDirectEmail) {
          logger.warn('Waitpoint completion failed; falling back to direct execution', {
            proposalId,
            caseId,
            error: waitpointError.message,
          });
          if (canFallbackToDirectPdfEmail) {
            await executeApprovedProposalPdfEmailDirectly(fallbackProposal, humanDecision);
          } else {
            await executeApprovedProposalEmailDirectly(fallbackProposal, humanDecision);
          }
          return res.json({
            success: true,
            message: canFallbackToDirectPdfEmail
              ? 'PDF email sent directly after waitpoint fallback'
              : 'Email sent directly after waitpoint fallback',
            proposal_id: proposalId,
            action,
            fallback: canFallbackToDirectPdfEmail ? 'direct_pdf_email' : 'direct_email',
          });
        }

        await proposalLifecycle.clearHumanReviewDecision(proposalId, {
          status: 'PENDING_APPROVAL',
        });
        await db.query(
          `UPDATE cases
           SET requires_human = true,
               pause_reason = 'PENDING_APPROVAL',
               updated_at = NOW()
           WHERE id = $1`,
          [caseId]
        );
        throw waitpointError;
      }

      logger.info('Trigger.dev waitpoint token completed', {
        proposalId,
        caseId,
        action,
        tokenId,
      });

      return res.status(202).json({
        success: true,
        message: 'Decision received, Trigger.dev task resuming',
        proposal_id: proposalId,
        action,
      });
    }

    // === Legacy path: proposals without waitpoint_token (old LangGraph pipeline) ===

    // DISMISS/WITHDRAW: just update DB status
    if (action === 'DISMISS' || action === 'WITHDRAW') {
      await proposalLifecycle.applyHumanReviewDecision(proposalId, {
        status: action === 'WITHDRAW' ? 'WITHDRAWN' : 'DISMISSED',
        humanDecision,
      });
      logger.info(`Legacy proposal ${action.toLowerCase()}ed`, { proposalId, action });

      // Reconcile case state so it doesn't stay orphaned in a review status
      if (action === 'WITHDRAW') {
        await transitionCaseRuntime(caseId, 'PROPOSAL_WITHDRAWN', { proposalId });
        await transitionCaseRuntime(caseId, 'CASE_CANCELLED', { substatus: 'withdrawn_by_user' });
      } else {
        await reconcileCaseAfterDismiss(caseId, proposal);
      }

      return res.json({
        success: true,
        message: `Proposal ${action.toLowerCase()}ed`,
        proposal_id: proposalId,
        action
      });
    }

    // APPROVE on old proposals: send email directly if draft is present
    // ADJUST falls through to pipeline re-trigger so the instruction can be applied
    const refreshedProposal = await db.getProposalById(proposalId);
    if (action === 'APPROVE' && refreshedProposal.draft_body_text && refreshedProposal.draft_subject) {
      if (refreshedProposal.action_type === 'SEND_PDF_EMAIL') {
        await executeApprovedProposalPdfEmailDirectly(refreshedProposal, humanDecision);
      } else {
        await executeApprovedProposalEmailDirectly(refreshedProposal, humanDecision);
      }
      return res.json({
        success: true,
        message: refreshedProposal.action_type === 'SEND_PDF_EMAIL'
          ? 'PDF email sent directly'
          : 'Email sent directly',
        proposal_id: proposalId,
        action,
      });
    }

    // Fallback: no draft — re-trigger through Trigger.dev to regenerate
    const run = await db.createAgentRunFull({
      case_id: caseId,
      trigger_type: 'resume',
      status: 'queued',
      autopilot_mode: proposal.autopilot_mode || 'SUPERVISED',
      langgraph_thread_id: `resume:${caseId}:proposal-${proposalId}`
    });

    await proposalLifecycle.markProposalDecisionReceived(proposalId, {
      humanDecision,
    });
    await db.query(
      `UPDATE cases SET requires_human = false, pause_reason = NULL, updated_at = NOW() WHERE id = $1`,
      [caseId]
    );

    let handle;
    try {
      if (proposal.action_type === 'SUBMIT_PORTAL') {
        // Portal approval: create portal_task and dispatch submit-portal directly
        const caseData = await db.getCaseById(caseId);
        const portalUrl = caseData?.portal_url;
        if (!portalUrl) throw new Error(`No portal URL on case ${caseId}`);
        if (!isSupportedPortalUrl(portalUrl, caseData?.portal_provider || null, caseData?.last_portal_status || null)) {
          throw new Error(`Portal URL on case ${caseId} is not automatable`);
        }
        const portalDecision = await db.getPortalAutomationDecision(
          portalUrl,
          caseData?.portal_provider || null,
          caseData?.last_portal_status || null
        );
        if (portalDecision?.decision === 'review') {
          return res.status(409).json(buildOperatorActionErrorResponse(
            new Error('Portal needs operator confirmation before automation. Confirm it on the case detail page or mark it manual-only.'),
            'PORTAL_CONFIRMATION_REQUIRED'
          ));
        }
        if (portalDecision?.decision === 'block') {
          return res.status(409).json(buildOperatorActionErrorResponse(
            new Error(`Portal is blocked for automation (${portalDecision.reason || 'manual-only'})`),
            'PORTAL_MANUAL_ONLY'
          ));
        }
        const priorPortalAttempts = await db.getAutomatedPortalAttemptCount(caseId);
        if (priorPortalAttempts >= 2) {
          return res.status(409).json(buildOperatorActionErrorResponse(
            new Error(`Portal automation attempt limit reached (${priorPortalAttempts} prior automated attempts)`),
            'PORTAL_ATTEMPT_LIMIT_REACHED'
          ));
        }

        const ptResult = await db.query(
          `INSERT INTO portal_tasks (case_id, portal_url, action_type, status, proposal_id, instructions)
           VALUES ($1, $2, $3, 'PENDING', $4, $5)
           RETURNING id`,
          [caseId, portalUrl, proposal.action_type, proposalId, refreshedProposal.draft_body_text || null]
        );
        const portalTaskId = ptResult.rows[0]?.id || null;

        // Transition proposal to PENDING_PORTAL so the portal service approval gate recognizes it
        await proposalLifecycle.markProposalPendingPortal(proposalId, {
          humanDecision,
          runId: run.id,
        });

        // Update run trigger_type for clarity
        await db.updateAgentRun(run.id, { trigger_type: 'submit_portal' });

        handle = (await triggerDispatch.triggerTask('submit-portal', {
          caseId,
          portalUrl,
          provider: caseData.portal_provider || null,
          instructions: refreshedProposal.draft_body_text || null,
          portalTaskId,
          agentRunId: run.id,
        }, triggerOpts(caseId, 'portal', run.id), {
          runId: run.id,
          caseId,
          triggerType: 'submit_portal',
          source: 'run_engine_approve_portal',
        })).handle;
      } else if (proposal.action_type === 'SEND_INITIAL_REQUEST') {
        const initialPayload = {
          runId: run.id,
          caseId,
          autopilotMode: proposal.autopilot_mode || 'SUPERVISED',
          ...(action === 'ADJUST'
            ? {
                triggerType: 'ADJUSTMENT',
                reviewInstruction: instruction || null,
                originalActionType: proposal.action_type,
                originalProposalId: proposalId,
              }
            : {}),
        };
        handle = (await triggerDispatch.triggerTask(
          'process-initial-request',
          initialPayload,
          triggerOptsDebounced(caseId, 'resume-initial', run.id)
        )).handle;
      } else {
        const inboundPayload = {
          runId: run.id,
          caseId,
          messageId: proposal.trigger_message_id,
          autopilotMode: proposal.autopilot_mode || 'SUPERVISED',
          ...(action === 'ADJUST'
            ? {
                triggerType: 'ADJUSTMENT',
                reviewInstruction: instruction || null,
                originalActionType: proposal.action_type,
                originalProposalId: proposalId,
              }
            : {}),
        };
        handle = (await triggerDispatch.triggerTask(
          'process-inbound',
          inboundPayload,
          triggerOptsDebounced(caseId, 'resume-inbound', run.id)
        )).handle;
      }
    } catch (triggerError) {
      // Keep proposal actionable if Trigger.dev dispatch fails.
      await proposalLifecycle.clearHumanReviewDecision(proposalId, {
        status: 'PENDING_APPROVAL',
      });
      await db.logActivity('proposal_dispatch_failed', `Decision for proposal #${proposalId} could not be dispatched to Trigger.dev: ${triggerError.message}`, {
        case_id: caseId,
        proposal_id: proposalId,
        action,
        error: triggerError.message,
        actor_type: 'human',
        source_service: 'dashboard',
      });
      await db.updateAgentRun(run.id, { status: 'failed', ended_at: new Date(), error: `Trigger failed: ${triggerError.message}` });
      throw triggerError;
    }

    await saveTriggerRunId(run.id, handle.id);
    logger.info('Legacy proposal re-triggered via Trigger.dev (no draft)', {
      runId: run.id,
      caseId,
      proposalId,
      action,
      triggerRunId: handle.id
    });

    res.status(202).json({
      success: true,
      message: 'Decision received, re-processing via Trigger.dev',
      run: {
        id: run.id,
        status: run.status
      },
      proposal_id: proposalId,
      action,
      trigger_run_id: handle.id
    });

  } catch (error) {
    if (error.code === '23505' && String(error.constraint || '').includes('one_active_per_case')) {
      return res.status(409).json(buildOperatorActionErrorResponse(
        new Error('Case already has an active agent run (constraint)'),
        'ACTIVE_RUN_EXISTS'
      ));
    }
    logger.error('Error processing proposal decision', { proposalId, error: error.message });
    res.status(500).json(buildOperatorActionErrorResponse(error, getProposalDecisionErrorCode(error)));
  }
});

/**
 * POST /cases/:id/run-followup
 *
 * Manually trigger a follow-up for a case.
 * Creates agent_run record and enqueues worker job.
 *
 * Body (optional):
 * - autopilotMode: 'AUTO' | 'SUPERVISED' (default: 'SUPERVISED')
 * - followupScheduleId: ID of the follow_up_schedule record (optional, will lookup if not provided)
 */
router.post('/cases/:id/run-followup', async (req, res) => {
  const caseId = parseInt(req.params.id);
  const { autopilotMode = 'SUPERVISED', followupScheduleId, llmStubs } = req.body || {};

  try {
    // Verify case exists
    const caseData = await db.getCaseById(caseId);
    if (!caseData) {
      return res.status(404).json({
        success: false,
        error: `Case ${caseId} not found`
      });
    }

    // Check case is in appropriate status
    const status = String(caseData.status || '').toLowerCase();
    const isResearchHandoff = String(caseData.pause_reason || '').toUpperCase() === 'RESEARCH_HANDOFF';
    const isEligible =
      FOLLOWUP_ELIGIBLE_STATUSES.has(status) ||
      (FOLLOWUP_RESEARCH_HANDOFF_STATUSES.has(status) && isResearchHandoff);
    if (!isEligible) {
      return res.status(400).json({
        success: false,
        error: `Case status is not eligible for follow-up`,
        current_status: caseData.status,
        pause_reason: caseData.pause_reason || null
      });
    }

    // Check for existing active run
    const existingRun = await db.getActiveRunForCase(caseId);
    if (existingRun) {
      return res.status(409).json({
        success: false,
        error: 'Case already has an active agent run',
        activeRun: {
          id: existingRun.id,
          status: existingRun.status,
          trigger_type: existingRun.trigger_type,
          started_at: existingRun.started_at
        }
      });
    }

    // Get or validate follow-up schedule
    let followupSchedule;
    if (followupScheduleId) {
      followupSchedule = await db.getFollowUpScheduleById(followupScheduleId);
      if (!followupSchedule || followupSchedule.case_id !== caseId) {
        return res.status(404).json({
          success: false,
          error: `Follow-up schedule ${followupScheduleId} not found or does not belong to case`
        });
      }
    } else {
      // Lookup schedule by case_id
      followupSchedule = await db.getFollowUpScheduleByCaseId(caseId);
    }

    const followupCount = followupSchedule?.followup_count || 0;
    const today = new Date().toISOString().split('T')[0];
    const scheduledKey = `followup:${caseId}:${followupCount}:manual:${today}`;

    // Create run record
    const run = await db.createAgentRunFull({
      case_id: caseId,
      trigger_type: 'followup_trigger',
      scheduled_key: scheduledKey,
      status: 'queued',
      autopilot_mode: autopilotMode,
      langgraph_thread_id: `followup:${caseId}:${followupCount}:${Date.now()}`
    });

    // Update follow-up schedule if it exists
    if (followupSchedule) {
      await db.query(`
        UPDATE follow_up_schedule
        SET status = 'processing',
            scheduled_key = $2,
            last_run_id = $3,
            updated_at = NOW()
        WHERE id = $1
      `, [followupSchedule.id, scheduledKey, run.id]);
    }

    const localMaterialization = await materializeFollowupLocally({
      caseData,
      run,
      autopilotMode,
      llmStubs,
    });
    if (localMaterialization) {
      return res.status(202).json({
        success: true,
        message: 'Follow-up processed locally',
        fallback: 'local_followup_materialization',
        proposal_id: localMaterialization.proposalId,
        action_type: localMaterialization.actionType,
        run: {
          id: run.id,
          status: localMaterialization.runStatus || 'completed',
          thread_id: run.langgraph_thread_id
        },
        followup: {
          count: followupCount,
          schedule_id: followupSchedule?.id || null
        }
      });
    }

    // Trigger Trigger.dev task (clean up orphaned run on failure)
    let handle;
    try {
      handle = (await triggerDispatch.triggerTask('process-followup', {
        runId: run.id,
        caseId,
        followupScheduleId: followupSchedule?.id || null,
      }, triggerOpts(caseId, 'followup', run.id))).handle;
    } catch (triggerError) {
      await db.updateAgentRun(run.id, { status: 'failed', ended_at: new Date(), error: `Trigger failed: ${triggerError.message}` });
      throw triggerError;
    }

    await saveTriggerRunId(run.id, handle.id);
    logger.info('Follow-up trigger task triggered', {
      runId: run.id,
      caseId,
      triggerRunId: handle.id,
      followupCount,
      manualTrigger: true
    });

    res.status(202).json({
      success: true,
      message: 'Follow-up generation queued',
      run: {
        id: run.id,
        status: run.status,
        thread_id: run.langgraph_thread_id
      },
      followup: {
        count: followupCount,
        schedule_id: followupSchedule?.id || null
      },
      trigger_run_id: handle.id
    });

  } catch (error) {
    if (error.code === '23505' && String(error.constraint || '').includes('one_active_per_case')) {
      return res.status(409).json({ success: false, error: 'Case already has an active agent run (constraint)' });
    }
    logger.error('Error creating followup run', { caseId, error: error.message });
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * POST /followups/:id/trigger
 *
 * Manually trigger a specific follow-up schedule.
 * Creates agent_run record and enqueues worker job.
 *
 * Body (optional):
 * - autopilotMode: 'AUTO' | 'SUPERVISED' (default from schedule or 'SUPERVISED')
 */
router.post('/followups/:id/trigger', async (req, res) => {
  const followupId = parseInt(req.params.id);
  const { autopilotMode } = req.body || {};

  try {
    // Get follow-up schedule
    const followupSchedule = await db.getFollowUpScheduleById(followupId);
    if (!followupSchedule) {
      return res.status(404).json({
        success: false,
        error: `Follow-up schedule ${followupId} not found`
      });
    }

    const caseId = followupSchedule.case_id;

    // Verify case exists
    const caseData = await db.getCaseById(caseId);
    if (!caseData) {
      return res.status(404).json({
        success: false,
        error: `Case ${caseId} not found`
      });
    }

    // Check for existing active run
    const existingRun = await db.getActiveRunForCase(caseId);
    if (existingRun) {
      return res.status(409).json({
        success: false,
        error: 'Case already has an active agent run',
        activeRun: {
          id: existingRun.id,
          status: existingRun.status,
          trigger_type: existingRun.trigger_type,
          started_at: existingRun.started_at
        }
      });
    }

    const followupCount = followupSchedule.followup_count || 0;
    const mode = autopilotMode || followupSchedule.autopilot_mode || caseData.autopilot_mode || 'SUPERVISED';
    const today = new Date().toISOString().split('T')[0];
    const scheduledKey = `followup:${caseId}:${followupCount}:manual:${today}`;

    // Create run record
    const run = await db.createAgentRunFull({
      case_id: caseId,
      trigger_type: 'followup_trigger',
      scheduled_key: scheduledKey,
      status: 'queued',
      autopilot_mode: mode,
      langgraph_thread_id: `followup:${caseId}:${followupCount}:${Date.now()}`
    });

    // Update follow-up schedule
    await db.query(`
      UPDATE follow_up_schedule
      SET status = 'processing',
          scheduled_key = $2,
          last_run_id = $3,
          updated_at = NOW()
      WHERE id = $1
    `, [followupId, scheduledKey, run.id]);

    // Trigger Trigger.dev task (clean up orphaned run on failure)
    let handle;
    try {
      handle = (await triggerDispatch.triggerTask('process-followup', {
        runId: run.id,
        caseId,
        followupScheduleId: followupId,
      }, triggerOpts(caseId, 'followup', run.id))).handle;
    } catch (triggerError) {
      await db.updateAgentRun(run.id, { status: 'failed', ended_at: new Date(), error: `Trigger failed: ${triggerError.message}` });
      throw triggerError;
    }

    await saveTriggerRunId(run.id, handle.id);
    logger.info('Follow-up trigger task triggered', {
      runId: run.id,
      caseId,
      followupId,
      triggerRunId: handle.id,
      followupCount,
      manualTrigger: true
    });

    res.status(202).json({
      success: true,
      message: 'Follow-up generation queued',
      run: {
        id: run.id,
        status: run.status,
        thread_id: run.langgraph_thread_id
      },
      followup: {
        id: followupId,
        count: followupCount,
        autopilot_mode: mode
      },
      trigger_run_id: handle.id
    });

  } catch (error) {
    if (error.code === '23505' && String(error.constraint || '').includes('one_active_per_case')) {
      return res.status(409).json({ success: false, error: 'Case already has an active agent run (constraint)' });
    }
    logger.error('Error triggering followup', { followupId, error: error.message });
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /proposals
 *
 * List proposals, with optional filters.
 * Used by the Approval Queue UI.
 *
 * Query params:
 * - status: Filter by status (single or comma-separated; default: human-review statuses)
 * - case_id: Filter by case ID
 * - limit: Max results (default: 50)
 */
router.get('/proposals', async (req, res) => {
  const statusParam = typeof req.query.status === 'string' ? req.query.status : '';
  const statuses = statusParam
    ? statusParam.split(',').map((s) => String(s || '').trim().toUpperCase()).filter(Boolean)
    : [...HUMAN_REVIEW_PROPOSAL_STATUSES];
  const caseId = req.query.case_id ? parseInt(req.query.case_id) : null;
  const limit = parseInt(req.query.limit) || 50;

  try {
    let query = `
      SELECT
        p.id,
        p.case_id,
        p.proposal_key,
        p.action_type,
        p.draft_subject,
        p.draft_body_text,
        p.draft_body_html,
        p.reasoning,
        p.confidence,
        p.risk_flags,
        p.warnings,
        p.can_auto_execute,
        p.requires_human,
        p.pause_reason,
        p.status,
        p.human_decision,
        p.created_at,
        p.updated_at,
        c.case_name,
        c.subject_name,
        c.agency_name,
        c.state AS agency_state,
        c.status AS case_status,
        c.requires_human AS case_requires_human,
        c.pause_reason AS case_pause_reason,
        c.autopilot_mode,
        ar.status AS active_run_status,
        ra.intent AS classification,
        ra.sentiment,
        ra.extracted_fee_amount
      FROM proposals p
      JOIN cases c ON p.case_id = c.id
      LEFT JOIN LATERAL (
        SELECT status
        FROM agent_runs ar
        WHERE ar.case_id = c.id
          AND ar.status IN ('created', 'queued', 'processing', 'running', 'waiting')
        ORDER BY ar.started_at DESC NULLS LAST, ar.id DESC
        LIMIT 1
      ) ar ON TRUE
      LEFT JOIN response_analysis ra ON ra.case_id = c.id
        AND ra.id = (SELECT MAX(id) FROM response_analysis WHERE case_id = c.id)
      WHERE p.status = ANY($1::text[])
    `;

    const params = [statuses];
    let paramIndex = 2;

    if (caseId) {
      query += ` AND p.case_id = $${paramIndex}`;
      params.push(caseId);
      paramIndex++;
    }

    query += ` ORDER BY p.created_at DESC LIMIT $${paramIndex}`;
    params.push(limit);

    const result = await db.query(query, params);

    res.json({
      success: true,
      count: result.rows.length,
      proposals: result.rows.map(row => {
        const truth = buildCaseTruth({
          caseData: {
            id: row.case_id,
            status: row.case_status,
            requires_human: row.case_requires_human,
            pause_reason: row.case_pause_reason,
          },
          activeProposal: {
            id: row.id,
            status: row.status,
          },
          activeRun: row.active_run_status ? { status: row.active_run_status } : null,
        });
        return {
          id: row.id,
          case_id: row.case_id,
          proposal_key: row.proposal_key,
          action_type: row.action_type,
          draft_subject: row.draft_subject,
          draft_body_text: row.draft_body_text,
          draft_body_html: row.draft_body_html,
          reasoning: row.reasoning,
          confidence: row.confidence,
          risk_flags: row.risk_flags,
          warnings: row.warnings,
          can_auto_execute: row.can_auto_execute,
          requires_human: row.requires_human,
          pause_reason: row.pause_reason,
          status: row.status,
          review_state: truth.review_state,
          human_decision: row.human_decision,
          created_at: row.created_at,
          updated_at: row.updated_at,
          case: {
            name: row.case_name,
            subject_name: row.subject_name,
            agency_name: row.agency_name,
            state: row.agency_state,
            status: row.case_status,
            autopilot_mode: row.autopilot_mode
          },
          analysis: {
            classification: row.classification,
            sentiment: row.sentiment,
            extracted_fee_amount: row.extracted_fee_amount
          }
        };
      })
    });

  } catch (error) {
    logger.error('Error fetching proposals', { error: error.message });
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /proposals/:id
 *
 * Get a single proposal with full details.
 */
router.get('/proposals/:id', async (req, res) => {
  const proposalId = parseInt(req.params.id);

  try {
    const proposal = await db.getProposalById(proposalId);
    if (!proposal) {
      return res.status(404).json({
        success: false,
        error: `Proposal ${proposalId} not found`
      });
    }

    // Get case details
    const caseData = await db.getCaseById(proposal.case_id);

    // Get latest response analysis
    const analysis = await db.getLatestResponseAnalysis(proposal.case_id);

    res.json({
      success: true,
      proposal: {
        ...proposal,
        case: caseData ? {
          name: caseData.case_name,
          subject_name: caseData.subject_name,
          agency_name: caseData.agency_name,
          state: caseData.state,
          status: caseData.status,
          autopilot_mode: caseData.autopilot_mode
        } : null,
        analysis: analysis ? {
          classification: analysis.classification,
          sentiment: analysis.sentiment,
          extracted_fee_amount: analysis.extracted_fee
        } : null
      }
    });

  } catch (error) {
    logger.error('Error fetching proposal', { proposalId, error: error.message });
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /runs
 *
 * List recent agent runs across all cases.
 * Used by the Runs dashboard page.
 *
 * Query params:
 * - status: Filter by status (optional)
 * - case_id: Filter by case ID (optional)
 * - limit: Max results (default: 50)
 */
router.get('/runs', async (req, res) => {
  const status = req.query.status || null;
  const caseId = req.query.case_id ? parseInt(req.query.case_id) : null;
  const limit = parseInt(req.query.limit) || 50;

  // Helper to map DB status to UI status
  const mapRunStatus = (dbStatus) => {
    const statusMap = {
      'created': 'running',
      'queued': 'running',
      'running': 'running',
      'completed': 'completed',
      'finished': 'completed',
      'failed': 'failed',
      'error': 'failed',
      'gated': 'gated',
      'paused': 'gated',
      'waiting': 'gated',
      'cancelled': 'cancelled',
      'canceled': 'cancelled',
      'skipped': 'completed'
    };
    return statusMap[dbStatus] || 'running';
  };

  try {
    let query = `
      SELECT
        ar.id,
        ar.case_id,
        ar.trigger_type,
        ar.status,
        ar.langgraph_thread_id,
        ar.proposal_id,
        ar.message_id,
        ar.autopilot_mode,
        ar.error AS error_message,
        ar.started_at,
        ar.ended_at AS completed_at,
        ar.metadata,
        c.case_name,
        c.subject_name,
        c.pause_reason,
        p.action_type AS final_action,
        p.confidence,
        p.risk_flags,
        p.draft_subject,
        p.draft_body_text,
        p.reasoning,
        p.warnings,
        p.status AS proposal_status,
        m.from_email AS trigger_from_email,
        m.subject AS trigger_subject,
        COALESCE(NULLIF(m.normalized_body_text, ''), m.body_text) AS trigger_body_text,
        m.created_at AS trigger_received_at,
        ra.intent AS trigger_classification,
        ra.sentiment AS trigger_sentiment,
        EXTRACT(EPOCH FROM (NOW() - ar.started_at)) AS duration_seconds
      FROM agent_runs ar
      LEFT JOIN cases c ON ar.case_id = c.id
      LEFT JOIN proposals p ON ar.proposal_id = p.id
      LEFT JOIN messages m ON ar.message_id = m.id
      LEFT JOIN response_analysis ra ON ra.message_id = m.id
      WHERE 1=1
    `;

    const params = [];
    let paramIndex = 1;

    if (status) {
      query += ` AND ar.status = $${paramIndex}`;
      params.push(status);
      paramIndex++;
    }

    if (caseId) {
      query += ` AND ar.case_id = $${paramIndex}`;
      params.push(caseId);
      paramIndex++;
    }

    query += ` ORDER BY ar.started_at DESC LIMIT $${paramIndex}`;
    params.push(limit);

    const result = await db.query(query, params);

    // Map to expected format with string IDs for frontend compatibility
    const runs = result.rows.map(row => {
      const durationSeconds = row.duration_seconds ? Math.round(parseFloat(row.duration_seconds)) : null;
      const isStuck = row.status === 'running' && durationSeconds && durationSeconds > 120;
      const errorMessage = row.error_message || null;
      const isSuperseded = typeof errorMessage === 'string' && errorMessage.toLowerCase().startsWith('superseded by');
      const uiStatus = isSuperseded ? 'cancelled' : mapRunStatus(row.status);
      const statusDetail = isSuperseded ? 'Superseded by newer run' : null;

      return {
        id: String(row.id),
        case_id: String(row.case_id),
        trigger_type: row.trigger_type || 'unknown',
        status: uiStatus,
        started_at: row.started_at,
        completed_at: row.completed_at,
        duration_seconds: durationSeconds,
        is_stuck: isStuck,
        error_message: errorMessage,
        status_detail: statusDetail,
        failure_category: isSuperseded ? 'superseded' : (errorMessage ? 'error' : null),
        trigger_status_verified: row.metadata?.trigger_status_verified || null,
        dispatch_source: row.metadata?.source || null,
        trigger_started: row.metadata?.trigger_started ?? null,
        final_action: row.final_action,
        case_name: row.case_name || row.subject_name,
        pause_reason: row.pause_reason,
        gated_reason: row.status === 'gated' ? 'Requires human approval' : null,
        node_trace: row.metadata?.nodeTrace || null,
        trigger_run_id: row.metadata?.triggerRunId || null,
        metadata: row.metadata || null,
        // Proposal data for gated runs
        proposal_id: row.proposal_id ? String(row.proposal_id) : null,
        proposal: row.proposal_id ? {
          action_type: row.final_action,
          confidence: row.confidence,
          risk_flags: row.risk_flags,
          draft_subject: row.draft_subject,
          draft_preview: row.draft_body_text ? row.draft_body_text.slice(0, 200) : null,
          reasoning: row.reasoning,
          warnings: row.warnings,
          status: row.proposal_status
        } : null,
        // Triggering inbound message data
        trigger_message: row.message_id ? {
          id: String(row.message_id),
          from_email: row.trigger_from_email,
          subject: row.trigger_subject,
          body_text: row.trigger_body_text,
          received_at: row.trigger_received_at,
          classification: row.trigger_classification,
          sentiment: row.trigger_sentiment
        } : null
      };
    });

    res.json({
      success: true,
      runs
    });

  } catch (error) {
    logger.error('Error fetching runs', { error: error.message });
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /runs/:id
 *
 * Get status and details of an agent run.
 */
router.get('/runs/:id', async (req, res) => {
  const runId = parseInt(req.params.id);

  try {
    const run = await db.getAgentRunById(runId);
    if (!run) {
      return res.status(404).json({
        success: false,
        error: `Run ${runId} not found`
      });
    }

    // Get associated proposals - try by run_id first, then fallback to case_id
    let proposals = await db.getProposalsByRunId(runId);

    // Fallback: if no proposals found by run_id, try to find recent proposals for this case
    // This handles legacy runs where run_id wasn't set on proposals
    if (proposals.length === 0 && run.case_id) {
      const caseProposals = await db.query(`
        SELECT * FROM proposals
        WHERE case_id = $1
          AND created_at >= $2
          AND created_at <= COALESCE($3, NOW() + interval '1 hour')
        ORDER BY created_at DESC
        LIMIT 5
      `, [run.case_id, run.started_at, run.ended_at]);
      proposals = caseProposals.rows;
    }

    // Get decision trace if available
    const decisionTrace = await db.getDecisionTraceByRunId(runId);

    // Pull run-scoped activity so the dashboard can show live "what is it doing?" context.
    const activityResult = await db.query(`
      SELECT id, event_type, description, metadata, created_at
      FROM activity_log
      WHERE case_id = $1
        AND (
          (
            (metadata->>'run_id') ~ '^[0-9]+$'
            AND (metadata->>'run_id')::int = $2
          )
          OR (
            (metadata->>'replay_run_id') ~ '^[0-9]+$'
            AND (metadata->>'replay_run_id')::int = $2
          )
          OR (
            (metadata->>'original_run_id') ~ '^[0-9]+$'
            AND (metadata->>'original_run_id')::int = $2
          )
          OR (
            (metadata->>'runId') ~ '^[0-9]+$'
            AND (metadata->>'runId')::int = $2
          )
          OR (
            (metadata->>'agent_run_id') ~ '^[0-9]+$'
            AND (metadata->>'agent_run_id')::int = $2
          )
          OR created_at BETWEEN ($3::timestamptz - interval '2 minutes')
                            AND (COALESCE($4::timestamptz, NOW()) + interval '2 minutes')
        )
      ORDER BY created_at DESC
      LIMIT 200
    `, [run.case_id, runId, run.started_at, run.ended_at || null]);

    const activity = activityResult.rows.map((row) => ({
      id: String(row.id),
      event_type: row.event_type,
      description: row.description,
      metadata: row.metadata || {},
      created_at: row.created_at
    }));

    res.json({
      success: true,
      run,
      proposals,
      decision_trace: decisionTrace,
      activity
    });

  } catch (error) {
    logger.error('Error fetching run', { runId, error: error.message });
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /cases/:id/runs
 *
 * Get all agent runs for a case.
 */
router.get('/cases/:id/runs', async (req, res) => {
  const caseId = parseInt(req.params.id);
  const limit = parseInt(req.query.limit) || 20;

  try {
    const runs = await db.getAgentRunsByCaseId(caseId, limit);

    res.json({
      success: true,
      count: runs.length,
      runs
    });

  } catch (error) {
    logger.error('Error fetching case runs', { caseId, error: error.message });
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * POST /runs/:id/cancel
 *
 * Cancel a stuck or running agent run.
 * Marks the run as failed so new runs can be started.
 */
router.post('/runs/:id/cancel', async (req, res) => {
  const runId = parseInt(req.params.id);
  const { reason } = req.body || {};

  try {
    // Update the run status to failed
    await db.query(`
      UPDATE agent_runs
      SET status = 'failed',
          ended_at = NOW(),
          error = $2
      WHERE id = $1
    `, [runId, reason || 'Cancelled by user']);

    logger.info('Agent run cancelled', { runId, reason });

    res.json({
      success: true,
      message: `Run ${runId} cancelled`,
      run_id: runId
    });

  } catch (error) {
    logger.error('Error cancelling run', { runId, error: error.message });
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * POST /runs/:id/retry
 *
 * Retry a failed or gated run.
 * Creates a new run with the same trigger type and case.
 */
router.post('/runs/:id/retry', async (req, res) => {
  const runId = parseInt(req.params.id);

  try {
    // Get the original run
    const originalRun = await db.getAgentRunById(runId);
    if (!originalRun) {
      return res.status(404).json({
        success: false,
        error: `Run ${runId} not found`
      });
    }

    // Check if case already has an active run
    const existingRun = await db.getActiveRunForCase(originalRun.case_id);
    if (existingRun) {
      return res.status(409).json({
        success: false,
        error: 'Case already has an active agent run',
        active_run_id: existingRun.id
      });
    }

    // Create a new run based on the original
    const newRun = await db.createAgentRunFull({
      case_id: originalRun.case_id,
      trigger_type: `RETRY_${originalRun.trigger_type}`,
      status: 'queued',
      autopilot_mode: originalRun.autopilot_mode || 'SUPERVISED',
      langgraph_thread_id: `retry:${originalRun.case_id}:run-${runId}:${Date.now()}`
    });

    // Trigger the appropriate Trigger.dev task based on original trigger type
    let handle;
    const triggerType = originalRun.trigger_type?.toLowerCase() || 'manual';

    try {
      if (triggerType.includes('initial')) {
        handle = (await triggerDispatch.triggerTask('process-initial-request', {
          runId: newRun.id,
          caseId: originalRun.case_id,
          autopilotMode: newRun.autopilot_mode || 'SUPERVISED',
        }, triggerOpts(originalRun.case_id, 'retry-initial', newRun.id))).handle;
      } else if (triggerType.includes('inbound') || triggerType.includes('manual')) {
        const messageId = originalRun.message_id;
        if (!messageId) {
          await db.updateAgentRun(newRun.id, { status: 'failed', ended_at: new Date(), error: 'No message_id on original run — cannot retry' });
          return res.status(400).json({ success: false, error: 'Original run has no message_id, cannot retry as inbound' });
        }
        handle = (await triggerDispatch.triggerTask('process-inbound', {
          runId: newRun.id,
          caseId: originalRun.case_id,
          messageId,
          autopilotMode: newRun.autopilot_mode || 'SUPERVISED',
        }, triggerOpts(originalRun.case_id, 'retry-inbound', newRun.id))).handle;
      } else if (triggerType.includes('followup')) {
        handle = (await triggerDispatch.triggerTask('process-followup', {
          runId: newRun.id,
          caseId: originalRun.case_id,
          followupScheduleId: null,
        }, triggerOpts(originalRun.case_id, 'retry-followup', newRun.id))).handle;
      } else {
        await db.updateAgentRun(newRun.id, { status: 'failed', ended_at: new Date(), error: `Unsupported trigger type for retry: ${triggerType}` });
        return res.status(400).json({ success: false, error: `Cannot retry trigger type: ${triggerType}` });
      }
    } catch (triggerError) {
      await db.updateAgentRun(newRun.id, { status: 'failed', ended_at: new Date(), error: `Trigger failed: ${triggerError.message}` });
      throw triggerError;
    }

    await saveTriggerRunId(newRun.id, handle.id);
    logger.info('Agent run retry created via Trigger.dev', {
      originalRunId: runId,
      newRunId: newRun.id,
      triggerType: newRun.trigger_type,
      triggerRunId: handle.id
    });

    res.status(202).json({
      success: true,
      message: 'Retry run created',
      original_run_id: runId,
      new_run: {
        id: newRun.id,
        status: newRun.status,
        trigger_type: newRun.trigger_type
      },
      trigger_run_id: handle.id
    });

  } catch (error) {
    if (error.code === '23505' && String(error.constraint || '').includes('one_active_per_case')) {
      return res.status(409).json({ success: false, error: 'Case already has an active agent run (constraint)' });
    }
    logger.error('Error retrying run', { runId, error: error.message });
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * POST /cases/:id/ingest-email
 *
 * ATOMIC endpoint: Manually ingest an inbound email AND trigger agent processing.
 * Used for manual data entry via paste or forwarding.
 *
 * Features:
 * - Idempotent: Duplicate emails (same from+subject+body within 24h window) return 409
 * - Atomic: Creates message AND triggers run in one call
 * - Returns run_id for tracking
 *
 * Body:
 * - from_email: string (required) - Sender email address
 * - subject: string - Email subject
 * - body_text: string (required) - Email body
 * - message_id_header: string (optional) - Email Message-ID header for deduplication
 * - received_at: string - ISO timestamp (defaults to now)
 * - source: string - Source of the email (defaults to 'manual_paste')
 * - autopilot_mode: 'AUTO' | 'SUPERVISED' (defaults to 'SUPERVISED')
 * - trigger_run: boolean (defaults to true) - Set false to only create message without processing
 * - attachments: array (optional) - Synthetic/manual attachment payloads with filename, content_type/type,
 *   extracted_text, and optional content_base64 for file-backed attachment workflows
 */
router.post('/cases/:id/ingest-email', async (req, res) => {
  const caseId = parseInt(req.params.id);
  const {
    from_email,
    subject,
    body_text,
    message_id_header,
    received_at,
    source = 'manual_paste',
    autopilot_mode = 'SUPERVISED',
    trigger_run = true,
    attachments: rawAttachments = []
  } = req.body || {};
  const attachments = normalizeInboundAttachments(rawAttachments);

  try {
    // === VALIDATION (422 for parsing failures) ===
    const validationErrors = [];

    if (!from_email) {
      validationErrors.push({ field: 'from_email', error: 'required' });
    } else if (!from_email.includes('@')) {
      validationErrors.push({ field: 'from_email', error: 'invalid email format' });
    }

    if (!body_text) {
      validationErrors.push({ field: 'body_text', error: 'required' });
    } else if (body_text.length < 10) {
      validationErrors.push({ field: 'body_text', error: 'too short (min 10 chars)' });
    }

    if (validationErrors.length > 0) {
      return res.status(422).json({
        success: false,
        error: 'Validation failed',
        details: validationErrors
      });
    }

    // Verify case exists
    const caseData = await db.getCaseById(caseId);
    if (!caseData) {
      return res.status(404).json({
        success: false,
        error: 'Case not found'
      });
    }

    // === DEDUPLICATION ===
    // Generate dedupe key from: message_id_header OR hash(from + subject + normalized_body)
    const crypto = require('crypto');
    const normalizedBody = body_text.trim().toLowerCase().replace(/\s+/g, ' ').slice(0, 500);
    const dedupeKey = message_id_header ||
      crypto.createHash('sha256')
        .update(`${from_email}|${subject || ''}|${normalizedBody}`)
        .digest('hex')
        .slice(0, 32);

    // Check for duplicate within 24h window
    const duplicateCheck = await db.query(`
      SELECT id, created_at FROM messages
      WHERE thread_id IN (SELECT id FROM email_threads WHERE case_id = $1)
        AND direction = 'inbound'
        AND (
          metadata->>'dedupe_key' = $2
          OR metadata->>'message_id_header' = $3
        )
        AND created_at > NOW() - INTERVAL '24 hours'
      LIMIT 1
    `, [caseId, dedupeKey, message_id_header || 'none']);

    if (duplicateCheck.rows.length > 0) {
      const existing = duplicateCheck.rows[0];
      logger.info('Duplicate email detected', { caseId, existingMessageId: existing.id, dedupeKey });
      return res.status(409).json({
        success: false,
        error: 'Duplicate email already ingested',
        existing_message_id: existing.id,
        created_at: existing.created_at,
        dedupe_key: dedupeKey
      });
    }

    // === CHECK FOR ACTIVE RUN ===
    if (trigger_run) {
      const existingRun = await db.getActiveRunForCase(caseId);
      if (existingRun) {
        return res.status(409).json({
          success: false,
          error: 'Case has an active agent run. Wait for it to complete or cancel it first.',
          active_run: {
            id: existingRun.id,
            status: existingRun.status,
            started_at: existingRun.started_at
          }
        });
      }
    }

    // === CREATE THREAD IF NEEDED ===
    const thread = await ensureCaseThread(
      caseId,
      subject || `Manual ingestion for case ${caseId}`,
      from_email || caseData.agency_email || caseData.alternate_agency_email || null
    );

    // === CREATE MESSAGE ===
    const syntheticProviderMessageId = `ingest-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const message = await db.createMessage({
      thread_id: thread.id,
      case_id: caseId,
      message_id: message_id_header || `<${syntheticProviderMessageId}@manual.autobot>`,
      provider_message_id: syntheticProviderMessageId,
      sendgrid_message_id: null,
      direction: 'inbound',
      from_email,
      to_email: caseData.our_email || process.env.FOIA_FROM_EMAIL || 'noreply@example.com',
      subject: subject || '(No subject)',
      body_text,
      body_html: null,
      has_attachments: attachments.length > 0,
      attachment_count: attachments.length,
      message_type: 'manual_ingest',
      received_at: received_at ? new Date(received_at) : new Date(),
      metadata: {
        source,
        manual_paste: true,
        dedupe_key: dedupeKey,
        message_id_header: message_id_header || null,
        attachment_count: attachments.length
      }
    });

    if (attachments.length > 0) {
      for (const attachment of attachments) {
        const fileBuffer = attachment.contentBase64
          ? Buffer.from(attachment.contentBase64, 'base64')
          : null;
        const savedAttachment = await db.createAttachment({
          message_id: message.id,
          case_id: caseId,
          filename: attachment.filename,
          content_type: attachment.contentType,
          size_bytes:
            attachment.sizeBytes ||
            fileBuffer?.length ||
            Buffer.byteLength(attachment.extractedText || '', 'utf8'),
          storage_path: null,
          storage_url: null,
          file_data: fileBuffer,
        });
        if (attachment.extractedText) {
          await db.query(
            'UPDATE attachments SET extracted_text = $1 WHERE id = $2',
            [attachment.extractedText, savedAttachment.id]
          );
        }
      }
    }

    // Update case last_response_date
    await db.updateCase(caseId, {
      last_response_date: message.received_at,
      status: 'responded'
    });

    // Log activity
    await db.logActivity('email_ingested', `Manually ingested inbound email from ${from_email}`, {
      case_id: caseId,
      message_id: message.id,
      source: source,
      from_email: from_email,
      actor_type: 'human',
      source_service: 'dashboard',
    });

    // === TRIGGER RUN (atomic) ===
    let run = null;
    let job = null;

    if (trigger_run) {
      // Create agent run record
      run = await db.createAgentRunFull({
        case_id: caseId,
        trigger_type: 'inbound_message',
        message_id: message.id,
        status: 'queued',
        autopilot_mode: autopilot_mode,
        langgraph_thread_id: `case:${caseId}:msg-${message.id}`
      });

      // Trigger Trigger.dev task (clean up orphaned run on failure)
      try {
        const handle = (await triggerDispatch.triggerTask('process-inbound', {
          runId: run.id,
          caseId,
          messageId: message.id,
          autopilotMode: autopilot_mode,
        }, triggerOpts(caseId, 'inbound', run.id))).handle;
        job = { id: handle.id };
      } catch (triggerError) {
        await db.updateAgentRun(run.id, { status: 'failed', ended_at: new Date(), error: `Trigger failed: ${triggerError.message}` });
        throw triggerError;
      }

      logger.info('Email ingested and Trigger.dev task triggered', {
        caseId,
        messageId: message.id,
        runId: run.id,
        triggerRunId: job.id
      });
    } else {
      logger.info('Email ingested (no run triggered)', {
        caseId,
        messageId: message.id
      });
    }

    // Return 201 for new resource, with run info
    res.status(201).json({
      success: true,
      message: trigger_run ? 'Email ingested and processing started' : 'Email ingested successfully',
      inbound_message_id: message.id,
      thread_id: thread.id,
      dedupe_key: dedupeKey,
      run: run ? {
        id: run.id,
        status: run.status,
        thread_id: run.langgraph_thread_id
      } : null,
      job_id: job?.id || null
    });

  } catch (error) {
    logger.error('Error ingesting email', { caseId, error: error.message, stack: error.stack });
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * POST /cases/:id/add-correspondence
 *
 * Log manual correspondence (phone call, letter, in-person, fax, other)
 * and optionally trigger agent processing for next-step recommendations.
 *
 * Body:
 * - correspondence_type: string (required) - phone_call | letter | in_person | fax | other
 * - direction: string (required) - inbound | outbound
 * - summary: string (required, min 10 chars) - Description of what happened
 * - contact_name: string (optional) - Contact person name
 * - contact_info: string (optional) - Phone/address/etc
 * - trigger_ai: boolean (defaults to true) - Set false to only log without processing
 */
router.post('/cases/:id/add-correspondence', async (req, res) => {
  const caseId = parseInt(req.params.id);
  const {
    correspondence_type,
    direction,
    summary,
    contact_name,
    contact_info
  } = req.body || {};
  // Coerce trigger_ai: string "false" → false, missing → true
  const trigger_ai = req.body?.trigger_ai === false || req.body?.trigger_ai === 'false' ? false : true;

  try {
    // === VALIDATION ===
    const validationErrors = [];
    const allowedTypes = ['phone_call', 'letter', 'in_person', 'fax', 'other'];
    const allowedDirections = ['inbound', 'outbound'];

    if (!correspondence_type || typeof correspondence_type !== 'string') {
      validationErrors.push({ field: 'correspondence_type', error: 'required (string)' });
    } else if (!allowedTypes.includes(correspondence_type)) {
      validationErrors.push({ field: 'correspondence_type', error: `must be one of: ${allowedTypes.join(', ')}` });
    }

    if (!direction || typeof direction !== 'string') {
      validationErrors.push({ field: 'direction', error: 'required (string)' });
    } else if (!allowedDirections.includes(direction)) {
      validationErrors.push({ field: 'direction', error: 'must be inbound or outbound' });
    }

    if (!summary || typeof summary !== 'string') {
      validationErrors.push({ field: 'summary', error: 'required (string)' });
    } else if (summary.trim().length < 10) {
      validationErrors.push({ field: 'summary', error: 'too short (min 10 chars after trimming)' });
    }

    if (validationErrors.length > 0) {
      return res.status(422).json({
        success: false,
        error: 'Validation failed',
        details: validationErrors
      });
    }

    // Verify case exists
    const caseData = await db.getCaseById(caseId);
    if (!caseData) {
      return res.status(404).json({ success: false, error: 'Case not found' });
    }

    // === DEDUPLICATION ===
    const crypto = require('crypto');
    const normalizedSummary = summary.trim().toLowerCase().replace(/\s+/g, ' ').slice(0, 500);
    const dedupeKey = crypto.createHash('sha256')
      .update(`${correspondence_type}|${direction}|${normalizedSummary}`)
      .digest('hex')
      .slice(0, 32);

    const duplicateCheck = await db.query(`
      SELECT id, created_at FROM messages
      WHERE thread_id IN (SELECT id FROM email_threads WHERE case_id = $1)
        AND direction = $2
        AND metadata->>'dedupe_key' = $3
        AND created_at > NOW() - INTERVAL '24 hours'
      LIMIT 1
    `, [caseId, direction, dedupeKey]);

    if (duplicateCheck.rows.length > 0) {
      const existing = duplicateCheck.rows[0];
      logger.info('Duplicate correspondence detected', { caseId, existingMessageId: existing.id, dedupeKey });
      return res.status(409).json({
        success: false,
        reason: 'duplicate',
        error: 'Duplicate correspondence already logged',
        existing_message_id: existing.id,
        dedupe_key: dedupeKey
      });
    }

    // === CHECK FOR ACTIVE RUN ===
    if (trigger_ai) {
      const existingRun = await db.getActiveRunForCase(caseId);
      if (existingRun) {
        return res.status(409).json({
          success: false,
          reason: 'active_run',
          error: 'Case has an active agent run. Wait for it to complete or cancel it first.',
          active_run: { id: existingRun.id, status: existingRun.status, started_at: existingRun.started_at }
        });
      }
    }

    // === CREATE THREAD IF NEEDED ===
    const thread = await ensureCaseThread(
      caseId,
      `Correspondence for case ${caseId}`,
      caseData.agency_email || caseData.alternate_agency_email || null
    );

    // === CREATE MESSAGE ===
    const fromLabel = direction === 'inbound' ? (contact_name || 'Agency Contact') : 'Our Team';
    const toLabel = direction === 'inbound' ? 'Our Team' : (contact_name || 'Agency Contact');
    const typeLabel = correspondence_type.replace(/_/g, ' ');

    const syntheticProviderMessageId = `correspondence-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const message = await db.createMessage({
      thread_id: thread.id,
      case_id: caseId,
      message_id: `<${syntheticProviderMessageId}@manual.autobot>`,
      provider_message_id: syntheticProviderMessageId,
      sendgrid_message_id: null,
      direction,
      from_email: fromLabel,
      to_email: toLabel,
      subject: `Manual ${typeLabel}${contact_name ? ` - ${contact_name}` : ''}`,
      body_text: summary,
      body_html: null,
      message_type: correspondence_type,
      received_at: direction === 'inbound' ? new Date() : null,
      sent_at: direction === 'outbound' ? new Date() : null,
      metadata: {
        source: 'manual_correspondence',
        correspondence_type,
        contact_name: contact_name || null,
        contact_info: contact_info || null,
        dedupe_key: dedupeKey
      }
    });

    // Update case status based on direction
    if (direction === 'inbound') {
      await db.updateCase(caseId, { last_response_date: message.received_at, status: 'responded' });
    } else if (direction === 'outbound') {
      await db.updateCase(caseId, { status: 'awaiting_response' });
    }

    await db.logActivity('correspondence_logged', `Logged ${direction} ${typeLabel}`, {
      case_id: caseId, message_id: message.id, correspondence_type, direction, contact_name: contact_name || null,
      actor_type: 'human', source_service: 'dashboard',
    });

    // === TRIGGER AI RUN ===
    let run = null;
    let job = null;

    if (trigger_ai) {
      run = await db.createAgentRunFull({
        case_id: caseId,
        trigger_type: 'inbound_message',
        message_id: message.id,
        status: 'queued',
        autopilot_mode: 'SUPERVISED',
        langgraph_thread_id: `case:${caseId}:msg-${message.id}`
      });

      try {
        const handle = (await triggerDispatch.triggerTask('process-inbound', {
          runId: run.id,
          caseId,
          messageId: message.id,
          autopilotMode: 'SUPERVISED',
        }, triggerOpts(caseId, 'inbound', run.id))).handle;
        job = { id: handle.id };
      } catch (triggerError) {
        await db.updateAgentRun(run.id, { status: 'failed', ended_at: new Date(), error: `Trigger failed: ${triggerError.message}` });
        throw triggerError;
      }

      logger.info('Correspondence logged and Trigger.dev task triggered', { caseId, messageId: message.id, runId: run.id });
    } else {
      logger.info('Correspondence logged (no run triggered)', { caseId, messageId: message.id });
    }

    res.status(201).json({
      success: true,
      message: trigger_ai ? 'Correspondence logged and AI processing started' : 'Correspondence logged successfully',
      inbound_message_id: message.id,
      thread_id: thread.id,
      dedupe_key: dedupeKey,
      run: run ? { id: run.id, status: run.status, thread_id: run.langgraph_thread_id } : null,
      job_id: job?.id || null
    });

  } catch (error) {
    logger.error('Error logging correspondence', { caseId, error: error.message, stack: error.stack });
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /cases/:id/inbound-and-run
 *
 * ATOMIC endpoint that creates an inbound message AND triggers agent processing in one call.
 * This is the recommended endpoint for testing as it avoids race conditions.
 *
 * Body:
 * - body_text: (required) The email body text
 * - subject: (optional) Email subject
 * - from_email: (optional) Sender email, defaults to agency email
 * - classification: (optional) Pre-analyzed classification for testing
 * - extracted_fee: (optional) Pre-extracted fee amount
 * - autopilotMode: 'AUTO' | 'SUPERVISED' (default: 'SUPERVISED')
 * - llmStubs: Object with stubbed LLM responses for testing
 * - force_new_run: (optional) If true, cancels any active run first
 */
router.post('/cases/:id/inbound-and-run', async (req, res) => {
  const caseId = parseInt(req.params.id);
  const {
    body_text,
    subject,
    from_email,
    classification,
    extracted_fee,
    autopilotMode = 'SUPERVISED',
    llmStubs,
    force_new_run = false
  } = req.body || {};

  try {
    // Validate body_text
    if (!body_text) {
      return res.status(400).json({
        success: false,
        error: 'body_text is required',
        expected_format: {
          body_text: 'string (required)',
          subject: 'string (optional)',
          from_email: 'string (optional)',
          classification: 'string (optional) - FEE_QUOTE, DENIAL, etc.',
          extracted_fee: 'number (optional)',
          autopilotMode: 'AUTO | SUPERVISED (default: SUPERVISED)',
          llmStubs: 'object (optional)',
          force_new_run: 'boolean (optional) - cancel active run first'
        }
      });
    }

    // Verify case exists
    const caseData = await db.getCaseById(caseId);
    if (!caseData) {
      return res.status(404).json({
        success: false,
        error: `Case ${caseId} not found`
      });
    }

    // Check for existing active run
    const existingRun = await db.getActiveRunForCase(caseId);
    if (existingRun) {
      if (force_new_run) {
        // Cancel the existing run
        await db.query(`
          UPDATE agent_runs
          SET status = 'failed',
              ended_at = NOW(),
              error = 'Cancelled by inbound-and-run force_new_run'
          WHERE id = $1
        `, [existingRun.id]);
        logger.info('Cancelled existing run for force_new_run', { runId: existingRun.id, caseId });
      } else {
        return res.status(409).json({
          success: false,
          error: 'Case already has an active agent run',
          hint: 'Set force_new_run: true to cancel the active run, or wait for it to complete',
          activeRun: {
            id: existingRun.id,
            status: existingRun.status,
            trigger_type: existingRun.trigger_type,
            started_at: existingRun.started_at
          }
        });
      }
    }

    // Get or create thread for the case
    const thread = await ensureCaseThread(
      caseId,
      subject || `Inbound for case ${caseId}`,
      from_email || caseData.agency_email || caseData.alternate_agency_email || null
    );

    // Create the inbound message
    const syntheticProviderMessageId = `inbound-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const message = await db.createMessage({
      thread_id: thread.id,
      case_id: caseId,
      message_id: `<${syntheticProviderMessageId}@synthetic.autobot>`,
      provider_message_id: syntheticProviderMessageId,
      sendgrid_message_id: null,
      direction: 'inbound',
      from_email: from_email || caseData.agency_email || 'agency@test.example.com',
      to_email: process.env.FOIA_FROM_EMAIL || 'foia@autobot.example.com',
      subject: subject || `RE: ${caseData.case_name || 'FOIA Request'}`,
      body_text,
      body_html: `<p>${body_text.replace(/\n/g, '</p><p>')}</p>`,
      message_type: 'response',
      received_at: new Date(),
      metadata: { source: 'inbound-and-run', classification, extracted_fee }
    });

    // Create response analysis record if classification provided
    if (classification || extracted_fee) {
      await db.query(`
        INSERT INTO response_analysis (case_id, message_id, intent, sentiment, extracted_fee_amount)
        VALUES ($1, $2, $3, $4, $5)
      `, [caseId, message.id, classification || 'UNKNOWN', 'neutral', extracted_fee || null]);
    }

    // Create agent run record
    const run = await db.createAgentRunFull({
      case_id: caseId,
      trigger_type: 'inbound_message',
      message_id: message.id,
      status: 'queued',
      autopilot_mode: autopilotMode,
      langgraph_thread_id: `case:${caseId}:msg-${message.id}`
    });

    // Trigger Trigger.dev task (clean up orphaned run on failure)
    let handle;
    try {
      handle = (await triggerDispatch.triggerTask('process-inbound', {
        runId: run.id,
        caseId,
        messageId: message.id,
        autopilotMode,
      }, triggerOpts(caseId, 'inbound', run.id))).handle;
    } catch (triggerError) {
      await db.updateAgentRun(run.id, { status: 'failed', ended_at: new Date(), error: `Trigger failed: ${triggerError.message}` });
      throw triggerError;
    }

    await saveTriggerRunId(run.id, handle.id);
    logger.info('Inbound-and-run completed via Trigger.dev', {
      caseId,
      messageId: message.id,
      runId: run.id,
      triggerRunId: handle.id
    });

    res.status(202).json({
      success: true,
      message: 'Message created and processing queued',
      data: {
        message_id: message.id,
        thread_id: thread.id,
        run_id: run.id,
        trigger_run_id: handle.id,
        classification: classification || null,
        extracted_fee: extracted_fee || null
      },
      run: {
        id: run.id,
        status: run.status,
        thread_id: run.langgraph_thread_id
      }
    });

  } catch (error) {
    logger.error('Error in inbound-and-run', { caseId, error: error.message, stack: error.stack });
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

router.getProposalDecisionErrorCode = getProposalDecisionErrorCode;

module.exports = router;
