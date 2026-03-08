/**
 * Comprehensive test for process-inbound ADJUSTMENT fast-path and decision actions.
 * Tests: ADJUST (simple), DISMISS, WITHDRAW, nested ADJUST
 *
 * Usage: TRIGGER_SECRET_KEY=<key> node scripts/_test_inbound_decisions.js
 */

const { tasks, wait } = require('@trigger.dev/sdk');
const { Pool } = require('pg');

const pool = new Pool({ connectionString: 'postgresql://postgres:EsoRieVyRUVqLZEaGcecTqCDALRGxXXH@switchback.proxy.rlwy.net:39529/railway' });

const CASE_ID = 25202; // Millbrook PD - REFORMULATE_REQUEST
const MESSAGE_ID = 666;  // Inbound message for this case

/**
 * Wait for a PENDING_APPROVAL proposal with a NEW token (handles dedup/reuse).
 * Polls every 5s. Ignores proposals with the excludeToken.
 */
async function waitForProposal(caseId, excludeToken = null, maxWaitMs = 180000) {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    const r = await pool.query(
      `SELECT id, action_type, status, waitpoint_token, draft_subject,
              LEFT(draft_body_text, 200) as draft_preview, LENGTH(draft_body_text) as draft_len
       FROM proposals WHERE case_id = $1 AND status = 'PENDING_APPROVAL'
       ORDER BY id DESC LIMIT 1`,
      [caseId]
    );
    // Wait for the REAL Trigger.dev token (starts with 'waitpoint_'), not the UUID placeholder
    if (r.rows.length > 0 && r.rows[0].waitpoint_token
        && r.rows[0].waitpoint_token.startsWith('waitpoint_')
        && r.rows[0].waitpoint_token !== excludeToken) {
      return r.rows[0];
    }
    await new Promise(r => setTimeout(r, 5000));
  }
  throw new Error(`No new proposal found for case ${caseId} after ${maxWaitMs/1000}s`);
}

async function triggerInboundAdjustment(caseId, messageId, originalActionType, originalProposalId, instruction) {
  const handle = await tasks.trigger('process-inbound', {
    caseId,
    messageId,
    autopilotMode: 'supervised',
    triggerType: 'ADJUSTMENT',
    originalActionType,
    originalProposalId,
    reviewInstruction: instruction,
  });
  console.log(`  Triggered run: ${handle.id}`);
  return handle;
}

async function completeToken(tokenId, action, extra = {}, retries = 3) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const result = await wait.completeToken(tokenId, { action, ...extra });
      console.log(`  Token completed (${action}): ${JSON.stringify(result)}`);
      return result;
    } catch (err) {
      if (attempt < retries && err.status >= 500) {
        console.log(`  Token completion failed (attempt ${attempt}/${retries}, status ${err.status}), retrying in 3s...`);
        await new Promise(r => setTimeout(r, 3000));
      } else {
        throw err;
      }
    }
  }
}

async function getLatestProposal(caseId) {
  const r = await pool.query(
    'SELECT id, action_type, status, waitpoint_token FROM proposals WHERE case_id = $1 ORDER BY id DESC LIMIT 1',
    [caseId]
  );
  return r.rows[0];
}

async function getCaseStatus(caseId) {
  const r = await pool.query('SELECT status, substatus FROM cases WHERE id = $1', [caseId]);
  return r.rows[0];
}

async function runTests() {
  console.log('=== PROCESS-INBOUND DECISION TESTS ===\n');

  // Get current state
  const existing = await getLatestProposal(CASE_ID);
  console.log(`Starting state: latest proposal ${existing?.id} (${existing?.status})\n`);
  let lastToken = existing?.waitpoint_token || null;
  let lastProposalId = existing?.id || 318;

  // ──────────────────────────────────────
  // TEST 1: ADJUST (simple) + DISMISS
  // ──────────────────────────────────────
  await pool.query("UPDATE cases SET status = 'needs_human_review', substatus = 'Test: pre-adjust-dismiss' WHERE id = $1", [CASE_ID]);

  console.log('TEST 1: ADJUST (simple tone change) + DISMISS');
  const handle1 = await triggerInboundAdjustment(
    CASE_ID, MESSAGE_ID, 'REFORMULATE_REQUEST', lastProposalId,
    'Make this much shorter. Use plain language, no legal terms. Under 80 words.'
  );
  console.log('  Waiting for proposal...');
  const proposal1 = await waitForProposal(CASE_ID, lastToken);
  console.log(`  Proposal ${proposal1.id}: ${proposal1.action_type} (${proposal1.draft_len} chars)`);
  console.log(`  Preview: ${proposal1.draft_preview?.substring(0, 100)}...`);

  console.log('  Sending DISMISS...');
  await completeToken(proposal1.waitpoint_token, 'DISMISS', { reason: 'Test dismiss' });
  await new Promise(r => setTimeout(r, 5000));

  const afterDismiss = await getLatestProposal(CASE_ID);
  const dismissPassed = afterDismiss?.status === 'DISMISSED';
  console.log(`  Result: proposal ${afterDismiss?.id} status = ${afterDismiss?.status}`);
  console.log(`  TEST 1 (ADJUST + DISMISS): ${dismissPassed ? 'PASSED ✓' : 'FAILED ✗'}\n`);
  lastToken = proposal1.waitpoint_token;
  lastProposalId = proposal1.id;

  // ──────────────────────────────────────
  // TEST 2: ADJUST + WITHDRAW
  // ──────────────────────────────────────
  await pool.query("UPDATE cases SET status = 'needs_human_review', substatus = 'Test: pre-withdraw' WHERE id = $1", [CASE_ID]);

  console.log('TEST 2: ADJUST + WITHDRAW');
  const handle2 = await triggerInboundAdjustment(
    CASE_ID, MESSAGE_ID, 'REFORMULATE_REQUEST', lastProposalId,
    'Add more detail about the specific records we need.'
  );
  console.log('  Waiting for proposal...');
  const proposal2 = await waitForProposal(CASE_ID, lastToken);
  console.log(`  Proposal ${proposal2.id}: ${proposal2.action_type} (${proposal2.draft_len} chars)`);

  console.log('  Sending WITHDRAW...');
  await completeToken(proposal2.waitpoint_token, 'WITHDRAW', { reason: 'Test withdraw' });
  await new Promise(r => setTimeout(r, 5000));

  const afterWithdraw = await getLatestProposal(CASE_ID);
  const caseAfterWithdraw = await getCaseStatus(CASE_ID);
  const withdrawPassed = afterWithdraw?.status === 'WITHDRAWN' && caseAfterWithdraw?.status === 'cancelled';
  console.log(`  Result: proposal ${afterWithdraw?.id} status = ${afterWithdraw?.status}, case = ${caseAfterWithdraw?.status}/${caseAfterWithdraw?.substatus}`);
  console.log(`  TEST 2 (ADJUST + WITHDRAW): ${withdrawPassed ? 'PASSED ✓' : 'FAILED ✗'}\n`);
  lastToken = proposal2.waitpoint_token;
  lastProposalId = proposal2.id;

  // ──────────────────────────────────────
  // TEST 3: ADJUST + nested ADJUST
  // ──────────────────────────────────────
  await pool.query("UPDATE cases SET status = 'needs_human_review', substatus = 'Test: pre-nested-adjust' WHERE id = $1", [CASE_ID]);

  console.log('TEST 3: ADJUST + nested ADJUST');
  const handle3 = await triggerInboundAdjustment(
    CASE_ID, MESSAGE_ID, 'REFORMULATE_REQUEST', lastProposalId,
    'Keep it formal but shorter.'
  );
  console.log('  Waiting for proposal...');
  const proposal3 = await waitForProposal(CASE_ID, lastToken);
  console.log(`  Proposal ${proposal3.id}: ${proposal3.action_type} (${proposal3.draft_len} chars)`);

  console.log('  Sending nested ADJUST...');
  await completeToken(proposal3.waitpoint_token, 'ADJUST', { instruction: 'Actually make it even shorter' });
  await new Promise(r => setTimeout(r, 8000));

  // After nested ADJUST: the original proposal should be DISMISSED, and a NEW proposal
  // may be created by a follow-up run. Check the ORIGINAL proposal status.
  const originalAfterAdjust = await pool.query(
    'SELECT id, status FROM proposals WHERE id = $1', [proposal3.id]
  );
  const nestedPassed = originalAfterAdjust.rows[0]?.status === 'DISMISSED';
  console.log(`  Result: original proposal ${proposal3.id} status = ${originalAfterAdjust.rows[0]?.status}`);
  const latest = await getLatestProposal(CASE_ID);
  if (latest?.id !== proposal3.id) {
    console.log(`  New proposal ${latest?.id} created (${latest?.status}) — expected from follow-up run`);
  }
  console.log(`  TEST 3 (nested ADJUST): ${nestedPassed ? 'PASSED ✓' : 'FAILED ✗'}\n`);

  // ──────────────────────────────────────
  // SUMMARY
  // ──────────────────────────────────────
  console.log('=== SUMMARY ===');
  console.log(`TEST 1 (ADJUST + DISMISS):  ${dismissPassed ? 'PASSED ✓' : 'FAILED ✗'}`);
  console.log(`TEST 2 (ADJUST + WITHDRAW): ${withdrawPassed ? 'PASSED ✓' : 'FAILED ✗'}`);
  console.log(`TEST 3 (nested ADJUST):     ${nestedPassed ? 'PASSED ✓' : 'FAILED ✗'}`);

  // Clean up case status
  await pool.query("UPDATE cases SET status = 'needs_human_review', substatus = 'Test case - cleaned up' WHERE id = $1", [CASE_ID]);
  await pool.end();
}

runTests().catch(err => {
  console.error('Test failed:', err);
  pool.end();
  process.exit(1);
});
