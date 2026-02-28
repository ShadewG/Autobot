#!/usr/bin/env node
/**
 * One-time fix: Expand case 25208 (Raul Trevino III) scope from just
 * "Surveillance video" to full documentary scope for double murder investigation.
 *
 * Updates both requested_records (legacy array) and scope_items_jsonb
 * (which parseScopeItems() prioritizes).
 *
 * Usage: DATABASE_URL=... node scripts/_fix_25208_scope.js
 */

const { Pool } = require('pg');

const CASE_ID = 25208;

const FULL_SCOPE = [
  'Surveillance video',
  'Body camera footage',
  'Police reports / incident reports',
  '911 call recordings / dispatch logs',
  'Crime scene photographs',
  'Witness statements',
  'Arrest records',
];

const SCOPE_ITEMS_JSONB = FULL_SCOPE.map((name) => ({
  name,
  status: 'REQUESTED',
}));

async function main() {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  });

  try {
    // Verify case exists
    const check = await pool.query('SELECT id, case_name, requested_records, scope_items_jsonb FROM cases WHERE id = $1', [CASE_ID]);
    if (check.rows.length === 0) {
      console.error(`Case ${CASE_ID} not found`);
      process.exit(1);
    }

    const before = check.rows[0];
    console.log('Before:');
    console.log('  case_name:', before.case_name);
    console.log('  requested_records:', JSON.stringify(before.requested_records));
    console.log('  scope_items_jsonb:', JSON.stringify(before.scope_items_jsonb));

    // Update both columns
    await pool.query(
      `UPDATE cases
       SET requested_records = $1,
           scope_items_jsonb = $2,
           updated_at = NOW()
       WHERE id = $3`,
      [FULL_SCOPE, JSON.stringify(SCOPE_ITEMS_JSONB), CASE_ID]
    );

    // Verify
    const after = await pool.query('SELECT requested_records, scope_items_jsonb FROM cases WHERE id = $1', [CASE_ID]);
    console.log('\nAfter:');
    console.log('  requested_records:', JSON.stringify(after.rows[0].requested_records));
    console.log('  scope_items_jsonb:', JSON.stringify(after.rows[0].scope_items_jsonb));
    console.log('\nDone — case 25208 scope expanded to', FULL_SCOPE.length, 'items');
  } catch (err) {
    console.error('Error:', err.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

main();
