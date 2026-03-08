require("tsx/cjs");

const assert = require("assert");
const path = require("path");
const sinon = require("sinon");

describe("CLARIFICATION_REQUEST fallback routing", function () {
  let aiPath;
  let decidePath;
  let originalAi;
  let originalDecide;
  let database;

  beforeEach(function () {
    aiPath = require.resolve("ai");
    decidePath = path.resolve(__dirname, "../trigger/steps/decide-next-action.ts");
    originalAi = require.cache[aiPath];
    originalDecide = require.cache[decidePath];

    require.cache[aiPath] = {
      id: aiPath,
      filename: aiPath,
      loaded: true,
      exports: {
        generateObject: sinon.stub().rejects(new Error("sorry, too many clients already")),
      },
    };

    delete require.cache[decidePath];
    database = require("../services/database");
  });

  afterEach(function () {
    sinon.restore();
    if (originalAi) require.cache[aiPath] = originalAi;
    else delete require.cache[aiPath];
    if (originalDecide) require.cache[decidePath] = originalDecide;
    else delete require.cache[decidePath];
  });

  it("falls back to deterministic SEND_CLARIFICATION when the AI decision call fails", async function () {
    sinon.stub(database, "getCaseById").resolves({
      id: 25284,
      status: "awaiting_response",
      constraints_jsonb: [],
      constraints: [],
      requested_records: ["Incident report and dashcam footage"],
    });
    sinon.stub(database, "getLatestResponseAnalysis").resolves(null);
    sinon.stub(database, "query").callsFake(async (sql) => {
      if (String(sql).includes("action_type = 'RESEARCH_AGENCY'")) {
        return { rows: [{ cnt: 0 }] };
      }
      return { rows: [] };
    });

    const { decideNextAction } = require("../trigger/steps/decide-next-action.ts");

    const result = await decideNextAction(
      25284,
      "CLARIFICATION_REQUEST",
      [],
      null,
      "neutral",
      "SUPERVISED",
      "inbound_message",
      true,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null
    );

    assert.strictEqual(result.actionType, "SEND_CLARIFICATION");
    assert.ok(
      result.reasoning.some((line) => /agency requested clarification/i.test(String(line))),
      `expected clarification reasoning, got: ${JSON.stringify(result.reasoning)}`
    );
  });
});
