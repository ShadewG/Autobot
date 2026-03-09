require("tsx/cjs");

const assert = require("assert");
const sinon = require("sinon");

process.env.OPENAI_API_KEY = "";

const database = require("../services/database");
const { decideNextAction, validateDecision } = require("../trigger/steps/decide-next-action.ts");

describe("DENIAL rebuttal gating", function () {
  beforeEach(function () {
    sinon.stub(database, "getCaseById").resolves({
      id: 99001,
      agency_name: "Synthetic QA Records Unit",
      additional_details: "Synthetic denial QA case",
      contact_research_notes: null,
      constraints_jsonb: [],
      constraints: [],
      requested_records: ["dispatch audio"],
      status: "awaiting_response",
    });
    sinon.stub(database, "getMessagesByCaseId").resolves([]);
    sinon.stub(database, "getLatestResponseAnalysis").resolves({ full_analysis_json: {} });
    sinon.stub(database, "query").resolves({ rows: [] });
  });

  afterEach(function () {
    sinon.restore();
  });

  it("requires human review for vague denials that route to rebuttal", async function () {
    const result = await decideNextAction(
      99001,
      "DENIAL",
      [],
      null,
      "neutral",
      "AUTO",
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
      ["Request denied in full. We will not release the requested records."],
    );

    assert.strictEqual(result.actionType, "SEND_REBUTTAL");
    assert.strictEqual(result.requiresHuman, true);
    assert.strictEqual(result.canAutoExecute, false);
    assert.strictEqual(result.pauseReason, "DENIAL");
  });

  it("requires human review for third-party confidentiality rebuttals", async function () {
    const result = await decideNextAction(
      99001,
      "DENIAL",
      [],
      null,
      "neutral",
      "AUTO",
      "INBOUND_MESSAGE",
      true,
      null,
      "respond",
      null,
      "third_party_confidential",
      null,
      null,
      null,
      null,
      ["The requested contract records are withheld as confidential third-party information."],
    );

    assert.strictEqual(result.actionType, "SEND_REBUTTAL");
    assert.strictEqual(result.requiresHuman, true);
    assert.strictEqual(result.canAutoExecute, false);
    assert.strictEqual(result.pauseReason, "DENIAL");
  });

  it("rejects AI send-rebuttal decisions that try to auto-execute", async function () {
    const result = await validateDecision(
      {
        action: "SEND_REBUTTAL",
        confidence: 0.92,
        requiresHuman: false,
        pauseReason: null,
      },
      {
        caseId: 99001,
        classification: "DENIAL",
        extractedFeeAmount: null,
        autopilotMode: "AUTO",
        denialSubtype: "privacy_exemption",
        dismissedProposals: [],
        constraints: [],
        inlineKeyPoints: ["We deny your request in full under personal privacy protections."],
      }
    );

    assert.strictEqual(result.valid, false);
    assert.match(String(result.reason), /must require human review/i);
  });

  it("rejects appeal routing for strong juvenile-record denials", async function () {
    const result = await validateDecision(
      {
        action: "SEND_APPEAL",
        confidence: 0.94,
        requiresHuman: true,
        pauseReason: "DENIAL",
      },
      {
        caseId: 99001,
        classification: "DENIAL",
        extractedFeeAmount: null,
        autopilotMode: "AUTO",
        denialSubtype: "juvenile_records",
        dismissedProposals: [],
        constraints: [],
        inlineKeyPoints: ["The requested report is entirely confidential under the juvenile records statute."],
      }
    );

    assert.strictEqual(result.valid, false);
    assert.match(String(result.reason), /should CLOSE_CASE/i);
  });

  it("routes privacy denials for accountability records to rebuttal instead of closure", async function () {
    const result = await decideNextAction(
      99001,
      "DENIAL",
      [],
      null,
      "neutral",
      "AUTO",
      "INBOUND_MESSAGE",
      true,
      null,
      "respond",
      null,
      "privacy_exemption",
      null,
      null,
      null,
      null,
      [
        "We deny your request in full under the personal privacy exemption.",
        "Disclosure would be an unwarranted invasion of personal privacy.",
      ],
    );

    assert.strictEqual(result.actionType, "SEND_REBUTTAL");
    assert.strictEqual(result.requiresHuman, true);
    assert.strictEqual(result.pauseReason, "DENIAL");
  });

  it("allows rebuttal for privacy denials involving dispatch or body-camera records", async function () {
    const result = await validateDecision(
      {
        action: "SEND_REBUTTAL",
        confidence: 0.95,
        requiresHuman: true,
        pauseReason: "DENIAL",
      },
      {
        caseId: 99001,
        classification: "DENIAL",
        extractedFeeAmount: null,
        autopilotMode: "AUTO",
        denialSubtype: "privacy_exemption",
        dismissedProposals: [],
        constraints: [],
        inlineKeyPoints: [
          "We deny your request in full under the personal privacy exemption.",
          "Disclosure would be an unwarranted invasion of personal privacy.",
        ],
      }
    );

    assert.strictEqual(result.valid, true);
  });
});
