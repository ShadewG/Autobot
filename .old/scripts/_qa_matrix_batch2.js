require('dotenv').config({ path: '/Users/samuelhylton/Documents/gits/Autobot MVP/.env' });
const db = require('../services/database');
const base = 'http://127.0.0.1:3094';

async function j(url, opts = {}) {
  const res = await fetch(url, opts);
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text };
  }
  if (!res.ok) throw new Error(`${res.status} ${url} ${JSON.stringify(data)}`);
  return data;
}

async function createSeed({ name, email = 'shadewofficial@gmail.com', state = 'AZ' }) {
  const result = await db.query(
    `INSERT INTO cases (
      case_name, subject_name, agency_name, agency_email, state, status,
      notion_page_id, additional_details, autopilot_mode, requires_human,
      pause_reason, created_at, updated_at
    ) VALUES ($1,$2,$3,$4,$5,'draft',$6,$7,'SUPERVISED',false,NULL,NOW(),NOW()) RETURNING id`,
    [
      `QA Matrix ${name}`,
      'Jordan QA',
      name,
      email,
      state,
      `qa-matrix-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      'Synthetic QA seed'
    ]
  );
  return result.rows[0].id;
}

async function runScenario(scenario, decision = null, seed = {}) {
  const caseId = await createSeed({ name: 'Synthetic QA Records Unit, Arizona', ...seed });
  const runCreate = await j(`${base}/api/test/e2e/runs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ case_id: caseId, scenario, use_worker: false, deterministic: true, dry_run: false })
  });
  const runId = runCreate.run.id;
  let state = await j(`${base}/api/test/e2e/runs/${runId}/run-until-interrupt`, { method: 'POST' });
  if (state.run.status === 'awaiting_human' && decision) {
    await j(`${base}/api/test/e2e/runs/${runId}/human-decision`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(decision)
    });
    state = await j(`${base}/api/test/e2e/runs/${runId}/run-until-interrupt`, { method: 'POST' });
  }
  const finalRun = (await j(`${base}/api/test/e2e/runs/${runId}`)).run;
  return {
    scenario,
    caseId,
    runId,
    status: finalRun.status,
    failed: (finalRun.assertions || []).filter((a) => !a.passed),
    logs: (finalRun.logs || []).slice(-12)
  };
}

(async () => {
  const results = [];
  results.push(await runScenario('denial_strong_approve', { action: 'APPROVE' }));
  results.push(await runScenario('denial_strong_adjust', { action: 'ADJUST', instruction: 'Make the appeal more assertive and cite relevant case law' }));
  results.push(await runScenario('denial_strong_dismiss', { action: 'DISMISS' }));
  results.push(await runScenario('clarification_supervised_approve', { action: 'APPROVE' }));
  results.push(await runScenario('hostile'));
  results.push(await runScenario('portal_case', { action: 'APPROVE' }));
  results.push(await runScenario('followup_no_response'));
  console.log(JSON.stringify(results, null, 2));
  await db.pool.end();
})().catch(async (error) => {
  console.error(error);
  try { await db.pool.end(); } catch (_) {}
  process.exit(1);
});
