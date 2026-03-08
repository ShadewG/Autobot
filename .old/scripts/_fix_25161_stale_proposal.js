#!/usr/bin/env node
/**
 * One-time fix: Case 25161 has a stale DECLINE_FEE proposal (#485) and is stuck
 * in NEEDS_HUMAN_REVIEW even though a fee negotiation was already sent on Feb 25.
 *
 * This script:
 * 1. Dismisses proposal 485
 * 2. Clears requires_human / pause_reason
 * 3. Sets status to awaiting_response
 * 4. Marks the stale waiting run 883 as failed
 *
 * Usage: DATABASE_URL=... node scripts/_fix_25161_stale_proposal.js
 */

const { Pool } = require('pg');

async function main() {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : { rejectUnauthorized: false },
  });

  try {
    // 1. Check and dismiss proposal
    const p = await pool.query('SELECT id, status, action_type, waitpoint_token FROM proposals WHERE id = 485');
    const proposal = p.rows[0];
    console.log('Proposal 485:', proposal ? `${proposal.status} / ${proposal.action_type}` : 'NOT FOUND');

    if (proposal && proposal.status === 'PENDING_APPROVAL') {
      await pool.query(
        `UPDATE proposals SET status = 'DISMISSED', human_decision = '"DISMISS"'::jsonb, human_decided_at = NOW(), updated_at = NOW() WHERE id = 485`
      );
      console.log('  -> Dismissed');
    } else {
      console.log('  -> Skipping (not PENDING_APPROVAL)');
    }

    // 2. Fix case status
    await pool.query(
      `UPDATE cases SET requires_human = false, pause_reason = NULL, status = 'awaiting_response', substatus = 'fee_negotiation_sent', updated_at = NOW() WHERE id = 25161`
    );
    console.log('Case 25161 -> awaiting_response, requires_human=false');

    // 3. Fail the stale waiting run
    const runResult = await pool.query(
      `UPDATE agent_runs SET status = 'failed', error = 'Stale run dismissed - fee negotiation already sent', completed_at = NOW() WHERE case_id = 25161 AND status = 'waiting'`
    );
    console.log(`Stale waiting runs marked failed: ${runResult.rowCount}`);

    // 4. Log activity
    await pool.query(
      `INSERT INTO activity_log (case_id, event_type, description, metadata) VALUES ($1, $2, $3, $4)`,
      [25161, 'human_decision', 'Manual fix: dismissed stale DECLINE_FEE proposal #485 and cleared review state - fee negotiation already sent Feb 25', '{}']
    );
    console.log('Activity logged');

    // 5. Verify
    const c = await pool.query('SELECT status, requires_human, pause_reason, substatus FROM cases WHERE id = 25161');
    console.log('\nVerified:', c.rows[0]);
  } catch (err) {
    console.error('Error:', err.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

main();
