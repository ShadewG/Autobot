require("tsx/cjs");

const assert = require("assert");

const { shouldFallbackToSkyvern } = require("../trigger/tasks/submit-portal.ts");

describe("submit-portal engine selection", function () {
  it("does not fallback when Playwright already confirmed the submission", function () {
    assert.strictEqual(
      shouldFallbackToSkyvern({
        success: true,
        submissionConfirmed: true,
        fallback_safe: false,
      }),
      false
    );
  });

  it("falls back when Playwright failed in a fallback-safe way", function () {
    assert.strictEqual(
      shouldFallbackToSkyvern({
        success: false,
        submissionConfirmed: false,
        fallback_safe: true,
        status: "submit_button_not_found",
      }),
      true
    );
  });

  it("does not fallback when Playwright marked the result unsafe to retry", function () {
    assert.strictEqual(
      shouldFallbackToSkyvern({
        success: false,
        submissionConfirmed: false,
        fallback_safe: false,
        status: "auth_intervention_required",
      }),
      false
    );
  });
});
