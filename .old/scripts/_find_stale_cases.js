const { Pool } = require("pg");
const pool = new Pool({ connectionString: "postgresql://postgres:EsoRieVyRUVqLZEaGcecTqCDALRGxXXH@switchback.proxy.rlwy.net:39529/railway" });

(async () => {
  const { rows } = await pool.query(`
    SELECT c.id, c.case_name, c.agency_name, c.status, c.substatus, c.pause_reason,
           c.requires_human, c.updated_at, c.portal_url, c.agency_email,
           (SELECT COUNT(*) FROM messages m WHERE m.case_id = c.id AND m.direction = 'outbound') as outbound_count,
           (SELECT COUNT(*) FROM portal_tasks pt WHERE pt.case_id = c.id) as portal_task_count,
           (SELECT COUNT(*) FROM agent_runs ar WHERE ar.case_id = c.id AND ar.status IN ('created','queued','processing','running','waiting')) as active_runs,
           (SELECT description FROM activity_log al WHERE al.case_id = c.id ORDER BY al.created_at DESC LIMIT 1) as last_activity
    FROM cases c
    WHERE c.status NOT IN ('completed', 'closed', 'withdrawn', 'cancelled', 'duplicate')
    ORDER BY c.updated_at DESC
  `);

  console.log("Total active cases:", rows.length);

  const suspicious = rows.filter(r => {
    const sub = (r.substatus || "").toLowerCase();
    const status = r.status || "";
    const outbound = Number(r.outbound_count);
    const portal = Number(r.portal_task_count);
    const activeRuns = Number(r.active_runs);
    const hoursStale = (Date.now() - new Date(r.updated_at).getTime()) / (1000 * 60 * 60);
    const lastAct = (r.last_activity || "").toLowerCase();

    // awaiting_response but nothing was ever sent
    if (status === "awaiting_response" && outbound === 0 && portal === 0) return true;

    // Substatus mentions research but no human flag and no active run
    if (sub.includes("research") && r.requires_human === false && activeRuns === 0 && hoursStale > 1) return true;

    // Stuck "Resolving:" substatus with no active run
    if (sub.includes("resolving") && activeRuns === 0 && hoursStale > 1) return true;

    // awaiting_response, no active runs, no human flag, stale > 24h
    if (status === "awaiting_response" && activeRuns === 0 && r.requires_human === false && hoursStale > 24) return true;

    // Last activity was research_failed and case is idle
    if (lastAct.includes("research_failed") && activeRuns === 0 && r.requires_human === false) return true;

    // needs_human_review but stale > 48h (might be forgotten)
    if (status === "needs_human_review" && hoursStale > 48 && activeRuns === 0) return true;

    return false;
  });

  console.log("\n=== POTENTIALLY STALE CASES ===");
  console.log("Count:", suspicious.length);

  for (const r of suspicious) {
    const hoursAgo = ((Date.now() - new Date(r.updated_at).getTime()) / (1000 * 60 * 60)).toFixed(1);
    console.log(`\n#${r.id} ${(r.case_name || "").slice(0, 60)}`);
    console.log(`  agency: ${r.agency_name}`);
    console.log(`  status: ${r.status} | substatus: ${r.substatus}`);
    console.log(`  pause: ${r.pause_reason} | human: ${r.requires_human}`);
    console.log(`  outbound: ${r.outbound_count} | portal: ${r.portal_task_count} | active_runs: ${r.active_runs}`);
    console.log(`  stale: ${hoursAgo}h ago`);
    console.log(`  last_activity: ${(r.last_activity || "none").slice(0, 120)}`);
  }

  await pool.end();
})();
