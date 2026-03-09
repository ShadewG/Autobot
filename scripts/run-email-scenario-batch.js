#!/usr/bin/env node
require("dotenv").config();

const fs = require("fs");
const path = require("path");
const db = require("../services/database");

const API_BASE_URL = process.env.API_BASE_URL || "http://127.0.0.1:3035";
const SERVICE_KEY = process.env.FOIA_SERVICE_KEY || "";
const CONCURRENCY = Math.max(1, Number(process.env.EMAIL_SCENARIO_CONCURRENCY || "5"));
const SCENARIO_FILTER = String(process.env.EMAIL_SCENARIO_FILTER || "").trim().toLowerCase();
const LOCAL_CURRENT_CHECKOUT_REPLAY = process.env.EMAIL_SCENARIO_LOCAL_REPLAY === "1";
const POLL_INTERVAL_MS = 1000;
const POLL_TIMEOUT_MS = Math.max(1000, Number(process.env.EMAIL_SCENARIO_POLL_TIMEOUT_MS || "240000"));
const ACTIVE_RUN_STATUSES = new Set(["created", "queued", "running", "processing"]);

const GOLDEN_FIXTURES_PATH = path.join(__dirname, "../tests/fixtures/inbound/golden-fixtures.json");
const REAL_PATTERNS_PATH = path.join(__dirname, "../tests/fixtures/inbound/real-message-patterns.json");
const REPORTS_DIR = path.join(__dirname, "../tests/reports");

function detectPortalProvider(fromEmail = "", body = "", subject = "") {
  const corpus = `${fromEmail}\n${subject}\n${body}`.toLowerCase();
  if (corpus.includes("nextrequest")) return "nextrequest";
  if (corpus.includes("justfoia")) return "justfoia";
  if (corpus.includes("govqa") || corpus.includes("mycusthelp") || corpus.includes("records center")) return "govqa";
  if (corpus.includes("civicplus")) return "civicplus";
  return null;
}

function extractPortalUrl(text = "") {
  const match = String(text).match(/https?:\/\/[^\s"'<>]+/i);
  if (!match) return null;
  return match[0].replace(/[)\].,;!?]+$/g, "");
}

function fallbackPortalUrl(provider) {
  switch (String(provider || "").trim().toLowerCase()) {
    case "nextrequest":
      return "https://example.nextrequest.com/requests";
    case "justfoia":
      return "https://example.request.justfoia.com/";
    case "govqa":
      return "https://example.govqa.us/portal";
    case "civicplus":
      return "https://example.civicplus.help/portal";
    default:
      return null;
  }
}

function sanitizeSyntheticPortalUrl(url, provider) {
  const trimmed = String(url || "").trim();
  if (!trimmed) return fallbackPortalUrl(provider);

  const lower = trimmed.toLowerCase();
  if (
    trimmed.length > 950 ||
    lower.includes(".sendgrid.net/ls/click") ||
    lower.includes("ct.sendgrid.net/ls/click")
  ) {
    return fallbackPortalUrl(provider);
  }

  return trimmed;
}

function headers() {
  const result = { "Content-Type": "application/json" };
  if (SERVICE_KEY) {
    result["X-Service-Key"] = SERVICE_KEY;
  }
  return result;
}

async function apiRequest(method, endpoint, body = null) {
  const response = await fetch(`${API_BASE_URL}${endpoint}`, {
    method,
    headers: headers(),
    body: body ? JSON.stringify(body) : undefined,
  });

  const raw = await response.text();
  let parsed;
  try {
    parsed = raw ? JSON.parse(raw) : {};
  } catch {
    parsed = { raw };
  }

  if (!response.ok) {
    throw new Error(`${method} ${endpoint} failed (${response.status}): ${JSON.stringify(parsed)}`);
  }

  return parsed;
}

async function post(endpoint, body) {
  return apiRequest("POST", endpoint, body);
}

async function get(endpoint) {
  return apiRequest("GET", endpoint);
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function pollLatestRun(runId, caseId, timeoutMs = POLL_TIMEOUT_MS) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    let run = null;
    if (runId) {
      const result = await db.query(
        `SELECT id, case_id, status, error, started_at, ended_at
           FROM agent_runs
          WHERE id = $1
          LIMIT 1`,
        [runId]
      );
      run = result.rows[0] || null;
    }

    if (!run && caseId) {
      const result = await db.query(
        `SELECT id, case_id, status, error, started_at, ended_at
           FROM agent_runs
          WHERE case_id = $1
          ORDER BY id DESC
          LIMIT 1`,
        [caseId]
      );
      run = result.rows[0] || null;
    }

    if (run) {
      const status = String(run.status || "").trim().toLowerCase();
      if (!ACTIVE_RUN_STATUSES.has(status)) {
        return run;
      }
    }
    await sleep(POLL_INTERVAL_MS);
  }
  throw new Error(
    runId
      ? `Timed out waiting for run ${runId} on case ${caseId}`
      : `Timed out waiting for latest run on case ${caseId}`
  );
}

async function createCaseForScenario(label, scenario) {
  const name = `EMAIL_E2E ${label} ${Date.now()}`;
  const agencyEmail = `scenario+${label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}@matcher.com`;
  const originalContext = scenario.original_case_context || {};
  const requestedRecords =
    Array.isArray(originalContext.requested_records) && originalContext.requested_records.length > 0
      ? originalContext.requested_records
      : [
          scenario.request_summary ||
            scenario.requested_records ||
            "All body camera footage, dispatch audio, and incident reports related to the incident.",
        ];
  const payload = {
    case_name: name,
    subject_name: scenario.subject_name || originalContext.subject_name || "Scenario Subject",
    agency_name: scenario.agency_name || `Scenario Agency ${label}`,
    agency_email: agencyEmail,
    state: scenario.state || "TX",
    requested_records: requestedRecords,
    incident_date: scenario.incident_date || originalContext.incident_date || "2024-01-01",
    status: "draft",
  };
  const response = await post("/api/cases", payload);
  const createdCase = response.case || response;
  const inferredPortalProvider = detectPortalProvider(
    scenario.inbound?.from_email,
    scenario.inbound?.body_text,
    scenario.inbound?.subject
  );
  const inferredPortalUrl =
    sanitizeSyntheticPortalUrl(
      extractPortalUrl(`${scenario.inbound?.subject || ""}\n${scenario.inbound?.body_text || ""}`),
      inferredPortalProvider
    ) || fallbackPortalUrl(inferredPortalProvider);

  // Override notion_page_id to a non-UUID so Notion sync skips these test cases
  // (hasValidNotionPageId rejects anything not matching /^[0-9a-f]{32}$/i)
  const updates = { notion_page_id: `test-corpus-${createdCase.id}` };
  if (inferredPortalProvider || inferredPortalUrl) {
    updates.portal_provider = inferredPortalProvider;
    updates.portal_url = inferredPortalUrl;
  }
  if (originalContext.additional_details) {
    updates.additional_details = originalContext.additional_details;
  }
  if (originalContext.contact_research_notes) {
    updates.contact_research_notes = originalContext.contact_research_notes;
  }
  await db.updateCase(createdCase.id, updates);

  return createdCase;
}

async function createSyntheticOutbound(caseId, scenario, label) {
  return post(`/api/test/cases/${caseId}/simulate-outbound`, {
    type: "initial",
    subject: scenario.initial_subject || `Public Records Request - ${label}`,
    body:
      scenario.initial_body ||
      `Hello,\n\nThis is an automated records request test for ${label}. Please reply to this message with your agency response.\n\nThank you.`,
    to_email: scenario.initial_to_email || undefined,
  });
}

async function setupCaseForE2E(caseId, scenario, label) {
  const agencyEmail =
    scenario.inbound?.from_email ||
    `scenario+${label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}@matcher.com`;

  return post(`/api/test/cases/${caseId}/setup-for-e2e`, {
    agency_email: agencyEmail,
    run_initial: false,
    autopilot_mode: "SUPERVISED",
  });
}

async function getLatestMessage(caseId, direction) {
  const result = await db.query(
    `SELECT id, message_id, subject, from_email, to_email, body_text, created_at
       FROM messages
      WHERE case_id = $1
        AND direction = $2
      ORDER BY created_at DESC
      LIMIT 1`,
    [caseId, direction]
  );
  return result.rows[0] || null;
}

function normalizeFromEmail(raw) {
  if (!raw) return "records@fixture.test";
  if (raw.includes("@")) return raw;
  // Convert display names like "Lawrence County E-911" to valid emails
  return raw.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") + "@fixture.test";
}

function inferLocalReplayClassification(scenario) {
  const explicit = String(scenario.expected_intent || scenario.intent || "").trim().toUpperCase();
  if (explicit) return explicit;

  switch (String(scenario.pattern || "").trim().toLowerCase()) {
    case "portal_confirmation":
      return "ACKNOWLEDGMENT";
    case "portal_release":
      return "RECORDS_READY";
    case "portal_access_issue":
      return "PORTAL_REDIRECT";
    case "blank_request_form":
      return "CLARIFICATION_REQUEST";
    case "fee_letter":
      return "FEE_QUOTE";
    case "denial_letter":
      return "DENIAL";
    case "mixed_partial_release":
      return "PARTIAL_DELIVERY";
    case "wrong_agency_referral":
      return "WRONG_AGENCY";
    default:
      return null;
  }
}

function inferLocalReplayDenialSubtype(scenario) {
  const explicit = String(scenario.denial_subtype || "").trim().toLowerCase();
  if (explicit) return explicit;

  const corpus = [
    scenario.body_excerpt,
    scenario.inbound?.subject,
    scenario.inbound?.body_text,
  ]
    .filter(Boolean)
    .join("\n")
    .toLowerCase();

  if (/no responsive records|no records/.test(corpus)) return "no_records";
  if (/wrong agency|not the custodian|not our records|another agency|another division/.test(corpus)) return "wrong_agency";
  if (/exemption 7\(a\)|ongoing investigation|law enforcement investigation/.test(corpus)) return "ongoing_investigation";
  if (/privacy|confidential/.test(corpus)) return "privacy_exemption";
  if (/juvenile/.test(corpus)) return "juvenile_records";
  if (/sealed/.test(corpus)) return "sealed_court_order";
  if (/attorney[- ]client|work product|privilege/.test(corpus)) return "privilege_attorney_work_product";
  return null;
}

function buildLocalReplayStubs(scenario) {
  const classification = inferLocalReplayClassification(scenario);
  if (!classification) return null;

  return {
    current_checkout_replay: true,
    classify: {
      classification,
      sentiment: "neutral",
      key_points: [
        scenario.body_excerpt,
        scenario.inbound?.subject,
        scenario.inbound?.body_text,
      ].filter(Boolean),
      suggested_action: scenario.expected_action || scenario.suggested_action || null,
      denial_subtype: inferLocalReplayDenialSubtype(scenario),
      requires_action: scenario.requires_action !== false,
    },
  };
}

async function ingestInbound(caseId, inbound) {
  const payload = {
    from_email: normalizeFromEmail(inbound.from_email),
    subject: inbound.subject,
    body_text: inbound.body_text,
    source: inbound.source || "email_e2e_batch",
    trigger_run: false,
    attachments: Array.isArray(inbound.attachments) ? inbound.attachments : [],
  };
  return post(`/api/cases/${caseId}/ingest-email`, payload);
}

async function triggerInbound(caseId, messageId, scenario) {
  const payload = {
    messageId,
    autopilotMode: "SUPERVISED",
  };
  if (LOCAL_CURRENT_CHECKOUT_REPLAY) {
    payload.llmStubs = buildLocalReplayStubs(scenario) || { current_checkout_replay: true };
  }
  return post(`/api/cases/${caseId}/run-inbound`, payload);
}

async function getLatestProposal(caseId) {
  const response = await get(`/api/requests/${caseId}/proposals?all=true&limit=5`);
  const proposals = response.proposals || [];
  return proposals[0] || null;
}

async function getRecentProposals(caseId) {
  const result = await db.query(
    `SELECT id, case_id, action_type, status, created_at
       FROM proposals
      WHERE case_id = $1
      ORDER BY id DESC
      LIMIT 5`,
    [caseId]
  );
  return result.rows || [];
}

async function getLatestPortalTask(caseId) {
  const result = await db.query(
    `SELECT id, action_type, status, portal_url, created_at
       FROM portal_tasks
      WHERE case_id = $1
      ORDER BY created_at DESC
      LIMIT 1`,
    [caseId]
  );
  return result.rows[0] || null;
}

function loadGoldenScenarios() {
  const parsed = JSON.parse(fs.readFileSync(GOLDEN_FIXTURES_PATH, "utf8"));
  return parsed.fixtures
    .filter((fixture) => fixture.message)
    .map((fixture) => ({
      label: `golden:${fixture.fixture_id}`,
      source: "golden",
      expected_intent: fixture.expected?.intent || null,
      expected_action: fixture.expected?.action_type || null,
      agency_name: fixture.case_data?.agency_name || null,
      state: fixture.case_data?.state || null,
      subject_name: fixture.case_data?.subject_name || null,
      request_summary: fixture.case_data?.request_summary || null,
      inbound: {
        from_email: fixture.message.from_email || fixture.message.from_address || "records@test.gov",
        subject: fixture.message.subject || "Re: FOIA Request",
        body_text: fixture.message.body_text,
        source: "golden_fixture",
      },
    }));
}

function flattenRealPatterns() {
  const parsed = JSON.parse(fs.readFileSync(REAL_PATTERNS_PATH, "utf8"));
  const rows = [];
  for (const [pattern, items] of Object.entries(parsed.patterns || {})) {
    for (const item of items) {
      rows.push({ pattern, ...item });
    }
  }
  return rows;
}

async function loadRealPatternScenarios() {
  const rows = flattenRealPatterns();
  const ids = rows.map((row) => row.message_id).filter(Boolean);
  const caseIds = rows.map((row) => row.case_id).filter(Boolean);
  const bodyLookup = new Map();
  const attachmentsLookup = new Map();
  const caseLookup = new Map();

  if (ids.length) {
    const result = await db.query(
      `SELECT id, subject, from_email, body_text, body_html
         FROM messages
        WHERE id = ANY($1::int[])`,
      [ids]
    );
    for (const row of result.rows) {
      bodyLookup.set(row.id, row);
    }

    const attachmentResult = await db.query(
      `SELECT id, message_id, filename, content_type, extracted_text, storage_path,
              CASE
                WHEN content_type = 'application/pdf'
                  AND (
                    COALESCE(filename, '') ~* '(form|request)'
                    OR COALESCE(extracted_text, '') ~* '(request form|apra|foia|public records request form)'
                  )
                THEN encode(file_data, 'base64')
                ELSE NULL
              END AS content_base64
         FROM attachments
        WHERE message_id = ANY($1::int[])`,
      [ids]
    );
    for (const row of attachmentResult.rows) {
      let contentBase64 = row.content_base64 || null;
      if (!contentBase64 && row.storage_path && fs.existsSync(row.storage_path)) {
        contentBase64 = fs.readFileSync(row.storage_path).toString("base64");
      }
      const current = attachmentsLookup.get(row.message_id) || [];
      current.push({
        filename: row.filename,
        content_type: row.content_type,
        extracted_text: row.extracted_text || null,
        content_base64: contentBase64,
      });
      attachmentsLookup.set(row.message_id, current);
    }
  }

  if (caseIds.length) {
    const caseResult = await db.query(
      `SELECT id, subject_name, incident_date, additional_details, contact_research_notes, requested_records
         FROM cases
        WHERE id = ANY($1::int[])`,
      [caseIds]
    );
    for (const row of caseResult.rows) {
      caseLookup.set(row.id, row);
    }
  }

  return rows.map((row) => {
    const full = bodyLookup.get(row.message_id) || {};
    const originalCase = caseLookup.get(row.case_id) || null;
    return {
      label: `real:${row.pattern}:${row.message_id}`,
      source: "real_pattern",
      expected_intent: row.intent || null,
      expected_action: row.suggested_action || null,
      agency_name: row.agency_name || null,
      state: row.state || null,
      subject_name: row.subject || "Real Pattern Scenario",
      request_summary: row.body_excerpt || null,
      inbound: {
        from_email: row.from_email || "records@test.gov",
        subject: full.subject || row.subject || "Re: Public Records Request",
        body_text: full.body_text || full.body_html || row.body_excerpt || "",
        source: `real_pattern:${row.pattern}`,
        attachments: attachmentsLookup.get(row.message_id) || [],
      },
      original_case_context: originalCase
        ? {
            subject_name: originalCase.subject_name || null,
            incident_date: originalCase.incident_date || null,
            additional_details: originalCase.additional_details || null,
            contact_research_notes: originalCase.contact_research_notes || null,
            requested_records: originalCase.requested_records || null,
          }
        : null,
    };
  });
}

function classifyOutcome(proposals, portalTask, scenario) {
  const proposalList = Array.isArray(proposals) ? proposals : proposals ? [proposals] : [];
  const latestProposal = proposalList[0] || null;
  const actualAction = latestProposal?.action_type || (portalTask ? "SUBMIT_PORTAL" : null);
  const expectedAction = normalizeExpectedAction(scenario.expected_action);
  const matchedProposal = expectedAction
    ? proposalList.find((proposal) => proposal?.action_type === expectedAction)
    : null;
  const effectiveAction = matchedProposal?.action_type || actualAction;
  const matches = !expectedAction || effectiveAction === expectedAction;

  if (!actualAction) {
    return {
      status: "no_proposal",
      actual_action: null,
      expected_action: expectedAction,
      matches_expected_action: expectedAction == null || expectedAction === "NONE",
      matched_via_action: null,
    };
  }

  return {
    status: latestProposal ? "proposal_created" : "portal_task_created",
    actual_action: effectiveAction,
    expected_action: expectedAction,
    matches_expected_action: matches,
    matched_via_action: matchedProposal?.action_type || null,
  };
}

function normalizeExpectedAction(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;

  const map = {
    respond: null,
    wait: "NONE",
    use_portal: "SUBMIT_PORTAL",
    find_correct_agency: "RESEARCH_AGENCY",
    send_rebuttal: "SEND_REBUTTAL",
    negotiate_fee: "NEGOTIATE_FEE",
    pay_fee: "ACCEPT_FEE",
    download: "RECORDS_READY",
    download_records: "RECORDS_READY",
    SEND_PDF_EMAIL: "SEND_PDF_EMAIL",
  };

  return map[raw] || raw.toUpperCase();
}

async function runScenario(scenario) {
  const started = Date.now();
  const record = {
    label: scenario.label,
    source: scenario.source,
    expected_intent: scenario.expected_intent,
    expected_action: scenario.expected_action,
    case_id: null,
    outbound_message_id: null,
    inbound_message_id: null,
    run_id: null,
    proposal_id: null,
    proposal_action: null,
    status: "pending",
    error: null,
    duration_ms: null,
  };

  try {
    const createdCase = await createCaseForScenario(scenario.label, scenario);
    record.case_id = createdCase.id;

    await setupCaseForE2E(createdCase.id, scenario, scenario.label);
    await createSyntheticOutbound(createdCase.id, scenario, scenario.label);
    const outbound = await getLatestMessage(createdCase.id, "outbound");
    record.outbound_message_id = outbound?.id || null;

    const ingested = await ingestInbound(createdCase.id, scenario.inbound);
    const latestInbound = await getLatestMessage(createdCase.id, "inbound");
    const inboundMessageId =
      ingested.message?.id ||
      ingested.inbound_message_id ||
      ingested.message_id ||
      latestInbound?.id ||
      null;
    record.inbound_message_id = inboundMessageId;

    const trigger = await triggerInbound(createdCase.id, inboundMessageId, scenario);
    record.run_id = trigger.run?.id || trigger.run_id || null;

    let runTimeoutError = null;
    try {
      const completedRun = await pollLatestRun(record.run_id, createdCase.id);
      record.run_id = completedRun.id;
    } catch (error) {
      if (/Timed out waiting for latest run/i.test(String(error?.message || ""))) {
        runTimeoutError = error;
      } else {
        throw error;
      }
    }

    const proposals = await getRecentProposals(createdCase.id);
    const proposal = proposals[0] || null;
    const portalTask = await getLatestPortalTask(createdCase.id);
    if (runTimeoutError && !proposal && !portalTask) {
      throw runTimeoutError;
    }
    if (runTimeoutError) {
      record.run_timeout = true;
    }
    record.proposal_id = proposal?.id || null;
    record.proposal_action = proposal?.action_type || null;
    record.portal_task_id = portalTask?.id || null;
    record.portal_task_status = portalTask?.status || null;

    const outcome = classifyOutcome(proposals, portalTask, scenario);
    record.status = outcome.status;
    record.actual_action = outcome.actual_action || null;
    record.matches_expected_action = outcome.matches_expected_action;
    record.expected_action_normalized = outcome.expected_action || null;
    record.matched_via_action = outcome.matched_via_action || null;
  } catch (error) {
    record.status = "error";
    record.error = error.message;
  }

  record.duration_ms = Date.now() - started;
  return record;
}

function buildSummary(results) {
  const total = results.length;
  const errors = results.filter((result) => result.status === "error").length;
  const noProposal = results.filter((result) => result.status === "no_proposal").length;
  const withProposal = results.filter((result) => result.status === "proposal_created").length;
  const withPortalTask = results.filter((result) => result.status === "portal_task_created").length;
  const matches = results.filter((result) => result.matches_expected_action === true).length;
  const actionable = results.filter(
    (result) => result.status === "proposal_created" || result.status === "portal_task_created"
  ).length;
  const actionableMatches = results.filter(
    (result) =>
      (result.status === "proposal_created" || result.status === "portal_task_created") &&
      result.matches_expected_action === true
  ).length;
  const nonErrorTotal = results.filter((result) => result.status !== "error").length;

  const byAction = {};
  for (const result of results) {
    const key = result.actual_action || result.proposal_action || "NO_PROPOSAL";
    byAction[key] = (byAction[key] || 0) + 1;
  }

  return {
    generated_at: new Date().toISOString(),
    api_base_url: API_BASE_URL,
    total,
    with_proposal: withProposal,
    with_portal_task: withPortalTask,
    no_proposal: noProposal,
    errors,
    matches_expected_action: matches,
    match_rate: nonErrorTotal ? Number((matches / nonErrorTotal).toFixed(4)) : null,
    actionable_match_rate: actionable ? Number((actionableMatches / actionable).toFixed(4)) : null,
    by_action: byAction,
  };
}

async function main() {
  const golden = loadGoldenScenarios();
  const real = await loadRealPatternScenarios();
  const scenarios = [...golden, ...real].filter((scenario) =>
    !SCENARIO_FILTER || scenario.label.toLowerCase().includes(SCENARIO_FILTER)
  );

  console.log(
    `Running ${scenarios.length} email scenarios against ${API_BASE_URL} with concurrency ${CONCURRENCY}`
  );

  const results = new Array(scenarios.length);
  let cursor = 0;

  async function worker(workerId) {
    while (true) {
      const index = cursor;
      if (index >= scenarios.length) return;
      cursor += 1;

      const scenario = scenarios[index];
      console.log(`[${index + 1}/${scenarios.length}] worker-${workerId} ${scenario.label}`);
      const result = await runScenario(scenario);
      results[index] = result;
      console.log(
        `  -> worker-${workerId} ${result.status}` +
          (result.proposal_action ? ` (${result.proposal_action})` : "") +
          (result.error ? ` ERROR: ${result.error}` : "")
      );
    }
  }

  const workers = Array.from({ length: Math.min(CONCURRENCY, scenarios.length) }, (_, index) =>
    worker(index + 1)
  );
  await Promise.all(workers);

  const report = {
    summary: buildSummary(results),
    results,
  };

  fs.mkdirSync(REPORTS_DIR, { recursive: true });
  const outputPath = path.join(REPORTS_DIR, "email-scenario-batch-report.json");
  fs.writeFileSync(outputPath, JSON.stringify(report, null, 2));

  console.log(`Report written to ${outputPath}`);
  console.log(JSON.stringify(report.summary, null, 2));
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.close?.();
  });
