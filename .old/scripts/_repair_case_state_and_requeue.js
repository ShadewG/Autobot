#!/usr/bin/env node
require("dotenv").config();

if (!process.env.DATABASE_URL || process.env.DATABASE_URL.includes("railway.internal")) {
  process.env.DATABASE_URL = process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL;
}

const db = require("../services/database");

const BASE_URL = process.env.BASE_URL || "https://sincere-strength-production.up.railway.app";
const EXECUTE = process.argv.includes("--execute");

async function repairFollowupState() {
  const rows = await db.query(
    `
      SELECT f.id, f.case_id, f.status AS followup_status, c.status AS case_status, c.case_name
      FROM follow_up_schedule f
      JOIN cases c ON c.id = f.case_id
      WHERE f.status IN ('scheduled', 'processing')
        AND c.status NOT IN ('sent', 'awaiting_response')
      ORDER BY f.updated_at DESC
    `
  );

  const toCancel = rows.rows.filter((r) => ["completed", "cancelled", "needs_phone_call"].includes(r.case_status));
  const toPause = rows.rows.filter((r) => !["completed", "cancelled", "needs_phone_call"].includes(r.case_status));

  if (!EXECUTE) {
    return {
      total: rows.rows.length,
      toCancel,
      toPause,
      cancelled: 0,
      paused: 0,
    };
  }

  let cancelled = 0;
  let paused = 0;
  if (toCancel.length > 0) {
    const q = await db.query(
      `UPDATE follow_up_schedule
       SET status = 'cancelled', updated_at = NOW()
       WHERE id = ANY($1::int[])`,
      [toCancel.map((r) => r.id)]
    );
    cancelled = q.rowCount || 0;
  }

  if (toPause.length > 0) {
    const q = await db.query(
      `UPDATE follow_up_schedule
       SET status = 'paused', updated_at = NOW()
       WHERE id = ANY($1::int[])`,
      [toPause.map((r) => r.id)]
    );
    paused = q.rowCount || 0;
  }

  return {
    total: rows.rows.length,
    toCancel,
    toPause,
    cancelled,
    paused,
  };
}

async function findMislabelledReviewCases() {
  const result = await db.query(
    `
      SELECT
        c.id,
        c.case_name,
        c.status,
        c.substatus,
        c.requires_human,
        c.pause_reason,
        ap.id AS active_proposal_id,
        ar.id AS active_run_id,
        ar.status AS active_run_status,
        lm.id AS latest_inbound_id
      FROM cases c
      LEFT JOIN LATERAL (
        SELECT p.id
        FROM proposals p
        WHERE p.case_id = c.id
          AND p.status IN ('PENDING_APPROVAL','BLOCKED','DECISION_RECEIVED','PENDING_PORTAL')
        ORDER BY p.created_at DESC
        LIMIT 1
      ) ap ON TRUE
      LEFT JOIN LATERAL (
        SELECT ar.id, ar.status
        FROM agent_runs ar
        WHERE ar.case_id = c.id
          AND ar.status IN ('created','queued','processing','running','paused','waiting','gated')
        ORDER BY ar.id DESC
        LIMIT 1
      ) ar ON TRUE
      LEFT JOIN LATERAL (
        SELECT m.id
        FROM messages m
        WHERE m.case_id = c.id
          AND m.direction = 'inbound'
        ORDER BY COALESCE(m.received_at, m.created_at) DESC
        LIMIT 1
      ) lm ON TRUE
      WHERE c.status = 'needs_human_review'
        AND ap.id IS NULL
      ORDER BY c.updated_at DESC
    `
  );
  return result.rows;
}

async function requeueCase(caseId) {
  const response = await fetch(`${BASE_URL}/api/requests/${caseId}/reset-to-last-inbound`, {
    method: "POST",
    headers: { "content-type": "application/json" },
  });
  const payload = await response.json().catch(() => ({}));
  return {
    ok: response.ok && payload?.success,
    status: response.status,
    payload,
  };
}

async function main() {
  console.log(`Mode: ${EXECUTE ? "EXECUTE" : "DRY_RUN"}`);
  console.log(`Base URL: ${BASE_URL}`);

  const followupRepair = await repairFollowupState();
  console.log(`\nFollow-up schedule mismatches: ${followupRepair.total}`);
  console.log(`  Will cancel: ${followupRepair.toCancel.length}`);
  console.log(`  Will pause:  ${followupRepair.toPause.length}`);
  if (EXECUTE) {
    console.log(`  Cancelled: ${followupRepair.cancelled}`);
    console.log(`  Paused:    ${followupRepair.paused}`);
  }

  const mislabelled = await findMislabelledReviewCases();
  console.log(`\nMislabelled review cases (no active pending proposal): ${mislabelled.length}`);
  for (const c of mislabelled) {
    console.log(
      `  Case ${c.id}: requires_human=${c.requires_human} pause=${c.pause_reason || "null"} inbound=${c.latest_inbound_id || "none"}`
    );
  }

  if (!EXECUTE) return;

  let queued = 0;
  let failed = 0;
  for (const c of mislabelled) {
    if (!c.latest_inbound_id) {
      failed++;
      console.log(`  Skip case ${c.id}: no inbound message`);
      continue;
    }
    const res = await requeueCase(c.id);
    if (res.ok) {
      queued++;
      console.log(`  Requeued case ${c.id}: run ${res.payload.run_id} trigger ${res.payload.trigger_run_id}`);
    } else {
      failed++;
      console.log(`  Failed case ${c.id}: HTTP ${res.status} ${res.payload?.error || "unknown_error"}`);
    }
  }

  console.log(`\nRequeue summary: queued=${queued}, failed=${failed}`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });

