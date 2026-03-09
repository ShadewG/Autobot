/**
 * Pipeline Inbound E2E Tests
 *
 * Tests the REAL Trigger.dev pipeline steps (classify, decide, draft, safety, gate)
 * with mocked AI responses and DB. Exercises the full pipeline for each golden fixture.
 *
 * Usage:
 *   npm run test:pipeline
 *   npx mocha tests/e2e/pipeline-inbound.test.js --timeout 30000
 */

require("tsx/cjs");

const { describe, it, beforeEach, afterEach } = require("mocha");
const { expect } = require("chai");
const sinon = require("sinon");
const path = require("path");

const {
  installMocks,
  getInboundFixtures,
  getFixture,
  expectedClassification,
  classificationMatches,
  mockAI,
} = require("./pipeline-helpers");

// ============================================================
// CLASSIFICATION TESTS
// ============================================================

describe("Pipeline E2E: Classification Step", function () {
  this.timeout(15000);

  const inboundFixtures = getInboundFixtures();

  inboundFixtures.forEach((fixture) => {
    describe(`fixture: ${fixture.fixture_id}`, function () {
      let mocks;

      beforeEach(function () {
        mocks = installMocks(fixture.fixture_id);
      });

      afterEach(function () {
        mocks.restore();
      });

      it("classifies inbound message with correct intent", async function () {
        const { classifyInbound } = require("../../trigger/steps/classify-inbound.ts");

        const context = {
          caseId: fixture.case_data.id,
          caseData: mocks.caseData,
          messages: mocks.message ? [mocks.message] : [],
          attachments: [],
          analysis: null,
          followups: null,
          existingProposal: null,
          autopilotMode: "SUPERVISED",
          constraints: [],
          scopeItems: [],
        };

        const result = await classifyInbound(context, mocks.message.id, "INBOUND_MESSAGE");

        // Verify classification maps to expected
        const expected = expectedClassification(fixture);
        expect(classificationMatches(result.classification, expected)).to.equal(
          true,
          `Expected classification ${JSON.stringify(expected)}, got ${result.classification}`
        );

        // Verify confidence is reasonable
        expect(result.confidence).to.be.a("number");
        expect(result.confidence).to.be.greaterThan(0.5);

        // Verify portal URL extraction where expected
        if (fixture.expected.portal_url) {
          expect(result.portalUrl).to.equal(fixture.expected.portal_url);
        }

        // Verify fee amount extraction where expected
        if (fixture.expected.fee_amount) {
          expect(result.extractedFeeAmount).to.equal(fixture.expected.fee_amount);
        }

        // Verify denial subtype where expected
        if (fixture.expected.denial_subtype) {
          expect(result.denialSubtype).to.equal(fixture.expected.denial_subtype);
        }

        // Verify requires_response where expected (not null)
        if (fixture.expected.requires_response !== null && fixture.expected.requires_response !== undefined) {
          expect(result.requiresResponse).to.equal(fixture.expected.requires_response);
        }

        // Verify generateObject was called (not the legacy fallback)
        expect(mocks.generateObjectStub.called).to.equal(true);
      });

      it("saves response analysis to DB", async function () {
        const { classifyInbound } = require("../../trigger/steps/classify-inbound.ts");

        const context = {
          caseId: fixture.case_data.id,
          caseData: mocks.caseData,
          messages: mocks.message ? [mocks.message] : [],
          attachments: [],
          analysis: null,
          followups: null,
          existingProposal: null,
          autopilotMode: "SUPERVISED",
          constraints: [],
          scopeItems: [],
        };

        await classifyInbound(context, mocks.message.id, "INBOUND_MESSAGE");

        // Verify saveResponseAnalysis was called
        expect(mocks.dbStub.saveResponseAnalysis.calledOnce).to.equal(true);
        const savedAnalysis = mocks.dbStub.saveResponseAnalysis.firstCall.args[0];
        expect(savedAnalysis.caseId).to.equal(fixture.case_data.id);
        expect(savedAnalysis.messageId).to.equal(mocks.message.id);
        expect(savedAnalysis.intent).to.be.a("string");
        expect(savedAnalysis.confidenceScore).to.be.a("number");
      });
    });
  });

  // Special case: followup triggers skip classification
  it("returns NO_RESPONSE for scheduled followup triggers", async function () {
    const mocks = installMocks("acknowledgment");
    try {
      const { classifyInbound } = require("../../trigger/steps/classify-inbound.ts");

      const context = {
        caseId: 1003,
        caseData: mocks.caseData,
        messages: [],
        attachments: [],
        analysis: null,
        followups: null,
        existingProposal: null,
        autopilotMode: "SUPERVISED",
        constraints: [],
        scopeItems: [],
      };

      const result = await classifyInbound(context, null, "SCHEDULED_FOLLOWUP");

      expect(result.classification).to.equal("NO_RESPONSE");
      expect(result.confidence).to.equal(1.0);
      expect(result.requiresResponse).to.equal(false);
      // generateObject should NOT be called for followup triggers
      expect(mocks.generateObjectStub.called).to.equal(false);
    } finally {
      mocks.restore();
    }
  });

  it("auto-classifies portal password-assistance emails as portal routing work", async function () {
    const mocks = installMocks("acknowledgment");
    try {
      const { classifyInbound } = require("../../trigger/steps/classify-inbound.ts");

      mocks.caseData.portal_url = "https://example.govqa.us/portal";
      mocks.message.from_email = "lubbock@govqa.us";
      mocks.message.subject = "[Records Center] Password Assistance";
      mocks.message.body_text = [
        "We received your request for password assistance.",
        "Below is your temporary password.",
        "Please use it to access your account online.",
        "https://example.govqa.us/portal/reset"
      ].join("\n");

      const context = {
        caseId: 1003,
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

      expect(result.classification).to.equal("PORTAL_REDIRECT");
      expect(result.requiresResponse).to.equal(true);
      expect(result.suggestedAction).to.equal("use_portal");
      expect(result.portalUrl).to.equal("https://example.govqa.us/portal/reset");
      expect(mocks.generateObjectStub.called).to.equal(false);
    } finally {
      mocks.restore();
    }
  });

  it("overrides portal acknowledgment drift when the body explicitly says there are no responsive records", async function () {
    const mocks = installMocks("acknowledgment");
    try {
      const { classifyInbound } = require("../../trigger/steps/classify-inbound.ts");

      mocks.message.from_email = "lubbock@govqa.us";
      mocks.message.subject = "[Records Center] Police Records Request :: P002732-030626";
      mocks.message.body_text = [
        "The City of Lubbock received a public information request from you on March 06, 2026.",
        "The City of Lubbock has reviewed its files and has determined there are no responsive documents to your request.",
        "To monitor the progress or update this request please log into the Open Records Center.",
      ].join("\n");

      const context = {
        caseId: 1003,
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

      expect(result.classification).to.equal("DENIAL");
      expect(result.denialSubtype).to.equal("no_records");
      expect(result.requiresResponse).to.equal(true);
      expect(result.suggestedAction).to.equal("respond");
      expect(mocks.generateObjectStub.called).to.equal(true);
    } finally {
      mocks.restore();
    }
  });

  it("overrides fee-schedule drift when the response also asserts statutory confidentiality", async function () {
    const mocks = installMocks("acknowledgment");
    try {
      const { classifyInbound } = require("../../trigger/steps/classify-inbound.ts");

      mocks.message.from_email = "kristy.winslow@maine.gov";
      mocks.message.subject = "FW: Public Records Request - Marcel A. Lagrange Jr";
      mocks.message.body_text = [
        "Please consider this letter an acknowledgment of receipt of your Freedom of Access Act request.",
        "We will remove records that are clearly confidential by statute, including criminal history record information.",
        "911 calls are confidential pursuant to 25 M.R.S. § 2929 and cannot be disseminated.",
        "The fees for production of records are as follows: $25 per hour for staff time after the first two hours; $0.10 per page.",
      ].join("\n");

      const context = {
        caseId: 1004,
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

      expect(result.classification).to.equal("DENIAL");
      expect(result.denialSubtype).to.equal("privacy_exemption");
      expect(result.requiresResponse).to.equal(true);
      expect(result.suggestedAction).to.equal("respond");
      expect(mocks.generateObjectStub.called).to.equal(true);
    } finally {
      mocks.restore();
    }
  });
});

// ============================================================
// DECISION ROUTING TESTS
// ============================================================

describe("Pipeline E2E: Decision Step", function () {
  this.timeout(15000);

  const inboundFixtures = getInboundFixtures();

  // Map fixture category/intent to expected decision actions
  const EXPECTED_ACTIONS = {
    portal_redirect_simple: ["NONE", "SUBMIT_PORTAL"],
    portal_redirect_no_url: ["NONE", "RESEARCH_AGENCY", "SUBMIT_PORTAL"],
    acknowledgment: ["NONE"],
    records_ready_link: ["NONE", "CLOSE_CASE"],
    delivery_attached: ["NONE", "CLOSE_CASE"],
    partial_delivery_more_coming: ["NONE", "SEND_FOLLOWUP"],
    more_info_needed: ["SEND_CLARIFICATION"],
    direct_question: ["SEND_CLARIFICATION"],
    fee_request_low: ["ACCEPT_FEE"],
    fee_request_high: ["NEGOTIATE_FEE"],
    denial_weak: ["SEND_REBUTTAL", "RESEARCH_AGENCY"],
    denial_strong: ["SEND_REBUTTAL", "CLOSE_CASE", "SEND_APPEAL"],
    wrong_agency: ["RESEARCH_AGENCY", "NONE"],
    retention_expired: ["SEND_REBUTTAL", "CLOSE_CASE"],
    hostile: ["ESCALATE"],
    sensitive_minors: ["SEND_CLARIFICATION"],
    multi_portal_plus_fee: ["NONE", "SUBMIT_PORTAL"],
    multi_portal_plus_denial_language: ["NONE", "SUBMIT_PORTAL"],
    multi_partial_approval_plus_fee: ["ACCEPT_FEE", "NEGOTIATE_FEE", "RESPOND_PARTIAL_APPROVAL"],
    multi_ack_plus_fee_estimate: ["ACCEPT_FEE", "NEGOTIATE_FEE", "NONE"],
    multi_denial_plus_partial_release: ["RESPOND_PARTIAL_APPROVAL", "SEND_REBUTTAL", "NONE"],
  };

  inboundFixtures.forEach((fixture) => {
    // Skip fixtures we don't have decision expectations for
    const expectedActions = EXPECTED_ACTIONS[fixture.fixture_id];
    if (!expectedActions) return;

    describe(`fixture: ${fixture.fixture_id}`, function () {
      let mocks;

      beforeEach(function () {
        mocks = installMocks(fixture.fixture_id);
      });

      afterEach(function () {
        mocks.restore();
      });

      it("routes to correct action type", async function () {
        const { decideNextAction } = require("../../trigger/steps/decide-next-action.ts");
        const classifyMock = mockAI("classify", fixture.fixture_id);

        // Map the raw intent to the Classification enum
        const CLASSIFICATION_MAP = {
          fee_request: "FEE_QUOTE",
          question: "CLARIFICATION_REQUEST",
          more_info_needed: "CLARIFICATION_REQUEST",
          hostile: "HOSTILE",
          denial: "DENIAL",
          partial_denial: "PARTIAL_APPROVAL",
          portal_redirect: "PORTAL_REDIRECT",
          acknowledgment: "ACKNOWLEDGMENT",
          records_ready: "RECORDS_READY",
          delivery: "RECORDS_READY",
          partial_delivery: "PARTIAL_DELIVERY",
          wrong_agency: "WRONG_AGENCY",
          other: "UNKNOWN",
        };
        const classification = CLASSIFICATION_MAP[classifyMock.intent] || "UNKNOWN";

        const result = await decideNextAction(
          fixture.case_data.id,
          classification,
          classifyMock.constraints_to_add || [],
          classifyMock.fee_amount || null,
          classifyMock.sentiment || "neutral",
          "SUPERVISED",
          "INBOUND_MESSAGE",
          classifyMock.requires_response,
          classifyMock.portal_url || null,
          classifyMock.suggested_action || null,
          classifyMock.reason_no_response || null,
          classifyMock.denial_subtype || null,
          null, // reviewAction
          null, // reviewInstruction
          null, // humanDecision
          classifyMock.jurisdiction_level || null,
          classifyMock.key_points || []
        );

        expect(result).to.have.property("actionType");
        expect(expectedActions).to.include(
          result.actionType,
          `Expected one of [${expectedActions.join(", ")}], got ${result.actionType} for ${fixture.fixture_id}`
        );
        expect(result).to.have.property("reasoning");
        expect(result.reasoning).to.be.an("array");
      });

      it("sets correct human review flags", async function () {
        const { decideNextAction } = require("../../trigger/steps/decide-next-action.ts");
        const classifyMock = mockAI("classify", fixture.fixture_id);

        const CLASSIFICATION_MAP = {
          fee_request: "FEE_QUOTE",
          question: "CLARIFICATION_REQUEST",
          more_info_needed: "CLARIFICATION_REQUEST",
          hostile: "HOSTILE",
          denial: "DENIAL",
          partial_denial: "PARTIAL_APPROVAL",
          portal_redirect: "PORTAL_REDIRECT",
          acknowledgment: "ACKNOWLEDGMENT",
          records_ready: "RECORDS_READY",
          delivery: "RECORDS_READY",
          partial_delivery: "PARTIAL_DELIVERY",
          wrong_agency: "WRONG_AGENCY",
          other: "UNKNOWN",
        };
        const classification = CLASSIFICATION_MAP[classifyMock.intent] || "UNKNOWN";

        const result = await decideNextAction(
          fixture.case_data.id,
          classification,
          classifyMock.constraints_to_add || [],
          classifyMock.fee_amount || null,
          classifyMock.sentiment || "neutral",
          "SUPERVISED",
          "INBOUND_MESSAGE",
          classifyMock.requires_response,
          classifyMock.portal_url || null,
          classifyMock.suggested_action || null,
          classifyMock.reason_no_response || null,
          classifyMock.denial_subtype || null,
          null, null, null,
          classifyMock.jurisdiction_level || null,
          classifyMock.key_points || []
        );

        // ALWAYS_GATE actions must require human
        const ALWAYS_GATE = ["CLOSE_CASE", "ESCALATE", "SEND_APPEAL", "SEND_FEE_WAIVER_REQUEST", "WITHDRAW"];
        if (ALWAYS_GATE.includes(result.actionType)) {
          expect(result.requiresHuman).to.equal(true);
        }

        // NONE actions should not require human
        if (result.actionType === "NONE") {
          expect(result.requiresHuman).to.equal(false);
        }

        // RESEARCH_AGENCY should auto-execute
        if (result.actionType === "RESEARCH_AGENCY") {
          expect(result.requiresHuman).to.equal(false);
        }
      });
    });
  });
});

// ============================================================
// SAFETY CHECK TESTS
// ============================================================

describe("Pipeline E2E: Safety Check Step", function () {
  this.timeout(15000);

  // Test fixtures that should produce drafts
  const DRAFT_FIXTURES = [
    "more_info_needed",
    "direct_question",
    "fee_request_low",
    "fee_request_high",
    "denial_weak",
    "sensitive_minors",
  ];

  DRAFT_FIXTURES.forEach((fixtureId) => {
    describe(`fixture: ${fixtureId}`, function () {
      let mocks;

      beforeEach(function () {
        mocks = installMocks(fixtureId);
      });

      afterEach(function () {
        mocks.restore();
      });

      it("passes safety check on clean draft", async function () {
        const { safetyCheck } = require("../../trigger/steps/safety-check.ts");
        const draftMock = mockAI("draft", fixtureId) || mockAI("draft", "_default");

        const result = await safetyCheck(
          draftMock.body_text,
          draftMock.subject,
          "SEND_CLARIFICATION",
          [], // constraints
          [], // scopeItems
          "local", // jurisdictionLevel
          getFixture(fixtureId).case_data.state
        );

        expect(result).to.have.property("canAutoExecute");
        expect(result).to.have.property("requiresHuman");
        expect(result).to.have.property("riskFlags");
        expect(result).to.have.property("warnings");
        expect(result.riskFlags).to.be.an("array");
        expect(result.warnings).to.be.an("array");
      });

      it("catches forbidden terms in draft", async function () {
        const { safetyCheck } = require("../../trigger/steps/safety-check.ts");

        // Draft with SSN — should flag
        const result = await safetyCheck(
          "Please send records to John Doe, SSN 123-45-6789.",
          "RE: Request",
          "SEND_CLARIFICATION",
          [],
          [],
          "local",
          "CA"
        );

        expect(result.riskFlags).to.include("CONTAINS_PII");
        expect(result.canAutoExecute).to.equal(false);
        expect(result.requiresHuman).to.equal(true);
      });

      it("does not flag ordinary phone or mailing-address text as highly sensitive PII", async function () {
        const { safetyCheck } = require("../../trigger/steps/safety-check.ts");

        const result = await safetyCheck(
          "Please mail the CD to 3021 21st Ave W, Apt 202, Seattle, WA 98199 or call me at 206-555-1234 if needed.",
          "RE: Request",
          "SEND_CLARIFICATION",
          [],
          [],
          "local",
          "WA"
        );

        expect(result.riskFlags).to.not.include("CONTAINS_PII");
      });

      it("catches BWC exempt constraint contradiction", async function () {
        const { safetyCheck } = require("../../trigger/steps/safety-check.ts");

        const result = await safetyCheck(
          "We request body camera footage from the incident.",
          "RE: Request",
          "SEND_FOLLOWUP",
          ["BWC_EXEMPT"],
          [],
          "local",
          "TX"
        );

        expect(result.riskFlags).to.include("REQUESTS_EXEMPT_ITEM");
        expect(result.canAutoExecute).to.equal(false);
      });

      it("catches fee acceptance contradiction", async function () {
        const { safetyCheck } = require("../../trigger/steps/safety-check.ts");

        const result = await safetyCheck(
          "We would like to negotiate the fee and request a reduction.",
          "RE: Fee Discussion",
          "NEGOTIATE_FEE",
          ["FEE_ACCEPTED"],
          [],
          "local",
          "NY"
        );

        expect(result.riskFlags).to.include("CONTRADICTS_FEE_ACCEPTANCE");
        expect(result.canAutoExecute).to.equal(false);
      });
    });
  });

  it("returns safe result for null draft", async function () {
    const mocks = installMocks("acknowledgment");
    try {
      const { safetyCheck } = require("../../trigger/steps/safety-check.ts");

      const result = await safetyCheck(
        null, null,
        "NONE",
        [], [],
        "local", "IL"
      );

      expect(result.canAutoExecute).to.equal(true);
      expect(result.requiresHuman).to.equal(false);
    } finally {
      mocks.restore();
    }
  });
});

// ============================================================
// GATE / PROPOSAL CREATION TESTS
// ============================================================

describe("Pipeline E2E: Gate Step", function () {
  this.timeout(15000);

  it("creates proposal with PENDING_APPROVAL for human-required actions", async function () {
    const mocks = installMocks("denial_weak");
    try {
      const { createProposalAndGate } = require("../../trigger/steps/gate-or-execute.ts");
      const draftMock = mockAI("draft", "denial_weak") || mockAI("draft", "_default");

      const result = await createProposalAndGate(
        1011, // caseId
        1,    // runId
        "SEND_REBUTTAL",
        9011, // messageId
        { subject: draftMock.subject, bodyText: draftMock.body_text, bodyHtml: null },
        { riskFlags: [], warnings: [], canAutoExecute: true, requiresHuman: false, pauseReason: null },
        false, // decisionCanAutoExecute
        true,  // decisionRequiresHuman
        "DENIAL",
        ["Weak denial", "Challenging"],
        0.90,
        0,    // adjustmentCount
        null, // caseAgencyId
        null  // lessonsApplied
      );

      expect(result).to.have.property("proposalId");
      expect(result).to.have.property("shouldWait");

      // Verify upsertProposal was called
      expect(mocks.dbStub.upsertProposal.calledOnce).to.equal(true);
      const proposalArgs = mocks.dbStub.upsertProposal.firstCall.args[0];
      expect(proposalArgs.actionType).to.equal("SEND_REBUTTAL");
      expect(proposalArgs.status).to.equal("PENDING_APPROVAL");
      expect(proposalArgs.requiresHuman).to.equal(true);
      expect(proposalArgs.draftBodyText).to.be.a("string");
      expect(proposalArgs.draftBodyText.length).to.be.greaterThan(0);
    } finally {
      mocks.restore();
    }
  });

  it("creates proposal with APPROVED status for auto-executable actions", async function () {
    const mocks = installMocks("fee_request_low");
    try {
      const { createProposalAndGate } = require("../../trigger/steps/gate-or-execute.ts");
      const draftMock = mockAI("draft", "fee_request_low") || mockAI("draft", "_default");

      const result = await createProposalAndGate(
        1009,
        1,
        "ACCEPT_FEE",
        9009,
        { subject: draftMock.subject, bodyText: draftMock.body_text, bodyHtml: null },
        { riskFlags: [], warnings: [], canAutoExecute: true, requiresHuman: false, pauseReason: null },
        true,  // decisionCanAutoExecute
        false, // decisionRequiresHuman
        null,
        ["Fee under threshold, auto-approving"],
        0.97,
        0, null, null
      );

      expect(result.proposalId).to.be.greaterThan(0);
      const proposalArgs = mocks.dbStub.upsertProposal.firstCall.args[0];
      expect(proposalArgs.status).to.equal("APPROVED");
      expect(proposalArgs.canAutoExecute).to.equal(true);
    } finally {
      mocks.restore();
    }
  });

  it("skips proposal creation for NONE actions", async function () {
    const mocks = installMocks("acknowledgment");
    try {
      const { createProposalAndGate } = require("../../trigger/steps/gate-or-execute.ts");

      const result = await createProposalAndGate(
        1003, 1, "NONE", null,
        { subject: null, bodyText: null, bodyHtml: null },
        { riskFlags: [], warnings: [], canAutoExecute: true, requiresHuman: false, pauseReason: null },
        true, false, null,
        ["Acknowledgment, no action needed"],
        0.98, 0, null, null
      );

      expect(result.proposalId).to.equal(0);
      expect(result.shouldWait).to.equal(false);
      expect(mocks.dbStub.upsertProposal.called).to.equal(false);
    } finally {
      mocks.restore();
    }
  });

  it("generates fallback draft when draft content is missing for reviewable action", async function () {
    const mocks = installMocks("more_info_needed");
    try {
      const { createProposalAndGate } = require("../../trigger/steps/gate-or-execute.ts");

      const result = await createProposalAndGate(
        1007, 1, "SEND_CLARIFICATION", 9007,
        { subject: null, bodyText: null, bodyHtml: null }, // Missing draft!
        { riskFlags: [], warnings: [], canAutoExecute: true, requiresHuman: false, pauseReason: null },
        true, false, null,
        ["Clarification needed"],
        0.95, 0, null, null
      );

      // Should force PENDING_APPROVAL since fallback draft was generated
      const proposalArgs = mocks.dbStub.upsertProposal.firstCall.args[0];
      expect(proposalArgs.status).to.equal("PENDING_APPROVAL");
      expect(proposalArgs.requiresHuman).to.equal(true);
      expect(proposalArgs.draftBodyText).to.be.a("string");
      expect(proposalArgs.draftBodyText).to.include("fallback");
    } finally {
      mocks.restore();
    }
  });

  it("forces auto-execute for RESEARCH_AGENCY regardless of decision flags", async function () {
    const mocks = installMocks("wrong_agency");
    try {
      const { createProposalAndGate } = require("../../trigger/steps/gate-or-execute.ts");

      const result = await createProposalAndGate(
        1013, 1, "RESEARCH_AGENCY", 9013,
        { subject: null, bodyText: null, bodyHtml: null },
        { riskFlags: [], warnings: [], canAutoExecute: false, requiresHuman: true, pauseReason: "DENIAL" },
        false, true, "DENIAL",
        ["Wrong agency, researching correct custodian"],
        0.95, 0, null, null
      );

      const proposalArgs = mocks.dbStub.upsertProposal.firstCall.args[0];
      expect(proposalArgs.canAutoExecute).to.equal(true);
      expect(proposalArgs.requiresHuman).to.equal(false);
      expect(proposalArgs.status).to.equal("APPROVED");
    } finally {
      mocks.restore();
    }
  });
});

// ============================================================
// DRAFT RESPONSE TESTS
// ============================================================

describe("Pipeline E2E: Draft Response Step", function () {
  this.timeout(15000);

  const DRAFT_TEST_CASES = [
    { fixtureId: "more_info_needed", actionType: "SEND_CLARIFICATION" },
    { fixtureId: "direct_question", actionType: "SEND_CLARIFICATION" },
    { fixtureId: "fee_request_low", actionType: "ACCEPT_FEE" },
    { fixtureId: "fee_request_high", actionType: "NEGOTIATE_FEE" },
    { fixtureId: "denial_weak", actionType: "SEND_REBUTTAL" },
    { fixtureId: "sensitive_minors", actionType: "SEND_CLARIFICATION" },
  ];

  DRAFT_TEST_CASES.forEach(({ fixtureId, actionType }) => {
    describe(`fixture: ${fixtureId} (${actionType})`, function () {
      let mocks;

      beforeEach(function () {
        mocks = installMocks(fixtureId);
      });

      afterEach(function () {
        mocks.restore();
      });

      it("produces a draft with subject and body", async function () {
        const { draftResponse } = require("../../trigger/steps/draft-response.ts");
        const fixture = getFixture(fixtureId);
        const classifyMock = mockAI("classify", fixtureId);

        const result = await draftResponse(
          fixture.case_data.id,
          actionType,
          classifyMock.constraints_to_add || [],
          [], // scopeItems
          classifyMock.fee_amount || null,
          null, // adjustmentInstruction
          mocks.message?.id || null
        );

        expect(result).to.have.property("subject");
        expect(result).to.have.property("bodyText");
        // aiService mock returns the canned draft, so these should be non-null
        if (result.subject) {
          expect(result.subject).to.be.a("string");
          expect(result.subject.length).to.be.greaterThan(0);
        }
        if (result.bodyText) {
          expect(result.bodyText).to.be.a("string");
          expect(result.bodyText.length).to.be.greaterThan(10);
        }
      });

      it("draft does not contain forbidden aggressive terms (non-rebuttal)", async function () {
        if (actionType === "SEND_REBUTTAL" || actionType === "SEND_APPEAL") {
          this.skip(); // Rebuttals may contain firm language
        }

        const { draftResponse } = require("../../trigger/steps/draft-response.ts");
        const fixture = getFixture(fixtureId);
        const classifyMock = mockAI("classify", fixtureId);

        const result = await draftResponse(
          fixture.case_data.id,
          actionType,
          classifyMock.constraints_to_add || [],
          [],
          classifyMock.fee_amount || null,
          null,
          mocks.message?.id || null
        );

        const bodyLower = (result.bodyText || "").toLowerCase();
        const forbidden = ["lawsuit", "sue", "attorney"];
        for (const term of forbidden) {
          expect(bodyLower).to.not.include(
            term,
            `Draft should not contain "${term}" for action ${actionType}`
          );
        }
      });
    });
  });
});

// ============================================================
// FULL PIPELINE INTEGRATION TESTS
// ============================================================

describe("Pipeline E2E: Full Pipeline (classify -> decide)", function () {
  this.timeout(20000);

  // Test the no-response category fixtures
  const NO_RESPONSE_FIXTURES = [
    "acknowledgment",
    "records_ready_link",
    "delivery_attached",
    "partial_delivery_more_coming",
  ];

  NO_RESPONSE_FIXTURES.forEach((fixtureId) => {
    it(`${fixtureId}: classify + decide produces no-action`, async function () {
      const mocks = installMocks(fixtureId);
      try {
        const { classifyInbound } = require("../../trigger/steps/classify-inbound.ts");
        const fixture = getFixture(fixtureId);

        const context = {
          caseId: fixture.case_data.id,
          caseData: mocks.caseData,
          messages: mocks.message ? [mocks.message] : [],
          attachments: [],
          analysis: null,
          followups: null,
          existingProposal: null,
          autopilotMode: "SUPERVISED",
          constraints: [],
          scopeItems: [],
        };

        const classResult = await classifyInbound(context, mocks.message.id, "INBOUND_MESSAGE");

        // No-response fixtures should not require response
        expect(classResult.requiresResponse).to.equal(false);

        // Now clear step caches and reload for decision step
        delete require.cache[require.resolve("../../trigger/steps/decide-next-action.ts")];
        const { decideNextAction } = require("../../trigger/steps/decide-next-action.ts");

        const decisionResult = await decideNextAction(
          fixture.case_data.id,
          classResult.classification,
          [],
          classResult.extractedFeeAmount,
          classResult.sentiment,
          "SUPERVISED",
          "INBOUND_MESSAGE",
          classResult.requiresResponse,
          classResult.portalUrl,
          classResult.suggestedAction,
          classResult.reasonNoResponse,
          classResult.denialSubtype,
          null, null, null,
          classResult.jurisdiction_level || null,
          classResult.keyPoints || []
        );

        // Should be NONE or a non-email action
        expect(["NONE", "CLOSE_CASE", "RESEARCH_AGENCY"]).to.include(
          decisionResult.actionType,
          `${fixtureId}: expected no-action, got ${decisionResult.actionType}`
        );
      } finally {
        mocks.restore();
      }
    });
  });

  // Test portal redirect fixtures
  const PORTAL_FIXTURES = ["portal_redirect_simple", "multi_portal_plus_fee", "multi_portal_plus_denial_language"];

  PORTAL_FIXTURES.forEach((fixtureId) => {
    it(`${fixtureId}: classify + decide routes to portal/no-action`, async function () {
      const mocks = installMocks(fixtureId);
      try {
        const { classifyInbound } = require("../../trigger/steps/classify-inbound.ts");
        const fixture = getFixture(fixtureId);

        const context = {
          caseId: fixture.case_data.id,
          caseData: mocks.caseData,
          messages: mocks.message ? [mocks.message] : [],
          attachments: [],
          analysis: null,
          followups: null,
          existingProposal: null,
          autopilotMode: "SUPERVISED",
          constraints: [],
          scopeItems: [],
        };

        const classResult = await classifyInbound(context, mocks.message.id, "INBOUND_MESSAGE");
        expect(classResult.classification).to.equal("PORTAL_REDIRECT");

        delete require.cache[require.resolve("../../trigger/steps/decide-next-action.ts")];
        const { decideNextAction } = require("../../trigger/steps/decide-next-action.ts");

        const decisionResult = await decideNextAction(
          fixture.case_data.id,
          classResult.classification,
          [],
          classResult.extractedFeeAmount,
          classResult.sentiment,
          "SUPERVISED",
          "INBOUND_MESSAGE",
          classResult.requiresResponse,
          classResult.portalUrl,
          classResult.suggestedAction,
          classResult.reasonNoResponse,
          classResult.denialSubtype,
          null, null, null,
          classResult.jurisdiction_level || null,
          classResult.keyPoints || []
        );

        // Portal redirects should create portal task and return NONE
        expect(["NONE", "SUBMIT_PORTAL", "RESEARCH_AGENCY"]).to.include(
          decisionResult.actionType,
          `${fixtureId}: expected portal routing, got ${decisionResult.actionType}`
        );
      } finally {
        mocks.restore();
      }
    });
  });

  // Test response-required fixtures end-to-end
  const RESPOND_FIXTURES = [
    { id: "more_info_needed", expectedActions: ["SEND_CLARIFICATION"] },
    { id: "fee_request_low", expectedActions: ["ACCEPT_FEE"] },
  ];

  RESPOND_FIXTURES.forEach(({ id, expectedActions }) => {
    it(`${id}: full pipeline produces correct proposal`, async function () {
      const mocks = installMocks(id);
      try {
        // 1. Classify
        const { classifyInbound } = require("../../trigger/steps/classify-inbound.ts");
        const fixture = getFixture(id);

        const context = {
          caseId: fixture.case_data.id,
          caseData: mocks.caseData,
          messages: mocks.message ? [mocks.message] : [],
          attachments: [],
          analysis: null,
          followups: null,
          existingProposal: null,
          autopilotMode: "SUPERVISED",
          constraints: [],
          scopeItems: [],
        };

        const classResult = await classifyInbound(context, mocks.message.id, "INBOUND_MESSAGE");
        expect(classResult.requiresResponse).to.equal(true);

        // 2. Decide
        delete require.cache[require.resolve("../../trigger/steps/decide-next-action.ts")];
        const { decideNextAction } = require("../../trigger/steps/decide-next-action.ts");

        const decisionResult = await decideNextAction(
          fixture.case_data.id,
          classResult.classification,
          [],
          classResult.extractedFeeAmount,
          classResult.sentiment,
          "SUPERVISED",
          "INBOUND_MESSAGE",
          classResult.requiresResponse,
          classResult.portalUrl,
          classResult.suggestedAction,
          classResult.reasonNoResponse,
          classResult.denialSubtype,
          null, null, null,
          classResult.jurisdiction_level || null,
          classResult.keyPoints || []
        );

        expect(expectedActions).to.include(
          decisionResult.actionType,
          `${id}: expected [${expectedActions}], got ${decisionResult.actionType}`
        );

        // 3. Safety check
        delete require.cache[require.resolve("../../trigger/steps/safety-check.ts")];
        const { safetyCheck } = require("../../trigger/steps/safety-check.ts");
        const draftMock = mockAI("draft", id) || mockAI("draft", "_default");

        const safetyResult = await safetyCheck(
          draftMock.body_text,
          draftMock.subject,
          decisionResult.actionType,
          [],
          [],
          classResult.jurisdiction_level || "local",
          fixture.case_data.state
        );

        // Clean draft should pass
        expect(safetyResult.riskFlags.filter((f) => f !== "NO_DRAFT")).to.have.length(0);

        // 4. Gate
        delete require.cache[require.resolve("../../trigger/steps/gate-or-execute.ts")];
        const { createProposalAndGate } = require("../../trigger/steps/gate-or-execute.ts");

        const gateResult = await createProposalAndGate(
          fixture.case_data.id,
          1, // runId
          decisionResult.actionType,
          mocks.message?.id || null,
          { subject: draftMock.subject, bodyText: draftMock.body_text, bodyHtml: null },
          safetyResult,
          decisionResult.canAutoExecute,
          decisionResult.requiresHuman,
          decisionResult.pauseReason,
          decisionResult.reasoning,
          0.95,
          0, null, null
        );

        expect(gateResult.proposalId).to.be.greaterThan(0);

        // Verify proposal was created with correct action type
        const proposalArgs = mocks.dbStub.upsertProposal.firstCall.args[0];
        expect(proposalArgs.actionType).to.equal(decisionResult.actionType);
        expect(proposalArgs.draftBodyText).to.be.a("string");
        expect(proposalArgs.draftBodyText.length).to.be.greaterThan(0);
      } finally {
        mocks.restore();
      }
    });
  });
});

// ============================================================
// CLASSIFICATION MAP UNIT TESTS
// ============================================================

describe("Pipeline E2E: CLASSIFICATION_MAP completeness", function () {
  it("maps all known intents to classifications", function () {
    const mocks = installMocks("acknowledgment");
    try {
      const { CLASSIFICATION_MAP } = require("../../trigger/steps/classify-inbound.ts");

      const knownIntents = [
        "fee_request", "question", "more_info_needed", "hostile", "denial",
        "partial_denial", "partial_approval", "partial_release",
        "portal_redirect", "acknowledgment", "records_ready", "delivery",
        "partial_delivery", "wrong_agency", "other",
      ];

      for (const intent of knownIntents) {
        expect(CLASSIFICATION_MAP).to.have.property(intent);
        expect(CLASSIFICATION_MAP[intent]).to.be.a("string");
      }
    } finally {
      mocks.restore();
    }
  });
});

// ============================================================
// EDGE CASE TESTS
// ============================================================

describe("Pipeline E2E: Edge Cases", function () {
  this.timeout(15000);

  it("handles hostile classification routing to ESCALATE", async function () {
    const mocks = installMocks("hostile");
    try {
      const { decideNextAction } = require("../../trigger/steps/decide-next-action.ts");

      // Use HOSTILE classification (from the CLASSIFICATION_MAP for hostile intent)
      // But our mock returns "denial" intent, which maps to DENIAL classification
      // The hostile fixture has sentiment=hostile but intent=denial per the mock
      // The CLASSIFICATION_MAP for "hostile" intent would give HOSTILE
      // Let's test with the actual hostile classification path
      const result = await decideNextAction(
        1015,
        "HOSTILE",
        [],
        null,
        "hostile",
        "SUPERVISED",
        "INBOUND_MESSAGE",
        true,
        null,
        "send_rebuttal",
        null,
        null,
        null, null, null,
        "local",
        ["Hostile response from agency"]
      );

      expect(result.actionType).to.equal("ESCALATE");
      expect(result.requiresHuman).to.equal(true);
    } finally {
      mocks.restore();
    }
  });

  it("handles wrong_agency classification routing to RESEARCH_AGENCY", async function () {
    const mocks = installMocks("wrong_agency");
    try {
      const { decideNextAction } = require("../../trigger/steps/decide-next-action.ts");

      const result = await decideNextAction(
        1013,
        "WRONG_AGENCY",
        ["WRONG_AGENCY"],
        null,
        "neutral",
        "SUPERVISED",
        "INBOUND_MESSAGE",
        false,
        null,
        "find_correct_agency",
        null,
        "wrong_agency",
        null, null, null,
        "local",
        ["Wrong jurisdiction", "Dallas County Sheriff handles these records"]
      );

      expect(["RESEARCH_AGENCY", "ESCALATE"]).to.include(result.actionType);
    } finally {
      mocks.restore();
    }
  });

  it("safety check detects federal FOIA citation for local agency", async function () {
    const mocks = installMocks("denial_weak");
    try {
      const { safetyCheck } = require("../../trigger/steps/safety-check.ts");

      const result = await safetyCheck(
        "Pursuant to 5 U.S.C. § 552, we hereby request all records...",
        "RE: FOIA Request",
        "SEND_REBUTTAL",
        [],
        [],
        "local", // local agency
        "GA"
      );

      expect(result.riskFlags).to.include("LAW_JURISDICTION_MISMATCH");
    } finally {
      mocks.restore();
    }
  });

  it("safety check detects scope narrowing contradiction", async function () {
    const mocks = installMocks("more_info_needed");
    try {
      const { safetyCheck } = require("../../trigger/steps/safety-check.ts");

      const result = await safetyCheck(
        "We request all records related to this case including additional records from other departments.",
        "RE: Records Request",
        "SEND_FOLLOWUP",
        ["SCOPE_NARROWED"],
        [],
        "local",
        "CA"
      );

      expect(result.riskFlags).to.include("CONTRADICTS_SCOPE_NARROWING");
    } finally {
      mocks.restore();
    }
  });
});
