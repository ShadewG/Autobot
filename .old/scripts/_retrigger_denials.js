#!/usr/bin/env node
/**
 * Retrigger LangGraph processing for denial messages that were dropped
 * due to the requires_action=false + send_rebuttal contradiction bug.
 *
 * Uses the app's actual queue system (BullMQ via agent-queue) to properly
 * trigger graph runs, matching the pattern from routes/monitor.js.
 *
 * Must be run from the project root with env vars loaded.
 *
 * Usage:
 *   node scripts/_retrigger_denials.js --dry-run    # list affected, don't trigger
 *   node scripts/_retrigger_denials.js               # actually retrigger
 */
require('dotenv').config();
const db = require('../services/database');
const { enqueueInboundMessageJob } = require('../queues/agent-queue');

const DRY_RUN = process.argv.includes('--dry-run');

(async () => {
    // Find contradictions: response-implying suggested_action + requires_action=false
    // Only for messages belonging to cases with no active proposals
    const affected = await db.query(`
        SELECT ra.message_id, ra.intent, ra.suggested_action, ra.requires_action,
               m.case_id, m.subject, c.status as case_status, c.agency_name
        FROM response_analysis ra
        JOIN messages m ON m.id = ra.message_id
        JOIN cases c ON c.id = m.case_id
        WHERE ra.requires_action = false
          AND (ra.suggested_action IN ('send_rebuttal', 'challenge')
               OR (ra.suggested_action = 'respond' AND ra.intent = 'denial'))
          AND m.case_id IS NOT NULL
          AND NOT EXISTS (
              SELECT 1 FROM proposals p
              WHERE p.case_id = m.case_id
              AND p.status NOT IN ('DISMISSED')
          )
        ORDER BY ra.created_at
    `);

    console.log(`Found ${affected.rows.length} affected messages${DRY_RUN ? ' (DRY RUN)' : ''}:\n`);

    for (const row of affected.rows) {
        console.log(`Case #${row.case_id} (${row.agency_name}) [${row.case_status}]`);
        console.log(`  MSG #${row.message_id}: ${row.intent} → ${row.suggested_action}`);
        console.log(`  Subject: ${(row.subject || '').slice(0, 100)}`);
        console.log();
    }

    if (DRY_RUN) {
        console.log('Run without --dry-run to retrigger.');
        process.exit(0);
    }

    // Retrigger each affected message through the graph
    for (const row of affected.rows) {
        try {
            // Check for active run on this case
            const activeRun = await db.getActiveRunForCase(row.case_id);
            if (activeRun) {
                console.log(`Case #${row.case_id}: Skipping — active run #${activeRun.id} exists`);
                continue;
            }

            // Create agent run + enqueue job (same pattern as monitor.js)
            const run = await db.createAgentRunFull({
                case_id: row.case_id,
                trigger_type: 'inbound_message',
                status: 'queued',
                message_id: row.message_id,
                autopilot_mode: 'SUPERVISED',
                langgraph_thread_id: `case:${row.case_id}:msg-${row.message_id}`
            });

            const job = await enqueueInboundMessageJob(run.id, row.case_id, row.message_id, {
                autopilotMode: 'SUPERVISED',
                threadId: run.langgraph_thread_id
            });

            console.log(`Case #${row.case_id}: Queued run #${run.id} (job ${job.id})`);
        } catch (e) {
            console.log(`Case #${row.case_id}: ERROR — ${e.message}`);
        }
    }

    console.log('\nDone. Check the monitor for new proposals.');
    process.exit(0);
})();
