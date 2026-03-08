/**
 * Reprocess old-system cases (agent_handled = false) through the new Run Engine.
 *
 * Handles three scenarios discovered during investigation:
 * 1. ALREADY_DONE — runs completed and proposals exist → just mark agent_handled = true
 * 2. NEEDS_RERUN — runs completed but zero proposals/traces (empty results) → clear processed_at, re-trigger
 * 3. FAILED_RUNS — all runs failed → clear processed_at on latest message, re-trigger
 *
 * Uses SUPERVISED autopilot mode — all proposals require manual approval, nothing auto-sends.
 *
 * Usage: DATABASE_URL=... node scripts/_reprocess_old_cases.js [--dry-run]
 */
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

const BASE_URL = process.env.BASE_URL || 'https://sincere-strength-production.up.railway.app';
const DRY_RUN = process.argv.includes('--dry-run');
const POLL_INTERVAL_MS = 5000;
const POLL_TIMEOUT_MS = 180000; // 3 minutes
const DELAY_BETWEEN_CASES_MS = 2000;

// Cat A case IDs — have inbound messages, agent_handled = false
const CAT_A_CASES = [49, 60, 726, 1660, 2593, 25147, 25149, 25153, 25156, 25158, 25169];

async function getCaseInfo(caseId) {
  const result = await pool.query(`
    SELECT id, case_name, status, agency_name, agent_handled, autopilot_mode
    FROM cases WHERE id = $1
  `, [caseId]);
  return result.rows[0] || null;
}

async function getLatestCompletedRun(caseId) {
  const result = await pool.query(`
    SELECT id, status, message_id, started_at, ended_at
    FROM agent_runs
    WHERE case_id = $1 AND status = 'completed'
    ORDER BY started_at DESC LIMIT 1
  `, [caseId]);
  return result.rows[0] || null;
}

async function getActiveRun(caseId) {
  const result = await pool.query(`
    SELECT id, status, trigger_type, started_at
    FROM agent_runs
    WHERE case_id = $1 AND status IN ('queued', 'running', 'created')
    LIMIT 1
  `, [caseId]);
  return result.rows[0] || null;
}

async function getProposalCount(caseId) {
  const result = await pool.query(`
    SELECT count(*) as total,
      count(*) filter (where status IN ('PENDING_APPROVAL', 'PENDING', 'DRAFT')) as pending,
      count(*) filter (where status = 'EXECUTED') as executed
    FROM proposals WHERE case_id = $1
  `, [caseId]);
  const r = result.rows[0];
  return { total: parseInt(r.total), pending: parseInt(r.pending), executed: parseInt(r.executed) };
}

async function getDecisionTraceCount(caseId) {
  const result = await pool.query(`
    SELECT count(*) as cnt FROM decision_traces WHERE case_id = $1
  `, [caseId]);
  return parseInt(result.rows[0].cnt);
}

async function getLatestInboundMessage(caseId) {
  const result = await pool.query(`
    SELECT m.id, m.subject, m.from_email, m.received_at, m.processed_at, m.processed_run_id
    FROM messages m
    WHERE m.case_id = $1 AND m.direction = 'inbound'
    ORDER BY m.received_at DESC NULLS LAST
    LIMIT 1
  `, [caseId]);
  return result.rows[0] || null;
}

async function clearProcessedAt(messageId) {
  await pool.query(`
    UPDATE messages SET processed_at = NULL, processed_run_id = NULL
    WHERE id = $1
  `, [messageId]);
}

// Verify the run that processed this message actually failed or produced no output
// before clearing processed_at — prevents wiping valid processing markers
async function shouldClearProcessedAt(caseId, processedRunId) {
  if (!processedRunId) return { ok: true, reason: 'no processed_run_id on message' };

  const result = await pool.query(`
    SELECT ar.id, ar.status,
      COALESCE(p.cnt, 0)::int AS proposal_count,
      COALESCE(dt.cnt, 0)::int AS trace_count
    FROM agent_runs ar
    LEFT JOIN (SELECT run_id, count(*) AS cnt FROM proposals GROUP BY run_id) p ON p.run_id = ar.id
    LEFT JOIN (SELECT run_id, count(*) AS cnt FROM decision_traces GROUP BY run_id) dt ON dt.run_id = ar.id
    WHERE ar.id = $1 AND ar.case_id = $2
    LIMIT 1
  `, [processedRunId, caseId]);

  const run = result.rows[0];
  if (!run) return { ok: true, reason: `run #${processedRunId} not found` };
  if (run.status === 'failed' || run.status === 'cancelled') return { ok: true, reason: `run #${processedRunId} ${run.status}` };
  if (run.status === 'completed' && run.proposal_count === 0 && run.trace_count === 0) return { ok: true, reason: `run #${processedRunId} completed with no output` };
  return { ok: false, reason: `run #${processedRunId} status=${run.status}, proposals=${run.proposal_count}, traces=${run.trace_count}` };
}

async function markAgentHandled(caseId) {
  await pool.query(`UPDATE cases SET agent_handled = true WHERE id = $1`, [caseId]);
}

async function triggerRunInbound(caseId, messageId) {
  const response = await fetch(`${BASE_URL}/api/cases/${caseId}/run-inbound`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messageId, autopilotMode: 'SUPERVISED' })
  });
  return { status: response.status, data: await response.json() };
}

async function pollRunStatus(runId) {
  const start = Date.now();
  while (Date.now() - start < POLL_TIMEOUT_MS) {
    const response = await fetch(`${BASE_URL}/api/runs/${runId}`);
    const data = await response.json();
    const run = data.run;

    if (!run) return { status: 'unknown', error: 'Run not found in response' };

    if (['completed', 'failed', 'paused', 'cancelled'].includes(run.status)) {
      return {
        status: run.status,
        error: run.error || null,
        proposals: data.proposals || [],
        endedAt: run.ended_at
      };
    }

    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
  }
  return { status: 'timeout', error: `Polling timed out after ${POLL_TIMEOUT_MS / 1000}s` };
}

// Categorize a case based on current DB state
async function categorizeCase(caseId) {
  const caseInfo = await getCaseInfo(caseId);
  if (!caseInfo) return { category: 'NOT_FOUND', caseInfo: null };

  const activeRun = await getActiveRun(caseId);
  if (activeRun) return { category: 'ACTIVE_RUN', caseInfo, activeRun };

  const proposals = await getProposalCount(caseId);
  const latestRun = await getLatestCompletedRun(caseId);
  const traces = await getDecisionTraceCount(caseId);
  const latestMsg = await getLatestInboundMessage(caseId);

  // Already has proposals from completed runs → done
  if (latestRun && proposals.total > 0) {
    return { category: 'ALREADY_DONE', caseInfo, proposals, latestRun, latestMsg };
  }

  // Completed run but zero proposals AND zero traces → empty run, needs re-trigger
  if (latestRun && proposals.total === 0 && traces === 0) {
    return { category: 'NEEDS_RERUN', caseInfo, proposals, latestRun, latestMsg, reason: 'completed run produced no proposals or traces' };
  }

  // No completed runs (all failed) → needs re-trigger
  if (!latestRun) {
    return { category: 'FAILED_RUNS', caseInfo, proposals, latestMsg, reason: 'no completed runs' };
  }

  return { category: 'UNKNOWN', caseInfo, proposals, latestRun, latestMsg };
}

async function main() {
  console.log(`\n${'='.repeat(70)}`);
  console.log(`  REPROCESS OLD-SYSTEM CASES THROUGH RUN ENGINE`);
  console.log(`  Mode: ${DRY_RUN ? 'DRY RUN (no changes)' : 'LIVE (SUPERVISED — proposals need approval)'}`);
  console.log(`  Target: ${CAT_A_CASES.length} Cat A cases`);
  console.log(`  API: ${BASE_URL}`);
  console.log(`${'='.repeat(70)}\n`);

  // Pre-flight: snapshot proposal counts
  const preFlightProposals = await pool.query(`
    SELECT case_id, count(*) as cnt FROM proposals WHERE case_id = ANY($1) GROUP BY case_id
  `, [CAT_A_CASES]);
  const proposalCountsBefore = {};
  for (const row of preFlightProposals.rows) {
    proposalCountsBefore[row.case_id] = parseInt(row.cnt);
  }

  // Phase 1: Categorize all cases
  console.log('--- Phase 1: Categorizing cases ---\n');
  const categorized = [];
  for (const caseId of CAT_A_CASES) {
    const cat = await categorizeCase(caseId);
    categorized.push({ caseId, ...cat });
    const info = cat.caseInfo;
    console.log(`  Case #${caseId}: ${cat.category}${info ? ` | ${info.status} | ${info.agency_name}` : ''}${cat.reason ? ` (${cat.reason})` : ''}`);
  }

  const alreadyDone = categorized.filter(c => c.category === 'ALREADY_DONE');
  const needsRerun = categorized.filter(c => c.category === 'NEEDS_RERUN' || c.category === 'FAILED_RUNS');
  const skipped = categorized.filter(c => !['ALREADY_DONE', 'NEEDS_RERUN', 'FAILED_RUNS'].includes(c.category));

  console.log(`\n  Summary: ${alreadyDone.length} already done, ${needsRerun.length} need rerun, ${skipped.length} skipped\n`);

  const results = [];

  // Phase 2: Mark already-done cases as agent_handled
  console.log('--- Phase 2: Marking already-done cases ---\n');
  for (const c of alreadyDone) {
    if (DRY_RUN) {
      console.log(`  Case #${c.caseId}: DRY RUN — would mark agent_handled = true (${c.proposals.total} proposals, ${c.proposals.executed} executed)`);
    } else {
      await markAgentHandled(c.caseId);
      console.log(`  Case #${c.caseId}: marked agent_handled = true (${c.proposals.total} proposals, ${c.proposals.executed} executed)`);
    }
    results.push({ caseId: c.caseId, outcome: 'MARKED_HANDLED', proposals: c.proposals });
  }

  // Phase 3: Reprocess cases that need it
  console.log('\n--- Phase 3: Reprocessing cases ---\n');
  for (let i = 0; i < needsRerun.length; i++) {
    const c = needsRerun[i];
    const caseId = c.caseId;
    console.log(`\n  [${i + 1}/${needsRerun.length}] Case #${caseId} (${c.category})`);

    if (!c.latestMsg) {
      console.log(`    SKIP: No inbound messages found`);
      results.push({ caseId, outcome: 'SKIP', reason: 'No inbound messages' });
      continue;
    }

    const msg = c.latestMsg;
    console.log(`    Latest inbound: Msg #${msg.id} — ${(msg.subject || '').substring(0, 60)}`);

    // Clear processed_at if message was marked processed by a failed/empty run
    if (msg.processed_at) {
      const clearCheck = await shouldClearProcessedAt(caseId, msg.processed_run_id);
      if (!clearCheck.ok) {
        console.log(`    SKIP: Not clearing processed_at — ${clearCheck.reason}`);
        results.push({ caseId, outcome: 'SKIP', reason: `processed_at safeguard: ${clearCheck.reason}` });
        continue;
      }
      if (DRY_RUN) {
        console.log(`    DRY RUN: Would clear processed_at on Msg #${msg.id} (${clearCheck.reason})`);
        console.log(`    DRY RUN: Would trigger run-inbound with Msg #${msg.id}`);
        results.push({ caseId, outcome: 'DRY_RUN', messageId: msg.id });
        continue;
      }
      console.log(`    Clearing processed_at on Msg #${msg.id} (${clearCheck.reason})`);
      await clearProcessedAt(msg.id);
    } else if (DRY_RUN) {
      console.log(`    DRY RUN: Would trigger run-inbound with Msg #${msg.id}`);
      results.push({ caseId, outcome: 'DRY_RUN', messageId: msg.id });
      continue;
    }

    // Trigger the run
    console.log(`    Triggering run-inbound with Msg #${msg.id}...`);
    const { status: httpStatus, data } = await triggerRunInbound(caseId, msg.id);

    if (httpStatus === 409) {
      console.log(`    CONFLICT (409): ${data.error}`);
      results.push({ caseId, outcome: 'CONFLICT', reason: data.error });
      continue;
    }

    if (!data.success) {
      console.log(`    ERROR (${httpStatus}): ${data.error}`);
      results.push({ caseId, outcome: 'ERROR', reason: data.error, httpStatus });
      continue;
    }

    const runId = data.run.id;
    console.log(`    Run #${runId} created (job: ${data.job_id}). Polling...`);

    const pollResult = await pollRunStatus(runId);
    console.log(`    Run #${runId} => ${pollResult.status}${pollResult.error ? ` (${pollResult.error})` : ''}`);

    if (pollResult.proposals && pollResult.proposals.length > 0) {
      for (const p of pollResult.proposals) {
        console.log(`      Proposal #${p.id}: ${p.action_type} [${p.status}]`);
      }
    }

    if (['completed', 'paused'].includes(pollResult.status)) {
      await markAgentHandled(caseId);
      console.log(`    Marked agent_handled = true`);
    }

    results.push({
      caseId,
      outcome: pollResult.status.toUpperCase(),
      runId,
      messageId: msg.id,
      proposals: (pollResult.proposals || []).map(p => ({ id: p.id, action: p.action_type, status: p.status })),
      error: pollResult.error
    });

    if (i < needsRerun.length - 1) {
      await new Promise(r => setTimeout(r, DELAY_BETWEEN_CASES_MS));
    }
  }

  // Phase 4: Report skipped cases
  for (const c of skipped) {
    results.push({ caseId: c.caseId, outcome: 'SKIP', reason: c.category });
  }

  // Summary
  console.log(`\n${'='.repeat(70)}`);
  console.log(`  RESULTS SUMMARY`);
  console.log(`${'='.repeat(70)}`);

  const byOutcome = {};
  for (const r of results) {
    byOutcome[r.outcome] = (byOutcome[r.outcome] || 0) + 1;
  }
  console.log(`\nOutcomes: ${JSON.stringify(byOutcome)}`);

  console.log(`\nPer-case:`);
  for (const r of results) {
    const parts = [`  Case #${r.caseId}: ${r.outcome}`];
    if (r.runId) parts.push(`Run #${r.runId}`);
    if (r.proposals && r.proposals.length > 0) {
      parts.push(`Proposals: ${r.proposals.map(p => `${p.action}[${p.status}]`).join(', ')}`);
    }
    if (r.reason) parts.push(`(${r.reason})`);
    if (r.error) parts.push(`Error: ${r.error}`);
    console.log(parts.join(' | '));
  }

  // Post-run verification
  if (!DRY_RUN) {
    console.log(`\n--- Safety Verification ---`);

    const queuedExecs = await pool.query(`
      SELECT e.id, e.case_id, e.action_type, e.status
      FROM executions e
      WHERE e.case_id = ANY($1) AND e.status = 'QUEUED'
    `, [CAT_A_CASES]);
    if (queuedExecs.rows.length === 0) {
      console.log(`  QUEUED executions: 0 (SAFE — nothing will auto-send)`);
    } else {
      console.log(`  WARNING: ${queuedExecs.rows.length} QUEUED execution(s) found!`);
      for (const e of queuedExecs.rows) {
        console.log(`    Execution #${e.id}: Case #${e.case_id} ${e.action_type}`);
      }
    }

    const postProposals = await pool.query(`
      SELECT case_id, count(*) as cnt FROM proposals WHERE case_id = ANY($1) GROUP BY case_id
    `, [CAT_A_CASES]);
    const proposalCountsAfter = {};
    for (const row of postProposals.rows) {
      proposalCountsAfter[row.case_id] = parseInt(row.cnt);
    }

    console.log(`\n--- Proposal Count Changes ---`);
    for (const caseId of CAT_A_CASES) {
      const before = proposalCountsBefore[caseId] || 0;
      const after = proposalCountsAfter[caseId] || 0;
      const diff = after - before;
      if (diff > 0) {
        console.log(`  Case #${caseId}: ${before} -> ${after} (+${diff})`);
      }
    }

    const newPending = await pool.query(`
      SELECT p.id, p.case_id, p.action_type, p.status, p.created_at
      FROM proposals p
      WHERE p.case_id = ANY($1) AND p.status IN ('PENDING_APPROVAL', 'PENDING')
      ORDER BY p.created_at DESC
    `, [CAT_A_CASES]);
    console.log(`\n--- Pending Proposals ---`);
    if (newPending.rows.length === 0) {
      console.log(`  None`);
    } else {
      for (const p of newPending.rows) {
        console.log(`  Proposal #${p.id}: Case #${p.case_id} ${p.action_type} [${p.status}] (${p.created_at})`);
      }
    }
  }

  console.log(`\n${'='.repeat(70)}`);
  console.log(`  DONE`);
  console.log(`${'='.repeat(70)}\n`);

  await pool.end();
  return results;
}

main()
  .then(results => {
    console.log('\nFull results JSON:');
    console.log(JSON.stringify(results, null, 2));
  })
  .catch(err => {
    console.error('FATAL:', err);
    process.exit(1);
  });
