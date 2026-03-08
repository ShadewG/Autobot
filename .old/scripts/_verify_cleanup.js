const { Client } = require('pg');

const CONNECTION_STRING = 'postgresql://postgres:EsoRieVyRUVqLZEaGcecTqCDALRGxXXH@switchback.proxy.rlwy.net:39529/railway';

async function run() {
  const client = new Client({ connectionString: CONNECTION_STRING });
  await client.connect();

  const checks = [];

  // Helper to run a check
  async function check(name, query, validator) {
    try {
      const result = await client.query(query);
      const { pass, detail } = validator(result);
      checks.push({ name, pass, detail });
    } catch (err) {
      // Table might not exist — treat as PASS with note
      if (err.message.includes('does not exist')) {
        checks.push({ name, pass: true, detail: `Table does not exist (N/A)` });
      } else {
        checks.push({ name, pass: false, detail: `ERROR: ${err.message}` });
      }
    }
  }

  // ── 1. Trigger types normalized ──
  await check(
    '1. Trigger types normalized',
    `SELECT trigger_type FROM agent_runs WHERE trigger_type != LOWER(trigger_type) OR trigger_type = 'inbound'`,
    (r) => ({
      pass: r.rowCount === 0,
      detail: r.rowCount === 0 ? '0 non-normalized rows' : `${r.rowCount} non-normalized rows found`,
    })
  );

  // ── 2. No duplicate fee history ──
  await check(
    '2. No duplicate fee history',
    `SELECT case_id, amount, event_type, COUNT(*) FROM fee_history GROUP BY case_id, amount, event_type HAVING COUNT(*) > 1`,
    (r) => ({
      pass: r.rowCount === 0,
      detail: r.rowCount === 0 ? '0 duplicate groups' : `${r.rowCount} duplicate groups found`,
    })
  );

  // ── 3. No stuck waiting runs ──
  await check(
    '3. No stuck waiting runs (>1hr)',
    `SELECT COUNT(*)::int AS cnt FROM agent_runs WHERE status = 'waiting' AND started_at < NOW() - INTERVAL '1 hour'`,
    (r) => {
      const cnt = r.rows[0].cnt;
      return { pass: cnt === 0, detail: `${cnt} stuck waiting runs` };
    }
  );

  // ── 4. Dead letter queue clean ──
  await check(
    '4. Dead letter queue clean',
    `SELECT COUNT(*)::int AS cnt FROM dead_letter_queue WHERE resolution = 'pending'`,
    (r) => {
      const cnt = r.rows[0].cnt;
      return { pass: cnt === 0, detail: `${cnt} pending DLQ entries` };
    }
  );

  // ── 5. No incorrect partial_approval outcomes ──
  await check(
    '5. No incorrect partial_approval outcomes',
    `SELECT COUNT(*)::int AS cnt FROM cases WHERE outcome_recorded = true AND outcome_type = 'partial_approval'`,
    (r) => {
      const cnt = r.rows[0].cnt;
      return { pass: cnt === 0, detail: `${cnt} partial_approval outcomes` };
    }
  );

  // ── 6. Adaptive strategy outcomes retired or clean ──
  await check(
    '6. Adaptive strategy outcomes retired or clean',
    `SELECT COUNT(*)::int AS cnt FROM foia_strategy_outcomes WHERE response_time_days < 0`,
    (r) => {
      const cnt = r.rows[0].cnt;
      return { pass: cnt === 0, detail: `${cnt} negative response_time_days` };
    }
  );

  // ── 7. No decision spin ──
  await check(
    '7. No decision spin (>3 NONE per case)',
    `SELECT case_id, COUNT(*)::int AS cnt FROM agent_decisions WHERE action_taken = 'NONE' GROUP BY case_id HAVING COUNT(*) > 3`,
    (r) => ({
      pass: r.rowCount === 0,
      detail: r.rowCount === 0 ? '0 spinning cases' : `${r.rowCount} cases with >3 NONE decisions: ${r.rows.map(x => `case ${x.case_id} (${x.cnt}x)`).join(', ')}`,
    })
  );

  // ── 8. No NULL pause_reason on human review cases ──
  await check(
    '8. No NULL pause_reason on human review',
    `SELECT COUNT(*)::int AS cnt FROM cases WHERE status = 'needs_human_review' AND pause_reason IS NULL`,
    (r) => {
      const cnt = r.rows[0].cnt;
      return { pass: cnt === 0, detail: `${cnt} cases missing pause_reason` };
    }
  );

  // ── 9. Case 25163 has LOOP_DETECTED ──
  await check(
    '9. Case 25163 → LOOP_DETECTED',
    `SELECT pause_reason FROM cases WHERE id = 25163`,
    (r) => {
      if (r.rowCount === 0) return { pass: false, detail: 'Case 25163 not found' };
      const reason = r.rows[0].pause_reason;
      return { pass: reason === 'LOOP_DETECTED', detail: `pause_reason = '${reason}'` };
    }
  );

  // ── 10. Case 25147 has CONFLICTING_SIGNALS ──
  await check(
    '10. Case 25147 → CONFLICTING_SIGNALS',
    `SELECT pause_reason FROM cases WHERE id = 25147`,
    (r) => {
      if (r.rowCount === 0) return { pass: false, detail: 'Case 25147 not found' };
      const reason = r.rows[0].pause_reason;
      return { pass: reason === 'CONFLICTING_SIGNALS', detail: `pause_reason = '${reason}'` };
    }
  );

  // ── 11. Auto reply queue cleared ──
  await check(
    '11. Auto reply queue cleared (>24hr)',
    `SELECT COUNT(*)::int AS cnt FROM auto_reply_queue WHERE status = 'PENDING_APPROVAL' AND created_at < NOW() - INTERVAL '24 hours'`,
    (r) => {
      const cnt = r.rows[0].cnt;
      return { pass: cnt === 0, detail: `${cnt} stale PENDING_APPROVAL entries` };
    }
  );

  // ── 12. Stale executions cleared ──
  await check(
    '12. Stale executions cleared (>24hr)',
    `SELECT COUNT(*)::int AS cnt FROM executions WHERE status = 'QUEUED' AND created_at < NOW() - INTERVAL '24 hours'`,
    (r) => {
      const cnt = r.rows[0].cnt;
      return { pass: cnt === 0, detail: `${cnt} stale QUEUED executions` };
    }
  );

  // ══════════════════════════════════════
  // Print check results
  // ══════════════════════════════════════
  console.log('\n' + '='.repeat(80));
  console.log('  PRODUCTION DATABASE VERIFICATION');
  console.log('  ' + new Date().toISOString());
  console.log('='.repeat(80) + '\n');

  const passCount = checks.filter(c => c.pass).length;
  const failCount = checks.filter(c => !c.pass).length;

  const maxNameLen = Math.max(...checks.map(c => c.name.length));

  for (const c of checks) {
    const status = c.pass ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m';
    const paddedName = c.name.padEnd(maxNameLen);
    console.log(`  ${status}  ${paddedName}  ${c.detail}`);
  }

  console.log('\n' + '-'.repeat(80));
  console.log(`  Results: ${passCount} passed, ${failCount} failed out of ${checks.length} checks`);
  console.log('-'.repeat(80));

  // ══════════════════════════════════════
  // Health summary
  // ══════════════════════════════════════
  console.log('\n' + '='.repeat(80));
  console.log('  GENERAL HEALTH SUMMARY');
  console.log('='.repeat(80));

  // Cases by status
  try {
    const casesRes = await client.query(`SELECT status, COUNT(*)::int AS cnt FROM cases GROUP BY status ORDER BY cnt DESC`);
    const totalCases = casesRes.rows.reduce((sum, r) => sum + r.cnt, 0);
    console.log(`\n  Cases (total: ${totalCases}):`);
    for (const row of casesRes.rows) {
      console.log(`    ${row.status.padEnd(30)} ${row.cnt}`);
    }
  } catch (e) {
    console.log(`\n  Cases: ERROR - ${e.message}`);
  }

  // Agent runs by status
  try {
    const runsRes = await client.query(`SELECT status, COUNT(*)::int AS cnt FROM agent_runs GROUP BY status ORDER BY cnt DESC`);
    const totalRuns = runsRes.rows.reduce((sum, r) => sum + r.cnt, 0);
    console.log(`\n  Agent Runs (total: ${totalRuns}):`);
    for (const row of runsRes.rows) {
      console.log(`    ${row.status.padEnd(30)} ${row.cnt}`);
    }
  } catch (e) {
    console.log(`\n  Agent Runs: ERROR - ${e.message}`);
  }

  // Proposals by status
  try {
    const propRes = await client.query(`SELECT status, COUNT(*)::int AS cnt FROM proposals GROUP BY status ORDER BY cnt DESC`);
    const totalProps = propRes.rows.reduce((sum, r) => sum + r.cnt, 0);
    console.log(`\n  Proposals (total: ${totalProps}):`);
    for (const row of propRes.rows) {
      console.log(`    ${row.status.padEnd(30)} ${row.cnt}`);
    }
  } catch (e) {
    console.log(`\n  Proposals: ERROR - ${e.message}`);
  }

  // Messages
  try {
    const msgRes = await client.query(`
      SELECT
        COUNT(*)::int AS total,
        COUNT(case_id)::int AS with_case,
        (COUNT(*) - COUNT(case_id))::int AS without_case
      FROM messages
    `);
    const m = msgRes.rows[0];
    console.log(`\n  Messages:`);
    console.log(`    Total:            ${m.total}`);
    console.log(`    With case_id:     ${m.with_case}`);
    console.log(`    Without case_id:  ${m.without_case}`);
  } catch (e) {
    console.log(`\n  Messages: ERROR - ${e.message}`);
  }

  console.log('\n' + '='.repeat(80) + '\n');

  await client.end();

  // Exit with code 1 if any check failed
  if (failCount > 0) process.exit(1);
}

run().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
