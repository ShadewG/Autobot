require("tsx/cjs");

const assert = require("assert");
const sinon = require("sinon");

const database = require("../services/database");
const {
  validateDecision,
  decideNextAction,
} = require("../trigger/steps/decide-next-action.ts");

describe("status update evidence guard", function () {
  beforeEach(function () {
    sinon.stub(database, "getCaseById").resolves({
      id: 25155,
      constraints_jsonb: [],
      constraints: [],
      send_date: null,
      last_portal_status: null,
      additional_details: "PRR-2025-1168 and your security key is DCC5EBE0.",
    });
    sinon.stub(database, "query").callsFake(async (sql) => {
      const text = String(sql);
      if (/outbound_count/i.test(text)) {
        return { rows: [{ outbound_count: 0 }] };
      }
      if (/completed_count/i.test(text)) {
        return { rows: [{ completed_count: 0 }] };
      }
      return { rows: [] };
    });
  });

  afterEach(function () {
    sinon.restore();
  });

  it("rejects SEND_STATUS_UPDATE when imported metadata is the only evidence", async function () {
    const result = await validateDecision(
      {
        action: "SEND_STATUS_UPDATE",
        confidence: 0.91,
        reasoning: ["Use the PRR reference from imported notes."],
        requiresHuman: true,
        pauseReason: "SENSITIVE",
      },
      {
        caseId: 25155,
        classification: "NO_RESPONSE",
        extractedFeeAmount: null,
        autopilotMode: "SUPERVISED",
        constraints: [],
      }
    );

    assert.strictEqual(result.valid, false);
    assert.match(
      String(result.reason || ""),
      /requires real submission evidence/i
    );
  });

  it("allows SEND_STATUS_UPDATE when portal submission evidence exists", async function () {
    database.getCaseById.restore();
    sinon.stub(database, "getCaseById").resolves({
      id: 25155,
      constraints_jsonb: [],
      constraints: [],
      send_date: null,
      last_portal_status: "completed",
      additional_details: "PRR-2025-1168 and your security key is DCC5EBE0.",
    });

    const result = await validateDecision(
      {
        action: "SEND_STATUS_UPDATE",
        confidence: 0.91,
        reasoning: ["Portal already completed; follow up for status."],
        requiresHuman: true,
        pauseReason: "SENSITIVE",
      },
      {
        caseId: 25155,
        classification: "NO_RESPONSE",
        extractedFeeAmount: null,
        autopilotMode: "SUPERVISED",
        constraints: [],
      }
    );

    assert.strictEqual(result.valid, true);
  });

  it("keeps send_via_email as SEND_INITIAL_REQUEST when only imported PRR/security-key text exists", async function () {
    const result = await decideNextAction(
      25155,
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

  it("routes send_via_email to SEND_STATUS_UPDATE when portal submission has completed", async function () {
    database.getCaseById.restore();
    sinon.stub(database, "getCaseById").resolves({
      id: 25155,
      constraints_jsonb: [],
      constraints: [],
      send_date: null,
      last_portal_status: "completed",
      additional_details: "PRR-2025-1168 and your security key is DCC5EBE0.",
    });

    const result = await decideNextAction(
      25155,
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
    assert.ok(
      result.reasoning.some((line) => /completed portal submission/i.test(String(line))),
      `expected portal evidence reasoning, got: ${JSON.stringify(result.reasoning)}`
    );
  });
});
