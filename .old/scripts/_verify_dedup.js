const { Pool } = require("pg");
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

(async () => {
  // 1. Check for any duplicate PENDING_APPROVAL proposals
  const dupes = await pool.query(`
    SELECT case_id, COUNT(*) as cnt, array_agg(id ORDER BY id) as ids, array_agg(action_type ORDER BY id) as actions
    FROM proposals WHERE status = 'PENDING_APPROVAL'
    GROUP BY case_id HAVING COUNT(*) > 1
  `);
  console.log("=== Cases with multiple PENDING_APPROVAL proposals ===");
  if (dupes.rows.length === 0) {
    console.log("  NONE — dedup guard is working");
  } else {
    dupes.rows.forEach(r => console.log(`  Case #${r.case_id}: ${r.cnt} proposals ${JSON.stringify(r.ids)} actions: ${JSON.stringify(r.actions)}`));
  }

  // 2. All current pending proposals
  const pending = await pool.query(`
    SELECT id, case_id, action_type, proposal_key, created_at
    FROM proposals WHERE status = 'PENDING_APPROVAL' ORDER BY id
  `);
  console.log(`\n=== All PENDING_APPROVAL proposals (${pending.rows.length}) ===`);
  pending.rows.forEach(r => console.log(`  #${r.id} Case #${r.case_id}: ${r.action_type} (key: ${r.proposal_key})`));

  // 3. Proposals created in last 6 hours (to see post-deploy activity)
  const recent = await pool.query(`
    SELECT id, case_id, action_type, status, proposal_key, created_at
    FROM proposals WHERE created_at > NOW() - INTERVAL '6 hours'
    ORDER BY created_at DESC
  `);
  console.log(`\n=== Proposals created in last 6 hours (${recent.rows.length}) ===`);
  recent.rows.forEach(r => console.log(`  #${r.id} Case #${r.case_id}: ${r.action_type} [${r.status}] key=${r.proposal_key}`));

  // 4. Recently dismissed proposals (to see our cleanup + any auto-dismissals)
  const dismissed = await pool.query(`
    SELECT id, case_id, action_type, human_decision, human_decided_at
    FROM proposals WHERE status = 'DISMISSED' AND human_decided_at > NOW() - INTERVAL '24 hours'
    ORDER BY human_decided_at DESC
  `);
  console.log(`\n=== Dismissed in last 24h (${dismissed.rows.length}) ===`);
  dismissed.rows.forEach(r => {
    const reason = typeof r.human_decision === "string" ? r.human_decision : JSON.stringify(r.human_decision);
    console.log(`  #${r.id} Case #${r.case_id}: ${r.action_type} — ${(reason || "no reason").substring(0, 100)}`);
  });

  // 5. Check if the cron sweep has run since deploy
  const cronActivity = await pool.query(`
    SELECT id, event_type, description, metadata, created_at
    FROM activity_log
    WHERE event_type IN ('deadline_escalation', 'sweep_stuck_portals', 'sweep_orphan_reviews')
      AND created_at > NOW() - INTERVAL '6 hours'
    ORDER BY created_at DESC LIMIT 10
  `);
  console.log(`\n=== Cron activity in last 6 hours (${cronActivity.rows.length}) ===`);
  cronActivity.rows.forEach(r => {
    const meta = typeof r.metadata === "object" ? JSON.stringify(r.metadata).substring(0, 100) : "";
    console.log(`  ${r.event_type} at ${r.created_at} — ${(r.description || "").substring(0, 80)} ${meta}`);
  });

  // 6. Historical check: how many times each case got multiple proposals (all-time)
  const historicalDupes = await pool.query(`
    SELECT case_id, COUNT(*) as total,
           COUNT(*) FILTER (WHERE status = 'PENDING_APPROVAL') as pending,
           COUNT(*) FILTER (WHERE status = 'DISMISSED') as dismissed,
           COUNT(*) FILTER (WHERE status = 'EXECUTED') as executed
    FROM proposals
    GROUP BY case_id
    HAVING COUNT(*) > 2
    ORDER BY COUNT(*) DESC
    LIMIT 10
  `);
  console.log(`\n=== Cases with most proposals (all-time, top 10) ===`);
  historicalDupes.rows.forEach(r => console.log(`  Case #${r.case_id}: ${r.total} total (${r.pending} pending, ${r.dismissed} dismissed, ${r.executed} executed)`));

  await pool.end();
})().catch(e => { console.error(e); process.exit(1); });
