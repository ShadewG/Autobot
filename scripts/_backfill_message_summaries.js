/**
 * Backfill message summaries for existing messages.
 *
 * 1. Inbound messages with existing analysis — extract summary from full_analysis_json (free, no AI call)
 * 2. Outbound messages without summary — generate via lightweight AI call
 * 3. Inbound messages without analysis — generate via lightweight AI call (rare edge case)
 *
 * Usage: node scripts/_backfill_message_summaries.js [--dry-run]
 */
require('dotenv').config();
const db = require('../services/database');
const aiService = require('../services/ai-service');

const DRY_RUN = process.argv.includes('--dry-run');
const CONCURRENCY = 3;

async function backfillFromAnalysis() {
    console.log('\n--- Phase 1: Extracting summaries from existing response_analysis ---');
    const result = await db.query(`
        UPDATE messages m
        SET summary = ra.full_analysis_json->>'summary'
        FROM response_analysis ra
        WHERE ra.message_id = m.id
          AND m.summary IS NULL
          AND ra.full_analysis_json->>'summary' IS NOT NULL
          AND ra.full_analysis_json->>'summary' != ''
        RETURNING m.id, m.subject, m.summary
    `);
    console.log(`  Updated ${result.rowCount} inbound messages from existing analysis`);
    for (const row of result.rows.slice(0, 5)) {
        console.log(`    msg #${row.id}: ${row.summary}`);
    }
    return result.rowCount;
}

async function backfillFromAnalysisDryRun() {
    console.log('\n--- Phase 1 (DRY RUN): Would extract summaries from existing response_analysis ---');
    const result = await db.query(`
        SELECT m.id, m.subject, ra.full_analysis_json->>'summary' AS summary
        FROM messages m
        JOIN response_analysis ra ON ra.message_id = m.id
        WHERE m.summary IS NULL
          AND ra.full_analysis_json->>'summary' IS NOT NULL
          AND ra.full_analysis_json->>'summary' != ''
    `);
    console.log(`  Would update ${result.rowCount} inbound messages`);
    for (const row of result.rows.slice(0, 5)) {
        console.log(`    msg #${row.id} (${row.subject}): ${row.summary}`);
    }
    return result.rowCount;
}

async function backfillWithAI() {
    console.log('\n--- Phase 2: Generating summaries for remaining messages via AI ---');
    const result = await db.query(`
        SELECT id, direction, subject, LEFT(body_text, 500) AS body_snippet
        FROM messages
        WHERE summary IS NULL
          AND (subject IS NOT NULL OR body_text IS NOT NULL)
        ORDER BY id
    `);
    console.log(`  Found ${result.rowCount} messages needing AI-generated summaries`);

    let updated = 0;
    let errors = 0;

    // Process in batches with concurrency limit
    for (let i = 0; i < result.rows.length; i += CONCURRENCY) {
        const batch = result.rows.slice(i, i + CONCURRENCY);
        const promises = batch.map(async (msg) => {
            try {
                if (DRY_RUN) {
                    console.log(`    [DRY RUN] Would generate summary for msg #${msg.id} (${msg.direction}): ${msg.subject}`);
                    return;
                }
                const summary = await aiService.generateMessageSummary(msg.subject, msg.body_snippet);
                if (summary) {
                    await db.query('UPDATE messages SET summary = $1 WHERE id = $2', [summary, msg.id]);
                    updated++;
                    console.log(`    msg #${msg.id}: ${summary}`);
                }
            } catch (err) {
                errors++;
                console.error(`    Error on msg #${msg.id}: ${err.message}`);
            }
        });
        await Promise.all(promises);
    }

    console.log(`  Generated ${updated} summaries, ${errors} errors`);
    return updated;
}

async function main() {
    console.log(`Backfilling message summaries${DRY_RUN ? ' (DRY RUN)' : ''}...`);

    const phase1 = DRY_RUN ? await backfillFromAnalysisDryRun() : await backfillFromAnalysis();
    const phase2Count = await backfillWithAI();

    console.log(`\nDone! Phase 1: ${phase1} from analysis, Phase 2: ${phase2Count} via AI`);
    process.exit(0);
}

main().catch(err => {
    console.error('Backfill failed:', err);
    process.exit(1);
});
