require("tsx/cjs");

const assert = require("assert");
process.env.OPENAI_API_KEY = "";

const { selectResearchFollowupChannels } = require("../trigger/steps/execute-action.ts");

describe("research follow-up channel selection", function () {
  it("uses a verified existing portal when research completed without a new channel", function () {
    const result = selectResearchFollowupChannels({
      candidatePortalUrl: "https://lubbocktx.govqa.us/WEBAPP/_rs/SupportHome.aspx",
      knownCasePortalSignal: "https://lubbocktx.govqa.us/WEBAPP/_rs/SupportHome.aspx",
      newPortalUrl: null,
      newEmail: null,
      newPhone: null,
      newFax: null,
    });

    assert.strictEqual(result.actionType, "SUBMIT_PORTAL");
    assert.strictEqual(result.followupPortalUrl, "https://lubbocktx.govqa.us/WEBAPP/_rs/SupportHome.aspx");
    assert.strictEqual(result.usesExistingSendChannel, true);
  });

  it("uses a verified existing email when research completed without a new channel", function () {
    const result = selectResearchFollowupChannels({
      candidateEmail: "orr@mylubbock.us",
      knownCaseEmailSignal: "orr@mylubbock.us",
      newPortalUrl: null,
      newEmail: null,
      newPhone: null,
      newFax: null,
    });

    assert.strictEqual(result.actionType, "SEND_INITIAL_REQUEST");
    assert.strictEqual(result.followupEmail, "orr@mylubbock.us");
    assert.strictEqual(result.usesExistingSendChannel, true);
  });

  it("still prefers newly discovered channels over existing ones", function () {
    const result = selectResearchFollowupChannels({
      candidateEmail: "existing@example.gov",
      knownCaseEmailSignal: "existing@example.gov",
      newPortalUrl: "https://portal.example.gov/request",
      newEmail: null,
      newPhone: null,
      newFax: null,
    });

    assert.strictEqual(result.actionType, "SUBMIT_PORTAL");
    assert.strictEqual(result.followupPortalUrl, "https://portal.example.gov/request");
    assert.strictEqual(result.followupEmail, "existing@example.gov");
    assert.strictEqual(result.usesExistingSendChannel, false);
  });
});
