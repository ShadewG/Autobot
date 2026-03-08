const { Pool } = require("pg");
const pool = new Pool({ connectionString: "postgresql://postgres:EsoRieVyRUVqLZEaGcecTqCDALRGxXXH@switchback.proxy.rlwy.net:39529/railway" });

(async () => {
  const all = [25152, 25164, 25153, 25210, 25140, 25159, 25161, 25211, 25169, 25243, 25246, 25249, 25250, 25252, 25253];

  const problems = [];

  for (const id of all) {
    const c = await pool.query(`
      SELECT c.id, c.agency_name, c.agency_email, c.status, c.substatus, c.portal_url, c.state,
             c.requires_human, c.pause_reason
      FROM cases c WHERE c.id = $1
    `, [id]);
    const r = c.rows[0];

    const run = await pool.query(`
      SELECT id, status, trigger_type FROM agent_runs WHERE case_id = $1 ORDER BY updated_at DESC LIMIT 1
    `, [id]);
    const lr = run.rows[0];

    const prop = await pool.query(`
      SELECT id, action_type, status FROM proposals WHERE case_id = $1 ORDER BY created_at DESC LIMIT 1
    `, [id]);
    const lp = prop.rows[0];

    const outbound = await pool.query(`SELECT COUNT(*) as cnt FROM messages WHERE case_id = $1 AND direction = 'outbound'`, [id]);
    const portal = await pool.query(`SELECT COUNT(*) as cnt FROM portal_tasks WHERE case_id = $1`, [id]);

    const lastAct = await pool.query(`
      SELECT event_type, description FROM activity_log WHERE case_id = $1 ORDER BY created_at DESC LIMIT 1
    `, [id]);

    const runDone = lr?.status === "completed" || lr?.status === "failed" || lr?.status === "cancelled";
    const hasProposal = lp && (lp.status === "PENDING_APPROVAL" || lp.status === "BLOCKED");
    const isStuck = runDone && !r.requires_human && r.status === "awaiting_response" &&
      Number(outbound.rows[0].cnt) === 0 && Number(portal.rows[0].cnt) === 0 &&
      !hasProposal;
    const noAction = (lastAct.rows[0]?.description || "").includes("no-action path");

    let status = "OK";
    if (lr?.status === "running" || lr?.status === "queued" || lr?.status === "waiting") status = "PROCESSING";
    else if (hasProposal) status = "PENDING_PROPOSAL";
    else if (r.requires_human) status = "NEEDS_REVIEW";
    else if (isStuck || noAction) status = "STUCK";
    else if (r.status === "awaiting_response" && Number(outbound.rows[0].cnt) > 0) status = "SENT";
    else if (r.status === "awaiting_response" && Number(portal.rows[0].cnt) > 0) status = "PORTAL_SENT";
    else if (r.status === "responded") status = "RESPONDED";

    const icon = {
      OK: "  ",
      PROCESSING: "...",
      PENDING_PROPOSAL: ">>",
      NEEDS_REVIEW: "??",
      SENT: "OK",
      PORTAL_SENT: "OK",
      RESPONDED: "OK",
      STUCK: "!!"
    }[status] || "  ";

    console.log(`${icon} #${id} ${status.padEnd(16)} | run:${(lr?.status||"none").padEnd(9)} | ${r.agency_name?.slice(0,35).padEnd(35)} | email:${(r.agency_email||"none").slice(0,35)}`);
    if (lp) console.log(`   proposal: #${lp.id} ${lp.action_type} ${lp.status}`);
    if (status === "STUCK") {
      console.log(`   STUCK: ${(lastAct.rows[0]?.description||"").slice(0,120)}`);
      problems.push(id);
    }
  }

  if (problems.length > 0) {
    console.log(`\n=== ${problems.length} STUCK CASES NEED ATTENTION: ${problems.join(", ")} ===`);
  } else {
    console.log("\n=== ALL CASES PROGRESSING ===");
  }

  await pool.end();
})();
