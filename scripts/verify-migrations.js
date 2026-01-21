#!/usr/bin/env node
/**
 * Migration Verification Script
 *
 * Verifies migrations 020, 021, 022 are applied correctly.
 * Run BEFORE enabling traffic to confirm schema health.
 *
 * Usage:
 *   node scripts/verify-migrations.js
 *   node scripts/verify-migrations.js --smoke-test
 *   node scripts/verify-migrations.js --fix-indexes
 *
 * Checks:
 * 1. Tables exist: portal_tasks, shadow_reviews, executions
 * 2. Columns exist: scheduled_key, last_run_id, autopilot_mode, etc.
 * 3. Indexes exist for frequently queried columns
 * 4. Unique constraints enforced on proposal_key, execution_key
 * 5. Smoke tests: can insert/delete test records
 */

require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://localhost:5432/autobot_test',
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

const args = process.argv.slice(2);
const runSmokeTest = args.includes('--smoke-test');
const fixIndexes = args.includes('--fix-indexes');

async function verify() {
  console.log('🔍 Migration Verification Starting...\n');
  console.log(`Database: ${(process.env.DATABASE_URL || 'local').substring(0, 40)}...`);
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}\n`);

  const results = { passed: 0, failed: 0, warnings: 0 };

  try {
    // =========================================================================
    // 1. CHECK NEW TABLES FROM PHASE 4, 6, 7.1
    // =========================================================================
    console.log('📋 Checking Phase 4/6/7.1 TABLES exist...');

    const newTables = [
      { name: 'portal_tasks', migration: '020' },
      { name: 'executions', migration: '020' },
      { name: 'shadow_reviews', migration: '022' }
    ];

    const tables = await pool.query(`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
    `);
    const tableNames = tables.rows.map(r => r.table_name);

    for (const t of newTables) {
      if (tableNames.includes(t.name)) {
        console.log(`  ✅ ${t.name} - exists (migration ${t.migration})`);
        results.passed++;
      } else {
        console.log(`  ❌ ${t.name} - MISSING (run migration ${t.migration})`);
        results.failed++;
      }
    }

    // Also check core tables
    const coreTables = ['cases', 'proposals', 'agent_runs', 'follow_up_schedule', 'messages'];
    for (const table of coreTables) {
      if (tableNames.includes(table)) {
        console.log(`  ✅ ${table} - exists`);
        results.passed++;
      } else {
        console.log(`  ❌ ${table} - MISSING`);
        results.failed++;
      }
    }

    // =========================================================================
    // 2. CHECK NEW COLUMNS FROM MIGRATIONS
    // =========================================================================
    console.log('\n📋 Checking Phase 4/6/7.1 COLUMNS exist...');

    const newColumns = [
      // Migration 020: executor-adapter
      { table: 'proposals', column: 'proposal_key', migration: '019/020' },
      { table: 'executions', column: 'execution_key', migration: '020' },

      // Migration 021: followup-scheduler
      { table: 'follow_up_schedule', column: 'scheduled_key', migration: '021' },
      { table: 'follow_up_schedule', column: 'last_run_id', migration: '021' },
      { table: 'follow_up_schedule', column: 'last_error', migration: '021' },
      { table: 'follow_up_schedule', column: 'error_count', migration: '021' },
      { table: 'follow_up_schedule', column: 'autopilot_mode', migration: '021' },

      // Core columns
      { table: 'cases', column: 'autopilot_mode', migration: 'core' },
      { table: 'agent_runs', column: 'trigger_type', migration: 'core' },
      { table: 'agent_runs', column: 'autopilot_mode', migration: 'core' }
    ];

    const columns = await pool.query(`
      SELECT table_name, column_name FROM information_schema.columns
      WHERE table_schema = 'public'
    `);

    for (const req of newColumns) {
      const found = columns.rows.find(
        r => r.table_name === req.table && r.column_name === req.column
      );
      if (found) {
        console.log(`  ✅ ${req.table}.${req.column} - exists`);
        results.passed++;
      } else {
        console.log(`  ❌ ${req.table}.${req.column} - MISSING (migration ${req.migration})`);
        results.failed++;
      }
    }

    // =========================================================================
    // 3. CHECK INDEXES
    // =========================================================================
    console.log('\n📋 Checking INDEXES for query performance...');

    const requiredIndexes = [
      // Phase 4/6/7.1 indexes
      { table: 'proposals', column: 'proposal_key', name: 'idx_proposals_proposal_key' },
      { table: 'executions', column: 'execution_key', name: 'idx_executions_execution_key' },
      { table: 'follow_up_schedule', column: 'scheduled_key', name: 'idx_follow_up_schedule_scheduled_key' },
      { table: 'follow_up_schedule', column: 'next_followup_date', name: 'idx_follow_up_schedule_next_date' },
      { table: 'follow_up_schedule', column: 'status', name: 'idx_follow_up_schedule_status' },
      { table: 'shadow_reviews', column: 'proposal_id', name: 'idx_shadow_reviews_proposal' },
      { table: 'portal_tasks', column: 'status', name: 'idx_portal_tasks_status' },
      { table: 'portal_tasks', column: 'case_id', name: 'idx_portal_tasks_case_id' },

      // Core indexes
      { table: 'proposals', column: 'case_id', name: 'idx_proposals_case_id' },
      { table: 'proposals', column: 'status', name: 'idx_proposals_status' },
      { table: 'agent_runs', column: 'case_id', name: 'idx_agent_runs_case_id' },
      { table: 'agent_runs', column: 'status', name: 'idx_agent_runs_status' },
      { table: 'cases', column: 'status', name: 'idx_cases_status' }
    ];

    const indexes = await pool.query(`
      SELECT tablename, indexname, indexdef FROM pg_indexes
      WHERE schemaname = 'public'
    `);

    for (const req of requiredIndexes) {
      const found = indexes.rows.find(r =>
        r.tablename === req.table && (
          r.indexname === req.name ||
          r.indexdef.toLowerCase().includes(req.column.toLowerCase())
        )
      );
      if (found) {
        console.log(`  ✅ ${req.table}.${req.column} - indexed`);
        results.passed++;
      } else {
        console.log(`  ❌ ${req.table}.${req.column} - NO INDEX`);
        if (fixIndexes) {
          try {
            await pool.query(`CREATE INDEX IF NOT EXISTS ${req.name} ON ${req.table}(${req.column})`);
            console.log(`     ✅ Created ${req.name}`);
            results.passed++;
          } catch (e) {
            console.log(`     ❌ Failed to create: ${e.message}`);
            results.failed++;
          }
        } else {
          results.warnings++;
        }
      }
    }

    // =========================================================================
    // 4. CHECK UNIQUE CONSTRAINTS (CRITICAL FOR IDEMPOTENCY)
    // =========================================================================
    console.log('\n📋 Checking UNIQUE CONSTRAINTS (idempotency)...');

    const uniqueChecks = [
      { table: 'proposals', column: 'proposal_key' },
      { table: 'executions', column: 'execution_key' },
      { table: 'shadow_reviews', column: 'proposal_id' }
    ];

    for (const uc of uniqueChecks) {
      // Check both unique indexes and constraints
      const uniqueResult = await pool.query(`
        SELECT COUNT(*) as count FROM (
          SELECT indexname FROM pg_indexes
          WHERE schemaname = 'public' AND tablename = $1
          AND indexdef LIKE '%UNIQUE%'
          AND indexdef LIKE '%${uc.column}%'
          UNION
          SELECT c.conname FROM pg_constraint c
          JOIN pg_class t ON c.conrelid = t.oid
          JOIN pg_namespace n ON t.relnamespace = n.oid
          WHERE n.nspname = 'public' AND t.relname = $1 AND c.contype = 'u'
        ) combined
      `, [uc.table]);

      if (parseInt(uniqueResult.rows[0].count) > 0) {
        console.log(`  ✅ ${uc.table}.${uc.column} - UNIQUE enforced`);
        results.passed++;
      } else {
        console.log(`  ❌ ${uc.table}.${uc.column} - NO UNIQUE constraint (CRITICAL!)`);
        results.failed++;
      }
    }

    // =========================================================================
    // 5. SMOKE TESTS (if --smoke-test flag)
    // =========================================================================
    if (runSmokeTest) {
      console.log('\n📋 Running SMOKE TESTS...');

      // Test 1: Insert agent_run
      console.log('\n  Test 1: Insert agent_run...');
      try {
        const runResult = await pool.query(`
          INSERT INTO agent_runs (case_id, trigger_type, status, autopilot_mode, langgraph_thread_id)
          VALUES (1, 'smoke_test', 'created', 'SUPERVISED', 'smoke:${Date.now()}')
          RETURNING id
        `);
        await pool.query('DELETE FROM agent_runs WHERE id = $1', [runResult.rows[0].id]);
        console.log('    ✅ Can insert/delete agent_run');
        results.passed++;
      } catch (e) {
        console.log(`    ❌ Failed: ${e.message}`);
        results.failed++;
      }

      // Test 2: Insert proposal with proposal_key
      console.log('\n  Test 2: Insert proposal with unique proposal_key...');
      try {
        const key = `smoke:${Date.now()}`;
        const propResult = await pool.query(`
          INSERT INTO proposals (case_id, action_type, status, proposal_key)
          VALUES (1, 'SEND_FOLLOWUP', 'PENDING_APPROVAL', $1)
          RETURNING id
        `, [key]);

        // Test uniqueness
        let uniqueEnforced = false;
        try {
          await pool.query(`
            INSERT INTO proposals (case_id, action_type, status, proposal_key)
            VALUES (1, 'SEND_FOLLOWUP', 'PENDING_APPROVAL', $1)
          `, [key]);
        } catch (e) {
          if (e.code === '23505') uniqueEnforced = true;
        }

        await pool.query('DELETE FROM proposals WHERE id = $1', [propResult.rows[0].id]);

        if (uniqueEnforced) {
          console.log('    ✅ proposal_key uniqueness enforced');
          results.passed++;
        } else {
          console.log('    ❌ proposal_key uniqueness NOT enforced');
          results.failed++;
        }
      } catch (e) {
        console.log(`    ❌ Failed: ${e.message}`);
        results.failed++;
      }

      // Test 3: Insert execution with execution_key
      console.log('\n  Test 3: Insert execution with unique execution_key...');
      try {
        const key = `smoke:${Date.now()}`;
        const execResult = await pool.query(`
          INSERT INTO executions (case_id, execution_key, action_type, status)
          VALUES (1, $1, 'SEND_FOLLOWUP', 'QUEUED')
          RETURNING id
        `, [key]);

        // Test uniqueness
        let uniqueEnforced = false;
        try {
          await pool.query(`
            INSERT INTO executions (case_id, execution_key, action_type, status)
            VALUES (1, $1, 'SEND_FOLLOWUP', 'QUEUED')
          `, [key]);
        } catch (e) {
          if (e.code === '23505') uniqueEnforced = true;
        }

        await pool.query('DELETE FROM executions WHERE id = $1', [execResult.rows[0].id]);

        if (uniqueEnforced) {
          console.log('    ✅ execution_key uniqueness enforced');
          results.passed++;
        } else {
          console.log('    ❌ execution_key uniqueness NOT enforced');
          results.failed++;
        }
      } catch (e) {
        console.log(`    ❌ Failed: ${e.message}`);
        results.failed++;
      }

      // Test 4: Insert portal_task
      console.log('\n  Test 4: Insert portal_task...');
      try {
        const taskResult = await pool.query(`
          INSERT INTO portal_tasks (case_id, action_type, status, portal_url)
          VALUES (1, 'SEND_INITIAL_REQUEST', 'PENDING', 'https://example.com')
          RETURNING id
        `);
        await pool.query('DELETE FROM portal_tasks WHERE id = $1', [taskResult.rows[0].id]);
        console.log('    ✅ Can insert portal_task');
        results.passed++;
      } catch (e) {
        console.log(`    ❌ Failed: ${e.message}`);
        results.failed++;
      }

      // Test 5: Insert shadow_review (needs a proposal)
      console.log('\n  Test 5: Insert shadow_review...');
      try {
        const propResult = await pool.query(`
          INSERT INTO proposals (case_id, action_type, status)
          VALUES (1, 'SEND_FOLLOWUP', 'PENDING_APPROVAL')
          RETURNING id
        `);
        const propId = propResult.rows[0].id;

        await pool.query(`
          INSERT INTO shadow_reviews (proposal_id, routing_correct, gating_correct, draft_quality_score)
          VALUES ($1, 'correct', 'correct', 4)
        `, [propId]);

        await pool.query('DELETE FROM shadow_reviews WHERE proposal_id = $1', [propId]);
        await pool.query('DELETE FROM proposals WHERE id = $1', [propId]);
        console.log('    ✅ Can insert shadow_review');
        results.passed++;
      } catch (e) {
        console.log(`    ❌ Failed: ${e.message}`);
        results.failed++;
      }

      // Test 6: Update follow_up_schedule with scheduled_key
      console.log('\n  Test 6: Update follow_up_schedule scheduled_key...');
      try {
        const existing = await pool.query('SELECT id FROM follow_up_schedule LIMIT 1');
        if (existing.rows.length > 0) {
          await pool.query(`
            UPDATE follow_up_schedule SET scheduled_key = 'smoke:test' WHERE id = $1
          `, [existing.rows[0].id]);
          await pool.query(`
            UPDATE follow_up_schedule SET scheduled_key = NULL WHERE id = $1
          `, [existing.rows[0].id]);
          console.log('    ✅ Can update scheduled_key');
          results.passed++;
        } else {
          console.log('    ⚠️  No follow_up_schedule rows to test');
          results.warnings++;
        }
      } catch (e) {
        console.log(`    ❌ Failed: ${e.message}`);
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
      console.log('\n❌ VERIFICATION FAILED');
      console.log('\nNext steps:');
      console.log('1. Apply migrations in order:');
      console.log('   - psql $DATABASE_URL -f migrations/020_portal_tasks.sql');
      console.log('   - psql $DATABASE_URL -f migrations/021_followup_scheduler.sql');
      console.log('   - psql $DATABASE_URL -f migrations/022_shadow_mode.sql');
      console.log('2. Re-run this script');
      console.log('3. Run with --smoke-test to verify writes');
      process.exit(1);
    } else if (results.warnings > 0) {
      console.log('\n⚠️  VERIFICATION PASSED with warnings');
      console.log('   Run with --fix-indexes to create missing indexes');
      process.exit(0);
    } else {
      console.log('\n✅ VERIFICATION PASSED - Schema is healthy!');
      if (!runSmokeTest) {
        console.log('   TIP: Run with --smoke-test to verify write operations');
      }
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
