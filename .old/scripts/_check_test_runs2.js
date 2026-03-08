const { Client } = require("pg");

async function main() {
  const c = new Client("postgresql://postgres:EsoRieVyRUVqLZEaGcecTqCDALRGxXXH@switchback.proxy.rlwy.net:39529/railway");
  await c.connect();

  const caseIds = [25158, 60, 25161, 25151, 25136];

  // Recent proposals (updated in last 30 min)
  const { rows: proposals } = await c.query(
    `SELECT p.id, p.case_id, p.action_type, p.status, p.confidence,
            p.waitpoint_token IS NOT NULL as has_token,
            LEFT(p.waitpoint_token, 30) as token_prefix,
            p.updated_at
     FROM proposals p
     WHERE p.case_id = ANY($1)
       AND p.updated_at > NOW() - interval '30 minutes'
     ORDER BY p.updated_at DESC`,
    [caseIds]
  );

  console.log("=== Proposals updated in last 30 min ===");
  for (const p of proposals) {
    const ts = new Date(p.updated_at).toISOString().substring(11, 19);
    console.log(
      `[${ts}] Proposal ${p.id} | case ${p.case_id} | ${p.action_type} | ${p.status} | conf ${p.confidence} | token: ${p.token_prefix || "none"}`
    );
  }

  // Check constraints updated recently
  const { rows: constraints } = await c.query(
    `SELECT case_id, constraint_text, created_at
     FROM case_constraints
     WHERE case_id = ANY($1) AND created_at > NOW() - interval '30 minutes'
     ORDER BY created_at DESC
     LIMIT 10`,
    [caseIds]
  );
  if (constraints.length > 0) {
    console.log("\n=== Constraints added ===");
    for (const cc of constraints) {
      console.log(`  case ${cc.case_id}: ${cc.constraint_text}`);
    }
  }

  // Check scope items updated recently
  const { rows: scope } = await c.query(
    `SELECT case_id, name, status, updated_at
     FROM scope_items
     WHERE case_id = ANY($1) AND updated_at > NOW() - interval '30 minutes'
     ORDER BY updated_at DESC
     LIMIT 10`,
    [caseIds]
  );
  if (scope.length > 0) {
    console.log("\n=== Scope items updated ===");
    for (const s of scope) {
      console.log(`  case ${s.case_id}: ${s.name} -> ${s.status}`);
    }
  }

  await c.end();
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
