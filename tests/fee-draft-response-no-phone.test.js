const assert = require("assert");
const sinon = require("sinon");

const db = require("../services/database");
const aiService = require("../services/ai-service");
const decisionMemory = require("../services/decision-memory-service");
const successfulExamples = require("../services/successful-examples-service");

describe("draftResponse fee normalization", function () {
  afterEach(function () {
    sinon.restore();
  });

  it("does not re-add requester phone numbers to ACCEPT_FEE drafts", async function () {
    sinon.stub(db, "getCaseById").resolves({
      id: 9991,
      user_id: 1,
      case_name: "QA Fee Case",
      subject_name: "Jordan Example",
      agency_name: "Synthetic QA Records Unit",
      agency_email: "records@example.gov",
      state: "WA",
      status: "awaiting_response",
      substatus: null,
      requested_records: ["dispatch audio"],
      constraints_jsonb: [],
      scope_items_jsonb: [],
      fee_quote_jsonb: { amount: 22, status: "QUOTED" },
    });
    sinon.stub(db, "getMessageById").resolves({
      id: 123,
      direction: "inbound",
      subject: "Fee estimate",
      body_text: "The cost to fulfill your request is $22. Please confirm if you would like us to proceed.",
      from_email: "records@example.gov",
      received_at: new Date().toISOString(),
    });
    sinon.stub(db, "getResponseAnalysisByMessageId").resolves({
      classification: "fee_quote",
      intent: "fee_quote",
      confidence: 0.95,
    });
    sinon.stub(db, "getMessagesByCaseId").resolves([
      {
        id: 123,
        direction: "inbound",
        subject: "Fee estimate",
        body_text: "The cost to fulfill your request is $22. Please confirm if you would like us to proceed.",
        from_email: "records@example.gov",
        received_at: new Date().toISOString(),
      },
    ]);
    sinon.stub(db, "getAllProposalsByCaseId").resolves([]);
    sinon.stub(db, "getFollowUpScheduleByCaseId").resolves(null);

    sinon.stub(decisionMemory, "getRelevantLessons").resolves([]);
    sinon.stub(successfulExamples, "getRelevantExamples").resolves([]);

    sinon.stub(aiService, "getUserSignatureForCase").resolves({
      name: "Samuel Hylton",
      title: "",
      organization: "",
      phone: "209-800-7702",
      email: "sam@example.com",
      address: "123 Main St\nSeattle, WA 98101",
    });

    const { draftResponse } = require("../trigger/steps/draft-response.ts");
    const result = await draftResponse(
      9991,
      "ACCEPT_FEE",
      [],
      [],
      22,
      null,
      123
    );

    assert.strictEqual(result.subject, "RE: Fee Authorization");
    assert.ok(!result.bodyText.includes("209-800-7702"), result.bodyText);
    assert.match(result.bodyText, /Please proceed with processing this request up to USD 22\.00/i);
  });
});
