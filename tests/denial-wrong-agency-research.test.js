require("tsx/cjs");

const assert = require("assert");
const sinon = require("sinon");

process.env.OPENAI_API_KEY = "";

const database = require("../services/database");
const { decideNextAction } = require("../trigger/steps/decide-next-action.ts");

describe("DENIAL no-records wrong-agency routing", function () {
  let getCaseByIdStub;
  let getMessagesByCaseIdStub;
  let getLatestResponseAnalysisStub;
  let queryStub;

  beforeEach(function () {
    getCaseByIdStub = sinon.stub(database, "getCaseById").resolves({
      id: 25210,
      agency_name: "Lubbock Police Department, Texas",
      additional_details: `
**Case Summary:** Example Georgia homicide
**Police Department:** Gwinnett County Police Department, Georgia
`,
      contact_research_notes: JSON.stringify({ brief: { summary: "Prior research exists" } }),
      constraints_jsonb: [],
      constraints: [],
      requested_records: ["Body camera footage", "911 audio"],
      status: "needs_human_review",
    });

    getMessagesByCaseIdStub = sinon.stub(database, "getMessagesByCaseId").resolves([]);
    getLatestResponseAnalysisStub = sinon.stub(database, "getLatestResponseAnalysis").resolves({
      full_analysis_json: { denial_subtype: "no_records" },
    });
    queryStub = sinon.stub(database, "query").resolves({ rows: [] });
  });

  afterEach(function () {
    sinon.restore();
  });

  it("routes to research instead of reformulating when metadata names a different agency", async function () {
    const result = await decideNextAction(
      25210,
      "DENIAL",
      [],
      null,
      "neutral",
      "SUPERVISED",
      "INBOUND_MESSAGE",
      true,
      "https://lubbocktx.govqa.us/WEBAPP/_rs/SupportHome.aspx",
      "respond",
      null,
      "no_records",
      null,
      null,
      null,
      null,
      ["No responsive records found"],
    );

    assert.strictEqual(result.actionType, "RESEARCH_AGENCY");
    assert.strictEqual(result.pauseReason, "DENIAL");
    assert.strictEqual(result.researchLevel, "deep");
    assert.ok(
      result.reasoning.some((line) => /case metadata names Gwinnett County Police Department, Georgia/i.test(String(line))),
      `expected mismatch reasoning, got: ${JSON.stringify(result.reasoning)}`
    );
    sinon.assert.called(getCaseByIdStub);
    sinon.assert.called(getMessagesByCaseIdStub);
    sinon.assert.called(getLatestResponseAnalysisStub);
    sinon.assert.called(queryStub);
  });

  it("forces agency research for custom human review instructions that reject the current agency", async function () {
    const result = await decideNextAction(
      25210,
      "OTHER",
      [],
      null,
      "neutral",
      "SUPERVISED",
      "HUMAN_REVIEW_RESOLUTION",
      true,
      null,
      "respond",
      null,
      null,
      "custom",
      "The denial came from the wrong jurisdiction. Do not use Lubbock Police Department. Research the correct agency or custodian in Gwinnett County, Georgia and route the request there.",
      null,
      null,
      ["Wrong agency follow-up required"],
    );

    assert.strictEqual(result.actionType, "RESEARCH_AGENCY");
    assert.strictEqual(result.researchLevel, "deep");
    assert.ok(
      result.reasoning.some((line) => /forcing a corrected-agency research pass/i.test(String(line))),
      `expected forced research reasoning, got: ${JSON.stringify(result.reasoning)}`
    );
  });
});
