#!/usr/bin/env node
/**
 * Repair queue/proposal state drift and retrigger orphaned review cases.
 *
 * Usage:
 *   node scripts/_repair_queue_and_retrigger.js --dry-run
 *   node scripts/_repair_queue_and_retrigger.js
 *   node scripts/_repair_queue_and_retrigger.js --cases=25161,25169
 */

require("dotenv").config({ path: ".env.test", override: true });
if (process.env.DATABASE_PUBLIC_URL) {
  process.env.DATABASE_URL = process.env.DATABASE_PUBLIC_URL;
}

const db = require("../services/database");
const { tasks } = require("@trigger.dev/sdk");

const DRY_RUN = process.argv.includes("--dry-run");
const casesArg = process.argv.find((arg) => arg.startsWith("--cases="));
const ONLY_CASE_IDS = casesArg
  ? casesArg
      .replace("--cases=", "")
      .split(",")
      .map((v) => parseInt(v.trim(), 10))
      .filter((n) => Number.isFinite(n))
  : [];

const ACTIVE_PROPOSAL_STATUSES = ["PENDING_APPROVAL", "BLOCKED", "DECISION_RECEIVED", "PENDING_PORTAL"];
const BLOCKING_CASE_STATUSES = ["sent", "awaiting_response", "responded", "completed", "cancelled", "needs_phone_call"];

async function repairData() {
  const summary = {
    dismissedBlockingCaseProposals: 0,
    fixedPauseReason: 0,
    droppedDuplicateConstraint: false,
    orphanWaitingRunsCleaned: 0,
  };

  if (!DRY_RUN) {
    try {
      await db.query(`
        ALTER TABLE auto_reply_queue
        DROP CONSTRAINT IF EXISTS auto_reply_queue_execution_key_key
      `);
      summary.droppedDuplicateConstraint = true;
    } catch (err) {
      console.warn(`Could not drop duplicate constraint: ${err.message}`);
    }

    const dismissRes = await db.query(
      `
      UPDATE proposals p
      SET status = 'DISMISSED',
          updated_at = NOW(),
          human_decision = COALESCE(p.human_decision, '{}'::jsonb)
            || jsonb_build_object('auto_dismiss_reason', 'repair:blocking_case_status', 'auto_dismissed_at', NOW()::text)
      FROM cases c
      WHERE p.case_id = c.id
        AND p.status = ANY($1)
        AND c.status = ANY($2)
      `,
      [ACTIVE_PROPOSAL_STATUSES, BLOCKING_CASE_STATUSES]
    );
    summary.dismissedBlockingCaseProposals = dismissRes.rowCount || 0;

    const pauseRes = await db.query(`
      UPDATE cases
      SET pause_reason = 'UNSPECIFIED', updated_at = NOW()
      WHERE status = 'needs_human_review' AND pause_reason IS NULL
    `);
    summary.fixedPauseReason = pauseRes.rowCount || 0;

    const waitingRunRes = await db.query(`
      UPDATE agent_runs ar
      SET status = 'failed',
          ended_at = NOW(),
          error = 'repair: orphaned waiting run >2h with no active proposal'
      WHERE ar.status = 'waiting'
        AND ar.started_at < NOW() - INTERVAL '2 hours'
        AND NOT EXISTS (
          SELECT 1
          FROM proposals p
          WHERE p.case_id = ar.case_id
            AND p.status = ANY($1::text[])
        )
    `, [ACTIVE_PROPOSAL_STATUSES]);
    summary.orphanWaitingRunsCleaned = waitingRunRes.rowCount || 0;
  } else {
    const dupConstraint = await db.query(`
      SELECT COUNT(*)::int AS cnt
      FROM pg_constraint
      WHERE conname = 'auto_reply_queue_execution_key_key'
        AND conrelid = 'auto_reply_queue'::regclass
    `);
    summary.droppedDuplicateConstraint = (dupConstraint.rows[0]?.cnt || 0) === 0;

    const countDismiss = await db.query(
      `
      SELECT COUNT(*)::int AS cnt
      FROM proposals p
      JOIN cases c ON c.id = p.case_id
      WHERE p.status = ANY($1)
        AND c.status = ANY($2)
      `,
      [ACTIVE_PROPOSAL_STATUSES, BLOCKING_CASE_STATUSES]
    );
    summary.dismissedBlockingCaseProposals = countDismiss.rows[0]?.cnt || 0;

    const countPause = await db.query(`
      SELECT COUNT(*)::int AS cnt
      FROM cases
      WHERE status = 'needs_human_review' AND pause_reason IS NULL
    `);
    summary.fixedPauseReason = countPause.rows[0]?.cnt || 0;

    const countOrphanWaiting = await db.query(`
      SELECT COUNT(*)::int AS cnt
      FROM agent_runs ar
      WHERE ar.status = 'waiting'
        AND ar.started_at < NOW() - INTERVAL '2 hours'
        AND NOT EXISTS (
          SELECT 1
          FROM proposals p
          WHERE p.case_id = ar.case_id
            AND p.status = ANY($1::text[])
        )
    `, [ACTIVE_PROPOSAL_STATUSES]);
    summary.orphanWaitingRunsCleaned = countOrphanWaiting.rows[0]?.cnt || 0;
  }

  return summary;
}

async function getRetriggerCandidates() {
  const params = [];
  const caseFilter =
    ONLY_CASE_IDS.length > 0
      ? `AND c.id = ANY($1::int[])`
      : "";
  if (ONLY_CASE_IDS.length > 0) params.push(ONLY_CASE_IDS);

  const result = await db.query(
    `
    SELECT
      c.id AS case_id,
      c.case_name,
      c.pause_reason,
      (
        SELECT m.id
        FROM messages m
        WHERE m.case_id = c.id
          AND m.direction = 'inbound'
        ORDER BY COALESCE(m.received_at, m.created_at) DESC
        LIMIT 1
      ) AS message_id
    FROM cases c
    WHERE c.status = 'needs_human_review'
      ${caseFilter}
      AND NOT EXISTS (
        SELECT 1 FROM proposals p
        WHERE p.case_id = c.id
          AND p.status = ANY($${params.length + 1}::text[])
      )
      AND NOT EXISTS (
        SELECT 1 FROM phone_call_queue pcq
        WHERE pcq.case_id = c.id
          AND pcq.status = 'pending'
      )
    ORDER BY c.updated_at ASC
  `,
    [...params, ACTIVE_PROPOSAL_STATUSES]
  );

  return result.rows.filter((r) => r.message_id != null);
}

async function retriggerCase(row) {
  const activeRun = await db.getActiveRunForCase(row.case_id);
  if (activeRun) {
    return { caseId: row.case_id, skipped: true, reason: `active_run_${activeRun.id}:${activeRun.status}` };
  }

  if (DRY_RUN) {
    return { caseId: row.case_id, skipped: false, dryRun: true, messageId: row.message_id };
  }

  const run = await db.createAgentRunFull({
    case_id: row.case_id,
    trigger_type: "inbound_message",
    status: "queued",
    message_id: row.message_id,
    autopilot_mode: "SUPERVISED",
    langgraph_thread_id: `repair:${row.case_id}:msg-${row.message_id}`,
    metadata: { source: "repair_retrigger" },
  });

  const handle = await tasks.trigger("process-inbound", {
    runId: run.id,
    caseId: row.case_id,
    messageId: row.message_id,
    autopilotMode: "SUPERVISED",
  });

  return { caseId: row.case_id, runId: run.id, triggerRunId: handle.id, messageId: row.message_id };
}

async function main() {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is missing");
  }
  if (!DRY_RUN && !process.env.TRIGGER_SECRET_KEY) {
    throw new Error("TRIGGER_SECRET_KEY is missing (required to retrigger)");
  }

  console.log(`Mode: ${DRY_RUN ? "DRY RUN" : "LIVE"}`);
  if (ONLY_CASE_IDS.length > 0) {
    console.log(`Scoped cases: ${ONLY_CASE_IDS.join(", ")}`);
  }

  const repair = await repairData();
  console.log("\nRepair summary:");
  console.log(`  Duplicate constraint already absent/dropped: ${repair.droppedDuplicateConstraint}`);
  console.log(`  Proposals to dismiss on blocking statuses: ${repair.dismissedBlockingCaseProposals}`);
  console.log(`  needs_human_review rows with missing pause_reason: ${repair.fixedPauseReason}`);
  console.log(`  Orphan waiting runs to clean: ${repair.orphanWaitingRunsCleaned}`);

  const candidates = await getRetriggerCandidates();
  console.log(`\nRetrigger candidates: ${candidates.length}`);
  candidates.forEach((c) => {
    console.log(`  Case #${c.case_id} (msg ${c.message_id}) pause=${c.pause_reason || "NULL"} ${c.case_name.slice(0, 80)}`);
  });

  const results = [];
  for (const c of candidates) {
    try {
      // Serialize by case to avoid enqueue races.
      const outcome = await retriggerCase(c);
      results.push(outcome);
      if (outcome.skipped) {
        console.log(`  SKIP case #${outcome.caseId}: ${outcome.reason}`);
      } else if (outcome.dryRun) {
        console.log(`  DRY case #${outcome.caseId}: would trigger msg ${outcome.messageId}`);
      } else {
        console.log(`  OK   case #${outcome.caseId}: run ${outcome.runId}, trigger ${outcome.triggerRunId}`);
      }
    } catch (err) {
      results.push({ caseId: c.case_id, error: err.message });
      console.log(`  ERR  case #${c.case_id}: ${err.message}`);
    }
  }

  const ok = results.filter((r) => r.runId).length;
  const skipped = results.filter((r) => r.skipped).length;
  const failed = results.filter((r) => r.error).length;
  console.log(`\nDone. triggered=${ok} skipped=${skipped} errors=${failed}`);
}

main()
  .catch((err) => {
    console.error(`Fatal: ${err.message}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    try {
      await db.close();
    } catch (_) {}
  });
