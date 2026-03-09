require("tsx/cjs");

const assert = require("assert");
const path = require("path");
const sinon = require("sinon");

describe("AI Router v2 deterministic fallback", function () {
  let aiPath;
  let decidePath;
  let originalAi;
  let originalDecide;
  let database;
  let originalRouterFlag;

  beforeEach(function () {
    aiPath = require.resolve("ai");
    decidePath = path.resolve(__dirname, "../trigger/steps/decide-next-action.ts");
    originalAi = require.cache[aiPath];
    originalDecide = require.cache[decidePath];
    originalRouterFlag = process.env.AI_ROUTER_V2;

    process.env.AI_ROUTER_V2 = "true";

    require.cache[aiPath] = {
      id: aiPath,
      filename: aiPath,
      loaded: true,
      exports: {
        generateObject: sinon.stub().resolves({
          object: {
            action: "SEND_FEE_WAIVER_REQUEST",
            confidence: 0.82,
            requiresHuman: true,
            pauseReason: "FEE_QUOTE",
            reasoning: ["Request a fee waiver before paying the fee."],
          },
          usage: {},
          response: {},
        }),
      },
    };

    delete require.cache[decidePath];
    database = require("../services/database");
  });

  afterEach(function () {
    sinon.restore();
    process.env.AI_ROUTER_V2 = originalRouterFlag;
    if (originalAi) require.cache[aiPath] = originalAi;
    else delete require.cache[aiPath];
    if (originalDecide) require.cache[decidePath] = originalDecide;
    else delete require.cache[decidePath];
  });

  it("falls back to deterministic ACCEPT_FEE for small AUTO fee quotes after repeated invalid AI outputs", async function () {
    sinon.stub(database, "getCaseById").resolves({
      id: 99123,
      status: "awaiting_response",
      constraints_jsonb: [],
      constraints: [],
      requested_records: ["incident report"],
      portal_url: null,
      portal_provider: null,
    });
    sinon.stub(database, "getLatestResponseAnalysis").resolves(null);
    sinon.stub(database, "getMessagesByCaseId").resolves([]);
    sinon.stub(database, "getLatestInboundMessage").resolves(null);
    sinon.stub(database, "query").callsFake(async (sql) => {
      const text = String(sql);
      if (text.includes("COUNT(*)")) {
        return { rows: [{ cnt: 0 }] };
      }
      return { rows: [] };
    });

    const { decideNextAction } = require("../trigger/steps/decide-next-action.ts");

    const result = await decideNextAction(
      99123,
      "FEE_QUOTE",
      [],
      22,
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
      null
    );

    assert.strictEqual(result.actionType, "ACCEPT_FEE");
    assert.strictEqual(result.requiresHuman, false);
    assert.strictEqual(result.canAutoExecute, true);
    assert.ok(
      result.reasoning.some((line) => /auto-approving|must auto-accept|AI Router v2 failed after 3 attempts/i.test(String(line))),
      `expected deterministic fallback reasoning, got: ${JSON.stringify(result.reasoning)}`
    );
  });

  it("overrides AI ESCALATE for third-party confidentiality denials when deterministic routing has a specific rebuttal action", async function () {
    const ai = require("ai");
    ai.generateObject.resetBehavior();
    ai.generateObject.resolves({
      object: {
        action: "ESCALATE",
        confidence: 0.74,
        requiresHuman: true,
        pauseReason: "DENIAL",
        reasoning: ["System constraints allow only ESCALATE for this step."],
      },
      usage: {},
      response: {},
    });

    sinon.stub(database, "getCaseById").resolves({
      id: 99124,
      status: "awaiting_response",
      agency_name: "Synthetic QA Records Unit",
      additional_details: "Closed homicide file with 911 audio request",
      constraints_jsonb: [],
      constraints: [],
      requested_records: ["dispatch audio", "body camera footage"],
      portal_url: null,
      portal_provider: null,
      contact_research_notes: "Existing custodian verified",
    });
    sinon.stub(database, "getLatestResponseAnalysis").resolves({ full_analysis_json: {} });
    sinon.stub(database, "getMessagesByCaseId").resolves([]);
    sinon.stub(database, "getLatestInboundMessage").resolves(null);
    sinon.stub(database, "query").callsFake(async (sql) => {
      const text = String(sql);
      if (text.includes("COUNT(*)")) {
        return { rows: [{ cnt: 0 }] };
      }
      return { rows: [] };
    });

    const { decideNextAction } = require("../trigger/steps/decide-next-action.ts");

    const result = await decideNextAction(
      99124,
      "DENIAL",
      [],
      null,
      "neutral",
      "SUPERVISED",
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
      [
        "The requested 911 calls are confidential pursuant to statute and cannot be disseminated.",
        "We will remove records that are clearly confidential by statute before any release.",
      ]
    );

    assert.strictEqual(result.actionType, "SEND_REBUTTAL");
    assert.strictEqual(result.requiresHuman, true);
    assert.strictEqual(result.pauseReason, "DENIAL");
    assert.ok(
      result.reasoning.some((line) => /deterministic denial routing preferred send_rebuttal/i.test(String(line))),
      `expected deterministic override reasoning, got: ${JSON.stringify(result.reasoning)}`
    );
  });
});
