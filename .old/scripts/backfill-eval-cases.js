/**
 * backfill-eval-cases.js
 *
 * One-time script: insert all historical proposals with a human decision into eval_cases.
 *
 * Decision mapping:
 *   DISMISS  → expected_action = 'DISMISSED'      (AI proposed wrong action)
 *   ADJUST   → expected_action = proposal.action_type  (action right, draft was bad)
 *   APPROVE  → expected_action = proposal.action_type  (AI was correct)
 *   WITHDRAW → skipped (not meaningful as eval data)
 *
 * Usage:
 *   DATABASE_PUBLIC_URL=... node scripts/backfill-eval-cases.js [--dry-run]
 */

require('dotenv').config();
const { Client } = require('pg');

const DRY_RUN = process.argv.includes('--dry-run');

async function run() {
    const client = new Client({
        connectionString: process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL,
        ssl: process.env.DATABASE_PUBLIC_URL ? { rejectUnauthorized: false } : false,
    });

    await client.connect();
    console.log(`Connected to database${DRY_RUN ? ' (DRY RUN — no writes)' : ''}\n`);

    const { rows: proposals } = await client.query(`
        SELECT
            p.id,
            p.case_id,
            p.trigger_message_id,
            p.action_type,
            p.human_decision,
            p.status,
            c.case_name,
            c.agency_name
        FROM proposals p
        LEFT JOIN cases c ON c.id = p.case_id
        WHERE p.human_decision IS NOT NULL
        ORDER BY p.created_at ASC
    `);

    console.log(`Found ${proposals.length} proposals with human decisions\n`);

    let inserted = 0;
    let skipped = 0;
    let errors = 0;

    for (const p of proposals) {
        try {
            let decision;
            try {
                decision = typeof p.human_decision === 'string'
                    ? JSON.parse(p.human_decision)
                    : p.human_decision;
            } catch (_) {
                decision = {};
            }

            const action = decision.action || p.status || '';

            // Map to expected_action
            let expectedAction;
            if (action === 'DISMISS' || p.status === 'DISMISSED') {
                expectedAction = 'DISMISSED';
            } else if (action === 'ADJUST') {
                // Human agreed on action type but wanted draft changes
                expectedAction = p.action_type;
            } else if (action === 'APPROVE' || p.status === 'EXECUTED') {
                // Human approved the AI decision — action was correct
                expectedAction = p.action_type;
            } else if (action === 'WITHDRAW' || p.status === 'WITHDRAWN') {
                console.log(`  SKIP  proposal ${p.id} (${p.agency_name}) — WITHDRAW is not meaningful eval data`);
                skipped++;
                continue;
            } else {
                // Unknown status — still include with proposal action_type
                expectedAction = p.action_type;
            }

            const notes = decision.instruction || decision.reason || null;

            const label = `proposal ${p.id} (${p.agency_name || 'unknown'}) — ${action} → ${expectedAction}`;

            if (DRY_RUN) {
                console.log(`  DRY   ${label}`);
                inserted++;
                continue;
            }

            const result = await client.query(
                `INSERT INTO eval_cases (proposal_id, case_id, trigger_message_id, expected_action, notes)
                 VALUES ($1, $2, $3, $4, $5)
                 ON CONFLICT (proposal_id) DO NOTHING
                 RETURNING id`,
                [p.id, p.case_id, p.trigger_message_id || null, expectedAction, notes]
            );

            if (result.rows.length > 0) {
                console.log(`  INSERT ${label} → eval_case ${result.rows[0].id}`);
                inserted++;
            } else {
                console.log(`  EXIST  ${label} (already in eval_cases)`);
                skipped++;
            }
        } catch (err) {
            console.error(`  ERROR  proposal ${p.id}:`, err.message);
            errors++;
        }
    }

    console.log(`\n${'─'.repeat(50)}`);
    console.log(`${DRY_RUN ? 'DRY RUN — ' : ''}Results:`);
    console.log(`  Inserted : ${inserted}`);
    console.log(`  Skipped  : ${skipped}`);
    console.log(`  Errors   : ${errors}`);
    console.log(`  Total    : ${proposals.length}`);

    await client.end();
}

run().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
});
