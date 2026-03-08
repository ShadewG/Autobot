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

async function jRetry(url, opts = {}, attempts = 4, delayMs = 500) {
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await j(url, opts);
    } catch (error) {
      lastError = error;
      const message = String(error?.message || '');
      const retryable =
        /timeout exceeded when trying to connect/i.test(message) ||
        /ECONNRESET/i.test(message) ||
        /socket hang up/i.test(message) ||
        /connection terminated/i.test(message);
      if (!retryable || attempt === attempts) break;
      await new Promise((resolve) => setTimeout(resolve, delayMs * attempt));
    }
  }
  throw lastError;
}

async function waitForProposal(caseId, attempts = 25, delayMs = 250) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const data = await j(`${base}/api/requests/${caseId}/proposals`);
    const proposal = data.proposals?.[0] || null;
    if (proposal) return proposal;
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  return null;
}

async function createReadyCase(label) {
  const result = await db.query(
    `INSERT INTO cases (
      case_name, subject_name, agency_name, agency_email, state, status,
      notion_page_id, additional_details, autopilot_mode, requires_human,
      pause_reason, created_at, updated_at
    ) VALUES ($1,$2,$3,$4,$5,'ready_to_send',$6,$7,'SUPERVISED',false,NULL,NOW(),NOW()) RETURNING id`,
    [
      `QA Initial ${label}`,
      'Jordan QA',
      'Synthetic QA Records Unit, Arizona',
      'shadewofficial@gmail.com',
      'AZ',
      `qa-initial-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      'Synthetic QA ready_to_send seed'
    ]
  );
  return result.rows[0].id;
}

async function runInitialCase({ label, draft, decision = null }) {
  const caseId = await createReadyCase(label);
  const runResp = await j(`${base}/api/cases/${caseId}/run-initial`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      autopilotMode: 'SUPERVISED',
      llmStubs: { draft }
    })
  });

  const proposal = await waitForProposal(caseId);
  if (!proposal) throw new Error(`No proposal created for case ${caseId}`);

  let decisionResp = null;
  if (decision) {
    decisionResp = await jRetry(`${base}/api/proposals/${proposal.id}/decision`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(decision)
    });
  }

  const workspace = await j(`${base}/api/requests/${caseId}/workspace`);
  const proposalState = await j(`${base}/api/requests/${caseId}/proposals`);
  return {
    label,
    caseId,
    initialRun: runResp,
    proposalId: proposal.id,
    decision: decisionResp,
    workspace: {
      request_status: workspace.request?.status,
      review_state: workspace.review_state,
      control_state: workspace.control_state,
      next_action: workspace.next_action_proposal?.action_type || null,
      pending_action: workspace.pending_proposal?.action_type || null,
      active_run_status: workspace.active_run?.status || null
    },
    proposals: proposalState.proposals.map((p) => ({
      id: p.id,
      status: p.status,
      action_type: p.action_type,
      draft_subject: p.draft_subject
    }))
  };
}

(async () => {
  const results = [];
  results.push(await runInitialCase({
    label: 'approve',
    draft: {
      subject: 'Synthetic QA Initial Request',
      body: 'To Synthetic QA Records Unit,\n\nPlease provide the requested records for Jordan QA.\n\nThank you.'
    },
    decision: { action: 'APPROVE' }
  }));
  results.push(await runInitialCase({
    label: 'adjust',
    draft: {
      subject: 'Synthetic QA Initial Request',
      body: 'To Synthetic QA Records Unit,\n\nPlease provide the requested records for Jordan QA.\n\nThank you.'
    },
    decision: { action: 'ADJUST', instruction: 'Add one sentence noting this is a time-sensitive public records request.' }
  }));
  results.push(await runInitialCase({
    label: 'dismiss',
    draft: {
      subject: 'Synthetic QA Initial Request',
      body: 'To Synthetic QA Records Unit,\n\nPlease provide the requested records for Jordan QA.\n\nThank you.'
    },
    decision: { action: 'DISMISS' }
  }));
  console.log(JSON.stringify(results, null, 2));
  await db.pool.end();
})().catch(async (error) => {
  console.error(error);
  try { await db.pool.end(); } catch (_) {}
  process.exit(1);
});
