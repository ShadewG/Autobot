require("tsx/cjs");

const assert = require("assert");
const sinon = require("sinon");

const db = require("../services/database");
const aiService = require("../services/ai-service");
const {
  draftInitialRequestProposalsForCase,
} = require("../trigger/tasks/process-initial-request.ts");

describe("multi-agency initial request proposal fan-out", function () {
  beforeEach(function () {
    sinon.stub(db, "query").resolves({ rowCount: 0, rows: [] });
    sinon.stub(db, "getCaseById").resolves({
      id: 26688,
      subject_name: "Example Incident",
      case_name: "Example multi-agency case",
      agency_name: "Brevard County Sheriff's Office, Florida",
      agency_email: "records@brevardsheriff.gov",
      portal_url: "https://brevardsheriff.nextrequest.com",
      portal_provider: "nextrequest",
      last_portal_status: null,
      requested_records: ["Body camera footage", "911 audio"],
    });
    sinon.stub(db, "getCaseAgencies").resolves([
      {
        id: 501,
        case_id: 26688,
        agency_id: 9001,
        agency_name: "Brevard County Sheriff's Office, Florida",
        agency_email: "records@brevardsheriff.gov",
        portal_url: null,
        portal_provider: null,
        is_active: true,
      },
      {
        id: 502,
        case_id: 26688,
        agency_id: 9002,
        agency_name: "Cocoa Police Department",
        agency_email: null,
        portal_url: "https://cocoa.govqa.us/WEBAPP/_rs/",
        portal_provider: "govqa",
        is_active: true,
      },
    ]);
    sinon.stub(db, "getCaseAgencyById").callsFake(async (id) => {
      const agencies = await db.getCaseAgencies();
      return agencies.find((agency) => agency.id === id) || null;
    });
    sinon.stub(db, "getProposalByKey").resolves(null);
    sinon.stub(aiService, "generateFOIARequest").callsFake(async (caseData) => ({
      subject: `Public Records Request - ${caseData.agency_name}`,
      body: `Draft for ${caseData.agency_name}`,
      modelMetadata: null,
    }));
    sinon.stub(db, "upsertProposal").callsFake(async (proposal) => ({
      id: proposal.caseAgencyId === 501 ? 2001 : 2002,
      proposal_key: proposal.proposalKey,
      status: proposal.status,
      can_auto_execute: proposal.canAutoExecute,
      requires_human: proposal.requiresHuman,
      draft_subject: proposal.draftSubject,
      draft_body_text: proposal.draftBodyText,
      draft_body_html: proposal.draftBodyHtml,
      reasoning: proposal.reasoning,
    }));
  });

  afterEach(function () {
    sinon.restore();
  });

  it("creates one scoped proposal per active agency when a case has multiple PDs", async function () {
    const result = await draftInitialRequestProposalsForCase(26688, 7001, "SUPERVISED");

    assert.strictEqual(result.mode, "multi");
    assert.strictEqual(result.proposals.length, 2);
    assert.ok(db.query.calledOnce);
    assert.match(db.query.firstCall.args[0], /UPDATE proposals/);
    assert.deepStrictEqual(db.query.firstCall.args[1], [26688, "26688:initial:%"]);
    assert.deepStrictEqual(
      result.proposals.map((proposal) => proposal.caseAgencyId),
      [501, 502]
    );
    assert.deepStrictEqual(
      result.proposals.map((proposal) => proposal.actionType),
      ["SEND_INITIAL_REQUEST", "SUBMIT_PORTAL"]
    );
    assert.deepStrictEqual(
      result.proposals.map((proposal) => proposal.proposalKey),
      [
        "26688:initial:ca501:SEND_INITIAL_REQUEST:0",
        "26688:initial:ca502:SUBMIT_PORTAL:0",
      ]
    );
  });

  it("creates a manual handoff proposal for an additional agency with no delivery path", async function () {
    db.getCaseAgencies.restore();
    sinon.stub(db, "getCaseAgencies").resolves([
      {
        id: 601,
        case_id: 26689,
        agency_id: 9010,
        agency_name: "Agency With Email",
        agency_email: "records@example.gov",
        portal_url: null,
        portal_provider: null,
        is_active: true,
      },
      {
        id: 602,
        case_id: 26689,
        agency_id: 9011,
        agency_name: "Agency Missing Delivery",
        agency_email: null,
        portal_url: null,
        portal_provider: null,
        is_active: true,
      },
    ]);
    db.getCaseById.restore();
    sinon.stub(db, "getCaseById").resolves({
      id: 26689,
      subject_name: "Missing route example",
      case_name: "Case with one missing delivery path",
      agency_name: "Agency With Email",
      agency_email: "records@example.gov",
      portal_url: null,
      portal_provider: null,
      last_portal_status: null,
      requested_records: ["Dispatch audio"],
    });
    db.getCaseAgencyById.restore();
    sinon.stub(db, "getCaseAgencyById").callsFake(async (id) => {
      const agencies = await db.getCaseAgencies();
      return agencies.find((agency) => agency.id === id) || null;
    });
    db.upsertProposal.restore();
    sinon.stub(db, "upsertProposal").callsFake(async (proposal) => ({
      id: proposal.caseAgencyId === 601 ? 3001 : 3002,
      proposal_key: proposal.proposalKey,
      status: proposal.status,
      can_auto_execute: proposal.canAutoExecute,
      requires_human: proposal.requiresHuman,
      draft_subject: proposal.draftSubject,
      draft_body_text: proposal.draftBodyText,
      draft_body_html: proposal.draftBodyHtml,
      reasoning: proposal.reasoning,
    }));

    const result = await draftInitialRequestProposalsForCase(26689, 7002, "SUPERVISED");

    assert.strictEqual(result.mode, "multi");
    assert.deepStrictEqual(
      result.proposals.map((proposal) => proposal.actionType),
      ["SEND_INITIAL_REQUEST", "ESCALATE"]
    );
    const missingDeliveryProposal = result.proposals.find((proposal) => proposal.caseAgencyId === 602);
    assert.ok(missingDeliveryProposal);
    assert.match(missingDeliveryProposal.bodyText, /No verified email or portal was found/i);
  });
});
