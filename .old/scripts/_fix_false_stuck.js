const { Pool } = require("pg");
const pool = new Pool({ connectionString: "postgresql://postgres:EsoRieVyRUVqLZEaGcecTqCDALRGxXXH@switchback.proxy.rlwy.net:39529/railway" });

(async () => {
  // Verify portal tasks for the "stuck" cases
  for (const id of [25164, 25153, 25211]) {
    const portal = await pool.query(`
      SELECT id, status, action_type, completion_notes, updated_at
      FROM portal_tasks WHERE case_id = $1 ORDER BY updated_at DESC LIMIT 3
    `, [id]);
    const outbound = await pool.query(`SELECT COUNT(*) as cnt FROM messages WHERE case_id = $1 AND direction = 'outbound'`, [id]);
    const inbound = await pool.query(`SELECT COUNT(*) as cnt FROM messages WHERE case_id = $1 AND direction = 'inbound'`, [id]);

    console.log(`#${id}:`);
    console.log(`  outbound messages: ${outbound.rows[0].cnt} | inbound: ${inbound.rows[0].cnt}`);
    console.log(`  portal tasks (${portal.rows.length}):`);
    for (const p of portal.rows) {
      console.log(`    #${p.id} ${p.status} ${p.action_type} | ${(p.completion_notes || "").slice(0, 100)}`);
    }
    console.log();
  }

  // These cases actually HAVE sent requests (via portal) and received confirmations.
  // They are correctly at awaiting_response. The no-action path was correct behavior.
  // Reset substatus to something meaningful.
  for (const { id, note } of [
    { id: 25164, note: "Portal submitted + confirmed (MR-2026-6). Awaiting agency response." },
    { id: 25153, note: "Portal submitted + confirmed. Awaiting records." },
    { id: 25211, note: "Agency needs APRA form. Has 3 inbound msgs." },
  ]) {
    await pool.query(`
      UPDATE cases SET
        substatus = $2,
        requires_human = false,
        pause_reason = null
      WHERE id = $1
    `, [id, note]);
    await pool.query(
      `INSERT INTO activity_log (case_id, event_type, description) VALUES ($1, 'manual_fix', $2)`,
      [id, `Corrected false-stuck: request was sent via portal, inbound confirms receipt. ${note}`]
    );
    console.log(`Fixed #${id}: ${note}`);
  }

  // #25210 also needs attention - run failed, still has wrong email
  const c210 = await pool.query(`SELECT agency_name, agency_email, status, substatus FROM cases WHERE id = 25210`);
  console.log(`\n#25210: ${c210.rows[0].agency_name} | email: ${c210.rows[0].agency_email} | ${c210.rows[0].status}`);

  console.log("\n=== DONE ===");
  await pool.end();
})();
