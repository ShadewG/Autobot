import { config } from 'dotenv';
import fs from 'node:fs';
import crypto from 'node:crypto';

config({ path: '/Users/samuelhylton/Documents/gits/Autobot MVP/.env' });

const db = require('../services/database');
const notionService = require('../services/notion-service');
const pdfFormService = require('../services/pdf-form-service');
const { updateConstraints } = require('../trigger/steps/update-constraints');
const { decideNextAction } = require('../trigger/steps/decide-next-action');
const { draftResponse } = require('../trigger/steps/draft-response');
const { safetyCheck } = require('../trigger/steps/safety-check');
const { createProposalAndGate } = require('../trigger/steps/gate-or-execute');

notionService.syncStatusToNotion = async () => ({ skipped: true });

const base = 'http://127.0.0.1:3094';
const samplePdfPath = '/Users/samuelhylton/Documents/gits/Autobot MVP/data/attachments/25159/form_1771427720609.pdf';
const attachmentText = 'PORTER COUNTY ACCESS TO PUBLIC RECORDS ACT REQUEST FORM';
const requesterInbox = process.env.REQUESTER_EMAIL || process.env.REQUESTS_INBOX || 'requests@foib-request.com';
const inboundBody = [
  'The requested records are compiled, but they are too large to email.',
  'Please complete the attached New FOIA Request Form for our records.',
  'Include a mailing address for CD delivery if needed.',
].join('\n\n');

type FlowResult = Record<string, any>;

async function j(url: string, opts: any = {}) {
  const res = await fetch(url, opts);
  const text = await res.text();
  let data: any;
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text };
  }
  if (!res.ok) throw new Error(`${res.status} ${url} ${JSON.stringify(data)}`);
  return data;
}

async function jRetry(url: string, opts: any = {}, attempts = 4, delayMs = 500) {
  let lastError: any = null;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await j(url, opts);
    } catch (error: any) {
      lastError = error;
      const message = String(error?.message || '');
      const retryable = /timeout exceeded when trying to connect/i.test(message)
        || /ECONNRESET/i.test(message)
        || /socket hang up/i.test(message)
        || /connection terminated/i.test(message);
      if (!retryable || attempt === attempts) break;
      await new Promise((resolve) => setTimeout(resolve, delayMs * attempt));
    }
  }
  throw lastError;
}

async function createSeedCase(label: string) {
  const notionId = crypto.randomUUID();
  const result = await db.query(
    `INSERT INTO cases (
      case_name, subject_name, agency_name, agency_email, state, status,
      notion_page_id, additional_details, autopilot_mode, requires_human,
      pause_reason,
      created_at, updated_at
    ) VALUES (
      $1,$2,$3,$4,$5,'needs_human_review',$6,$7,'SUPERVISED',false,
      NULL,
      NOW(),NOW()
    ) RETURNING *`,
    [
      `QA PDF ${label}`,
      'Jordan Example',
      'Synthetic QA Records Unit, Arizona',
      'shadewofficial@gmail.com',
      'AZ',
      notionId,
      'Synthetic QA PDF flow seed',
    ]
  );
  return result.rows[0];
}

async function seedInboundPdfCase(label: string) {
  const caseData = await createSeedCase(label);
  const thread = await db.createEmailThread({
    case_id: caseData.id,
    thread_id: `<qa-pdf-${caseData.id}@autobot.local>`,
    subject: 'Re: Completed Public Records Request Form needed',
    agency_email: caseData.agency_email,
    status: 'active',
  });
  const message = await db.createMessage({
    thread_id: thread.id,
    case_id: caseData.id,
    message_id: `<qa-pdf-msg-${caseData.id}@autobot.local>`,
    direction: 'inbound',
    from_email: caseData.agency_email,
    to_email: requesterInbox,
    subject: 'Re: Completed Public Records Request Form needed',
    body_text: inboundBody,
    body_html: null,
    has_attachments: true,
    attachment_count: 1,
    message_type: 'email',
    portal_notification: false,
    sent_at: null,
    received_at: new Date(),
    summary: 'Agency requested a completed request form and mailing address',
    metadata: { source: 'qa_pdf_manual_batch' },
  });
  const stat = fs.statSync(samplePdfPath);
  const attachment = await db.createAttachment({
    message_id: message.id,
    case_id: caseData.id,
    filename: 'New FOIA Request Form.pdf',
    content_type: 'application/pdf',
    size_bytes: stat.size,
    storage_path: samplePdfPath,
    storage_url: null,
    file_data: null,
  });
  await db.query(
    'UPDATE attachments SET extracted_text = $2 WHERE id = $1',
    [attachment.id, attachmentText]
  );
  await db.createResponseAnalysis({
    message_id: message.id,
    case_id: caseData.id,
    intent: 'CLARIFICATION_REQUEST',
    confidence_score: 0.97,
    sentiment: 'neutral',
    key_points: ['request form required', 'mailing address required', 'records too large for email'],
    extracted_deadline: null,
    extracted_fee_amount: null,
    requires_action: true,
    suggested_action: 'SEND_PDF_EMAIL',
    full_analysis_json: {
      classification: 'CLARIFICATION_REQUEST',
      key_points: ['request form required', 'mailing address required', 'records too large for email'],
    },
  });
  return { caseData, messageId: message.id };
}

async function materializePdfProposal(caseData: any, messageId: number, options: { forceFailure?: boolean } = {}) {
  const originalPrepare = pdfFormService.prepareInboundPdfFormReply;
  if (options.forceFailure) {
    pdfFormService.prepareInboundPdfFormReply = async () => ({
      success: false,
      manualRequired: true,
      error: 'Forced local PDF preparation failure for QA matrix',
      sourceAttachmentId: null,
      sourceFilename: 'New FOIA Request Form.pdf',
    });
  }

  try {
    const { constraints, scopeItems } = await updateConstraints(
      caseData.id,
      'CLARIFICATION_REQUEST',
      null,
      messageId,
      [],
      []
    );
    const decision = await decideNextAction(
      caseData.id,
      'CLARIFICATION_REQUEST',
      constraints,
      null,
      'neutral',
      'SUPERVISED',
      'INBOUND_MESSAGE',
      true,
      null,
      null,
      null,
      null
    );

    let draft: any = { subject: null, bodyText: null, bodyHtml: null, lessonsApplied: [] };
    let safety: any;
    if (decision.actionType === 'SEND_PDF_EMAIL') {
      draft = await draftResponse(
        caseData.id,
        decision.actionType,
        constraints,
        scopeItems,
        null,
        null,
        messageId
      );
    }

    safety = await safetyCheck(
      draft.bodyText,
      draft.subject,
      decision.actionType,
      constraints,
      scopeItems
    );

    const run = await db.createAgentRun(caseData.id, 'INBOUND_MESSAGE', {
      messageId,
      source: 'qa_pdf_manual_batch',
      forceFailure: Boolean(options.forceFailure),
    });
    await db.updateAgentRun(run.id, {
      status: 'running',
      started_at: new Date(),
      metadata: {
        messageId,
        source: 'qa_pdf_manual_batch',
        forceFailure: Boolean(options.forceFailure),
      },
    });

    const gate = await createProposalAndGate(
      caseData.id,
      run.id,
      decision.actionType,
      messageId,
      draft,
      safety,
      decision.canAutoExecute,
      decision.requiresHuman,
      decision.pauseReason,
      decision.reasoning,
      0.97,
      0,
      null,
      draft.lessonsApplied || null
    );

    await db.updateAgentRun(run.id, {
      status: gate.shouldWait ? 'waiting' : 'completed',
      proposal_id: gate.proposalId,
      ended_at: gate.shouldWait ? null : new Date(),
      metadata: {
        messageId,
        source: 'qa_pdf_manual_batch',
        forceFailure: Boolean(options.forceFailure),
        materializedProposalId: gate.proposalId,
      },
    });

    const proposal = await db.getProposalById(gate.proposalId);
    return { decision, proposal };
  } finally {
    pdfFormService.prepareInboundPdfFormReply = originalPrepare;
  }
}

async function latestOutbound(caseId: number) {
  const result = await db.query(
    `SELECT id, to_email, subject, body_text, message_type, sent_at
     FROM messages
     WHERE case_id = $1 AND direction = 'outbound'
     ORDER BY id DESC
     LIMIT 1`,
    [caseId]
  );
  return result.rows[0] || null;
}

async function runApproveFlow() {
  const { caseData, messageId } = await seedInboundPdfCase('approve');
  const { decision, proposal } = await materializePdfProposal(caseData, messageId);
  const approve = await jRetry(`${base}/api/proposals/${proposal.id}/decision`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'APPROVE' }),
  });
  const workspace = await jRetry(`${base}/api/requests/${caseData.id}/workspace`);
  const outbound = await latestOutbound(caseData.id);
  const prepared = await pdfFormService.getLatestPreparedPdfAttachment(caseData.id);
  return {
    flow: 'pdf_approve',
    caseId: caseData.id,
    decision: decision.actionType,
    proposalId: proposal.id,
    approve,
    workspace: {
      request_status: workspace.request?.status,
      review_state: workspace.review_state,
      control_state: workspace.control_state,
      next_action: workspace.next_action_proposal?.action_type || null,
      pending_action: workspace.pending_proposal?.action_type || null,
    },
    outbound,
    preparedAttachment: prepared ? { id: prepared.id, filename: prepared.filename } : null,
  };
}

async function runAdjustFlow() {
  const { caseData, messageId } = await seedInboundPdfCase('adjust');
  const { decision, proposal } = await materializePdfProposal(caseData, messageId);
  const sentence = 'The completed request form is attached as a PDF for your records.';
  const adjust = await jRetry(`${base}/api/proposals/${proposal.id}/decision`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      action: 'ADJUST',
      instruction: `Keep this as a PDF email. Add exactly this sentence after the first paragraph: ${sentence}`,
    }),
  });
  const proposals = await jRetry(`${base}/api/requests/${caseData.id}/proposals`);
  const adjusted = proposals.proposals[0] || null;
  const adjustedDetail = adjusted ? await jRetry(`${base}/api/proposals/${adjusted.id}`) : null;
  const approve = adjusted ? await jRetry(`${base}/api/proposals/${adjusted.id}/decision`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'APPROVE' }),
  }) : null;
  const workspace = await jRetry(`${base}/api/requests/${caseData.id}/workspace`);
  const outbound = await latestOutbound(caseData.id);
  return {
    flow: 'pdf_adjust_then_approve',
    caseId: caseData.id,
    decision: decision.actionType,
    proposalId: proposal.id,
    adjust,
    adjustedProposalId: adjusted?.id || null,
    adjustedContainsSentence: Boolean(adjustedDetail?.proposal?.draft_body_text?.includes(sentence)),
    approve,
    workspace: {
      request_status: workspace.request?.status,
      review_state: workspace.review_state,
      control_state: workspace.control_state,
      next_action: workspace.next_action_proposal?.action_type || null,
      pending_action: workspace.pending_proposal?.action_type || null,
    },
    outbound,
  };
}

async function runFailureManualFlow() {
  const { caseData, messageId } = await seedInboundPdfCase('manual');
  const { decision, proposal } = await materializePdfProposal(caseData, messageId, { forceFailure: true });
  const dismiss = await jRetry(`${base}/api/proposals/${proposal.id}/decision`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'DISMISS' }),
  });
  const manual = await jRetry(`${base}/api/requests/${caseData.id}/send-manual`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      to_email: caseData.agency_email,
      subject: 'Completed request form attached manually',
      body: 'To Synthetic QA Records Unit,\n\nI completed the attached request form manually and am sending it for your records.\n\nThank you.',
    }),
  });
  const workspace = await jRetry(`${base}/api/requests/${caseData.id}/workspace`);
  const outbound = await latestOutbound(caseData.id);
  return {
    flow: 'pdf_failure_manual_takeover',
    caseId: caseData.id,
    decision: decision.actionType,
    proposalId: proposal.id,
    dismiss,
    manual,
    workspace: {
      request_status: workspace.request?.status,
      review_state: workspace.review_state,
      control_state: workspace.control_state,
      next_action: workspace.next_action_proposal?.action_type || null,
      pending_action: workspace.pending_proposal?.action_type || null,
    },
    outbound,
  };
}

(async () => {
  const results: FlowResult[] = [];
  results.push(await runApproveFlow());
  results.push(await runAdjustFlow());
  results.push(await runFailureManualFlow());
  console.log(JSON.stringify(results, null, 2));
  await db.pool.end();
})().catch(async (error: any) => {
  console.error(error);
  try { await db.pool.end(); } catch (_) {}
  process.exit(1);
});
