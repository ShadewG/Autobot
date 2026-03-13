require("tsx/cjs");

const assert = require("assert");
const sinon = require("sinon");

const db = require("../services/database");
const aiService = require("../services/ai-service");
const decisionMemory = require("../services/decision-memory-service");
const successfulExamples = require("../services/successful-examples-service");
const { draftResponse } = require("../trigger/steps/draft-response.ts");

describe("research handoff draft generation", function () {
  afterEach(function () {
    sinon.restore();
  });

  it("builds a structured research handoff draft from reasoning details", async function () {
    sinon.stub(db, "getCaseById").resolves({
      id: 7006,
      case_name: "Kyneddi Miller’s mother sentenced in teen’s death",
      subject_name: "Kyneddi Miller’s mother sentenced in teen’s death",
      agency_name: "Boone County Sheriff's Office",
      agency_email: "info@boonewvsheriff.org",
      portal_url: "https://boonewvsheriff.org",
      state: "WV",
      status: "needs_human_review",
      substatus: null,
      additional_details: "",
      constraints_jsonb: [],
      scope_items_jsonb: [],
      contact_research_notes: null,
    });
    sinon.stub(db, "getMessagesByCaseId").resolves([]);
    sinon.stub(db, "updateCase").resolves({});
    sinon.stub(decisionMemory, "getRelevantLessons").resolves([]);
    sinon.stub(decisionMemory, "formatLessonsForPrompt").returns("");
    sinon.stub(successfulExamples, "getRelevantExamples").resolves([]);
    sinon.stub(successfulExamples, "formatExamplesForPrompt").returns("");
    sinon.stub(aiService, "generateAgencyResearchBrief").resolves({
      reasoning: [
        { step: "AI triage summary", detail: "Prior portal target was the wrong jurisdiction." },
        { step: "Recommendation", detail: "Research needs a verified Boone County records contact." },
      ],
      researchFailed: false,
      suggested_agencies: [],
    });

    const draft = await draftResponse(
      7006,
      "RESEARCH_AGENCY",
      [],
      [],
      null,
      null,
      null
    );

    assert.strictEqual(draft.subject, "Research handoff needed: Boone County Sheriff's Office");
    assert.match(draft.bodyText, /Research handoff required for Boone County Sheriff's Office\./);
    assert.match(draft.bodyText, /Prior portal target was the wrong jurisdiction\./);
    assert.match(draft.bodyText, /Research needs a verified Boone County records contact\./);
    assert.doesNotMatch(draft.bodyText, /\[object Object\]/);
  });
});
