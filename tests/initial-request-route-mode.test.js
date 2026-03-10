require("tsx/cjs");

const assert = require("assert");
const sinon = require("sinon");

const db = require("../services/database");
const aiService = require("../services/ai-service");
const { draftInitialRequest } = require("../trigger/steps/draft-initial-request.ts");

describe("draftInitialRequest route mode", function () {
  let getCaseByIdStub;
  let getProposalByKeyStub;
  let upsertProposalStub;
  let generateFOIARequestStub;

  beforeEach(function () {
    getCaseByIdStub = sinon.stub(db, "getCaseById").resolves({
      id: 25150,
      subject_name: "Casey Johnson",
      case_name: "Casey Johnson bodycam request",
      agency_name: "South St. Paul Police Department, Minnesota",
      agency_email: "ssppdclerical@southstpaul.org",
      portal_url: "https://www.southstpaulmn.gov/FormCenter/Police-8/Request-for-Police-Data-67",
      portal_provider: "civicplus",
      last_portal_status: null,
      requested_records: ["Body camera footage"],
    });
    getProposalByKeyStub = sinon.stub(db, "getProposalByKey").resolves(null);
    upsertProposalStub = sinon.stub(db, "upsertProposal").callsFake(async (proposal) => ({
      id: 501,
      status: proposal.status,
      can_auto_execute: proposal.canAutoExecute,
      requires_human: proposal.requiresHuman,
      draft_subject: proposal.draftSubject,
      draft_body_text: proposal.draftBodyText,
      draft_body_html: proposal.draftBodyHtml,
      reasoning: proposal.reasoning,
    }));
    generateFOIARequestStub = sinon.stub(aiService, "generateFOIARequest");
  });

  afterEach(function () {
    sinon.restore();
  });

  it("forces email delivery when routeMode is email even if a portal exists", async function () {
    generateFOIARequestStub.callsFake(async (caseData) => {
      assert.strictEqual(caseData.portal_url, null);
      assert.strictEqual(caseData.portal_provider, null);
      assert.strictEqual(caseData.agency_email, "ssppdclerical@southstpaul.org");
      return {
        subject: "Public Records Request - Casey Johnson",
        body: "Email draft body",
      };
    });

    const result = await draftInitialRequest(25150, 3001, "SUPERVISED", "email");

    assert.strictEqual(result.actionType, "SEND_INITIAL_REQUEST");
    assert.strictEqual(result.proposalKey, "25150:initial:SEND_INITIAL_REQUEST:0");
    assert.match(result.reasoning.join("\n"), /Delivery: Email: ssppdclerical@southstpaul\.org/);
    sinon.assert.calledOnce(getCaseByIdStub);
    sinon.assert.calledOnce(getProposalByKeyStub);
    sinon.assert.calledOnce(upsertProposalStub);
  });

  it("forces portal delivery when routeMode is portal even if an email exists", async function () {
    generateFOIARequestStub.callsFake(async (caseData) => {
      assert.strictEqual(caseData.portal_url, "https://www.southstpaulmn.gov/FormCenter/Police-8/Request-for-Police-Data-67");
      assert.strictEqual(caseData.agency_email, null);
      return {
        subject: "Public Records Request - Casey Johnson",
        body: "Portal draft body",
      };
    });

    const result = await draftInitialRequest(25150, 3002, "SUPERVISED", "portal");

    assert.strictEqual(result.actionType, "SUBMIT_PORTAL");
    assert.strictEqual(result.proposalKey, "25150:initial:SUBMIT_PORTAL:0");
    assert.match(result.reasoning.join("\n"), /Delivery: Portal: https:\/\/www\.southstpaulmn\.gov/);
    sinon.assert.calledOnce(getCaseByIdStub);
    sinon.assert.calledOnce(getProposalByKeyStub);
    sinon.assert.calledOnce(upsertProposalStub);
  });
});
