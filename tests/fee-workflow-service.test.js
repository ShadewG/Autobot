const assert = require('assert');
const sinon = require('sinon');

const db = require('../services/database');
const notionService = require('../services/notion-service');
const proposalLifecycle = require('../services/proposal-lifecycle');
const triggerDispatch = require('../services/trigger-dispatch-service');
const feeWorkflowService = require('../services/fee-workflow-service');

function buildNotionPage(overrides = {}) {
  return {
    id: '2fd87c20-070a-80c6-a908-d0f1a87bd7c2',
    properties: {
      Label: { type: 'multi_select', multi_select: [] },
      'Payment Notes': { type: 'rich_text', rich_text: [] },
      'Date Payment Sent': { type: 'date', date: null },
      'Portal Login Email': { type: 'email', email: 'requests@foib-request.com' },
      ...overrides,
    },
  };
}

describe('fee workflow service', function () {
  afterEach(function () {
    sinon.restore();
  });

  it('parks ACCEPT_FEE proposals in invoicing and writes Notion payment details', async function () {
    const proposal = {
      id: 2024,
      case_id: 25161,
      action_type: 'ACCEPT_FEE',
      metadata: {},
    };
    const humanDecision = { action: 'ADD_TO_INVOICING', reason: 'Need invoice workflow first' };

    sinon.stub(db, 'getCaseById').resolves({
      id: 25161,
      notion_page_id: '2fd87c20-070a-80c6-a908-d0f1a87bd7c2',
      portal_request_number: 'PD-2026-292',
      last_fee_quote_amount: 80,
      requester_address: '123 Main St',
      requester_city: 'Austin',
      requester_state: 'TX',
      requester_zip: '78701',
      agency_name: 'Bryan Police Department',
      user_id: null,
    });
    sinon.stub(db, 'getLatestInboundMessage').resolves({
      id: 9001,
      body_text: 'Please remit payment of $80. Invoice # INV-1234. Mail check to the address below.',
    });
    sinon.stub(db, 'getUserById').resolves(null);
    sinon.stub(db, 'getAttachmentsByMessageId').resolves([]);
    sinon.stub(db, 'getAttachmentsByCaseId').resolves([]);
    sinon.stub(notionService.notion.pages, 'retrieve').resolves(buildNotionPage());
    const updatePageStub = sinon.stub(notionService, 'updatePage').resolves({});
    const markExecutedStub = sinon.stub(proposalLifecycle, 'markProposalExecuted').resolves();
    const updateCaseStub = sinon.stub(db, 'updateCase').resolves();
    const logActivityStub = sinon.stub(db, 'logActivity').resolves();

    const result = await feeWorkflowService.handleFeeProposalDecision(proposal, {
      action: 'ADD_TO_INVOICING',
      humanDecision,
      reason: 'Invoice first',
      userId: 42,
      decidedBy: 'dashboard',
    });

    assert.strictEqual(result.handled, true);
    assert.strictEqual(result.response.action, 'ADD_TO_INVOICING');
    sinon.assert.calledOnce(markExecutedStub);
    sinon.assert.calledWithMatch(markExecutedStub, 2024, sinon.match({
      humanDecision,
      executionKey: 'add_to_invoicing:2024',
    }));
    sinon.assert.calledWithMatch(updateCaseStub, 25161, sinon.match({
      status: 'needs_human_fee_approval',
      pause_reason: feeWorkflowService.WAITING_INVOICE_PAYMENT,
      substatus: 'Added to invoicing — waiting for payment',
    }));
    sinon.assert.calledWithMatch(updatePageStub, sinon.match.string, sinon.match({
      fee_amount: 80,
      mailing_address: '123 Main St\nAustin, TX 78701',
      invoice_number: 'INV-1234',
      vendor: 'Bryan Police Department',
      labels: sinon.match((value) => Array.isArray(value) && value.includes(feeWorkflowService.READY_FOR_INVOICE_LABEL)),
    }));
    sinon.assert.calledOnce(logActivityStub);
  });

  it('parks ACCEPT_FEE proposals waiting for good-to-pay and writes Notion state', async function () {
    const proposal = {
      id: 2025,
      case_id: 25161,
      action_type: 'ACCEPT_FEE',
      metadata: {},
    };

    sinon.stub(db, 'getCaseById').resolves({
      id: 25161,
      notion_page_id: '2fd87c20-070a-80c6-a908-d0f1a87bd7c2',
      portal_request_number: 'PD-2026-292',
      last_fee_quote_amount: 80,
      agency_name: 'Bryan Police Department',
      user_id: null,
    });
    sinon.stub(db, 'getLatestInboundMessage').resolves({
      id: 9002,
      body_text: 'The fee is $80 and must be approved before payment.',
    });
    sinon.stub(db, 'getUserById').resolves(null);
    sinon.stub(db, 'getAttachmentsByMessageId').resolves([]);
    sinon.stub(db, 'getAttachmentsByCaseId').resolves([]);
    sinon.stub(notionService.notion.pages, 'retrieve').resolves(buildNotionPage());
    const updatePageStub = sinon.stub(notionService, 'updatePage').resolves({});
    sinon.stub(proposalLifecycle, 'markProposalExecuted').resolves();
    const updateCaseStub = sinon.stub(db, 'updateCase').resolves();
    sinon.stub(db, 'logActivity').resolves();

    const result = await feeWorkflowService.handleFeeProposalDecision(proposal, {
      action: 'WAIT_FOR_GOOD_TO_PAY',
      humanDecision: { action: 'WAIT_FOR_GOOD_TO_PAY' },
      decidedBy: 'dashboard',
    });

    assert.strictEqual(result.handled, true);
    assert.strictEqual(result.response.action, 'WAIT_FOR_GOOD_TO_PAY');
    sinon.assert.calledWithMatch(updateCaseStub, 25161, sinon.match({
      pause_reason: feeWorkflowService.WAITING_GOOD_TO_PAY,
      substatus: 'Waiting for good-to-pay approval before accepting fee',
    }));
    sinon.assert.calledWithMatch(updatePageStub, sinon.match.string, sinon.match({
      labels: sinon.match((value) => Array.isArray(value) && value.includes(feeWorkflowService.WAITING_GOOD_TO_PAY_LABEL)),
    }));
  });

  it('parks fee case even if Notion sync fails after the case update', async function () {
    const proposal = {
      id: 2026,
      case_id: 25161,
      action_type: 'ACCEPT_FEE',
      metadata: {},
    };
    const humanDecision = { action: 'WAIT_FOR_GOOD_TO_PAY' };

    sinon.stub(db, 'getCaseById').resolves({
      id: 25161,
      notion_page_id: '2fd87c20-070a-80c6-a908-d0f1a87bd7c2',
      portal_request_number: 'PD-2026-292',
      last_fee_quote_amount: 80,
      agency_name: 'Bryan Police Department',
      user_id: null,
    });
    sinon.stub(db, 'getLatestInboundMessage').resolves({
      id: 9003,
      body_text: 'The fee is $80 and must be approved before payment.',
    });
    sinon.stub(db, 'getUserById').resolves(null);
    sinon.stub(notionService.notion.pages, 'retrieve').rejects(new Error('Notion unavailable'));
    sinon.stub(proposalLifecycle, 'markProposalExecuted').resolves();
    const updateCaseStub = sinon.stub(db, 'updateCase').resolves();
    const logActivityStub = sinon.stub(db, 'logActivity').resolves();

    const result = await feeWorkflowService.handleFeeProposalDecision(proposal, {
      action: 'WAIT_FOR_GOOD_TO_PAY',
      humanDecision,
      decidedBy: 'dashboard',
    });

    assert.strictEqual(result.handled, true);
    assert.match(result.response.message, /Notion sync failed/i);
    sinon.assert.calledWithMatch(updateCaseStub, 25161, sinon.match({
      pause_reason: feeWorkflowService.WAITING_GOOD_TO_PAY,
    }));
    sinon.assert.calledTwice(logActivityStub);
  });

  it('advances waiting good-to-pay cases when Notion is marked good to pay', async function () {
    const caseRow = {
      id: 25161,
      status: 'needs_human_fee_approval',
      pause_reason: feeWorkflowService.WAITING_GOOD_TO_PAY,
      notion_page_id: '2fd87c20-070a-80c6-a908-d0f1a87bd7c2',
      autopilot_mode: 'SUPERVISED',
    };
    sinon.stub(db, 'query').resolves({ rows: [caseRow] });
    sinon.stub(notionService.notion.pages, 'retrieve').resolves(buildNotionPage({
      Label: { type: 'multi_select', multi_select: [{ name: feeWorkflowService.GOOD_TO_PAY_LABEL }] },
    }));
    sinon.stub(db, 'getLatestInboundMessage').resolves({ id: 9900 });
    sinon.stub(db, 'getActiveRunForCase').resolves(null);
    const triggerStub = sinon.stub(triggerDispatch, 'triggerTask').resolves({ handle: { id: 'run_fee_accept' } });
    sinon.stub(db, 'logActivity').resolves();

    const result = await feeWorkflowService.sweepFeeWorkflowCases({ limit: 10 });

    assert.strictEqual(result.advanced.length, 1);
    assert.deepStrictEqual(result.advanced[0], {
      caseId: 25161,
      action: 'accept_fee',
      triggerRunId: 'run_fee_accept',
    });
    sinon.assert.calledWithMatch(triggerStub, 'process-inbound', sinon.match({
      caseId: 25161,
      messageId: 9900,
      triggerType: 'HUMAN_REVIEW_RESOLUTION',
      reviewAction: 'accept_fee',
    }));
  });

  it('advances invoicing cases with a payment marker by sending a status update', async function () {
    const caseRow = {
      id: 25161,
      status: 'needs_human_fee_approval',
      pause_reason: feeWorkflowService.WAITING_INVOICE_PAYMENT,
      notion_page_id: '2fd87c20-070a-80c6-a908-d0f1a87bd7c2',
      autopilot_mode: 'SUPERVISED',
    };
    sinon.stub(db, 'query').resolves({ rows: [caseRow] });
    sinon.stub(notionService.notion.pages, 'retrieve').resolves(buildNotionPage({
      Label: { type: 'multi_select', multi_select: [{ name: feeWorkflowService.CASE_PAID_LABEL }] },
      'Date Payment Sent': { type: 'date', date: { start: '2026-03-11' } },
    }));
    sinon.stub(db, 'getLatestInboundMessage').resolves({ id: 9901 });
    sinon.stub(db, 'getActiveRunForCase').resolves(null);
    const triggerStub = sinon.stub(triggerDispatch, 'triggerTask').resolves({ handle: { id: 'run_fee_status' } });
    sinon.stub(db, 'logActivity').resolves();

    const result = await feeWorkflowService.sweepFeeWorkflowCases({ limit: 10 });

    assert.strictEqual(result.advanced.length, 1);
    assert.deepStrictEqual(result.advanced[0], {
      caseId: 25161,
      action: 'send_status_update',
      triggerRunId: 'run_fee_status',
    });
    sinon.assert.calledWithMatch(triggerStub, 'process-inbound', sinon.match({
      caseId: 25161,
      messageId: 9901,
      triggerType: 'HUMAN_REVIEW_RESOLUTION',
      reviewAction: 'send_status_update',
    }));
  });

  describe('extractInvoiceDueDate', function () {
    it('parses "within N business days" and skips weekends', function () {
      const result = feeWorkflowService.extractInvoiceDueDate('Payment must be received within 10 business days.');
      assert.ok(result, 'should return a date');
      const parsed = new Date(result);
      assert.ok(!isNaN(parsed.getTime()), 'should be valid date');
      // 10 business days ≈ 12-14 calendar days depending on start day
      const diff = (parsed - new Date()) / 86400000;
      assert.ok(diff >= 11 && diff <= 15, `expected 12-14 days out, got ${diff.toFixed(1)}`);
    });

    it('parses "due by [date]" with explicit date', function () {
      const result = feeWorkflowService.extractInvoiceDueDate('This invoice is due by March 30, 2026.');
      assert.strictEqual(result, '2026-03-30');
    });

    it('parses "must be received by [date]"', function () {
      const result = feeWorkflowService.extractInvoiceDueDate('Payment must be received by April 15, 2026.');
      assert.strictEqual(result, '2026-04-15');
    });

    it('returns null when no date pattern found', function () {
      const result = feeWorkflowService.extractInvoiceDueDate('Please remit payment of $80. Invoice # INV-1234.');
      assert.strictEqual(result, null);
    });

    it('parses spelled-out number "within ten business days"', function () {
      const result = feeWorkflowService.extractInvoiceDueDate(
        'Your request will be considered automatically withdrawn if you do not notify us in writing within ten business days from the date of this letter.'
      );
      assert.ok(result, 'should return a date');
      const parsed = new Date(result);
      assert.ok(!isNaN(parsed.getTime()), 'should be valid date');
      const diff = (parsed - new Date()) / 86400000;
      assert.ok(diff >= 11 && diff <= 15, `expected 12-14 days out, got ${diff.toFixed(1)}`);
    });

    it('returns null for empty/null input', function () {
      assert.strictEqual(feeWorkflowService.extractInvoiceDueDate(null), null);
      assert.strictEqual(feeWorkflowService.extractInvoiceDueDate(''), null);
    });
  });

  it('includes attachment download links in updatePage call', async function () {
    const proposal = {
      id: 2030,
      case_id: 25161,
      action_type: 'ACCEPT_FEE',
      metadata: {},
    };
    const humanDecision = { action: 'ADD_TO_INVOICING' };

    sinon.stub(db, 'getCaseById').resolves({
      id: 25161,
      notion_page_id: '2fd87c20-070a-80c6-a908-d0f1a87bd7c2',
      portal_request_number: 'PD-2026-292',
      last_fee_quote_amount: 50,
      agency_name: 'Test PD',
      user_id: null,
    });
    sinon.stub(db, 'getLatestInboundMessage').resolves({
      id: 9010,
      body_text: 'Fee is $50. Payment within 5 business days.',
    });
    sinon.stub(db, 'getUserById').resolves(null);
    sinon.stub(db, 'getAttachmentsByMessageId').resolves([
      { id: 101, filename: 'invoice.pdf' },
      { id: 102, filename: 'receipt.pdf' },
    ]);
    sinon.stub(db, 'getAttachmentsByCaseId').resolves([
      { id: 101, filename: 'invoice.pdf' },  // duplicate
      { id: 103, filename: 'estimate.pdf' },
    ]);
    sinon.stub(notionService.notion.pages, 'retrieve').resolves(buildNotionPage());
    const updatePageStub = sinon.stub(notionService, 'updatePage').resolves({});
    sinon.stub(proposalLifecycle, 'markProposalExecuted').resolves();
    sinon.stub(db, 'updateCase').resolves();
    sinon.stub(db, 'logActivity').resolves();

    await feeWorkflowService.handleFeeProposalDecision(proposal, {
      action: 'ADD_TO_INVOICING',
      humanDecision,
      decidedBy: 'dashboard',
    });

    const updateCall = updatePageStub.getCall(0);
    const updates = updateCall.args[1];

    // Should have 3 unique attachment links (101, 102, 103)
    assert.strictEqual(updates.download_links.length, 3);
    assert.ok(updates.download_links[0].includes('/api/monitor/attachments/101/download'));
    assert.ok(updates.download_links[1].includes('/api/monitor/attachments/102/download'));
    assert.ok(updates.download_links[2].includes('/api/monitor/attachments/103/download'));

    // Should include invoice due date from "within 5 business days"
    assert.ok(updates.invoice_due_date, 'should have invoice_due_date');
  });
});
