#!/usr/bin/env node
/**
 * Production Cleanup Audit Script
 *
 * Performs idempotent cleanup operations on the production database.
 * Safe to run multiple times - each operation checks preconditions before acting.
 *
 * Usage: node scripts/cleanup-audit.js
 */
const { Pool } = require('pg');

const CONNECTION_STRING = 'postgresql://postgres:EsoRieVyRUVqLZEaGcecTqCDALRGxXXH@switchback.proxy.rlwy.net:39529/railway';

const pool = new Pool({
  connectionString: CONNECTION_STRING,
  ssl: { rejectUnauthorized: false },
});

const summary = [];

function log(msg) {
  console.log(`\n${'='.repeat(70)}`);
  console.log(`  ${msg}`);
  console.log('='.repeat(70));
}

function record(step, rowCount) {
  summary.push({ step, rowCount });
  console.log(`  -> ${rowCount} row(s) affected`);
}

async function runStep(client, stepNumber, description, queries) {
  log(`Step ${stepNumber}: ${description}`);

  let totalAffected = 0;
  for (const { label, sql, params } of queries) {
    if (label) console.log(`  [${label}]`);
    console.log(`  SQL: ${sql.trim().replace(/\s+/g, ' ').substring(0, 120)}...`);
    const result = await client.query(sql, params || []);
    const affected = result.rowCount || 0;
    console.log(`  -> ${affected} row(s) affected`);
    totalAffected += affected;
  }

  record(description, totalAffected);
  return totalAffected;
}

(async () => {
  console.log('Cleanup Audit Script - Production Database');
  console.log(`Started at: ${new Date().toISOString()}`);
  console.log(`Database: switchback.proxy.rlwy.net:39529/railway`);

  const client = await pool.connect();

  try {
    // ---------------------------------------------------------------
    // Step 1: Normalize trigger types to lowercase
    // ---------------------------------------------------------------
    await client.query('BEGIN');
    try {
      await runStep(client, 1, 'Normalize trigger types to lowercase', [
        {
          label: 'Lowercase all trigger_type values',
          sql: `
            UPDATE agent_runs
            SET trigger_type = LOWER(trigger_type)
            WHERE trigger_type != LOWER(trigger_type);
          `,
        },
        {
          label: 'Normalize "inbound" variant to "inbound_message"',
          sql: `
            UPDATE agent_runs
            SET trigger_type = 'inbound_message'
            WHERE trigger_type = 'inbound';
          `,
        },
      ]);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      console.error(`  FAILED: ${err.message}`);
      record('Normalize trigger types (FAILED)', 0);
    }

    // ---------------------------------------------------------------
    // Step 2: Remove duplicate fee history entries
    // ---------------------------------------------------------------
    await client.query('BEGIN');
    try {
      await runStep(client, 2, 'Remove duplicate fee history entries (keep earliest per case_id+amount+event_type)', [
        {
          label: 'Delete duplicate fee_history rows',
          sql: `
            DELETE FROM fee_history
            WHERE id NOT IN (
              SELECT MIN(id) FROM fee_history GROUP BY case_id, amount, event_type
            );
          `,
        },
      ]);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      console.error(`  FAILED: ${err.message}`);
      record('Remove duplicate fee history (FAILED)', 0);
    }

    // ---------------------------------------------------------------
    // Step 3: Mark stuck waiting runs as failed
    // ---------------------------------------------------------------
    await client.query('BEGIN');
    try {
      await runStep(client, 3, 'Mark stuck waiting agent_runs as failed (>1 hour old)', [
        {
          label: 'Fail stuck waiting runs',
          sql: `
            UPDATE agent_runs
            SET status = 'failed',
                error = 'Cleaned up: stuck in waiting state during audit cleanup',
                ended_at = NOW()
            WHERE status = 'waiting'
              AND started_at < NOW() - INTERVAL '1 hour';
          `,
        },
      ]);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      console.error(`  FAILED: ${err.message}`);
      record('Mark stuck waiting runs (FAILED)', 0);
    }

    // ---------------------------------------------------------------
    // Step 4: Resolve dead letter queue items
    // ---------------------------------------------------------------
    await client.query('BEGIN');
    try {
      await runStep(client, 4, 'Resolve dead letter queue items', [
        {
          label: 'Resolve text.replace bug items',
          sql: `
            UPDATE dead_letter_queue
            SET resolution = 'resolved',
                processed_at = NOW(),
                resolution_notes = 'Audit cleanup: text.replace bug - non-string body_text passed to string method. Root cause fixed in code.'
            WHERE resolution = 'pending'
              AND error_message LIKE '%text.replace is not a function%';
          `,
        },
        {
          label: 'Resolve accept_fee unknown email type item',
          sql: `
            UPDATE dead_letter_queue
            SET resolution = 'resolved',
                processed_at = NOW(),
                resolution_notes = 'Audit cleanup: accept_fee email type not yet implemented. Will be handled by fee negotiation code fix.'
            WHERE resolution = 'pending'
              AND error_message LIKE '%Unknown email type: accept_fee%';
          `,
        },
      ]);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      console.error(`  FAILED: ${err.message}`);
      record('Resolve dead letter queue items (FAILED)', 0);
    }

    // ---------------------------------------------------------------
    // Step 5: Fix strategy outcomes
    // ---------------------------------------------------------------
    await client.query('BEGIN');
    try {
      await runStep(client, 5, 'Fix strategy outcomes (partial_approval + negative response times)', [
        {
          label: 'Reset incorrect partial_approval outcomes on cases',
          sql: `
            UPDATE cases
            SET outcome_type = NULL,
                outcome_recorded = false
            WHERE outcome_recorded = true
              AND outcome_type = 'partial_approval';
          `,
        },
        {
          label: 'Null out negative response_time_days',
          sql: `
            UPDATE foia_strategy_outcomes
            SET response_time_days = NULL
            WHERE response_time_days < 0;
          `,
        },
        {
          label: 'Delete partial_approval outcomes with empty strategy_config',
          sql: `
            DELETE FROM foia_strategy_outcomes
            WHERE outcome_type = 'partial_approval'
              AND (strategy_config IS NULL OR strategy_config::text = '{}');
          `,
        },
      ]);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      console.error(`  FAILED: ${err.message}`);
      record('Fix strategy outcomes (FAILED)', 0);
    }

    // ---------------------------------------------------------------
    // Step 6: Clean up case 25175 decision spin (16 NONE decisions)
    // ---------------------------------------------------------------
    await client.query('BEGIN');
    try {
      await runStep(client, 6, 'Clean up case 25175 NONE decision spin (keep most recent)', [
        {
          label: 'Delete extra NONE decisions for case 25175',
          sql: `
            DELETE FROM agent_decisions
            WHERE case_id = 25175
              AND action_taken = 'NONE'
              AND id != (SELECT MAX(id) FROM agent_decisions WHERE case_id = 25175 AND action_taken = 'NONE');
          `,
        },
      ]);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      console.error(`  FAILED: ${err.message}`);
      record('Clean up case 25175 decision spin (FAILED)', 0);
    }

    // ---------------------------------------------------------------
    // Step 7: Clean up auto_reply_queue stuck items
    // ---------------------------------------------------------------
    await client.query('BEGIN');
    try {
      await runStep(client, 7, 'Cancel stale PENDING_APPROVAL auto_reply_queue items (>24 hours)', [
        {
          label: 'Cancel stale auto_reply_queue items',
          sql: `
            UPDATE auto_reply_queue
            SET status = 'CANCELLED'
            WHERE status = 'PENDING_APPROVAL'
              AND created_at < NOW() - INTERVAL '24 hours';
          `,
        },
      ]);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      console.error(`  FAILED: ${err.message}`);
      record('Cancel stale auto_reply_queue items (FAILED)', 0);
    }

    // ---------------------------------------------------------------
    // Step 8: Clean up stuck QUEUED executions
    // ---------------------------------------------------------------
    await client.query('BEGIN');
    try {
      await runStep(client, 8, 'Cancel stale QUEUED executions (>24 hours)', [
        {
          label: 'Cancel stale QUEUED executions',
          sql: `
            UPDATE executions
            SET status = 'CANCELLED',
                error_message = 'Audit cleanup: stale QUEUED execution'
            WHERE status = 'QUEUED'
              AND created_at < NOW() - INTERVAL '24 hours';
          `,
        },
      ]);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      console.error(`  FAILED: ${err.message}`);
      record('Cancel stale QUEUED executions (FAILED)', 0);
    }

    // ---------------------------------------------------------------
    // Step 9-11 prerequisite: Expand pause_reason constraint
    // ---------------------------------------------------------------
    await client.query('BEGIN');
    try {
      await runStep(client, '9-pre', 'Expand chk_pause_reason constraint to include new values', [
        {
          label: 'Drop old constraint and add expanded one',
          sql: `
            ALTER TABLE cases DROP CONSTRAINT IF EXISTS chk_pause_reason;
            ALTER TABLE cases ADD CONSTRAINT chk_pause_reason CHECK (
              pause_reason IS NULL OR pause_reason IN (
                'FEE_QUOTE', 'SCOPE', 'DENIAL', 'ID_REQUIRED', 'SENSITIVE',
                'CLOSE_ACTION', 'TIMED_OUT', 'PENDING_APPROVAL', 'INITIAL_REQUEST',
                'EMAIL_FAILED', 'LOOP_DETECTED', 'CONFLICTING_SIGNALS', 'UNSPECIFIED'
              )
            );
          `,
        },
      ]);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      console.error(`  FAILED: ${err.message}`);
      record('Expand chk_pause_reason constraint (FAILED)', 0);
    }

    // ---------------------------------------------------------------
    // Step 9: Mark case 25163 for human review (runaway loop)
    // ---------------------------------------------------------------
    await client.query('BEGIN');
    try {
      await runStep(client, 9, 'Mark case 25163 for human review (portal notification loop)', [
        {
          label: 'Set pause_reason and substatus on case 25163',
          sql: `
            UPDATE cases
            SET pause_reason = 'LOOP_DETECTED',
                substatus = 'Portal notification loop detected - 126 failed runs cleaned'
            WHERE id = 25163
              AND (pause_reason IS DISTINCT FROM 'LOOP_DETECTED'
                   OR substatus IS DISTINCT FROM 'Portal notification loop detected - 126 failed runs cleaned');
          `,
        },
      ]);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      console.error(`  FAILED: ${err.message}`);
      record('Mark case 25163 for review (FAILED)', 0);
    }

    // ---------------------------------------------------------------
    // Step 10: Fix case 25147 contradictory state
    // ---------------------------------------------------------------
    await client.query('BEGIN');
    try {
      await runStep(client, 10, 'Fix case 25147 contradictory state (records_received + DENIAL)', [
        {
          label: 'Update case 25147 to reflect conflicting signals',
          sql: `
            UPDATE cases
            SET substatus = 'Conflicting signals: records_received + denial response',
                pause_reason = 'CONFLICTING_SIGNALS'
            WHERE id = 25147
              AND status = 'needs_human_review'
              AND substatus = 'records_received'
              AND pause_reason = 'DENIAL';
          `,
        },
      ]);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      console.error(`  FAILED: ${err.message}`);
      record('Fix case 25147 contradictory state (FAILED)', 0);
    }

    // ---------------------------------------------------------------
    // Step 11: Set pause_reason on needs_human_review cases with NULL
    // ---------------------------------------------------------------
    await client.query('BEGIN');
    try {
      await runStep(client, 11, 'Set pause_reason=UNSPECIFIED on needs_human_review cases with NULL pause_reason', [
        {
          label: 'Fill in missing pause_reason values',
          sql: `
            UPDATE cases
            SET pause_reason = 'UNSPECIFIED'
            WHERE status = 'needs_human_review'
              AND pause_reason IS NULL;
          `,
        },
      ]);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      console.error(`  FAILED: ${err.message}`);
      record('Set NULL pause_reason to UNSPECIFIED (FAILED)', 0);
    }

    // ---------------------------------------------------------------
    // Summary
    // ---------------------------------------------------------------
    console.log('\n');
    console.log('='.repeat(70));
    console.log('  CLEANUP AUDIT SUMMARY');
    console.log('='.repeat(70));
    console.log('');

    let totalRows = 0;
    for (const { step, rowCount } of summary) {
      const status = step.includes('FAILED') ? 'FAILED' : 'OK';
      console.log(`  [${status}] ${step}: ${rowCount} row(s)`);
      totalRows += rowCount;
    }

    console.log('');
    console.log(`  Total rows affected: ${totalRows}`);
    console.log(`  Completed at: ${new Date().toISOString()}`);
    console.log('='.repeat(70));

  } catch (err) {
    console.error('\nFATAL ERROR:', err.message);
    console.error(err.stack);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
})();
