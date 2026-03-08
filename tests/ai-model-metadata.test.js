const assert = require('assert');
const sinon = require('sinon');

const db = require('../services/database');
const aiService = require('../services/ai-service');
const { buildModelMetadata } = require('../utils/ai-model-metadata');

describe('AI model metadata capture', function () {
  afterEach(function () {
    sinon.restore();
  });

  it('normalizes Vercel AI metadata shapes', function () {
    const metadata = buildModelMetadata({
      response: { modelId: 'gpt-5-mini' },
      usage: { promptTokens: 101, completionTokens: 27 },
      startedAt: Date.now() - 250,
      finishedAt: Date.now(),
    });

    assert.strictEqual(metadata.modelId, 'gpt-5-mini');
    assert.strictEqual(metadata.promptTokens, 101);
    assert.strictEqual(metadata.completionTokens, 27);
    assert.ok(metadata.latencyMs >= 0);
  });

  it('normalizes OpenAI Responses/Anthropic usage shapes', function () {
    const metadata = buildModelMetadata({
      response: { model: 'claude-sonnet-4-6' },
      usage: { input_tokens: 88, output_tokens: 12 },
      startedAt: Date.now() - 100,
      finishedAt: Date.now(),
    });

    assert.strictEqual(metadata.modelId, 'claude-sonnet-4-6');
    assert.strictEqual(metadata.promptTokens, 88);
    assert.strictEqual(metadata.completionTokens, 12);
    assert.ok(metadata.latencyMs >= 0);
  });

  it('stores classifier metadata on response_analysis writes', async function () {
    const queryStub = sinon.stub(db, 'query').resolves({ rows: [{}] });

    await db.createResponseAnalysis({
      message_id: 501,
      case_id: 502,
      intent: 'question',
      confidence_score: 0.91,
      sentiment: 'neutral',
      key_points: ['Needs mailing address'],
      extracted_deadline: null,
      extracted_fee_amount: null,
      requires_action: true,
      suggested_action: 'respond',
      full_analysis_json: { intent: 'question' },
      model_id: 'gpt-5.2',
      prompt_tokens: 123,
      completion_tokens: 45,
      latency_ms: 678,
    });

    const call = queryStub.getCall(0);
    assert.match(call.args[0], /model_id/);
    assert.match(call.args[0], /prompt_tokens/);
    assert.match(call.args[0], /completion_tokens/);
    assert.match(call.args[0], /latency_ms/);
    assert.strictEqual(call.args[1][11], 'gpt-5.2');
    assert.strictEqual(call.args[1][12], 123);
    assert.strictEqual(call.args[1][13], 45);
    assert.strictEqual(call.args[1][14], 678);
  });

  it('persists model metadata from analyzeResponse calls', async function () {
    sinon.stub(db, 'createResponseAnalysis').resolves({ id: 1 });
    sinon.stub(db, 'query').resolves({ rows: [] });
    sinon.stub(aiService, 'recordOutcomeForLearning').resolves();
    aiService.openai = {
      responses: {
        create: sinon.stub().resolves({
          model: 'gpt-5.2-2025-12-11',
          usage: { input_tokens: 88, output_tokens: 21 },
          output_text: JSON.stringify({
            intent: 'question',
            confidence_score: 0.92,
            sentiment: 'neutral',
            key_points: ['Needs mailing address'],
            extracted_deadline: null,
            extracted_fee_amount: null,
            requires_response: true,
            suggested_action: 'respond',
            summary: 'Agency asked for a mailing address.',
          }),
        }),
      },
    };

    await aiService.analyzeResponse(
      {
        id: 700,
        subject: 'Need mailing address',
        body_text: 'Please provide a mailing address for the CD.',
        from_email: 'agency@example.gov',
      },
      {
        id: 701,
        case_name: 'QA case',
        subject_name: 'QA case',
        agency_name: 'Agency',
        requested_records: [],
        status: 'sent',
      }
    );

    const payload = db.createResponseAnalysis.firstCall.args[0];
    assert.strictEqual(payload.model_id, 'gpt-5.2-2025-12-11');
    assert.strictEqual(payload.prompt_tokens, 88);
    assert.strictEqual(payload.completion_tokens, 21);
    assert.ok(payload.latency_ms >= 0);
  });

  it('stores decision and draft metadata on proposal upserts', async function () {
    sinon.stub(db, 'getCaseById').resolves(null);
    const queryStub = sinon.stub(db, 'query').resolves({ rows: [{ id: 901 }] });
    queryStub.onCall(0).resolves({ rows: [] });
    queryStub.onCall(1).resolves({
      rows: [{
        id: 77,
        case_id: 123,
        status: 'PENDING_APPROVAL',
        action_type: 'SEND_CLARIFICATION',
      }],
    });

    await db.upsertProposal({
      proposalKey: '123:msg-1:SEND_CLARIFICATION:0',
      caseId: 123,
      triggerMessageId: 456,
      actionType: 'SEND_CLARIFICATION',
      draftSubject: 'Original subject',
      draftBodyText: 'Original body',
      status: 'PENDING_APPROVAL',
      decisionModelId: 'gpt-decide',
      decisionPromptTokens: 111,
      decisionCompletionTokens: 22,
      decisionLatencyMs: 333,
      draftModelId: 'gpt-draft',
      draftPromptTokens: 444,
      draftCompletionTokens: 55,
      draftLatencyMs: 666,
    });

    const insertCall = queryStub.getCall(1);
    assert.match(insertCall.args[0], /decision_model_id/);
    assert.match(insertCall.args[0], /draft_model_id/);
    assert.strictEqual(insertCall.args[1][11], 'gpt-decide');
    assert.strictEqual(insertCall.args[1][12], 111);
    assert.strictEqual(insertCall.args[1][13], 22);
    assert.strictEqual(insertCall.args[1][14], 333);
    assert.strictEqual(insertCall.args[1][15], 'gpt-draft');
    assert.strictEqual(insertCall.args[1][16], 444);
    assert.strictEqual(insertCall.args[1][17], 55);
    assert.strictEqual(insertCall.args[1][18], 666);
  });
});
