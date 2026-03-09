require("tsx/cjs");

const { describe, it } = require("mocha");
const { expect } = require("chai");

const { installMocks } = require("./e2e/pipeline-helpers");

describe("Portal onboarding acknowledgment classification", function () {
  this.timeout(15000);

  it("treats a human-sent GovQA onboarding acknowledgment as ACKNOWLEDGMENT", async function () {
    const mocks = installMocks("acknowledgment");
    try {
      const { classifyInbound } = require("../trigger/steps/classify-inbound.ts");

      mocks.message.from_email = "ashumaker@sjso.org";
      mocks.message.subject = "RE: Public Records Request Submission – Aiden Sean Fucci";
      mocks.message.body_text = [
        "Your request has been received and will be added to our GovQA portal.",
        "Please monitor your email for any updates, invoices, questions, or completion.",
        "Stay Safe,",
        "Ashton Shumaker",
        "Records Specialist | General Services Division",
      ].join("\n");

      mocks.generateObjectStub.callsFake(async () => ({
        object: {
          intent: "question",
          confidence_score: 0.84,
          sentiment: "neutral",
          key_points: ["Agency says the request has been received and will be added to GovQA."],
          extracted_deadline: null,
          fee_amount: null,
          requires_response: true,
          portal_url: null,
          suggested_action: "respond",
          reason_no_response: null,
          unanswered_agency_question: "Please monitor your email for updates.",
          denial_subtype: null,
          constraints_to_add: [],
          scope_updates: [],
          fee_breakdown: null,
        },
        usage: { promptTokens: 400, completionTokens: 80 },
        response: { modelId: "gpt-5.2-mock" },
      }));

      const context = {
        caseId: 25157,
        caseData: mocks.caseData,
        messages: [mocks.message],
        attachments: [],
        analysis: null,
        followups: null,
        existingProposal: null,
        autopilotMode: "SUPERVISED",
        constraints: [],
        scopeItems: [],
      };

      const result = await classifyInbound(context, mocks.message.id, "INBOUND_MESSAGE");

      expect(result.classification).to.equal("ACKNOWLEDGMENT");
      expect(result.requiresResponse).to.equal(false);
      expect(result.suggestedAction).to.equal("wait");
      expect(result.reasonNoResponse).to.match(/onboarding the request into the portal/i);
    } finally {
      mocks.restore();
    }
  });
});
