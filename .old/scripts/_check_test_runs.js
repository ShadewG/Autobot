const { Client } = require("pg");

async function main() {
  const c = new Client("postgresql://postgres:EsoRieVyRUVqLZEaGcecTqCDALRGxXXH@switchback.proxy.rlwy.net:39529/railway");
  await c.connect();

  // Activity log - last 30 min
  const { rows } = await c.query(
    "SELECT event_type, case_id, description, created_at FROM activity_log WHERE created_at > NOW() - interval '30 minutes' ORDER BY created_at DESC LIMIT 30"
  );

  console.log("=== Recent Activity (last 30 min) ===");
  for (const r of rows) {
    const ts = new Date(r.created_at).toISOString().substring(11, 19);
    console.log(`[${ts}] case ${r.case_id} | ${r.event_type}: ${r.description}`);
  }

  // Check agent_runs for our test runs
  const { rows: runs } = await c.query(
    "SELECT id, case_id, status, trigger_type, error, started_at FROM agent_runs WHERE id IN (491, 492, 494, 495, 496) ORDER BY id"
  );

  console.log("\n=== Agent Run Statuses ===");
  for (const r of runs) {
    console.log(`Run ${r.id} (case ${r.case_id}): ${r.status} | error: ${r.error || "none"}`);
  }

  await c.end();
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
