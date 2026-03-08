const assert = require('assert');

const sendgridService = require('../services/sendgrid-service');
const db = require('../services/database');
const aiService = require('../services/ai-service');

describe('Legacy fee proposal bridge', function () {
  let originalUpsertProposal;
  let originalCreateAutoReplyQueueEntry;
  let originalLogActivity;
  let originalGenerateFeeResponse;

  beforeEach(function () {
    originalUpsertProposal = db.upsertProposal;
    originalCreateAutoReplyQueueEntry = db.createAutoReplyQueueEntry;
    originalLogActivity = db.logActivity;
    originalGenerateFeeResponse = aiService.generateFeeResponse;
  });

  afterEach(function () {
    db.upsertProposal = originalUpsertProposal;
    db.createAutoReplyQueueEntry = originalCreateAutoReplyQueueEntry;
    db.logActivity = originalLogActivity;
    aiService.generateFeeResponse = originalGenerateFeeResponse;
  });

  it('writes a fee proposal instead of auto_reply_queue for negotiable fees', async function () {
    let capturedProposal = null;
    db.upsertProposal = async (proposal) => {
      capturedProposal = proposal;
      return { id: 501, ...proposal };
    };
    db.createAutoReplyQueueEntry = async () => {
      throw new Error('should not write auto_reply_queue');
    };
    db.logActivity = async () => {};
    aiService.generateFeeResponse = async () => ({
      subject: 'Re: Fee estimate',
      reply_text: 'Please reduce the fee.'
    });

    const result = await sendgridService.queueFeeResponseDraft({
      caseData: { id: 25175 },
      feeQuote: { amount: 250, currency: 'USD' },
      messageId: 7001,
      recommendedAction: 'negotiate'
    });

    assert.strictEqual(result.id, 501);
    assert.strictEqual(capturedProposal.actionType, 'NEGOTIATE_FEE');
    assert.strictEqual(capturedProposal.caseId, 25175);
    assert.strictEqual(capturedProposal.triggerMessageId, 7001);
    assert.strictEqual(capturedProposal.draftSubject, 'Re: Fee estimate');
    assert.strictEqual(capturedProposal.draftBodyText, 'Please reduce the fee.');
    assert.strictEqual(capturedProposal.status, 'PENDING_APPROVAL');
  });

  it('falls back to a manual escalation proposal for legacy escalate actions', async function () {
    let capturedProposal = null;
    db.upsertProposal = async (proposal) => {
      capturedProposal = proposal;
      return { id: 502, ...proposal };
    };
    db.createAutoReplyQueueEntry = async () => {
      throw new Error('should not write auto_reply_queue');
    };
    db.logActivity = async () => {};
    aiService.generateFeeResponse = async () => {
      throw new Error('should not generate fee draft for escalate');
    };

    const result = await sendgridService.queueFeeResponseDraft({
      caseData: { id: 25211 },
      feeQuote: { amount: 900, currency: 'USD' },
      messageId: 7002,
      recommendedAction: 'escalate'
    });

    assert.strictEqual(result.id, 502);
    assert.strictEqual(capturedProposal.actionType, 'ESCALATE');
    assert.match(capturedProposal.draftBodyText, /Legacy fee auto-draft path was retired/i);
    assert.strictEqual(capturedProposal.status, 'PENDING_APPROVAL');
  });
});
