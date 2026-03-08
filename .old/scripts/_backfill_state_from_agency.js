#!/usr/bin/env node
/**
 * One-time backfill: parse `state` from `agency_name` suffix for all cases where state IS NULL.
 * Also fixes case 25140's stale substatus.
 *
 * Usage:  node scripts/_backfill_state_from_agency.js [--dry-run]
 */

const { Pool } = require('pg');
const { parseStateFromAgencyName } = require('../utils/state-utils');

const DATABASE_URL = process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL;
if (!DATABASE_URL) {
    console.error('Set DATABASE_PUBLIC_URL or DATABASE_URL');
    process.exit(1);
}

const pool = new Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } });
const dryRun = process.argv.includes('--dry-run');

async function main() {
    const client = await pool.connect();
    try {
        // 1. Backfill state from agency_name
        const { rows } = await client.query(
            `SELECT id, agency_name FROM cases WHERE state IS NULL AND agency_name IS NOT NULL`
        );
        console.log(`Found ${rows.length} cases with NULL state`);

        let updated = 0;
        let skipped = 0;
        for (const row of rows) {
            const parsed = parseStateFromAgencyName(row.agency_name);
            if (parsed) {
                if (dryRun) {
                    console.log(`  [DRY RUN] Case ${row.id}: "${row.agency_name}" → ${parsed}`);
                } else {
                    await client.query('UPDATE cases SET state = $1 WHERE id = $2', [parsed, row.id]);
                    console.log(`  Updated case ${row.id}: "${row.agency_name}" → ${parsed}`);
                }
                updated++;
            } else {
                skipped++;
                console.log(`  Skipped case ${row.id}: "${row.agency_name}" (no state found)`);
            }
        }
        console.log(`\nState backfill: ${updated} updated, ${skipped} skipped${dryRun ? ' (dry run)' : ''}`);

        // 2. Fix case 25140 specifically — clear stale substatus
        if (!dryRun) {
            const fix = await client.query(
                `UPDATE cases SET substatus = NULL WHERE id = 25140 AND substatus LIKE 'Resolving:%' RETURNING id`
            );
            if (fix.rowCount > 0) {
                console.log('\nFixed case 25140: cleared stale "Resolving:" substatus');
            } else {
                console.log('\nCase 25140: no stale substatus to clear (already clean or not matching)');
            }
        } else {
            console.log('\n[DRY RUN] Would clear case 25140 stale substatus');
        }
    } finally {
        client.release();
        await pool.end();
    }
}

main().catch(err => { console.error(err); process.exit(1); });
