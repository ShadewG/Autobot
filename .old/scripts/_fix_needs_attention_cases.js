#!/usr/bin/env node
/**
 * One-time data fix for 4 misclassified "Needs Attention" cases.
 *
 * Case #49:   needs_phone_call → awaiting_response (agency replied with clarification)
 * Case #25136: stale substatus after SQL-approved proposal — reset and re-approve
 * Case #726:  ESCALATE proposal for deadline, but records are READY ($50 fee) — dismiss ESCALATE, create ACCEPT_FEE
 * Case #25151: needs_human_fee_approval from spurious GovQA fee detection → awaiting_response
 *
 * Usage: DATABASE_URL=<url> node scripts/_fix_needs_attention_cases.js
 */

const { Pool } = require('pg');

const DATABASE_URL = process.env.DATABASE_URL || process.env.DATABASE_PUBLIC_URL;
if (!DATABASE_URL) {
  console.error('ERROR: Set DATABASE_URL or DATABASE_PUBLIC_URL');
  process.exit(1);
}

const pool = new Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } });

async function fixCase49() {
  console.log('\n--- Case #49: needs_phone_call → awaiting_response ---');

  const caseResult = await pool.query('SELECT id, status, substatus FROM cases WHERE id = 49');
  if (caseResult.rows.length === 0) { console.log('Case #49 not found, skipping'); return; }
  console.log('  Current:', caseResult.rows[0]);

  // Update status
  await pool.query(
    `UPDATE cases SET status = 'awaiting_response',
       substatus = 'Agency sent clarification question — awaiting our reply',
       updated_at = NOW()
     WHERE id = 49`
  );

  // Remove from phone call queue
  const deleted = await pool.query('DELETE FROM phone_call_queue WHERE case_id = 49 RETURNING id');
  console.log(`  Removed ${deleted.rowCount} phone_call_queue entries`);

  // Log activity
  await pool.query(
    `INSERT INTO activity_log (event_type, case_id, description, metadata, created_at)
     VALUES ('data_fix', 49, 'Case #49: needs_phone_call → awaiting_response (agency replied with clarification)', $1, NOW())`,
    [JSON.stringify({ fix: 'needs_attention_audit' })]
  );

  console.log('  Fixed: Case #49 → awaiting_response');
}

async function fixCase25136() {
  console.log('\n--- Case #25136: Re-approve proposal #174 ---');

  const caseResult = await pool.query('SELECT id, status, substatus FROM cases WHERE id = 25136');
  if (caseResult.rows.length === 0) { console.log('Case #25136 not found, skipping'); return; }
  console.log('  Current:', caseResult.rows[0]);

  // Check proposal #174
  const proposal = await pool.query('SELECT id, status, action_type, human_decision FROM proposals WHERE id = 174');
  if (proposal.rows.length === 0) { console.log('Proposal #174 not found, skipping'); return; }
  console.log('  Proposal #174:', proposal.rows[0]);

  // Reset proposal to PENDING_APPROVAL so it can be properly approved via the dashboard
  await pool.query(
    `UPDATE proposals SET status = 'PENDING_APPROVAL', human_decision = NULL, updated_at = NOW()
     WHERE id = 174`
  );

  // Log activity
  await pool.query(
    `INSERT INTO activity_log (event_type, case_id, description, metadata, created_at)
     VALUES ('data_fix', 25136, 'Case #25136: Reset proposal #174 to PENDING_APPROVAL for re-approval', $1, NOW())`,
    [JSON.stringify({ proposal_id: 174, fix: 'needs_attention_audit' })]
  );

  console.log('  Fixed: Proposal #174 reset to PENDING_APPROVAL — approve via dashboard to trigger graph run');
}

async function fixCase726() {
  console.log('\n--- Case #726: Dismiss ESCALATE, create ACCEPT_FEE proposal ---');

  const caseResult = await pool.query('SELECT id, status, substatus, case_name FROM cases WHERE id = 726');
  if (caseResult.rows.length === 0) { console.log('Case #726 not found, skipping'); return; }
  console.log('  Current:', caseResult.rows[0]);

  // Dismiss proposal #177 (ESCALATE)
  const dismissed = await pool.query(
    `UPDATE proposals SET status = 'DISMISSED', human_decision = $1, updated_at = NOW()
     WHERE id = 177 AND case_id = 726 RETURNING id`,
    [JSON.stringify({ action: 'dismiss', reason: 'data_fix' })]
  );
  console.log(`  Dismissed ${dismissed.rowCount} ESCALATE proposal(s)`);

  // Create ACCEPT_FEE proposal for the $50 records fee
  const caseName = caseResult.rows[0].case_name || 'Case #726';
  const today = new Date().toISOString().slice(0, 10);
  const reasoning = [
    { step: 'Records ready', detail: 'Agency confirmed records are ready for $50 fee' },
    { step: 'Data fix', detail: 'Original ESCALATE proposal dismissed — records were actually available' }
  ];
  await pool.query(
    `INSERT INTO proposals (proposal_key, case_id, action_type, reasoning, confidence, requires_human, can_auto_execute, draft_subject, draft_body_text, status, created_at, updated_at)
     VALUES ($1, 726, 'ACCEPT_FEE', $2, 0.8, true, false, $3, $4, 'PENDING_APPROVAL', NOW(), NOW())`,
    [
      `726:data_fix:ACCEPT_FEE:${today}`,
      JSON.stringify(reasoning),
      `Fee payment: ${caseName}`,
      `Records are ready. Agency quoted $50 fee for records. Recommend accepting.`
    ]
  );

  // Update case status to needs_human_fee_approval with correct context
  await pool.query(
    `UPDATE cases SET status = 'needs_human_fee_approval',
       substatus = 'Records ready — $50 fee. Accept to proceed.',
       updated_at = NOW()
     WHERE id = 726`
  );

  // Log activity
  await pool.query(
    `INSERT INTO activity_log (event_type, case_id, description, metadata, created_at)
     VALUES ('data_fix', 726, 'Case #726: Dismissed ESCALATE #177, created ACCEPT_FEE proposal for $50', $1, NOW())`,
    [JSON.stringify({ dismissed_proposal: 177, fix: 'needs_attention_audit' })]
  );

  console.log('  Fixed: ESCALATE dismissed, ACCEPT_FEE proposal created for $50');
}

async function fixCase25151() {
  console.log('\n--- Case #25151: Spurious fee detection → awaiting_response ---');

  const caseResult = await pool.query('SELECT id, status, substatus FROM cases WHERE id = 25151');
  if (caseResult.rows.length === 0) { console.log('Case #25151 not found, skipping'); return; }
  console.log('  Current:', caseResult.rows[0]);

  // Update status
  await pool.query(
    `UPDATE cases SET status = 'awaiting_response',
       substatus = NULL,
       updated_at = NOW()
     WHERE id = 25151`
  );

  // Log activity
  await pool.query(
    `INSERT INTO activity_log (event_type, case_id, description, metadata, created_at)
     VALUES ('data_fix', 25151, 'Case #25151: needs_human_fee_approval → awaiting_response (spurious GovQA fee detection)', $1, NOW())`,
    [JSON.stringify({ fix: 'needs_attention_audit' })]
  );

  console.log('  Fixed: Case #25151 → awaiting_response (fee substatus cleared)');
}

async function main() {
  console.log('=== Needs Attention Queue — Data Fixes ===');
  console.log(`Database: ${DATABASE_URL.replace(/:[^@]+@/, ':***@')}`);

  try {
    await fixCase49();
    await fixCase25136();
    await fixCase726();
    await fixCase25151();

    console.log('\n=== All data fixes complete ===');

    // Verify final states
    console.log('\nVerification:');
    const verify = await pool.query(
      `SELECT id, status, substatus FROM cases WHERE id IN (49, 726, 25136, 25151) ORDER BY id`
    );
    for (const row of verify.rows) {
      console.log(`  Case #${row.id}: status=${row.status}, substatus=${row.substatus || '(null)'}`);
    }
  } catch (error) {
    console.error('ERROR:', error.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

main();
