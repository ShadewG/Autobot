const assert = require("assert");
const sinon = require("sinon");

const aiService = require("../services/ai-service");

describe("Fee response drafting", function () {
  let getUserSignatureStub;
  let callAIStub;

  beforeEach(function () {
    getUserSignatureStub = sinon.stub(aiService, "getUserSignatureForCase").resolves({
      name: "Sam Tester",
      title: "",
      organization: "",
      phone: "(206) 555-1212",
      email: "sam@example.com",
      address: "123 Main St\nSeattle, WA 98101",
    });
    callAIStub = sinon.stub(aiService, "callAI").resolves({
      text: "unused",
      modelMetadata: { modelId: "stub", promptTokens: 1, completionTokens: 1, latencyMs: 1 },
    });
  });

  afterEach(function () {
    sinon.restore();
  });

  it("uses a deterministic accept-fee template without requester phone numbers", async function () {
    const result = await aiService.generateFeeResponse(
      {
        id: 1,
        case_name: "QA Fee Case",
        agency_name: "Synthetic QA Records Unit",
        state: "WA",
        requested_records: ["dispatch audio"],
      },
      {
        recommendedAction: "accept",
        feeAmount: 22,
        currency: "USD",
      }
    );

    assert.strictEqual(result.subject, 'RE: Fee Authorization');
    assert.match(result.body_text, /please proceed with processing this request up to USD 22\.00/i);
    assert.match(result.body_text, /before incurring any additional charges/i);
    assert.ok(!result.body_text.includes('QA Fee Case'), result.body_text);
    assert.ok(!result.body_text.includes("(206) 555-1212"), result.body_text);
    assert.strictEqual(result.model, "deterministic-fee-accept-template");
    sinon.assert.notCalled(callAIStub);
  });
});
