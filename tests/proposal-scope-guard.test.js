require("tsx/cjs");

const assert = require("assert");
const sinon = require("sinon");

const db = require("../services/database");

describe("proposal scoping and queue guardrails", function () {
  afterEach(function () {
    sinon.restore();
  });

  it("backfills a primary case_agency from the case row when proposal scoping needs one", async function () {
    sinon.stub(db, "getCaseAgencies").resolves([]);
    sinon.stub(db, "getCaseById").resolves({
      id: 7001,
      agency_id: 991,
      agency_name: "Boone County Sheriff's Office",
      agency_email: "records@boonecountysheriff.org",
      portal_url: "https://boonecountysheriff.nextrequest.com",
      portal_provider: "nextrequest",
    });
    sinon.stub(db, "addCaseAgency").resolves({
      id: 444,
      case_id: 7001,
      agency_id: 991,
      agency_name: "Boone County Sheriff's Office",
      agency_email: "records@boonecountysheriff.org",
      portal_url: "https://boonecountysheriff.nextrequest.com",
      portal_provider: "nextrequest",
      is_primary: true,
      is_active: true,
    });

    const resolved = await db.resolveProposalCaseAgency(7001);

    assert.ok(resolved);
    assert.strictEqual(resolved.id, 444);
    sinon.assert.calledOnce(db.addCaseAgency);
    sinon.assert.calledWithMatch(
      db.addCaseAgency,
      7001,
      sinon.match({
        agency_name: "Boone County Sheriff's Office",
        added_source: "proposal_scope_backfill",
        is_primary: true,
      })
    );
  });

  it("anchors review proposals to the resolved primary case_agency", async function () {
    const queryStub = sinon.stub(db, "query");
    sinon.stub(db, "_ensureProposalContentVersion").resolves(null);
    sinon.stub(db, "updateCaseStatus").resolves({});
    sinon.stub(db, "getCaseById").resolves({
      id: 7002,
      status: "ready_to_send",
      case_name: "Anchored case",
      subject_name: "Anchored subject",
      agency_name: "Example Police Department, Michigan",
      agency_email: "records@examplepd.gov",
      portal_url: null,
      import_warnings: [],
    });
    sinon.stub(db, "resolveProposalCaseAgency").resolves({
      id: 777,
      case_id: 7002,
      agency_name: "Example Police Department, Michigan",
      agency_email: "records@examplepd.gov",
      portal_url: null,
      is_primary: true,
    });

    queryStub.onCall(0).resolves({ rows: [], rowCount: 0 });
    queryStub.onCall(1).resolves({
      rows: [{
        id: 901,
        proposal_key: "7002:initial:SEND_INITIAL_REQUEST:0",
        status: "PENDING_APPROVAL",
        can_auto_execute: false,
        requires_human: true,
        case_agency_id: 777,
      }],
      rowCount: 1,
    });

    const proposal = await db.upsertProposal({
      proposalKey: "7002:initial:SEND_INITIAL_REQUEST:0",
      caseId: 7002,
      runId: 8801,
      triggerMessageId: null,
      actionType: "SEND_INITIAL_REQUEST",
      draftSubject: "Public Records Request",
      draftBodyText: "Please provide the requested records.",
      draftBodyHtml: "<p>Please provide the requested records.</p>",
      reasoning: ["Generated request"],
      canAutoExecute: false,
      requiresHuman: true,
      status: "PENDING_APPROVAL",
    });

    assert.strictEqual(proposal.case_agency_id, 777);
    assert.strictEqual(queryStub.callCount, 2);
    assert.match(queryStub.getCall(1).args[0], /INSERT INTO proposals/);
    assert.strictEqual(queryStub.getCall(1).args[1][26], 777);
  });

  it("auto-dismisses generic unresolved initial proposals before they enter the queue", async function () {
    const queryStub = sinon.stub(db, "query");
    sinon.stub(db, "_ensureProposalContentVersion").resolves(null);
    sinon.stub(db, "updateCaseStatus").resolves({});
    sinon.stub(db, "getCaseById").resolves({
      id: 7003,
      status: "ready_to_send",
      case_name: "Generic case",
      subject_name: "Generic subject",
      agency_name: "Police Department",
      agency_email: "records@genericpd.gov",
      portal_url: "https://genericpd.govqa.us/WEBAPP/_rs/",
      import_warnings: [],
      additional_details: null,
      state: "TX",
    });
    sinon.stub(db, "resolveProposalCaseAgency").resolves(null);

    queryStub.onCall(0).resolves({ rows: [], rowCount: 1 });
    queryStub.onCall(1).resolves({
      rows: [{
        id: 902,
        proposal_key: "7003:initial:SUBMIT_PORTAL:0",
        status: "DISMISSED",
        can_auto_execute: false,
        requires_human: false,
        case_agency_id: null,
      }],
      rowCount: 1,
    });

    const proposal = await db.upsertProposal({
      proposalKey: "7003:initial:SUBMIT_PORTAL:0",
      caseId: 7003,
      runId: 8802,
      triggerMessageId: null,
      actionType: "SUBMIT_PORTAL",
      draftSubject: "Portal request",
      draftBodyText: "Please provide the requested records.",
      draftBodyHtml: "<p>Please provide the requested records.</p>",
      reasoning: ["Generated portal request"],
      canAutoExecute: false,
      requiresHuman: true,
      status: "PENDING_APPROVAL",
    });

    assert.strictEqual(proposal.status, "DISMISSED");
    assert.strictEqual(queryStub.callCount, 2);
    assert.match(queryStub.getCall(0).args[0], /UPDATE cases/);
    assert.match(queryStub.getCall(1).args[0], /INSERT INTO proposals/);
    assert.strictEqual(queryStub.getCall(1).args[1][25], "DISMISSED");
  });

  it("auto-dismisses initial proposals when the resolved agency row is still a compound identity", async function () {
    const queryStub = sinon.stub(db, "query");
    sinon.stub(db, "_ensureProposalContentVersion").resolves(null);
    sinon.stub(db, "updateCaseStatus").resolves({});
    sinon.stub(db, "getCaseById").resolves({
      id: 7004,
      status: "needs_human_review",
      case_name: "Compound case",
      subject_name: "Compound subject",
      agency_name: "Metropolitan Police Department (MPD) Homicide Branch; DC Fire and EMS",
      agency_email: "foia.admin@dc.gov",
      portal_url: "https://myfoia.dc.gov/",
      import_warnings: [],
      additional_details: null,
      state: "DC",
    });
    sinon.stub(db, "resolveProposalCaseAgency").resolves({
      id: 778,
      case_id: 7004,
      agency_name: "Metropolitan Police Department (MPD) Homicide Branch; DC Fire and EMS",
      agency_email: "foia.admin@dc.gov",
      portal_url: "https://myfoia.dc.gov/",
      is_primary: true,
    });

    queryStub.onCall(0).resolves({ rows: [], rowCount: 1 });
    queryStub.onCall(1).resolves({
      rows: [{
        id: 903,
        proposal_key: "7004:initial:SUBMIT_PORTAL:0",
        status: "DISMISSED",
        can_auto_execute: false,
        requires_human: false,
        case_agency_id: 778,
      }],
      rowCount: 1,
    });

    const proposal = await db.upsertProposal({
      proposalKey: "7004:initial:SUBMIT_PORTAL:0",
      caseId: 7004,
      runId: 8803,
      triggerMessageId: null,
      actionType: "SUBMIT_PORTAL",
      draftSubject: "Portal request",
      draftBodyText: "Please provide the requested records.",
      draftBodyHtml: "<p>Please provide the requested records.</p>",
      reasoning: ["Generated portal request"],
      canAutoExecute: false,
      requiresHuman: true,
      status: "PENDING_APPROVAL",
      caseAgencyId: 778,
    });

    assert.strictEqual(proposal.status, "DISMISSED");
    assert.strictEqual(queryStub.callCount, 2);
    assert.match(queryStub.getCall(1).args[0], /INSERT INTO proposals/);
    assert.strictEqual(queryStub.getCall(1).args[1][25], "DISMISSED");
    assert.strictEqual(queryStub.getCall(1).args[1][26], 778);
  });
});
