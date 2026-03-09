require("tsx/cjs");

const assert = require("assert");

const { validateDecision } = require("../trigger/steps/decide-next-action.ts");

describe("FEE_QUOTE auto-accept guard", function () {
  it("rejects fee-waiver routing for small auto-approvable fee quotes in AUTO mode", async function () {
    const result = await validateDecision(
      {
        action: "SEND_FEE_WAIVER_REQUEST",
        confidence: 0.9,
        requiresHuman: true,
        pauseReason: "FEE_QUOTE",
      },
      {
        caseId: 1,
        classification: "FEE_QUOTE",
        extractedFeeAmount: 22,
        autopilotMode: "AUTO",
        denialSubtype: null,
        dismissedProposals: [],
        constraints: [],
        inlineKeyPoints: [],
      }
    );

    assert.strictEqual(result.valid, false);
    assert.match(String(result.reason), /must auto-accept/i);
  });

  it("accepts auto-accept routing for small fee quotes in AUTO mode", async function () {
    const result = await validateDecision(
      {
        action: "ACCEPT_FEE",
        confidence: 0.9,
        requiresHuman: false,
        pauseReason: null,
      },
      {
        caseId: 1,
        classification: "FEE_QUOTE",
        extractedFeeAmount: 22,
        autopilotMode: "AUTO",
        denialSubtype: null,
        dismissedProposals: [],
        constraints: [],
        inlineKeyPoints: [],
      }
    );

    assert.strictEqual(result.valid, true);
  });

  it("rejects fee-waiver routing for mid-range fee quotes that should be accepted", async function () {
    const result = await validateDecision(
      {
        action: "SEND_FEE_WAIVER_REQUEST",
        confidence: 0.92,
        requiresHuman: true,
        pauseReason: "FEE_QUOTE",
      },
      {
        caseId: 1,
        classification: "FEE_QUOTE",
        extractedFeeAmount: 444,
        autopilotMode: "AUTO",
        denialSubtype: null,
        dismissedProposals: [],
        constraints: [],
        inlineKeyPoints: [],
      }
    );

    assert.strictEqual(result.valid, false);
    assert.match(String(result.reason), /must use ACCEPT_FEE/i);
  });

  it("accepts human-gated accept_fee routing for mid-range fee quotes", async function () {
    const result = await validateDecision(
      {
        action: "ACCEPT_FEE",
        confidence: 0.92,
        requiresHuman: true,
        pauseReason: "FEE_QUOTE",
      },
      {
        caseId: 1,
        classification: "FEE_QUOTE",
        extractedFeeAmount: 444,
        autopilotMode: "AUTO",
        denialSubtype: null,
        dismissedProposals: [],
        constraints: [],
        inlineKeyPoints: [],
      }
    );

    assert.strictEqual(result.valid, true);
  });
});
