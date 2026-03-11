require("tsx/cjs");

const assert = require("assert");
const sinon = require("sinon");

process.env.OPENAI_API_KEY = "";

const database = require("../services/database");
const caseRuntime = require("../services/case-runtime");
const { decideNextAction } = require("../trigger/steps/decide-next-action.ts");

describe("mock simulation routing", function () {
  beforeEach(function () {
    sinon.stub(database, "query").resolves({ rows: [] });
    sinon.stub(database, "getCaseById").resolves(null);
    sinon.stub(database, "getLatestResponseAnalysis").resolves(null);
    sinon.stub(database, "updateCase").resolves({});
    sinon.stub(database, "updateCasePortalStatus").resolves({});
    sinon.stub(database, "getMessagesByCaseId").resolves([]);
    sinon.stub(caseRuntime, "transitionCaseRuntime").resolves({});
  });

  afterEach(function () {
    sinon.restore();
  });

  it("returns NONE for partial delivery without requiring a real case", async function () {
    const result = await decideNextAction(
      0,
      "PARTIAL_DELIVERY",
      [],
      null,
      "positive",
      "SUPERVISED",
      "INBOUND_MESSAGE",
      false,
      null,
      "wait",
      null,
      null,
      null,
      null,
      null,
      null,
      []
    );

    assert.strictEqual(result.actionType, "NONE");
    assert.ok(result.reasoning.some((line) => /partial delivery/i.test(String(line))));
    sinon.assert.notCalled(caseRuntime.transitionCaseRuntime);
  });

  it("returns NONE for records-ready without requiring a real case", async function () {
    const result = await decideNextAction(
      0,
      "RECORDS_READY",
      [],
      null,
      "neutral",
      "SUPERVISED",
      "INBOUND_MESSAGE",
      false,
      "https://records.city.gov/download",
      "use_portal",
      null,
      null,
      null,
      null,
      null,
      null,
      []
    );

    assert.strictEqual(result.actionType, "NONE");
    assert.ok(
      result.reasoning.some((line) => /records ready|no response needed/i.test(String(line))),
      `expected records-ready reasoning, got ${JSON.stringify(result.reasoning)}`
    );
    sinon.assert.notCalled(caseRuntime.transitionCaseRuntime);
  });

  it("returns NONE for portal redirects without requiring a real case", async function () {
    const result = await decideNextAction(
      0,
      "PORTAL_REDIRECT",
      [],
      null,
      "neutral",
      "SUPERVISED",
      "INBOUND_MESSAGE",
      false,
      "https://publicrecords.city.gov",
      "use_portal",
      null,
      null,
      null,
      null,
      null,
      null,
      []
    );

    assert.strictEqual(result.actionType, "NONE");
    assert.ok(result.reasoning.some((line) => /portal redirect/i.test(String(line))));
    sinon.assert.notCalled(database.updateCasePortalStatus);
    sinon.assert.notCalled(caseRuntime.transitionCaseRuntime);
  });

  it("routes real portal redirects with non-automatable docs URLs into research instead of creating a portal task", async function () {
    database.getCaseById.resolves({
      id: 25210,
      portal_url: "https://www.civicplus.help/nextrequest/docs/requesters",
      portal_provider: "nextrequest",
      last_portal_status: null,
      request_summary: "Portal request",
    });

    const result = await decideNextAction(
      25210,
      "PORTAL_REDIRECT",
      [],
      null,
      "neutral",
      "SUPERVISED",
      "INBOUND_MESSAGE",
      true,
      null,
      "use_portal",
      null,
      null,
      null,
      null,
      null,
      null,
      []
    );

    assert.strictEqual(result.actionType, "RESEARCH_AGENCY");
    assert.ok(
      result.reasoning.some((line) => /no automatable portal url/i.test(String(line))),
      `expected non-automatable portal reasoning, got ${JSON.stringify(result.reasoning)}`
    );
    sinon.assert.notCalled(database.updateCasePortalStatus);
    sinon.assert.notCalled(caseRuntime.transitionCaseRuntime);
  });

  it("routes missing fee amounts to NEGOTIATE_FEE in simulation mode", async function () {
    const result = await decideNextAction(
      0,
      "FEE_QUOTE",
      [],
      null,
      "neutral",
      "SUPERVISED",
      "INBOUND_MESSAGE",
      true,
      null,
      "respond",
      null,
      null,
      null,
      null,
      null,
      null,
      []
    );

    assert.strictEqual(result.actionType, "NEGOTIATE_FEE");
  });

  it("treats strong privacy denials as CLOSE_CASE in simulation mode", async function () {
    const result = await decideNextAction(
      0,
      "DENIAL",
      [],
      null,
      "negative",
      "SUPERVISED",
      "INBOUND_MESSAGE",
      true,
      null,
      "send_rebuttal",
      null,
      "privacy_exemption",
      null,
      null,
      null,
      null,
      [
        "request is denied in full",
        "Exemption 6 and Exemption 7(C)",
        "law enforcement privacy",
        "no segregable non-exempt portions exist"
      ]
    );

    assert.strictEqual(result.actionType, "CLOSE_CASE");
  });

  it("treats wrong-agency denials as RESEARCH_AGENCY in simulation mode", async function () {
    const result = await decideNextAction(
      0,
      "DENIAL",
      [],
      null,
      "neutral",
      "SUPERVISED",
      "INBOUND_MESSAGE",
      true,
      null,
      "send_rebuttal",
      null,
      "wrong_agency",
      null,
      null,
      null,
      null,
      ["county sheriff maintains the records"]
    );

    assert.strictEqual(result.actionType, "RESEARCH_AGENCY");
  });

  it("treats contractor-custody denials as RESEARCH_AGENCY in simulation mode", async function () {
    const result = await decideNextAction(
      0,
      "DENIAL",
      [],
      null,
      "neutral",
      "SUPERVISED",
      "INBOUND_MESSAGE",
      true,
      null,
      "send_rebuttal",
      null,
      "third_party_confidential",
      null,
      null,
      null,
      null,
      [
        "not federal agency records subject to FOIA",
        "proprietary work product of our private contractor",
        "custody and control of the contractor"
      ]
    );

    assert.strictEqual(result.actionType, "RESEARCH_AGENCY");
  });
});
