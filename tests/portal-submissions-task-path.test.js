require('dotenv').config();
const assert = require('assert');
const crypto = require('crypto');
const path = require('path');
const { execFileSync } = require('child_process');
const db = require('../services/database');

describe('submit-portal task-path persistence helpers', function () {
  this.timeout(30000);

  const created = {
    caseIds: [],
    runIds: [],
    portalSubmissionIds: [],
  };

  afterEach(async function () {
    if (created.portalSubmissionIds.length) {
      await db.query('DELETE FROM portal_submissions WHERE id = ANY($1::int[])', [created.portalSubmissionIds.splice(0)]);
    }
    if (created.runIds.length) {
      await db.query('DELETE FROM agent_runs WHERE id = ANY($1::int[])', [created.runIds.splice(0)]);
    }
    if (created.caseIds.length) {
      await db.query('DELETE FROM error_events WHERE case_id = ANY($1::int[])', [created.caseIds]);
      await db.query('DELETE FROM activity_log WHERE case_id = ANY($1::int[])', [created.caseIds]);
      await db.query('DELETE FROM cases WHERE id = ANY($1::int[])', [created.caseIds.splice(0)]);
    }
  });

  async function createSyntheticCase() {
    const originalDispatch = db._dispatchStatusAction;
    db._dispatchStatusAction = async () => {};
    try {
      const testCase = await db.createCase({
        notion_page_id: crypto.randomUUID().replace(/-/g, ''),
        case_name: `Portal Task Path ${Date.now()}`,
        subject_name: 'Portal Task Path Subject',
        agency_name: 'Portal Task Path Agency',
        agency_email: 'portal-test@agency.gov',
        portal_url: 'https://portal.example.gov/request/123',
        portal_provider: 'GovQA',
        state: 'NC',
        requested_records: ['Portal persistence verification'],
        status: 'ready_to_send',
      });
      created.caseIds.push(testCase.id);
      return testCase;
    } finally {
      db._dispatchStatusAction = originalDispatch;
    }
  }

  function runTaskPathScript(script) {
    const cwd = path.resolve(__dirname, '..');
    return execFileSync('npx', ['tsx', '-e', script], {
      cwd,
      encoding: 'utf8',
    });
  }

  it('writes a completed portal_submissions row through the submit-portal task path helpers', async function () {
    const testCase = await createSyntheticCase();
    const run = await db.createAgentRunFull({
      case_id: testCase.id,
      trigger_type: 'submit_portal',
      langgraph_thread_id: `portal:test:${testCase.id}:success`,
      autopilot_mode: 'SUPERVISED',
      status: 'created',
    });
    created.runIds.push(run.id);
    const script = `
      (async () => {
        const db = require("./services/database");
        const imported = await import("./trigger/tasks/submit-portal.ts");
        const portalModule = imported.default || imported["module.exports"] || imported;
        try {
          const row = await portalModule.recordPortalSubmissionStart(db, {
            caseId: ${testCase.id},
            runId: ${run.id},
            engine: "GovQA",
            accountEmail: "portal-bot@example.test",
          });
          await portalModule.finalizePortalSubmissionSuccess(db, row.id, {
            taskId: "sky-task-123",
            screenshot_url: "https://artifacts.example.test/screenshot.png",
            recording_url: "https://artifacts.example.test/recording.mp4",
            extracted_data: { receipt: "ABC-123" },
          }, "https://app.skyvern.com/tasks/sky-task-123");
          console.log(JSON.stringify({ id: row.id }));
        } finally {
          await db.close();
        }
      })().catch((error) => {
        console.error(error);
        process.exit(1);
      });
    `;

    const stdout = runTaskPathScript(script);
    const result = JSON.parse(stdout.trim().split('\n').pop());
    created.portalSubmissionIds.push(result.id);

    const submissions = await db.getPortalSubmissions(testCase.id, { limit: 5 });
    assert.strictEqual(submissions.length, 1);
    assert.strictEqual(submissions[0].id, result.id);
    assert.strictEqual(submissions[0].status, 'completed');
    assert.strictEqual(submissions[0].skyvern_task_id, 'sky-task-123');
    assert.strictEqual(submissions[0].recording_url, 'https://artifacts.example.test/recording.mp4');
    assert.strictEqual(submissions[0].extracted_data.receipt, 'ABC-123');
    assert.ok(submissions[0].completed_at, 'expected completed_at to be set');
  });

  it('writes a failed portal_submissions row through the submit-portal task path helpers', async function () {
    const testCase = await createSyntheticCase();
    const run = await db.createAgentRunFull({
      case_id: testCase.id,
      trigger_type: 'submit_portal',
      langgraph_thread_id: `portal:test:${testCase.id}:failure`,
      autopilot_mode: 'SUPERVISED',
      status: 'created',
    });
    created.runIds.push(run.id);
    const script = `
      (async () => {
        const db = require("./services/database");
        const imported = await import("./trigger/tasks/submit-portal.ts");
        const portalModule = imported.default || imported["module.exports"] || imported;
        try {
          const row = await portalModule.recordPortalSubmissionStart(db, {
            caseId: ${testCase.id},
            runId: ${run.id},
            engine: "GovQA",
            accountEmail: "portal-bot@example.test",
          });
          await portalModule.finalizePortalSubmissionFailure(db, row.id, new Error("Portal timed out while waiting for confirmation"));
          console.log(JSON.stringify({ id: row.id }));
        } finally {
          await db.close();
        }
      })().catch((error) => {
        console.error(error);
        process.exit(1);
      });
    `;

    const stdout = runTaskPathScript(script);
    const result = JSON.parse(stdout.trim().split('\n').pop());
    created.portalSubmissionIds.push(result.id);

    const submissions = await db.getPortalSubmissions(testCase.id, { limit: 5 });
    assert.strictEqual(submissions.length, 1);
    assert.strictEqual(submissions[0].id, result.id);
    assert.strictEqual(submissions[0].status, 'failed');
    assert.match(submissions[0].error_message, /Portal timed out while waiting for confirmation/);
    assert.ok(submissions[0].completed_at, 'expected completed_at to be set');
  });
});
