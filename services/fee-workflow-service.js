const db = require('./database');
const notionService = require('./notion-service');
const proposalLifecycle = require('./proposal-lifecycle');
const triggerDispatch = require('./trigger-dispatch-service');
const { extractUrls } = require('../utils/contact-utils');

const WAITING_INVOICE_PAYMENT = 'WAITING_INVOICE_PAYMENT';
const WAITING_GOOD_TO_PAY = 'WAITING_GOOD_TO_PAY';
const READY_FOR_INVOICE_LABEL = 'READY FOR INVOICE';
const WAITING_GOOD_TO_PAY_LABEL = 'WAITING FOR GOOD TO PAY';
const GOOD_TO_PAY_LABEL = 'GOOD TO PAY';
const CASE_PAID_LABEL = 'CASE PAID';

function normalizeLabel(value) {
  return String(value || '').trim().toUpperCase();
}

function propertyPlainText(property) {
  if (!property || typeof property !== 'object') return '';
  switch (property.type) {
    case 'title':
      return (property.title || []).map((v) => v.plain_text || '').join('').trim();
    case 'rich_text':
      return (property.rich_text || []).map((v) => v.plain_text || '').join('').trim();
    case 'email':
      return String(property.email || '').trim();
    case 'url':
      return String(property.url || '').trim();
    case 'phone_number':
      return String(property.phone_number || '').trim();
    case 'number':
      return property.number == null ? '' : String(property.number);
    case 'select':
      return String(property.select?.name || '').trim();
    case 'status':
      return String(property.status?.name || '').trim();
    default:
      return '';
  }
}

function propertyDate(property) {
  if (!property || typeof property !== 'object') return null;
  if (property.type !== 'date') return null;
  return property.date?.start || null;
}

function propertyMultiSelect(property) {
  if (!property || typeof property !== 'object') return [];
  if (property.type !== 'multi_select') return [];
  return (property.multi_select || []).map((item) => String(item?.name || '').trim()).filter(Boolean);
}

function dedupeLines(lines) {
  return [...new Set(lines.map((line) => String(line || '').trim()).filter(Boolean))];
}

function getFeeAmount(caseData, proposal = null) {
  const amount =
    caseData?.last_fee_quote_amount ??
    caseData?.fee_amount ??
    caseData?.fee_quote_jsonb?.amount ??
    proposal?.metadata?.fee_amount ??
    null;
  const numeric = Number(amount);
  return Number.isFinite(numeric) ? numeric : null;
}

function buildMailingAddress(caseData, user = null) {
  const parts = [
    caseData?.requester_address || user?.address_street || null,
    caseData?.requester_address_line2 || user?.address_street2 || null,
  ].filter(Boolean);
  const city = caseData?.requester_city || user?.address_city || null;
  const state = caseData?.requester_state || user?.address_state || null;
  const zip = caseData?.requester_zip || user?.address_zip || null;
  const locality = [city, [state, zip].filter(Boolean).join(' ')].filter(Boolean).join(', ');
  if (locality) parts.push(locality);
  return parts.join('\n').trim() || null;
}

function buildPaymentContextFromMessage(message, caseData, proposal) {
  const body = [message?.body_text, message?.normalized_body_text, message?.body_html].filter(Boolean).join('\n');
  const urls = extractUrls(body).filter((url) => /pay|payment|invoice|billing/i.test(url));
  const invoiceMatch = body.match(/(?:invoice|inv(?:oice)?\s*(?:number|#)?|reference|ref(?:erence)?\s*#?)\s*[:#-]?\s*([A-Z0-9-]{4,})/i);
  const termLines = dedupeLines(
    body
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => /(invoice|payment|payable|mail|check|money order|due|fee|amount)/i.test(line))
  ).slice(0, 8);
  const mailingAddress = buildMailingAddress(caseData, null);
  const feeAmount = getFeeAmount(caseData, proposal);
  return {
    feeAmount,
    paymentLink: urls[0] || null,
    invoiceNumber: invoiceMatch?.[1] || null,
    paymentTerms: termLines,
    mailingAddress,
  };
}

async function resolveNotionPageForCase(caseData) {
  const existingPageId = db.normalizeNotionPageId(caseData?.notion_page_id);
  if (existingPageId) {
    const page = await notionService.notion.pages.retrieve({ page_id: existingPageId });
    return { pageId: existingPageId, page };
  }

  const requestNumber = String(caseData?.portal_request_number || '').trim();
  if (!requestNumber) {
    throw new Error(`Case ${caseData?.id} has no Notion page id or portal request number`);
  }

  const propertyInfo = await notionService.getDatabasePropertyInfo('Request NR');
  const filter = notionService.buildPropertyEqualsFilter('Request NR', propertyInfo, requestNumber);
  if (!filter) {
    throw new Error('Unable to query Notion by Request NR');
  }

  const response = await notionService.notion.databases.query({
    database_id: notionService.databaseId,
    filter,
    page_size: 1,
  });
  const page = response.results?.[0] || null;
  if (!page) {
    throw new Error(`No Notion page found for request number ${requestNumber}`);
  }

  const pageId = db.normalizeNotionPageId(page.id);
  if (pageId && pageId !== caseData?.notion_page_id) {
    await db.updateCase(caseData.id, { notion_page_id: pageId });
  }
  return { pageId, page };
}

function buildMergedLabels(page, labelsToAdd = []) {
  const existingLabels = propertyMultiSelect(page?.properties?.Label);
  const merged = dedupeLines([...existingLabels, ...labelsToAdd]);
  return merged.length > 0 ? merged : null;
}

function buildPaymentNotes(existingNotes, linesToAdd = []) {
  const lines = dedupeLines([
    existingNotes,
    ...linesToAdd,
  ]);
  return lines.join('\n').trim() || null;
}

async function syncFeeWorkflowToNotion(caseData, proposal, { mode, reason = null } = {}) {
  const { pageId, page } = await resolveNotionPageForCase(caseData);
  const latestInbound = await db.getLatestInboundMessage(caseData.id).catch(() => null);
  const user = caseData?.user_id ? await db.getUserById(caseData.user_id).catch(() => null) : null;
  const paymentContext = buildPaymentContextFromMessage(latestInbound, caseData, proposal);
  if (!paymentContext.mailingAddress) {
    paymentContext.mailingAddress = buildMailingAddress(caseData, user);
  }
  const existingNotes = propertyPlainText(page?.properties?.['Payment Notes']);
  const labels = buildMergedLabels(page, mode === 'invoice'
    ? [READY_FOR_INVOICE_LABEL]
    : [WAITING_GOOD_TO_PAY_LABEL]
  );
  const noteLines = mode === 'invoice'
    ? [
        '[Autobot] Ready for invoice',
        paymentContext.feeAmount != null ? `Amount: $${paymentContext.feeAmount}` : null,
        paymentContext.invoiceNumber ? `Invoice #: ${paymentContext.invoiceNumber}` : null,
        paymentContext.paymentLink ? `Payment link: ${paymentContext.paymentLink}` : null,
        paymentContext.mailingAddress ? `Mailing address:\n${paymentContext.mailingAddress}` : null,
        paymentContext.paymentTerms.length ? `Payment terms:\n${paymentContext.paymentTerms.join('\n')}` : null,
        reason ? `Reason: ${reason}` : null,
      ]
    : [
        '[Autobot] Waiting for good to pay before accepting fee',
        paymentContext.feeAmount != null ? `Amount: $${paymentContext.feeAmount}` : null,
        paymentContext.invoiceNumber ? `Invoice #: ${paymentContext.invoiceNumber}` : null,
        paymentContext.paymentLink ? `Payment link: ${paymentContext.paymentLink}` : null,
        reason ? `Reason: ${reason}` : null,
      ];

  await notionService.updatePage(pageId, {
    fee_amount: paymentContext.feeAmount,
    payment_notes: buildPaymentNotes(existingNotes, noteLines),
    mailing_address: paymentContext.mailingAddress,
    payment_link: paymentContext.paymentLink,
    payment_link_login: page?.properties?.['Portal Login Email'] ? propertyPlainText(page.properties['Portal Login Email']) : null,
    invoice_number: paymentContext.invoiceNumber,
    vendor: caseData?.agency_name || null,
    invoice_added_date: mode === 'invoice' ? new Date().toISOString().slice(0, 10) : null,
    invoice_status_change: new Date().toISOString().slice(0, 10),
    labels,
  });

  return { pageId, paymentContext };
}

async function markProposalWaiting(proposal, humanDecision, caseUpdate, activityType, activityMessage, { notionMode, reason, actorId, decidedBy } = {}) {
  const caseData = await db.getCaseById(proposal.case_id);
  if (!caseData) throw new Error(`Case ${proposal.case_id} not found`);
  await proposalLifecycle.markProposalExecuted(proposal.id, {
    humanDecision,
    executionKey: `${humanDecision.action.toLowerCase()}:${proposal.id}`,
  });
  await db.updateCase(proposal.case_id, {
    status: 'needs_human_fee_approval',
    requires_human: true,
    pause_reason: caseUpdate.pause_reason,
    substatus: caseUpdate.substatus,
    notion_page_id: caseData.notion_page_id,
  });
  await db.logActivity(activityType, activityMessage, {
    case_id: proposal.case_id,
    proposal_id: proposal.id,
    actor_type: 'human',
    actor_id: actorId || undefined,
    source_service: decidedBy || 'dashboard',
    notion_page_id: caseData.notion_page_id || null,
    pause_reason: caseUpdate.pause_reason,
  });
  try {
    const notionResult = await syncFeeWorkflowToNotion(caseData, proposal, { mode: notionMode, reason });
    if (notionResult?.pageId && notionResult.pageId !== caseData.notion_page_id) {
      await db.updateCase(proposal.case_id, { notion_page_id: notionResult.pageId });
    }
    return notionResult;
  } catch (error) {
    await db.logActivity('fee_workflow_notion_sync_failed', `Fee workflow Notion sync failed after parking case: ${error.message}`, {
      case_id: proposal.case_id,
      proposal_id: proposal.id,
      actor_type: 'system',
      actor_id: actorId || undefined,
      source_service: decidedBy || 'dashboard',
      pause_reason: caseUpdate.pause_reason,
      error_message: error.message,
    });
    return {
      pageId: caseData.notion_page_id || null,
      syncError: error.message,
    };
  }
}

async function handleFeeProposalDecision(proposal, { action, humanDecision, reason = null, userId = null, decidedBy = 'dashboard' } = {}) {
  const feeOnlyActions = new Set(['ADD_TO_INVOICING', 'WAIT_FOR_GOOD_TO_PAY']);
  if (!proposal) {
    return { handled: false };
  }
  if (feeOnlyActions.has(action) && proposal.action_type !== 'ACCEPT_FEE') {
    const err = new Error(`${action} is only valid for ACCEPT_FEE proposals`);
    err.status = 400;
    throw err;
  }
  if (proposal.action_type !== 'ACCEPT_FEE') {
    return { handled: false };
  }

  if (action === 'ADD_TO_INVOICING') {
    const notionResult = await markProposalWaiting(
      proposal,
      humanDecision,
      {
        pause_reason: WAITING_INVOICE_PAYMENT,
        substatus: 'Added to invoicing — waiting for payment',
      },
      'fee_added_to_invoicing',
      `Proposal #${proposal.id} added to invoicing and parked pending payment`,
      { notionMode: 'invoice', reason, actorId: userId, decidedBy }
    );

    return {
      handled: true,
      response: {
        success: true,
        message: notionResult?.syncError
          ? `Case added to invoicing and parked until payment is marked paid. Notion sync failed: ${notionResult.syncError}`
          : 'Case added to invoicing and parked until payment is marked paid.',
        proposal_id: proposal.id,
        action,
        notion_page_id: notionResult.pageId,
      },
    };
  }

  if (action === 'WAIT_FOR_GOOD_TO_PAY') {
    const notionResult = await markProposalWaiting(
      proposal,
      humanDecision,
      {
        pause_reason: WAITING_GOOD_TO_PAY,
        substatus: 'Waiting for good-to-pay approval before accepting fee',
      },
      'fee_waiting_good_to_pay',
      `Proposal #${proposal.id} parked waiting for good-to-pay approval`,
      { notionMode: 'good_to_pay', reason, actorId: userId, decidedBy }
    );

    return {
      handled: true,
      response: {
        success: true,
        message: notionResult?.syncError
          ? `Case parked until Notion marks it good to pay. Notion sync failed: ${notionResult.syncError}`
          : 'Case parked until Notion marks it good to pay.',
        proposal_id: proposal.id,
        action,
        notion_page_id: notionResult.pageId,
      },
    };
  }

  return { handled: false };
}

async function getFeeWorkflowNotionState(caseData) {
  const { pageId, page } = await resolveNotionPageForCase(caseData);
  const labels = propertyMultiSelect(page?.properties?.Label).map(normalizeLabel);
  const paymentNotes = propertyPlainText(page?.properties?.['Payment Notes']);
  const paymentSentDate = propertyDate(page?.properties?.['Date Payment Sent']);
  const goodToPay = labels.includes(GOOD_TO_PAY_LABEL) || /good to pay/i.test(paymentNotes);
  const paid = labels.includes(CASE_PAID_LABEL) || labels.includes('PAID') || Boolean(paymentSentDate) || /case paid|payment sent|paid in full/i.test(paymentNotes);
  return {
    pageId,
    labels,
    paymentNotes,
    paymentSentDate,
    goodToPay,
    paid,
  };
}

async function sweepFeeWorkflowCases({ limit = 25 } = {}) {
  const result = await db.query(
    `SELECT *
     FROM cases
     WHERE status = 'needs_human_fee_approval'
       AND pause_reason IN ($1, $2)
     ORDER BY updated_at ASC
     LIMIT $3`,
    [WAITING_INVOICE_PAYMENT, WAITING_GOOD_TO_PAY, limit]
  );

  const advanced = [];
  const skipped = [];

  for (const caseData of result.rows) {
    try {
      const notionState = await getFeeWorkflowNotionState(caseData);
      const latestInbound = await db.getLatestInboundMessage(caseData.id);
      if (!latestInbound?.id) {
        skipped.push({ caseId: caseData.id, reason: 'missing_inbound' });
        continue;
      }
      const activeRun = await db.getActiveRunForCase(caseData.id);
      if (activeRun) {
        skipped.push({ caseId: caseData.id, reason: 'active_run' });
        continue;
      }

      if (caseData.pause_reason === WAITING_GOOD_TO_PAY && notionState.goodToPay) {
        const { handle } = await triggerDispatch.triggerTask('process-inbound', {
          runId: 0,
          caseId: caseData.id,
          messageId: latestInbound.id,
          autopilotMode: caseData.autopilot_mode || 'SUPERVISED',
          triggerType: 'HUMAN_REVIEW_RESOLUTION',
          reviewAction: 'accept_fee',
          reviewInstruction: 'Notion marked this case good to pay. Accept the fee through the agency.',
        }, {}, { caseId: caseData.id, messageId: latestInbound.id, triggerType: 'human_review_resolution', source: 'fee_workflow_cron' });
        await db.logActivity('fee_good_to_pay_advanced', 'Good-to-pay marker detected in Notion; dispatched accept-fee follow-up', {
          case_id: caseData.id,
          actor_type: 'system',
          source_service: 'cron_service',
          trigger_run_id: handle.id,
          notion_page_id: notionState.pageId,
        });
        advanced.push({ caseId: caseData.id, action: 'accept_fee', triggerRunId: handle.id });
        continue;
      }

      if (caseData.pause_reason === WAITING_INVOICE_PAYMENT && notionState.paid) {
        const { handle } = await triggerDispatch.triggerTask('process-inbound', {
          runId: 0,
          caseId: caseData.id,
          messageId: latestInbound.id,
          autopilotMode: caseData.autopilot_mode || 'SUPERVISED',
          triggerType: 'HUMAN_REVIEW_RESOLUTION',
          reviewAction: 'send_status_update',
          reviewInstruction: 'Payment has been sent or marked paid. Send a short status update asking the agency to proceed with the request.',
        }, {}, { caseId: caseData.id, messageId: latestInbound.id, triggerType: 'human_review_resolution', source: 'fee_workflow_cron' });
        await db.logActivity('fee_payment_followup_started', 'Payment marker detected in Notion; dispatched status update follow-up', {
          case_id: caseData.id,
          actor_type: 'system',
          source_service: 'cron_service',
          trigger_run_id: handle.id,
          notion_page_id: notionState.pageId,
        });
        advanced.push({ caseId: caseData.id, action: 'send_status_update', triggerRunId: handle.id });
        continue;
      }

      skipped.push({ caseId: caseData.id, reason: 'not_ready' });
    } catch (error) {
      skipped.push({ caseId: caseData.id, reason: error.message });
    }
  }

  return { advanced, skipped };
}

module.exports = {
  WAITING_INVOICE_PAYMENT,
  WAITING_GOOD_TO_PAY,
  READY_FOR_INVOICE_LABEL,
  WAITING_GOOD_TO_PAY_LABEL,
  GOOD_TO_PAY_LABEL,
  CASE_PAID_LABEL,
  resolveNotionPageForCase,
  buildMailingAddress,
  handleFeeProposalDecision,
  getFeeWorkflowNotionState,
  sweepFeeWorkflowCases,
};
