require("tsx/cjs");

const assert = require("assert");
const sinon = require("sinon");

const db = require("../services/database");
const caseRuntime = require("../services/case-runtime");
const { createProposalAndGate } = require("../trigger/steps/gate-or-execute.ts");

describe("gate-or-execute research safety", function () {
  afterEach(function () {
    sinon.restore();
  });

  it("does not auto-execute RESEARCH_AGENCY when safety requires human review", async function () {
    sinon.stub(db, "resolveProposalCaseAgency").resolves(null);
    const upsertProposalStub = sinon.stub(db, "upsertProposal").resolves({
      id: 2100,
      status: "PENDING_APPROVAL",
      run_id: 2888,
    });
    sinon.stub(db, "updateProposal").resolves();
    const transitionStub = sinon.stub(caseRuntime, "transitionCaseRuntime").resolves();

    const result = await createProposalAndGate(
      25159,
      2888,
      "RESEARCH_AGENCY",
      724,
      { subject: null, bodyText: null, bodyHtml: null },
      {
        riskFlags: ["INVALID_ACTION_DRAFT"],
        warnings: ["draft invalid"],
        canAutoExecute: false,
        requiresHuman: true,
        pauseReason: "INVALID_ACTION_DRAFT",
      },
      true,
      false,
      "INVALID_ACTION_DRAFT",
      ["Research updated contact info first"],
      0.82,
      0,
      null,
      null,
      null,
      null,
      null
    );

    assert.strictEqual(result.shouldWait, true);
    sinon.assert.calledOnce(upsertProposalStub);
    const proposal = upsertProposalStub.firstCall.args[0];
    assert.strictEqual(proposal.canAutoExecute, false);
    assert.strictEqual(proposal.requiresHuman, true);
    sinon.assert.calledOnce(transitionStub);
  });
});
