#!/usr/bin/env node
/**
 * Migration Verification Script
 *
 * Verifies that all reliability constraints and indexes are properly set up.
 * Run on a fresh DB or staging copy to confirm migrations work correctly.
 *
 * Usage:
 *   node scripts/verify-migrations.js
 *   DATABASE_URL=postgres://... node scripts/verify-migrations.js
 */

const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://localhost:5432/autobot_test'
});

async function verify() {
  console.log('🔍 Migration Verification Starting...\n');
  const results = { passed: 0, failed: 0, warnings: 0 };

  try {
    // =========================================================================
    // 1. UNIQUE CONSTRAINTS FOR IDEMPOTENCY
    // =========================================================================
    console.log('📋 Checking UNIQUE CONSTRAINTS for idempotency...');

    const constraints = await pool.query(`
      SELECT
        tc.table_name,
        tc.constraint_name,
        kcu.column_name
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu
        ON tc.constraint_name = kcu.constraint_name
      WHERE tc.constraint_type = 'UNIQUE'
        AND tc.table_schema = 'public'
        AND (
          tc.constraint_name LIKE '%execution_key%'
          OR tc.constraint_name LIKE '%proposal_key%'
          OR kcu.column_name IN ('execution_key', 'proposal_key')
        )
      ORDER BY tc.table_name, tc.constraint_name
    `);

    const requiredConstraints = [
      { table: 'auto_reply_queue', column: 'execution_key' },
      { table: 'proposals', column: 'proposal_key' },
      { table: 'proposals', column: 'execution_key' }
    ];

    for (const req of requiredConstraints) {
      const found = constraints.rows.find(
        r => r.table_name === req.table && r.column_name === req.column
      );
      if (found) {
        console.log(`  ✅ ${req.table}.${req.column} - UNIQUE constraint exists`);
        results.passed++;
      } else {
        console.log(`  ❌ ${req.table}.${req.column} - UNIQUE constraint MISSING`);
        results.failed++;
      }
    }

    // =========================================================================
    // 2. INDEXES ON FREQUENTLY QUERIED COLUMNS
    // =========================================================================
    console.log('\n📋 Checking INDEXES on frequently queried columns...');

    const indexes = await pool.query(`
      SELECT
        tablename,
        indexname,
        indexdef
      FROM pg_indexes
      WHERE schemaname = 'public'
      ORDER BY tablename, indexname
    `);

    const requiredIndexes = [
      { table: 'cases', column: 'id', name: 'cases_pkey' },
      { table: 'cases', column: 'status', name: 'idx_cases_status' },
      { table: 'cases', column: 'requires_human', name: 'idx_cases_requires_human' },
      { table: 'cases', column: 'langgraph_thread_id', name: 'idx_cases_langgraph_thread_id' },
      { table: 'agent_runs', column: 'case_id', name: 'idx_agent_runs_case_id' },
      { table: 'agent_runs', column: 'status', name: 'idx_agent_runs_status' },
      { table: 'agent_runs', column: 'started_at', name: 'idx_agent_runs_started_at' },
      { table: 'proposals', column: 'case_id', name: 'idx_proposals_case_id' },
      { table: 'proposals', column: 'status', name: 'idx_proposals_status' },
      { table: 'proposals', column: 'langgraph_thread_id', name: 'idx_proposals_thread_id' },
      { table: 'proposals', column: 'execution_key', name: 'idx_proposals_execution_key' },
      { table: 'dead_letter_queue', column: 'case_id', name: 'idx_dlq_case_id' },
      { table: 'dead_letter_queue', column: 'resolution', name: 'idx_dlq_resolution' },
      { table: 'dead_letter_queue', column: 'created_at', name: 'idx_dlq_created_at' }
    ];

    for (const req of requiredIndexes) {
      const found = indexes.rows.find(r =>
        r.tablename === req.table && (
          r.indexname === req.name ||
          r.indexdef.includes(req.column)
        )
      );
      if (found) {
        console.log(`  ✅ ${req.table}.${req.column} - Index exists (${found.indexname})`);
        results.passed++;
      } else {
        console.log(`  ❌ ${req.table}.${req.column} - Index MISSING (expected: ${req.name})`);
        results.failed++;
      }
    }

    // =========================================================================
    // 3. JSONB COLUMN SIZE CHECK
    // =========================================================================
    console.log('\n📋 Checking JSONB columns for potential bloat...');

    const jsonbColumns = await pool.query(`
      SELECT
        table_name,
        column_name,
        udt_name
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND udt_name = 'jsonb'
      ORDER BY table_name, column_name
    `);

    console.log(`  Found ${jsonbColumns.rows.length} JSONB columns:`);

    for (const col of jsonbColumns.rows) {
      // Check average size of JSONB data
      try {
        const sizeCheck = await pool.query(`
          SELECT
            COUNT(*) as row_count,
            COALESCE(AVG(pg_column_size(${col.column_name})), 0) as avg_bytes,
            COALESCE(MAX(pg_column_size(${col.column_name})), 0) as max_bytes
          FROM ${col.table_name}
          WHERE ${col.column_name} IS NOT NULL
        `);

        const stats = sizeCheck.rows[0];
        const avgKb = (parseFloat(stats.avg_bytes) / 1024).toFixed(2);
        const maxKb = (parseFloat(stats.max_bytes) / 1024).toFixed(2);

        if (parseFloat(stats.max_bytes) > 1048576) { // > 1MB
          console.log(`  ⚠️  ${col.table_name}.${col.column_name} - WARNING: max size ${maxKb}KB (may bloat)`);
          results.warnings++;
        } else if (parseFloat(stats.max_bytes) > 102400) { // > 100KB
          console.log(`  ⚠️  ${col.table_name}.${col.column_name} - avg: ${avgKb}KB, max: ${maxKb}KB`);
          results.warnings++;
        } else {
          console.log(`  ✅ ${col.table_name}.${col.column_name} - avg: ${avgKb}KB, max: ${maxKb}KB (OK)`);
          results.passed++;
        }
      } catch (err) {
        console.log(`  ℹ️  ${col.table_name}.${col.column_name} - table may be empty`);
      }
    }

    // =========================================================================
    // 4. TABLE EXISTENCE CHECK
    // =========================================================================
    console.log('\n📋 Checking required TABLES exist...');

    const requiredTables = [
      'cases',
      'proposals',
      'agent_runs',
      'dead_letter_queue',
      'reaper_audit_log',
      'escalations',
      'follow_up_schedule'
    ];

    const tables = await pool.query(`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_type = 'BASE TABLE'
    `);
    const tableNames = tables.rows.map(r => r.table_name);

    for (const table of requiredTables) {
      if (tableNames.includes(table)) {
        console.log(`  ✅ ${table} - exists`);
        results.passed++;
      } else {
        console.log(`  ❌ ${table} - MISSING`);
        results.failed++;
      }
    }

    // =========================================================================
    // 5. FUNCTION EXISTENCE CHECK
    // =========================================================================
    console.log('\n📋 Checking required FUNCTIONS exist...');

    const functions = await pool.query(`
      SELECT routine_name
      FROM information_schema.routines
      WHERE routine_schema = 'public'
        AND routine_type = 'FUNCTION'
    `);
    const funcNames = functions.rows.map(r => r.routine_name);

    const requiredFunctions = ['claim_execution_slot'];

    for (const func of requiredFunctions) {
      if (funcNames.includes(func)) {
        console.log(`  ✅ ${func}() - exists`);
        results.passed++;
      } else {
        console.log(`  ❌ ${func}() - MISSING`);
        results.failed++;
      }
    }

    // =========================================================================
    // 6. COLUMN EXISTENCE CHECK
    // =========================================================================
    console.log('\n📋 Checking required COLUMNS exist...');

    const requiredColumns = [
      { table: 'agent_runs', column: 'lock_expires_at' },
      { table: 'agent_runs', column: 'heartbeat_at' },
      { table: 'agent_runs', column: 'recovery_attempted' },
      { table: 'agent_runs', column: 'is_replay' },
      { table: 'agent_runs', column: 'dry_run' },
      { table: 'agent_runs', column: 'replay_diff' },
      { table: 'proposals', column: 'execution_key' },
      { table: 'proposals', column: 'proposal_key' },
      { table: 'cases', column: 'requires_human' },
      { table: 'cases', column: 'pause_reason' },
      { table: 'cases', column: 'autopilot_mode' }
    ];

    const columns = await pool.query(`
      SELECT table_name, column_name
      FROM information_schema.columns
      WHERE table_schema = 'public'
    `);

    for (const req of requiredColumns) {
      const found = columns.rows.find(
        r => r.table_name === req.table && r.column_name === req.column
      );
      if (found) {
        console.log(`  ✅ ${req.table}.${req.column} - exists`);
        results.passed++;
      } else {
        console.log(`  ❌ ${req.table}.${req.column} - MISSING`);
        results.failed++;
      }
    }

    // =========================================================================
    // SUMMARY
    // =========================================================================
    console.log('\n' + '='.repeat(60));
    console.log('VERIFICATION SUMMARY');
    console.log('='.repeat(60));
    console.log(`  ✅ Passed:   ${results.passed}`);
    console.log(`  ❌ Failed:   ${results.failed}`);
    console.log(`  ⚠️  Warnings: ${results.warnings}`);
    console.log('='.repeat(60));

    if (results.failed > 0) {
      console.log('\n❌ VERIFICATION FAILED - Run missing migrations before deploying.');
      process.exit(1);
    } else if (results.warnings > 0) {
      console.log('\n⚠️  VERIFICATION PASSED with warnings - Review JSONB column sizes.');
      process.exit(0);
    } else {
      console.log('\n✅ VERIFICATION PASSED - All constraints and indexes are in place.');
      process.exit(0);
    }

  } catch (err) {
    console.error('\n❌ Verification error:', err.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

verify();
