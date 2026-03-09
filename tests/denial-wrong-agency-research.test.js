require("tsx/cjs");

const assert = require("assert");
const sinon = require("sinon");

process.env.OPENAI_API_KEY = "";

const database = require("../services/database");
const { decideNextAction } = require("../trigger/steps/decide-next-action.ts");
const {
  reasoningForcesCorrectedAgencyResearch,
  isSyntheticKnownChannelSignal,
} = require("../trigger/steps/execute-action.ts");

describe("DENIAL no-records wrong-agency routing", function () {
  let getCaseByIdStub;
  let getMessagesByCaseIdStub;
  let getLatestResponseAnalysisStub;
  let queryStub;
  let updateCaseStub;

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
    updateCaseStub = sinon.stub(database, "updateCase").resolves({});
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
    sinon.assert.called(updateCaseStub);
  });

  it("forces agency research for custom wrong-jurisdiction instructions even after the stale agency name is blanked", async function () {
    getCaseByIdStub.resolves({
      id: 25243,
      agency_name: null,
      additional_details: `
**Case Summary:** Body cam / dispatch request in Georgia
**Police Department:** Barrow County Sheriff's Office, Georgia
`,
      contact_research_notes: JSON.stringify({ brief: { summary: "Prior research exists" } }),
      constraints_jsonb: [],
      constraints: [],
      requested_records: ["Body camera footage", "911 audio"],
      status: "needs_human_review",
    });

    const result = await decideNextAction(
      25243,
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
      "The current Stow Police Department identity is wrong for this case. Research the correct Barrow County or Winder, Georgia custodian for the requested records. Do not use Stow, and do not assume email submission unless a real channel is verified.",
      null,
      null,
      ["Wrong agency follow-up required"],
    );

    assert.strictEqual(result.actionType, "RESEARCH_AGENCY");
    assert.strictEqual(result.researchLevel, "deep");
    sinon.assert.called(updateCaseStub);
  });

  it("flags wrong-jurisdiction reasoning so research execution ignores stale case channels", function () {
    const result = reasoningForcesCorrectedAgencyResearch([
      "Human review resolution: action=custom",
      "The denial/no-records response came from an unrelated jurisdiction (City of Lubbock, TX).",
      "Human directive requires re-targeting the request to the correct Georgia custodian.",
      "Research/confirm the correct Gwinnett County portal/contact before sending.",
    ]);

    assert.strictEqual(result, true);
  });

  it("treats backfilled test channels as synthetic known signals", function () {
    assert.strictEqual(
      isSyntheticKnownChannelSignal({
        agencyName: "E2E_multi_portal_plus_fee_1773011979834",
        agencyEmail: "test@agency.gov",
        portalUrl: "https://sanfrancisco.nextrequest.com",
        addedSource: "case_row_backfill",
      }),
      true
    );
  });
});
