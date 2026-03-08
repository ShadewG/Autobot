/**
 * Integration test for all 21 pipeline reliability fixes.
 * Tests against the live database to verify constraints, upserts, and key logic paths.
 */
require('dotenv').config();
const db = require('../services/database');
const fs = require('fs');
const { execFileSync } = require('child_process');

const results = [];
let passed = 0;
let failed = 0;

function ok(name) { results.push({ name, status: 'PASS' }); passed++; }
function fail(name, reason) { results.push({ name, status: 'FAIL', reason }); failed++; }

async function run() {
  console.log('=== Testing 21 Pipeline Reliability Fixes ===\n');

  // ─── Fix A: error column name ───────────────────────────────────────
  try {
    const cols = await db.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'agent_runs' AND column_name IN ('error', 'error_message')
    `);
    const colNames = cols.rows.map(r => r.column_name);
    if (colNames.includes('error') && !colNames.includes('error_message')) {
      ok('Fix A: agent_runs has `error` column (not `error_message`)');
    } else {
      fail('Fix A: column check', `Found columns: ${colNames.join(', ')}`);
    }
  } catch (e) { fail('Fix A', e.message); }

  // ─── Fix J: One active run per case (unique index) ──────────────────
  try {
    const idx = await db.query(`
      SELECT indexname FROM pg_indexes
      WHERE indexname = 'idx_agent_runs_one_active_per_case'
    `);
    if (idx.rows.length > 0) {
      ok('Fix J: idx_agent_runs_one_active_per_case exists');
    } else {
      fail('Fix J: unique index missing', 'Index not found');
    }
  } catch (e) { fail('Fix J', e.message); }

  // Test that the constraint actually blocks duplicates
  try {
    const freeCase = await db.query(`
      SELECT c.id FROM cases c
      WHERE NOT EXISTS (
        SELECT 1 FROM agent_runs ar
        WHERE ar.case_id = c.id AND ar.status IN ('created', 'queued', 'running')
      )
      LIMIT 1
    `);
    if (freeCase.rows.length > 0) {
      const testCaseId = freeCase.rows[0].id;
      const run1 = await db.query(`
        INSERT INTO agent_runs (case_id, trigger_type, status) VALUES ($1, 'test_fix_j', 'queued') RETURNING id
      `, [testCaseId]);
      let constraintWorked = false;
      try {
        await db.query(`
          INSERT INTO agent_runs (case_id, trigger_type, status) VALUES ($1, 'test_fix_j_dup', 'queued') RETURNING id
        `, [testCaseId]);
      } catch (dupErr) {
        if (dupErr.code === '23505') constraintWorked = true;
      }
      // Clean up
      await db.query(`DELETE FROM agent_runs WHERE id = $1`, [run1.rows[0].id]);

      if (constraintWorked) {
        ok('Fix J: Duplicate active run blocked by constraint');
      } else {
        fail('Fix J: constraint test', 'Second insert did NOT raise 23505');
      }
    } else {
      ok('Fix J: (skipped constraint test — no free case, but index exists)');
    }
  } catch (e) { fail('Fix J constraint test', e.message); }

  // ─── Fix N: One thread per case (unique index) ──────────────────────
  try {
    const idx = await db.query(`
      SELECT indexname FROM pg_indexes
      WHERE indexname = 'idx_email_threads_case_id_unique'
    `);
    if (idx.rows.length > 0) {
      ok('Fix N: idx_email_threads_case_id_unique exists');
    } else {
      fail('Fix N: unique index missing', 'Index not found');
    }
  } catch (e) { fail('Fix N', e.message); }

  // Test ON CONFLICT upsert in createEmailThread
  try {
    const existingThread = await db.query(`
      SELECT et.id, et.case_id, et.thread_id, et.subject, et.agency_email
      FROM email_threads et LIMIT 1
    `);
    if (existingThread.rows.length > 0) {
      const t = existingThread.rows[0];
      const result = await db.createEmailThread({
        case_id: t.case_id,
        thread_id: t.thread_id || 'test-upsert',
        subject: t.subject || 'test subject',
        agency_email: t.agency_email || 'test@example.com',
        initial_message_id: null,
        status: 'active'
      });
      if (result && result.id) {
        ok('Fix N: createEmailThread upsert works (no crash on duplicate)');
      } else {
        fail('Fix N: upsert test', 'No result returned');
      }
    } else {
      ok('Fix N: (skipped upsert test — no existing threads, but index exists)');
    }
  } catch (e) { fail('Fix N upsert test', e.message); }

  // ─── Fix P: created_at instead of COALESCE ──────────────────────────
  try {
    const workerCode = fs.readFileSync('workers/agent-worker.js', 'utf-8');
    if (workerCode.includes('AND created_at < $4') && !workerCode.includes('COALESCE(received_at, created_at)')) {
      ok('Fix P: Uses created_at (not COALESCE(received_at, created_at))');
    } else {
      fail('Fix P', 'Still uses COALESCE or missing created_at');
    }
  } catch (e) { fail('Fix P', e.message); }

  // ─── Fix A (code check): all error_message → error ──────────────────
  try {
    const workerCode = fs.readFileSync('workers/agent-worker.js', 'utf-8');
    const badPattern = /updateAgentRun\([^)]*\{[^}]*error_message:/;
    if (!badPattern.test(workerCode)) {
      ok('Fix A (code): No error_message in updateAgentRun calls');
    } else {
      fail('Fix A (code)', 'Still has error_message in updateAgentRun');
    }
  } catch (e) { fail('Fix A code check', e.message); }

  // ─── Fix T: Force-complete unknown statuses ──────────────────────────
  try {
    const workerCode = fs.readFileSync('workers/agent-worker.js', 'utf-8');
    const nonStandardCount = (workerCode.match(/Non-standard graph status/g) || []).length;
    if (nonStandardCount >= 3) {
      ok(`Fix T: ${nonStandardCount} non-standard status handlers (>= 3)`);
    } else {
      fail('Fix T', `Only ${nonStandardCount} handlers found`);
    }
  } catch (e) { fail('Fix T', e.message); }

  // ─── Fix D: DLQ for analysis worker ──────────────────────────────────
  try {
    const queueCode = fs.readFileSync('queues/email-queue.js', 'utf-8');
    if (queueCode.includes("moveToDeadLetterQueue('analysis-queue'")) {
      ok('Fix D: Analysis worker has DLQ handler');
    } else {
      fail('Fix D', 'Missing moveToDeadLetterQueue for analysis-queue');
    }
  } catch (e) { fail('Fix D', e.message); }

  // ─── Fix M: Idempotency guard ────────────────────────────────────────
  try {
    const queueCode = fs.readFileSync('queues/email-queue.js', 'utf-8');
    if (queueCode.includes('SELECT id FROM response_analysis WHERE message_id')) {
      ok('Fix M: Analysis worker has idempotency guard');
    } else {
      fail('Fix M', 'Missing idempotency check');
    }
  } catch (e) { fail('Fix M', e.message); }

  // ─── Fix S: emailQueue null throw ────────────────────────────────────
  try {
    const queueCode = fs.readFileSync('queues/email-queue.js', 'utf-8');
    if (queueCode.includes("throw new Error('emailQueue is null")) {
      ok('Fix S: emailQueue null check throws');
    } else {
      fail('Fix S', 'Missing emailQueue null throw');
    }
  } catch (e) { fail('Fix S', e.message); }

  // ─── Fix B+C: Split-brain prevention ─────────────────────────────────
  try {
    const queueCode = fs.readFileSync('queues/email-queue.js', 'utf-8');
    if (queueCode.includes('runEngineEnqueued') && queueCode.includes('legacyEnqueued')) {
      ok('Fix B+C: Split-brain prevention flags exist');
    } else {
      fail('Fix B+C', 'Missing enqueued flags');
    }
    if (queueCode.includes('if (runEngineEnqueued)') && queueCode.includes('if (legacyEnqueued)')) {
      ok('Fix B+C: Flags checked in catch blocks');
    } else {
      fail('Fix B+C catch check', 'Flags not checked in catch');
    }
  } catch (e) { fail('Fix B+C', e.message); }

  // ─── Fix O: Deterministic analysis job IDs ───────────────────────────
  try {
    const whCode = fs.readFileSync('routes/webhooks.js', 'utf-8');
    const analyzeJobIds = (whCode.match(/jobId: `analyze-\$/g) || []).length;
    if (analyzeJobIds >= 2) {
      ok(`Fix O: ${analyzeJobIds} deterministic analysis jobIds`);
    } else {
      fail('Fix O', `Only ${analyzeJobIds} analyze jobIds`);
    }
  } catch (e) { fail('Fix O', e.message); }

  // ─── Fix L: Null guards on queue.add() ───────────────────────────────
  try {
    const whCode = fs.readFileSync('routes/webhooks.js', 'utf-8');
    if (whCode.includes("if (!analysisQueue)") && whCode.includes("if (!portalQueue)")) {
      ok('Fix L: Null guards on analysisQueue and portalQueue');
    } else {
      fail('Fix L', 'Missing null guards');
    }
  } catch (e) { fail('Fix L', e.message); }

  // ─── Fix I: Orphan cleanup on enqueue failure ────────────────────────
  try {
    const reCode = fs.readFileSync('routes/run-engine.js', 'utf-8');
    const orphanCleanups = (reCode.match(/Enqueue failed:/g) || []).length;
    if (orphanCleanups >= 7) {
      ok(`Fix I: ${orphanCleanups} orphan cleanup handlers (>= 7)`);
    } else {
      fail('Fix I', `Only ${orphanCleanups} orphan cleanups (expected >= 7)`);
    }
  } catch (e) { fail('Fix I', e.message); }

  // ─── Fix G: DECISION_RECEIVED after enqueue ──────────────────────────
  try {
    const reCode = fs.readFileSync('routes/run-engine.js', 'utf-8');
    const decisionIdx = reCode.indexOf('enqueueResumeRunJob');
    const statusIdx = reCode.indexOf("status: 'DECISION_RECEIVED'");
    if (decisionIdx > 0 && statusIdx > 0 && statusIdx > decisionIdx) {
      ok('Fix G: DECISION_RECEIVED set AFTER enqueueResumeRunJob');
    } else {
      fail('Fix G', 'DECISION_RECEIVED appears before enqueue');
    }
  } catch (e) { fail('Fix G', e.message); }

  // ─── Fix H: Deterministic portal job IDs ─────────────────────────────
  try {
    const eaCode = fs.readFileSync('langgraph/nodes/execute-action.js', 'utf-8');
    const portalJobIds = (eaCode.match(/portal-submit:\$/g) || []).length;
    if (portalJobIds >= 2) {
      ok(`Fix H: ${portalJobIds} deterministic portal jobIds`);
    } else {
      fail('Fix H', `Only ${portalJobIds} portal jobIds`);
    }
  } catch (e) { fail('Fix H', e.message); }

  // ─── Fix Q: requires_response normalization ──────────────────────────
  try {
    const aiCode = fs.readFileSync('services/ai-service.js', 'utf-8');
    if (aiCode.includes('requires_response') && aiCode.includes('requires_action')) {
      ok('Fix Q: requires_response → requires_action normalization');
    } else {
      fail('Fix Q', 'Missing normalization');
    }
  } catch (e) { fail('Fix Q', e.message); }

  // ─── Fix R: Reactive dispatch in notion-service ──────────────────────
  try {
    const nsCode = fs.readFileSync('services/notion-service.js', 'utf-8');
    if (nsCode.includes('getGenerateQueue') && nsCode.includes('generate-and-send')) {
      ok('Fix R: Reactive dispatch via generateQueue');
    } else {
      fail('Fix R', 'Missing reactive dispatch');
    }
  } catch (e) { fail('Fix R', e.message); }

  // ─── Fix K: Timeout guard ────────────────────────────────────────────
  try {
    const eaCode = fs.readFileSync('langgraph/nodes/execute-action.js', 'utf-8');
    if (eaCode.includes('run_already_terminal') && eaCode.includes("['failed', 'skipped']")) {
      ok('Fix K: Timeout guard for terminal run status');
    } else {
      fail('Fix K', 'Missing timeout guard');
    }
  } catch (e) { fail('Fix K', e.message); }

  // ─── Fix F: Email send false positive check ──────────────────────────
  try {
    const eaCode = fs.readFileSync('langgraph/nodes/execute-action.js', 'utf-8');
    if (eaCode.includes('emailResult.success !== true') && eaCode.includes("emailResult?.error")) {
      ok('Fix F: Email send failure check with null-safe access');
    } else {
      fail('Fix F', 'Incomplete email failure check');
    }
  } catch (e) { fail('Fix F', e.message); }

  // ─── Fix U: markMessagesProcessed after terminal branches ────────────
  try {
    const workerCode = fs.readFileSync('workers/agent-worker.js', 'utf-8');
    const markCalls = (workerCode.match(/await markMessagesProcessed\(\)/g) || []).length;
    if (markCalls >= 3) {
      ok(`Fix U: markMessagesProcessed() called ${markCalls} times`);
    } else {
      fail('Fix U', `Only ${markCalls} calls (expected >= 3)`);
    }
  } catch (e) { fail('Fix U', e.message); }

  // ─── Fix E: Webhook signature verification ───────────────────────────
  try {
    const whCode = fs.readFileSync('routes/webhooks.js', 'utf-8');
    if (whCode.includes('x-twilio-email-event-webhook-signature') && whCode.includes('verifyWebhookSignature')) {
      ok('Fix E: Webhook signature verification present');
    } else {
      fail('Fix E', 'Missing signature verification');
    }
  } catch (e) { fail('Fix E', e.message); }

  // ─── Codex review fixes ──────────────────────────────────────────────
  try {
    const reCode = fs.readFileSync('routes/run-engine.js', 'utf-8');
    if (reCode.includes("await db.updateAgentRun(newRun.id, { status: 'failed'")) {
      ok('Codex #1: Retry route has orphan cleanup');
    } else {
      fail('Codex #1', 'Missing retry orphan cleanup');
    }
  } catch (e) { fail('Codex #1', e.message); }

  try {
    const reCode = fs.readFileSync('routes/run-engine.js', 'utf-8');
    const conflicts = (reCode.match(/ON CONFLICT \(case_id\) DO UPDATE/g) || []).length;
    if (conflicts >= 2) {
      ok(`Codex #4: ${conflicts} ON CONFLICT clauses in run-engine`);
    } else {
      fail('Codex #4', `Only ${conflicts} ON CONFLICT clauses`);
    }
  } catch (e) { fail('Codex #4', e.message); }

  try {
    const dbCode = fs.readFileSync('services/database.js', 'utf-8');
    if (dbCode.includes('COALESCE(EXCLUDED.thread_id') && dbCode.includes('COALESCE(EXCLUDED.agency_email')) {
      ok('Codex #3: createEmailThread upsert backfills columns');
    } else {
      fail('Codex #3', 'Upsert does not backfill columns');
    }
  } catch (e) { fail('Codex #3', e.message); }

  // ─── Syntax checks ──────────────────────────────────────────────────
  const modules = [
    'workers/agent-worker.js',
    'queues/email-queue.js',
    'services/ai-service.js',
    'routes/webhooks.js',
    'routes/run-engine.js',
    'langgraph/nodes/execute-action.js',
    'services/notion-service.js',
    'services/database.js'
  ];
  for (const mod of modules) {
    try {
      execFileSync('node', ['--check', mod], { cwd: process.cwd(), timeout: 10000 });
      ok(`Syntax: ${mod}`);
    } catch (e) {
      fail(`Syntax: ${mod}`, e.stderr ? e.stderr.toString().split('\n')[0] : e.message);
    }
  }

  // ─── Report ──────────────────────────────────────────────────────────
  console.log('\n=== RESULTS ===\n');
  for (const r of results) {
    const icon = r.status === 'PASS' ? '✓' : '✗';
    console.log(`  ${icon} ${r.name}${r.reason ? ` — ${r.reason}` : ''}`);
  }
  console.log(`\n  ${passed} passed, ${failed} failed out of ${results.length} tests\n`);

  process.exit(failed > 0 ? 1 : 0);
}

run().catch(e => { console.error('Test runner error:', e); process.exit(1); });
