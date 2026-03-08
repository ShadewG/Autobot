/**
 * Pipeline E2E Test Helpers
 *
 * Shared utilities for mocking AI, DB, and executors in pipeline tests.
 * These tests exercise the real Trigger.dev step functions with mocked dependencies.
 */

const path = require("path");
const sinon = require("sinon");
const fs = require("fs");

// Set AI_ROUTER_V2=true to use the production v2 path in tests
process.env.AI_ROUTER_V2 = "true";
// Suppress env-dependent warnings
process.env.FEE_AUTO_APPROVE_MAX = process.env.FEE_AUTO_APPROVE_MAX || "100";
process.env.FEE_NEGOTIATE_THRESHOLD = process.env.FEE_NEGOTIATE_THRESHOLD || "500";
process.env.MAX_FOLLOWUPS = process.env.MAX_FOLLOWUPS || "2";

// Load mock AI responses
const mockResponsesPath = path.join(__dirname, "../fixtures/mock-ai-responses.json");
const mockResponses = JSON.parse(fs.readFileSync(mockResponsesPath, "utf-8"));

// Load golden fixtures
const goldenFixturesPath = path.join(__dirname, "../fixtures/inbound/golden-fixtures.json");
const goldenFixtures = JSON.parse(fs.readFileSync(goldenFixturesPath, "utf-8"));

/**
 * Get mock AI response for a given step and fixture ID.
 * Falls back to _default if no fixture-specific mock exists.
 */
function mockAI(stepName, fixtureId) {
  const stepMocks = mockResponses[stepName];
  if (!stepMocks) throw new Error(`No mock responses for step: ${stepName}`);
  return stepMocks[fixtureId] || stepMocks._default || null;
}

/**
 * Get a golden fixture by ID.
 */
function getFixture(fixtureId) {
  const fixture = goldenFixtures.fixtures.find((f) => f.fixture_id === fixtureId);
  if (!fixture) throw new Error(`Golden fixture not found: ${fixtureId}`);
  return fixture;
}

/**
 * Get all golden fixtures (excluding followup-only fixtures that have no message).
 */
function getInboundFixtures() {
  return goldenFixtures.fixtures.filter((f) => f.message !== null);
}

/**
 * Get all fixture IDs.
 */
function getAllFixtureIds() {
  return goldenFixtures.fixtures.map((f) => f.fixture_id);
}

/**
 * Build a minimal DB stub that satisfies the pipeline step calls.
 * Returns stub object and a cleanup function.
 */
function createDbStub(fixture) {
  const caseData = {
    id: fixture.case_data.id,
    case_name: fixture.case_data.case_name,
    subject_name: fixture.case_data.subject_name,
    agency_name: fixture.case_data.agency_name,
    agency_email: `records@${(fixture.case_data.agency_name || "unknown").toLowerCase().replace(/\s+/g, "")}.gov`,
    state: fixture.case_data.state,
    status: "awaiting_response",
    substatus: null,
    incident_date: fixture.case_data.incident_date || null,
    incident_location: fixture.case_data.incident_location || null,
    requested_records: ["Incident report", "Body camera footage", "911 audio"],
    constraints_jsonb: [],
    constraints: [],
    scope_items_jsonb: [],
    scope_items: [],
    fee_amount: null,
    fee_quote_jsonb: null,
    portal_url: null,
    portal_provider: null,
    last_portal_status: null,
    research_context_jsonb: null,
    contact_research_notes: null,
    additional_details: null,
    send_date: fixture.case_data.send_date || "2026-01-13",
    deadline_date: null,
    days_overdue: 0,
    outcome_type: null,
    outcome_recorded: false,
    followup_count: fixture.case_data.followup_count || 0,
  };

  const message = fixture.message
    ? {
        id: 9000 + fixture.case_data.id,
        message_id: fixture.message.message_id,
        case_id: fixture.case_data.id,
        from_email: fixture.message.from_email,
        to_email: fixture.message.to_email,
        subject: fixture.message.subject,
        body_text: fixture.message.body_text,
        body_html: null,
        direction: "inbound",
        received_at: fixture.message.received_at,
        sent_at: null,
        created_at: fixture.message.received_at,
        portal_notification: false,
        portal_notification_provider: null,
      }
    : null;

  const stub = {
    getCaseById: sinon.stub().resolves(caseData),
    getMessageById: sinon.stub().resolves(message),
    getMessagesByCaseId: sinon.stub().resolves(message ? [message] : []),
    getLatestInboundMessage: sinon.stub().resolves(message),
    getLatestResponseAnalysis: sinon.stub().resolves(null),
    getResponseAnalysisByMessageId: sinon.stub().resolves(null),
    getFollowUpScheduleByCaseId: sinon.stub().resolves({ followup_count: fixture.case_data.followup_count || 0 }),
    getActiveRunForCase: sinon.stub().resolves(null),
    getCaseAgencies: sinon.stub().resolves([]),
    getAgencyIntelligence: sinon.stub().resolves(null),
    getAllProposalsByCaseId: sinon.stub().resolves([]),
    saveResponseAnalysis: sinon.stub().resolves(),
    updateCase: sinon.stub().resolves(),
    updateCasePortalStatus: sinon.stub().resolves(),
    logFeeEvent: sinon.stub().resolves(),
    logActivity: sinon.stub().resolves(),
    upsertProposal: sinon.stub().callsFake(async (params) => ({
      id: 1,
      proposal_key: params.proposalKey,
      case_id: params.caseId,
      run_id: params.runId,
      action_type: params.actionType,
      status: params.status || "PENDING_APPROVAL",
      draft_subject: params.draftSubject,
      draft_body_text: params.draftBodyText,
      draft_body_html: params.draftBodyHtml,
      reasoning: params.reasoning,
      can_auto_execute: params.canAutoExecute,
      requires_human: params.requiresHuman,
      waitpoint_token: null,
      version: 1,
      execution_key: null,
      action_chain: null,
      chain_id: null,
      chain_step: null,
    })),
    updateProposal: sinon.stub().resolves(),
    query: sinon.stub().callsFake(async (sql) => {
      // Handle common queries
      if (String(sql).includes("action_type = 'RESEARCH_AGENCY'")) {
        return { rows: [{ cnt: 0 }] };
      }
      if (String(sql).includes("proposals")) {
        return { rows: [] };
      }
      if (String(sql).includes("activity_log")) {
        return { rows: [] };
      }
      if (String(sql).includes("phone_call_queue")) {
        return { rows: [] };
      }
      if (String(sql).includes("response_analysis")) {
        return { rows: [] };
      }
      if (String(sql).includes("messages")) {
        return { rows: message ? [{ body_text: message.body_text }] : [] };
      }
      return { rows: [] };
    }),
    // case-runtime methods
    transitionCaseRuntime: sinon.stub().resolves(),
  };

  return { stub, caseData, message };
}

/**
 * Create executor stubs (email + portal) to prevent real sends.
 */
function createExecutorStubs() {
  return {
    emailExecutor: {
      sendEmail: sinon.stub().resolves({ id: "mock-email-job-1", success: true }),
    },
    portalExecutor: {
      submitPortal: sinon.stub().resolves({ id: "mock-portal-task-1", success: true }),
    },
    createPortalTask: sinon.stub().resolves({ id: 1 }),
    generateExecutionKey: sinon.stub().returns("exec-key-mock"),
    createExecutionRecord: sinon.stub().resolves({ id: 1 }),
  };
}

/**
 * Install mocks into the Node require cache for a test run.
 *
 * This replaces the `ai` module (Vercel AI SDK), `services/database.js`,
 * `services/executor-adapter.js`, and other dependencies with stubs.
 *
 * Returns a restore function that MUST be called in afterEach.
 */
function installMocks(fixtureId, opts = {}) {
  const fixture = getFixture(fixtureId);
  const { stub: dbStub, caseData, message } = createDbStub(fixture);
  const executorStubs = createExecutorStubs();

  // Store original cache entries
  const originalCache = {};
  const pathsToMock = [];

  // Helper to cache-replace a module
  function replaceModule(modulePath, exports) {
    const resolved = typeof modulePath === "string" && modulePath.startsWith("/")
      ? modulePath
      : require.resolve(modulePath);
    originalCache[resolved] = require.cache[resolved];
    require.cache[resolved] = {
      id: resolved,
      filename: resolved,
      loaded: true,
      exports,
    };
    pathsToMock.push(resolved);
  }

  // 1. Mock the `ai` module (Vercel AI SDK)
  const classifyResponse = mockAI("classify", fixtureId);
  const decideResponse = mockAI("decide", fixtureId);
  const safetyResponse = mockAI("safety", fixtureId) || mockAI("safety", "_default");

  let generateObjectCallCount = 0;
  const generateObjectStub = sinon.stub().callsFake(async ({ schema, prompt }) => {
    generateObjectCallCount++;
    const promptLower = (prompt || "").toLowerCase();

    // Detect which step is calling based on unique prompt markers.
    // Order matters — check from most-specific to least-specific.
    // The safety prompt starts with "Review this outbound draft for safety".
    // The decision prompt starts with "You are the decision engine" and contains "ALLOWED ACTIONS".
    // The classification prompt starts with "You are an expert FOIA analyst" and contains "Intent Definitions".
    // NOTE: The decision prompt contains "Classification:" (from classifier result) which is
    // a substring of "classify", and fixture body text may contain "safety" — so we use
    // specific multi-word markers to avoid false positives.
    if (promptLower.includes("review this outbound draft")) {
      return {
        object: safetyResponse,
        usage: { promptTokens: 300, completionTokens: 80 },
        response: { modelId: "gpt-5.2-mock" },
      };
    }
    if (promptLower.includes("decision engine") || promptLower.includes("allowed actions")) {
      return {
        object: decideResponse,
        usage: { promptTokens: 800, completionTokens: 150 },
        response: { modelId: "gpt-5.2-mock" },
      };
    }
    if (promptLower.includes("intent definitions") || promptLower.includes("analyst classifying")) {
      return {
        object: classifyResponse,
        usage: { promptTokens: 500, completionTokens: 100 },
        response: { modelId: "gpt-5.2-mock" },
      };
    }
    // Default fallback — classify
    return {
      object: classifyResponse,
      usage: { promptTokens: 100, completionTokens: 50 },
      response: { modelId: "gpt-5.2-mock" },
    };
  });

  replaceModule("ai", {
    generateObject: generateObjectStub,
    generateText: sinon.stub().resolves({ text: "Mock text" }),
  });

  // 2. Mock database
  const dbPath = path.resolve(__dirname, "../../services/database.js");
  replaceModule(dbPath, dbStub);

  // 3. Mock logger
  const loggerPath = path.resolve(__dirname, "../../services/logger.js");
  replaceModule(loggerPath, {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  });

  // 4. Mock executor-adapter
  const executorPath = path.resolve(__dirname, "../../services/executor-adapter.js");
  replaceModule(executorPath, executorStubs);

  // 5. Mock case-runtime
  const caseRuntimePath = path.resolve(__dirname, "../../services/case-runtime.js");
  replaceModule(caseRuntimePath, {
    transitionCaseRuntime: sinon.stub().resolves(),
  });

  // 6. Mock notion-service (non-blocking background call)
  const notionPath = path.resolve(__dirname, "../../services/notion-service.js");
  replaceModule(notionPath, {
    addAISummaryToNotion: sinon.stub().resolves(),
    updateNotionStatus: sinon.stub().resolves(),
  });

  // 7. Mock discord-service (non-blocking background call)
  const discordPath = path.resolve(__dirname, "../../services/discord-service.js");
  replaceModule(discordPath, {
    notifyResponseReceived: sinon.stub().resolves(),
    sendNotification: sinon.stub().resolves(),
  });

  // 8. Mock decision-memory-service
  const decisionMemoryPath = path.resolve(__dirname, "../../services/decision-memory-service.js");
  replaceModule(decisionMemoryPath, {
    getRelevantLessons: sinon.stub().resolves([]),
    formatLessonsForPrompt: sinon.stub().returns(""),
  });

  // 9. Mock successful-examples-service
  const successExamplesPath = path.resolve(__dirname, "../../services/successful-examples-service.js");
  replaceModule(successExamplesPath, {
    getRelevantExamples: sinon.stub().resolves([]),
    formatExamplesForPrompt: sinon.stub().returns(""),
  });

  // 10. Mock ai-service
  const aiServicePath = path.resolve(__dirname, "../../services/ai-service.js");
  const draftResponse = mockAI("draft", fixtureId) || mockAI("draft", "_default");
  replaceModule(aiServicePath, {
    analyzeResponse: sinon.stub().resolves(classifyResponse),
    generateFollowUp: sinon.stub().resolves(draftResponse),
    generateDenialRebuttal: sinon.stub().resolves(draftResponse),
    generateClarificationResponse: sinon.stub().resolves(draftResponse),
    generateFeeResponse: sinon.stub().resolves(draftResponse),
    generateAutoReply: sinon.stub().resolves(draftResponse),
    generatePartialApprovalResponse: sinon.stub().resolves(draftResponse),
    generateAppealLetter: sinon.stub().resolves(draftResponse),
    generateStatusUpdate: sinon.stub().resolves(draftResponse),
    generateReformulatedRequest: sinon.stub().resolves(draftResponse),
    getUserSignatureForCase: sinon.stub().resolves("Best regards,\nFOIB Request Team"),
    normalizeGeneratedDraftSignature: sinon.stub().callsFake((text) => text),
  });

  // 11. Mock pd-contact-service
  const pdContactPath = path.resolve(__dirname, "../../services/pd-contact-service.js");
  replaceModule(pdContactPath, {
    findContact: sinon.stub().resolves(null),
  });

  // 12. Mock event-bus
  const eventBusPath = path.resolve(__dirname, "../../services/event-bus.js");
  replaceModule(eventBusPath, {
    notify: sinon.stub(),
    on: sinon.stub(),
    emit: sinon.stub(),
  });

  // 13. Mock pdf-form-service
  const pdfFormPath = path.resolve(__dirname, "../../services/pdf-form-service.js");
  replaceModule(pdfFormPath, {
    findLatestRequestFormAttachment: sinon.stub().resolves(null),
    prepareInboundPdfFormReply: sinon.stub().resolves(null),
  });

  // 14. Mock request-normalization utility
  const reqNormPath = path.resolve(__dirname, "../../utils/request-normalization.js");
  try {
    replaceModule(reqNormPath, {
      detectCaseMetadataAgencyMismatch: sinon.stub().returns(null),
    });
  } catch (e) {
    // File might not exist, that's OK — the TS step has a require() that may or may not resolve
  }

  // Clear cached step modules so they pick up fresh mocks
  const stepPaths = [
    path.resolve(__dirname, "../../trigger/steps/classify-inbound.ts"),
    path.resolve(__dirname, "../../trigger/steps/decide-next-action.ts"),
    path.resolve(__dirname, "../../trigger/steps/draft-response.ts"),
    path.resolve(__dirname, "../../trigger/steps/safety-check.ts"),
    path.resolve(__dirname, "../../trigger/steps/gate-or-execute.ts"),
    path.resolve(__dirname, "../../trigger/lib/db.ts"),
    path.resolve(__dirname, "../../trigger/lib/ai.ts"),
    path.resolve(__dirname, "../../trigger/lib/portal-utils.ts"),
  ];
  for (const sp of stepPaths) {
    delete require.cache[sp];
  }

  function restore() {
    // Restore original cache entries
    for (const p of pathsToMock) {
      if (originalCache[p]) {
        require.cache[p] = originalCache[p];
      } else {
        delete require.cache[p];
      }
    }
    // Clear step caches again
    for (const sp of stepPaths) {
      delete require.cache[sp];
    }
    sinon.restore();
  }

  return {
    fixture,
    dbStub,
    caseData,
    message,
    executorStubs,
    generateObjectStub,
    restore,
  };
}

/**
 * Map golden fixture expected intent to the Classification enum used by the pipeline.
 * Handles arrays (multiple acceptable intents) by returning the first mapped value.
 */
function expectedClassification(fixture) {
  const CLASSIFICATION_MAP = {
    fee_request: "FEE_QUOTE",
    question: "CLARIFICATION_REQUEST",
    more_info_needed: "CLARIFICATION_REQUEST",
    hostile: "HOSTILE",
    denial: "DENIAL",
    partial_denial: "PARTIAL_APPROVAL",
    partial_approval: "PARTIAL_APPROVAL",
    partial_release: "PARTIAL_APPROVAL",
    portal_redirect: "PORTAL_REDIRECT",
    acknowledgment: "ACKNOWLEDGMENT",
    records_ready: "RECORDS_READY",
    delivery: "RECORDS_READY",
    partial_delivery: "PARTIAL_DELIVERY",
    wrong_agency: "WRONG_AGENCY",
    other: "UNKNOWN",
  };

  const intent = fixture.expected.intent;
  if (Array.isArray(intent)) {
    return intent.map((i) => CLASSIFICATION_MAP[i] || "UNKNOWN");
  }
  return CLASSIFICATION_MAP[intent] || "UNKNOWN";
}

/**
 * Check if a classification result matches the expected (handles arrays).
 */
function classificationMatches(actual, expected) {
  if (Array.isArray(expected)) {
    return expected.includes(actual);
  }
  return actual === expected;
}

module.exports = {
  mockAI,
  getFixture,
  getInboundFixtures,
  getAllFixtureIds,
  createDbStub,
  createExecutorStubs,
  installMocks,
  expectedClassification,
  classificationMatches,
  mockResponses,
  goldenFixtures,
};
