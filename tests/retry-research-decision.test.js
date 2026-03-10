require("tsx/cjs");

const assert = require("assert");
const sinon = require("sinon");

const database = require("../services/database");
const { decideNextAction } = require("../trigger/steps/decide-next-action.ts");

describe("HUMAN_REVIEW_RESOLUTION retry research routing", function () {
  let getCaseByIdStub;
  let queryStub;

  beforeEach(function () {
    getCaseByIdStub = sinon.stub(database, "getCaseById").resolves({
      id: 25243,
      constraints_jsonb: [],
      constraints: [],
      substatus: "agency_research_complete",
      contact_research_notes: null,
      status: "needs_human_review",
      send_date: null,
    });
    queryStub = sinon.stub(database, "query").resolves({ rows: [] });
  });

  afterEach(function () {
    sinon.restore();
  });

  it("maps uppercase RETRY_RESEARCH to a fresh research decision", async function () {
    const result = await decideNextAction(
      25243,
      "UNKNOWN",
      [],
      null,
      "neutral",
      "SUPERVISED",
      "HUMAN_REVIEW_RESOLUTION",
      true,
      null,
      null,
      null,
      null,
      "RETRY_RESEARCH",
      "Research failed previously. Retry agency research from scratch.",
      null,
      null
    );

    assert.strictEqual(result.actionType, "RESEARCH_AGENCY");
    assert.strictEqual(result.researchLevel, "deep");
    assert.strictEqual(result.adjustmentInstruction, "Research failed previously. Retry agency research from scratch.");
    assert.ok(
      result.reasoning.some((line) => /another agency research pass/i.test(String(line))),
      `expected retry reasoning, got: ${JSON.stringify(result.reasoning)}`
    );
    sinon.assert.calledOnce(getCaseByIdStub);
  });

  it("routes send_via_email to SEND_STATUS_UPDATE when prior outbound exists", async function () {
    queryStub.callsFake(async (sql) => {
      if (/outbound_count/i.test(String(sql))) {
        return { rows: [{ outbound_count: 3 }] };
      }
      return { rows: [] };
    });

    const result = await decideNextAction(
      25243,
      "UNKNOWN",
      [],
      null,
      "neutral",
      "SUPERVISED",
      "HUMAN_REVIEW_RESOLUTION",
      true,
      null,
      null,
      null,
      null,
      "send_via_email",
      "Send it by email instead.",
      null,
      null
    );

    assert.strictEqual(result.actionType, "SEND_STATUS_UPDATE");
    assert.strictEqual(result.adjustmentInstruction, "Send it by email instead.");
    assert.ok(
      result.reasoning.some((line) => /prior outbound correspondence already exists/i.test(String(line))),
      `expected prior-send reasoning, got: ${JSON.stringify(result.reasoning)}`
    );
  });

  it("keeps send_via_email as SEND_INITIAL_REQUEST when no prior submission exists", async function () {
    queryStub.callsFake(async (sql) => {
      if (/outbound_count/i.test(String(sql))) {
        return { rows: [{ outbound_count: 0 }] };
      }
      return { rows: [] };
    });

    const result = await decideNextAction(
      25243,
      "UNKNOWN",
      [],
      null,
      "neutral",
      "SUPERVISED",
      "HUMAN_REVIEW_RESOLUTION",
      true,
      null,
      null,
      null,
      null,
      "send_via_email",
      "Send it by email instead.",
      null,
      null
    );

    assert.strictEqual(result.actionType, "SEND_INITIAL_REQUEST");
  });
});
