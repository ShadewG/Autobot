#!/usr/bin/env node
/**
 * One-off: Fix 3 old stuck cases
 *   #51, #57 — Raleigh portal redirects → create SUBMIT_PORTAL proposals
 *   #2593   — Physical mail fee → needs_human_review
 */
const { Pool } = require('pg');
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

(async () => {
  // === #51 and #57: Raleigh PD portal redirects ===
  const portalCases = [
    {
      id: 51,
      reasoning: ['Agency (Raleigh PD) does not accept email requests', 'Directed to submit via NextRequest portal at raleighnc.nextrequest.com', 'Original email from Nov 2025'],
      portalUrl: 'https://raleighnc.nextrequest.com/'
    },
    {
      id: 57,
      reasoning: ['Agency (Raleigh PD) does not accept email requests', 'Directed to submit via NextRequest portal at raleighnc.nextrequest.com', 'Original email from Nov 2025'],
      portalUrl: 'https://raleighnc.nextrequest.com/'
    }
  ];

  for (const c of portalCases) {
    const proposalKey = `manual:${c.id}:SUBMIT_PORTAL:fix_stuck`;
    const triggerMsg = await pool.query(
      "SELECT id FROM messages WHERE case_id = $1 AND direction = 'inbound' ORDER BY created_at DESC LIMIT 1",
      [c.id]
    );
    const triggerId = triggerMsg.rows[0]?.id || null;

    await pool.query(`
      INSERT INTO proposals (
        proposal_key, case_id, trigger_message_id, action_type,
        reasoning, confidence, can_auto_execute, requires_human, status
      ) VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9)
      ON CONFLICT (proposal_key) DO NOTHING
    `, [
      proposalKey, c.id, triggerId, 'SUBMIT_PORTAL',
      JSON.stringify(c.reasoning), 0.95, false, true, 'PENDING_APPROVAL'
    ]);

    // Update case status and store portal URL
    await pool.query("UPDATE cases SET status = 'needs_human_review' WHERE id = $1", [c.id]);
    await pool.query("UPDATE cases SET portal_url = $1 WHERE id = $2", [c.portalUrl, c.id]);

    console.log(`#${c.id}: Created SUBMIT_PORTAL proposal → needs_human_review (portal: ${c.portalUrl})`);
  }

  // === #2593: Norman PD requires $36 physical mail payment ===
  const feeCase = 2593;
  const feeProposalKey = `manual:${feeCase}:ESCALATE:physical_mail_fee`;
  const feeTriggerMsg = await pool.query(
    "SELECT id FROM messages WHERE case_id = $1 AND direction = 'inbound' ORDER BY created_at DESC LIMIT 1",
    [feeCase]
  );
  const feeTriggerId = feeTriggerMsg.rows[0]?.id || null;

  await pool.query(`
    INSERT INTO proposals (
      proposal_key, case_id, trigger_message_id, action_type,
      reasoning, confidence, can_auto_execute, requires_human, status
    ) VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9)
    ON CONFLICT (proposal_key) DO NOTHING
  `, [
    feeProposalKey, feeCase, feeTriggerId, 'ESCALATE',
    JSON.stringify([
      'Norman PD requires $36 payment via physical mail',
      'Check/money order to 112 W. Daws St., Norman, OK 73069',
      'Includes: BWC footage, 911 audio, CAD report, incident report (all redacted)',
      'Processing time 12-15 weeks after payment',
      'System cannot handle physical mail payments'
    ]),
    0.98, false, true, 'PENDING_APPROVAL'
  ]);

  await pool.query("UPDATE cases SET status = 'needs_human_review' WHERE id = $1", [feeCase]);
  console.log(`#${feeCase}: Created ESCALATE proposal → needs_human_review (physical mail fee $36)`);

  console.log('\nDone — 3 cases fixed.');
  await pool.end();
})();
