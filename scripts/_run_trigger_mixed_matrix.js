#!/usr/bin/env node
const { tasks, runs } = require("@trigger.dev/sdk");
const db = require("../services/database");

const POLL_INTERVAL_MS = 3000;
const POLL_TIMEOUT_MS = 4 * 60 * 1000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function pollRun(runId) {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const run = await runs.retrieve(runId);
    if (run.status === "COMPLETED") return { ok: true, output: run.output, run };
    if (["FAILED", "CRASHED", "CANCELED"].includes(run.status)) {
      return { ok: false, error: run.output?.message || run.status, run };
    }
    await sleep(POLL_INTERVAL_MS);
  }
  return { ok: false, error: "timeout" };
}

async function triggerTask(taskId, payload) {
  const handle = await tasks.trigger(taskId, payload);
  const result = await pollRun(handle.id);
  return { handle, ...result };
}

async function getDefaultUserId() {
  const r = await db.query("SELECT id FROM users ORDER BY id ASC LIMIT 1");
  return r.rows[0]?.id || null;
}

function uniqueToken(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
}

async function createSyntheticCase(label, overrides = {}) {
  const userId = overrides.user_id ?? await getDefaultUserId();
  const notionPageId = overrides.notion_page_id || uniqueToken(`qa-trigger-${label}`);
  const emailAlias = overrides.agency_email || `shadewofficial+${label}@gmail.com`;
  const initialStatus = overrides.status || "draft";
  const created = await db.createCase({
    notion_page_id: notionPageId,
    case_name: overrides.case_name || `QA Trigger ${label}`,
    subject_name: overrides.subject_name || `Jordan Example ${label}`,
    agency_name: overrides.agency_name || "Synthetic QA Records Unit",
    agency_email: emailAlias,
    state: overrides.state || "WA",
    incident_date: overrides.incident_date || "2025-02-14",
    incident_location: overrides.incident_location || "Seattle, WA",
    requested_records: overrides.requested_records || ["body camera footage", "dispatch audio"],
    additional_details: overrides.additional_details || "Trigger mixed matrix synthetic case",
    status: initialStatus,
    deadline_date: overrides.deadline_date || null,
    portal_url: overrides.portal_url || null,
    portal_provider: overrides.portal_provider || null,
    alternate_agency_email: overrides.alternate_agency_email || null,
    user_id: userId,
    priority: overrides.priority || 0,
  });
  await db.updateCase(created.id, {
    autopilot_mode: overrides.autopilot_mode || "AUTO",
    status: initialStatus,
    send_date: overrides.send_date || null,
    deadline_date: overrides.deadline_date || null,
    substatus: null,
  });
  return db.getCaseById(created.id);
}

async function createThread(caseRow, subject, agencyEmail) {
  return db.createEmailThread({
    case_id: caseRow.id,
    thread_id: `<thread-${caseRow.id}-${Date.now()}@autobot.local>`,
    subject,
    agency_email: agencyEmail || caseRow.agency_email,
    initial_message_id: `<initial-${caseRow.id}-${Date.now()}@autobot.local>`,
    status: "active",
    case_agency_id: null,
  });
}

async function createOutbound(caseRow, thread, subject, bodyText, toEmail) {
  return db.createMessage({
    thread_id: thread.id,
    case_id: caseRow.id,
    message_id: `<outbound-${caseRow.id}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}@autobot.local>`,
    sendgrid_message_id: null,
    direction: "outbound",
    from_email: "sam@foib-request.com",
    to_email: toEmail || caseRow.agency_email,
    cc_emails: null,
    subject,
    body_text: bodyText,
    body_html: null,
    has_attachments: false,
    attachment_count: 0,
    message_type: "email",
    portal_notification: false,
    portal_notification_type: null,
    portal_notification_provider: null,
    sent_at: new Date(),
    received_at: null,
    summary: null,
    metadata: { source: "trigger-mixed-matrix" },
    provider_payload: { source: "trigger-mixed-matrix" },
  });
}

async function createInbound(caseRow, thread, subject, bodyText, fromEmail) {
  return db.createMessage({
    thread_id: thread.id,
    case_id: caseRow.id,
    message_id: `<inbound-${caseRow.id}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}@autobot.local>`,
    sendgrid_message_id: null,
    direction: "inbound",
    from_email: fromEmail || caseRow.agency_email,
    to_email: "sam@foib-request.com",
    cc_emails: null,
    subject,
    body_text: bodyText,
    body_html: null,
    has_attachments: false,
    attachment_count: 0,
    message_type: "email",
    portal_notification: false,
    portal_notification_type: null,
    portal_notification_provider: null,
    sent_at: null,
    received_at: new Date(),
    summary: null,
    metadata: { source: "trigger-mixed-matrix" },
    provider_payload: { source: "trigger-mixed-matrix" },
  });
}

function ok(name, details = "") {
  console.log(`PASS ${name}${details ? ` :: ${details}` : ""}`);
}

function fail(name, error) {
  console.error(`FAIL ${name} :: ${error}`);
}

async function runCase(name, fn, results) {
  try {
    const detail = await fn();
    ok(name, detail || "");
    results.push({ name, status: "pass", detail: detail || "" });
  } catch (error) {
    fail(name, error?.message || String(error));
    results.push({ name, status: "fail", error: error?.message || String(error) });
  }
}

async function run() {
  const results = [];

  const simCases = [
    {
      name: "SIM fee auto-accept",
      payload: {
        fromEmail: "records@example.gov",
        subject: "Public records request fee estimate",
        messageBody: "The estimated cost to fulfill your request is $18. You can confirm and we will proceed.",
      },
      expectAction: "ACCEPT_FEE",
    },
    {
      name: "SIM strong privacy denial",
      payload: {
        fromEmail: "records@example.gov",
        subject: "FOIA response",
        messageBody: "We deny your request in full under the personal privacy exemption because disclosure would be an unwarranted invasion of personal privacy.",
      },
      expectAction: "CLOSE_CASE",
    },
    {
      name: "SIM wrong agency denial",
      payload: {
        fromEmail: "records@example.gov",
        subject: "No responsive records",
        messageBody: "We do not maintain these records. They may be held by a different agency. Please contact the county sheriff records unit instead.",
      },
      expectAction: "RESEARCH_AGENCY",
    },
    {
      name: "SIM records ready no response",
      payload: {
        fromEmail: "records@example.gov",
        subject: "Records available",
        messageBody: "Your request is complete and records are ready for download at the portal. This message is only a notice.",
      },
      expectAction: "NONE",
    },
  ];

  for (const tc of simCases) {
    await runCase(tc.name, async () => {
      const result = await triggerTask("simulate-decision", tc.payload);
      if (!result.ok) throw new Error(result.error || "run failed");
      const action = result.output?.decision?.action;
      if (action !== tc.expectAction) {
        throw new Error(`expected ${tc.expectAction}, got ${action}`);
      }
      return action;
    }, results);
  }

  for (let i = 0; i < 4; i++) {
    await runCase(`HEALTH ${i + 1}`, async () => {
      const testCase = await createSyntheticCase(`health-${i + 1}`);
      const result = await triggerTask("health-check", { test: `matrix-${i + 1}`, caseId: testCase.id });
      if (!result.ok) throw new Error(result.error || "run failed");
      if (result.output?.dbPing !== "ok") throw new Error(`dbPing=${result.output?.dbPing}`);
      if (!String(result.output?.createAgentRun || "").startsWith("ok")) {
        throw new Error(`createAgentRun=${result.output?.createAgentRun}`);
      }
      return `case ${testCase.id}`;
    }, results);
  }

  const evalIds = (await db.query(
    "SELECT id FROM eval_cases WHERE is_active = true ORDER BY created_at DESC, id DESC LIMIT 4"
  )).rows.map((row) => row.id);
  for (const evalId of evalIds) {
    await runCase(`EVAL ${evalId}`, async () => {
      const result = await triggerTask("eval-decision", { evalCaseId: evalId });
      if (!result.ok) throw new Error(result.error || "run failed");
      if (result.output?.totalCases !== 1) throw new Error(`totalCases=${result.output?.totalCases}`);
      return `scored ${evalId}`;
    }, results);
  }

  for (let i = 0; i < 4; i++) {
    await runCase(`INITIAL ${i + 1}`, async () => {
      const caseRow = await createSyntheticCase(`initial-${i + 1}`);
      const agentRun = await db.createAgentRun(caseRow.id, "INITIAL_REQUEST", { source: "trigger-mixed-matrix" });
      const result = await triggerTask("process-initial-request", {
        runId: agentRun.id,
        caseId: caseRow.id,
        autopilotMode: "AUTO",
      });
      if (!result.ok) throw new Error(result.error || "run failed");
      const outboundCount = Number((await db.query(
        "SELECT COUNT(*)::int AS count FROM messages WHERE case_id = $1 AND direction = 'outbound'",
        [caseRow.id]
      )).rows[0]?.count || 0);
      if (outboundCount < 1) throw new Error("no outbound created");
      return `case ${caseRow.id} outbound=${outboundCount}`;
    }, results);
  }

  const inboundFixtures = [
    {
      name: "INBOUND wrong agency A",
      body: "We do not maintain these records. They are likely held by another agency, possibly the county sheriff records office.",
      subject: "No records here",
      expected: "RESEARCH_AGENCY",
    },
    {
      name: "INBOUND strong denial A",
      body: "We deny your request in full under the personal privacy exemption because disclosure would be an unwarranted invasion of personal privacy.",
      subject: "FOIA denial",
      expected: "CLOSE_CASE",
    },
    {
      name: "INBOUND records ready A",
      body: "Records are ready and available for download in the portal. This is a notice only.",
      subject: "Records ready",
      expected: "none",
    },
    {
      name: "INBOUND fee quote A",
      body: "The cost to fulfill your request is $22. Please confirm if you would like us to proceed.",
      subject: "Fee estimate",
      expected: "ACCEPT_FEE",
    },
    {
      name: "INBOUND wrong agency B",
      body: "Our office is not the proper custodian. Please direct your request to the state police records division.",
      subject: "Referral",
      expected: "RESEARCH_AGENCY",
    },
    {
      name: "INBOUND strong denial B",
      body: "This request is denied in full under personal privacy protections. We will not release the requested records.",
      subject: "Denied",
      expected: "CLOSE_CASE",
    },
    {
      name: "INBOUND acknowledgment",
      body: "We received your request and will respond when processing is complete. No action is needed from you now.",
      subject: "Acknowledgment",
      expected: "none",
    },
    {
      name: "INBOUND fee quote B",
      body: "We estimate duplication costs at $15. Please reply to authorize processing.",
      subject: "Estimated fees",
      expected: "ACCEPT_FEE",
    },
  ];

  for (const fixture of inboundFixtures) {
    await runCase(fixture.name, async () => {
      const caseRow = await createSyntheticCase(fixture.name.toLowerCase().replace(/[^a-z0-9]+/g, "-"), {
        status: "awaiting_response",
        send_date: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
      });
      const thread = await createThread(caseRow, `QA thread ${fixture.subject}`);
      await createOutbound(caseRow, thread, "Initial request", "Please provide the requested records.");
      const inbound = await createInbound(caseRow, thread, fixture.subject, fixture.body);
      const agentRun = await db.createAgentRun(caseRow.id, "INBOUND_MESSAGE", { source: "trigger-mixed-matrix", messageId: inbound.id });
      const result = await triggerTask("process-inbound", {
        runId: agentRun.id,
        caseId: caseRow.id,
        messageId: inbound.id,
        autopilotMode: "AUTO",
      });
      if (!result.ok) throw new Error(result.error || "run failed");
      const actual = result.output?.actionType || result.output?.action;
      if (actual !== fixture.expected) throw new Error(`expected ${fixture.expected}, got ${actual}`);
      return `case ${caseRow.id} => ${actual}`;
    }, results);
  }

  for (let i = 0; i < 4; i++) {
    await runCase(`FOLLOWUP ${i + 1}`, async () => {
      const caseRow = await createSyntheticCase(`followup-${i + 1}`, {
        status: "awaiting_response",
        send_date: new Date(Date.now() - 14 * 24 * 60 * 60 * 1000),
        deadline_date: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000),
      });
      const thread = await createThread(caseRow, `Follow-up QA ${i + 1}`);
      await createOutbound(caseRow, thread, "Initial request", "Following up on records request");
      const schedule = await db.upsertFollowUpSchedule(caseRow.id, {
        threadId: thread.id,
        nextFollowupDate: new Date(Date.now() - 60 * 60 * 1000),
        followupCount: 0,
        autoSend: false,
        status: "scheduled",
        lastFollowupSentAt: null,
      });
      const agentRun = await db.createAgentRun(caseRow.id, "SCHEDULED_FOLLOWUP", { source: "trigger-mixed-matrix", followupScheduleId: schedule.id });
      const result = await triggerTask("process-followup", {
        runId: agentRun.id,
        caseId: caseRow.id,
        followupScheduleId: schedule.id,
      });
      if (!result.ok) throw new Error(result.error || "run failed");
      if (result.output?.status !== "completed") throw new Error(`status=${result.output?.status}`);
      const outboundCount = Number((await db.query(
        "SELECT COUNT(*)::int AS count FROM messages WHERE case_id = $1 AND direction = 'outbound'",
        [caseRow.id]
      )).rows[0]?.count || 0);
      if (outboundCount < 2) throw new Error(`expected followup send, outboundCount=${outboundCount}`);
      return `case ${caseRow.id} outbound=${outboundCount}`;
    }, results);
  }

  await runCase("SUBMIT_PORTAL missing url", async () => {
    const caseRow = await createSyntheticCase("portal-missing-url", {
      status: "draft",
      agency_name: "Synthetic Portal Agency",
      portal_url: null,
      portal_provider: null,
    });
    const agentRun = await db.createAgentRun(caseRow.id, "SUBMIT_PORTAL", { source: "trigger-mixed-matrix" });
    const result = await triggerTask("submit-portal", {
      caseId: caseRow.id,
      portalUrl: "",
      provider: null,
      instructions: null,
      agentRunId: agentRun.id,
    });
    if (!result.ok) throw new Error(result.error || "run failed");
    if (result.output?.reason !== "invalid_portal_url") throw new Error(`reason=${result.output?.reason}`);
    return `case ${caseRow.id}`;
  }, results);

  await runCase("SUBMIT_PORTAL paper only", async () => {
    const caseRow = await createSyntheticCase("portal-paper-only", {
      status: "draft",
      agency_name: "Synthetic Portal Agency",
      portal_url: "https://example.invalid/portal",
      portal_provider: "paper form required",
    });
    const agentRun = await db.createAgentRun(caseRow.id, "SUBMIT_PORTAL", { source: "trigger-mixed-matrix" });
    const result = await triggerTask("submit-portal", {
      caseId: caseRow.id,
      portalUrl: caseRow.portal_url,
      provider: caseRow.portal_provider,
      instructions: null,
      agentRunId: agentRun.id,
    });
    if (!result.ok) throw new Error(result.error || "run failed");
    if (result.output?.reason !== "provider_paper_only") throw new Error(`reason=${result.output?.reason}`);
    return `case ${caseRow.id}`;
  }, results);

  await runCase("SUBMIT_PORTAL advanced case skip", async () => {
    const caseRow = await createSyntheticCase("portal-advanced-status", {
      status: "awaiting_response",
      portal_url: "https://example.invalid/portal",
      portal_provider: "GovQA",
    });
    const agentRun = await db.createAgentRun(caseRow.id, "SUBMIT_PORTAL", { source: "trigger-mixed-matrix" });
    const result = await triggerTask("submit-portal", {
      caseId: caseRow.id,
      portalUrl: caseRow.portal_url,
      provider: caseRow.portal_provider,
      instructions: null,
      agentRunId: agentRun.id,
    });
    if (!result.ok) throw new Error(result.error || "run failed");
    if (result.output?.reason !== "awaiting_response") throw new Error(`reason=${result.output?.reason}`);
    return `case ${caseRow.id}`;
  }, results);

  await runCase("SUBMIT_PORTAL recent success skip", async () => {
    const caseRow = await createSyntheticCase("portal-recent-success", {
      status: "draft",
      portal_url: "https://example.invalid/portal",
      portal_provider: "GovQA",
    });
    await db.logActivity("portal_stage_completed", `Synthetic recent portal success for case ${caseRow.id}`, {
      case_id: caseRow.id,
      engine: "skyvern_workflow",
    });
    const agentRun = await db.createAgentRun(caseRow.id, "SUBMIT_PORTAL", { source: "trigger-mixed-matrix" });
    const result = await triggerTask("submit-portal", {
      caseId: caseRow.id,
      portalUrl: caseRow.portal_url,
      provider: caseRow.portal_provider,
      instructions: null,
      agentRunId: agentRun.id,
    });
    if (!result.ok) throw new Error(result.error || "run failed");
    if (result.output?.reason !== "recent_success") throw new Error(`reason=${result.output?.reason}`);
    return `case ${caseRow.id}`;
  }, results);

  const passed = results.filter((r) => r.status === "pass").length;
  const failed = results.filter((r) => r.status === "fail").length;
  console.log(`\nMIXED MATRIX COMPLETE :: ${passed} passed / ${failed} failed / ${results.length} total`);
  if (failed > 0) {
    process.exitCode = 1;
  }
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
