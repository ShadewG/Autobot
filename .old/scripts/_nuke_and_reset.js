/**
 * Nuclear reset for broken cases that have been fixed/broken too many times.
 *
 * Deletes agent_decisions, proposals, agent_runs, and activity_log for target cases.
 * Keeps messages/threads intact. Resets case to clean state and triggers fresh processing.
 *
 * Usage: DATABASE_URL=... node scripts/_nuke_and_reset.js [--dry-run]
 */

require('dotenv').config();
const { Pool } = require("pg");

const DATABASE_URL = process.env.DATABASE_URL || process.env.DATABASE_PUBLIC_URL;
const pool = new Pool({ connectionString: DATABASE_URL });

const DRY_RUN = process.argv.includes('--dry-run');

// Cases to nuke: escalate cases + 25163 (Longview mess) + 25167 (fee quote mess)
const TARGET_CASES = [25158, 25163, 25167, 25206];

async function nukeCase(caseId) {
  const prefix = DRY_RUN ? '[DRY RUN] ' : '';
  console.log(`\n${prefix}=== Nuking case ${caseId} ===`);

  // Get case info
  const caseRow = (await pool.query(
    "SELECT id, status, substatus, agency_name, requires_human, pause_reason FROM cases WHERE id = $1", [caseId]
  )).rows[0];
  if (!caseRow) { console.log("  Case not found, skipping"); return; }
  console.log(`  Agency: ${caseRow.agency_name}`);
  console.log(`  Current: status=${caseRow.status}, substatus=${caseRow.substatus}, requires_human=${caseRow.requires_human}`);

  // Count what we'll delete
  const counts = {};
  for (const table of ['agent_decisions', 'proposals', 'agent_runs', 'activity_log']) {
    const r = (await pool.query(`SELECT count(*)::int as n FROM ${table} WHERE case_id = $1`, [caseId])).rows[0];
    counts[table] = r.n;
  }
  console.log(`  Will delete: decisions=${counts.agent_decisions}, proposals=${counts.proposals}, runs=${counts.agent_runs}, activity=${counts.activity_log}`);

  // Find latest real inbound (not from wrong agency for 25163)
  const latestInbound = (await pool.query(`
    SELECT m.id, m.from_email, m.subject, m.created_at
    FROM messages m JOIN email_threads t ON m.thread_id = t.id
    WHERE t.case_id = $1 AND m.direction = 'inbound'
    ORDER BY m.created_at DESC LIMIT 1
  `, [caseId])).rows[0];
  console.log(`  Latest inbound: msg ${latestInbound?.id} from ${latestInbound?.from_email} — ${(latestInbound?.subject || '').slice(0, 80)}`);

  if (DRY_RUN) {
    console.log(`  ${prefix}Would delete history and reset to awaiting_response`);
    return;
  }

  // Delete in order (respect FK constraints)
  // portal_tasks reference proposals, so delete portal_tasks first
  await pool.query("DELETE FROM portal_tasks WHERE case_id = $1", [caseId]);
  await pool.query("DELETE FROM activity_log WHERE case_id = $1", [caseId]);
  await pool.query("DELETE FROM agent_decisions WHERE case_id = $1", [caseId]);
  await pool.query("DELETE FROM proposals WHERE case_id = $1", [caseId]);
  await pool.query("DELETE FROM agent_runs WHERE case_id = $1", [caseId]);

  // Reset case to clean state — awaiting_response since it was already sent
  const hasInbound = latestInbound ? true : false;
  const targetStatus = hasInbound ? 'awaiting_response' : 'awaiting_response';
  await pool.query(`
    UPDATE cases SET
      status = $2,
      substatus = NULL,
      requires_human = false,
      pause_reason = NULL,
      updated_at = NOW()
    WHERE id = $1
  `, [caseId, targetStatus]);

  console.log(`  DONE: Deleted all history, reset to ${targetStatus}`);
}

async function triggerReprocessing(caseId) {
  const prefix = DRY_RUN ? '[DRY RUN] ' : '';

  // Find latest inbound to reprocess
  const latestInbound = (await pool.query(`
    SELECT m.id
    FROM messages m JOIN email_threads t ON m.thread_id = t.id
    WHERE t.case_id = $1 AND m.direction = 'inbound'
    ORDER BY m.created_at DESC LIMIT 1
  `, [caseId])).rows[0];

  if (!latestInbound) {
    console.log(`  ${prefix}No inbound message to reprocess for case ${caseId}`);
    return;
  }

  console.log(`  ${prefix}Would trigger process-inbound for case ${caseId} with msg ${latestInbound.id}`);

  if (DRY_RUN) return;

  // Use the reset-to-last-inbound endpoint via HTTP to the running server
  // Or just trigger directly via Trigger.dev SDK
  const triggerDispatch = require('../services/trigger-dispatch-service');

  // Create agent run first
  const db = require('../services/database');
  const run = await db.createAgentRunFull({
    case_id: caseId,
    trigger_type: 'inbound_message',
    status: 'queued',
    autopilot_mode: 'SUPERVISED',
  });

  const { handle } = await triggerDispatch.triggerTask('process-inbound', {
    runId: run.id,
    caseId,
    messageId: latestInbound.id,
    autopilotMode: 'SUPERVISED',
  }, {
    queue: `case-${caseId}`,
    concurrencyKey: `case-${caseId}`,
  });

  console.log(`  Triggered process-inbound run ${run.id} (trigger: ${handle.id}) for case ${caseId}`);
}

async function main() {
  console.log(DRY_RUN ? '=== DRY RUN — no changes will be made ===' : '=== LIVE RUN — deleting history and resetting cases ===');
  console.log(`Target cases: ${TARGET_CASES.join(', ')}`);

  // Phase 1: Nuke all history
  for (const caseId of TARGET_CASES) {
    try {
      await nukeCase(caseId);
    } catch (err) {
      console.error(`  Case ${caseId}: NUKE FAILED — ${err.message}`);
    }
  }

  // Special fix for 25163: delete misrouted Fort Collins messages from Longview thread
  if (!DRY_RUN) {
    console.log('\n--- Fixing misrouted messages in case 25163 ---');
    const deleted = await pool.query(
      "DELETE FROM messages WHERE id IN (680, 681) AND thread_id = (SELECT id FROM email_threads WHERE case_id = 25163) RETURNING id"
    );
    console.log(`  Deleted ${deleted.rows.length} misrouted Fort Collins messages from Longview thread`);
  }

  if (!DRY_RUN) {
    console.log('\n--- Phase 2: Triggering fresh processing ---');
    for (const caseId of TARGET_CASES) {
      try {
        await triggerReprocessing(caseId);
      } catch (err) {
        console.error(`  Case ${caseId}: TRIGGER FAILED — ${err.message}`);
      }
    }
  }

  console.log('\n=== Done ===');
}

main()
  .catch(err => { console.error('Fatal:', err); process.exit(1); })
  .finally(() => pool.end().then(() => setTimeout(() => process.exit(0), 2000)));
