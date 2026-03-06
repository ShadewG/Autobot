require("tsx/cjs");

const assert = require("assert");
const sinon = require("sinon");

const database = require("../services/database");
const { decideNextAction } = require("../trigger/steps/decide-next-action.ts");

describe("HUMAN_REVIEW_RESOLUTION retry research routing", function () {
  let getCaseByIdStub;

  beforeEach(function () {
    getCaseByIdStub = sinon.stub(database, "getCaseById").resolves({
      id: 25243,
      constraints_jsonb: [],
      constraints: [],
      substatus: "agency_research_complete",
      contact_research_notes: null,
      status: "needs_human_review",
    });
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
});
