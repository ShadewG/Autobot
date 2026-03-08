const { Pool } = require("pg");
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

(async () => {
  const res = await pool.query(`
    SELECT p.id, p.case_id, p.action_type, p.reasoning, p.draft_subject, p.draft_body_text,
           p.confidence, p.risk_flags, p.warnings, p.created_at,
           c.agency_name, c.state, c.status as case_status, c.case_name,
           c.agency_email, c.portal_url, c.requested_records, c.subject_name
    FROM proposals p
    JOIN cases c ON c.id = p.case_id
    WHERE p.status = 'PENDING_APPROVAL'
    ORDER BY p.id
  `);

  for (const p of res.rows) {
    console.log("========================================");
    console.log(`Proposal #${p.id} | Case #${p.case_id} | ${p.action_type}`);
    console.log(`Agency: ${p.agency_name}, ${p.state}`);
    console.log(`Case: ${p.case_name || p.subject_name || "unnamed"}`);
    const records = Array.isArray(p.requested_records) ? p.requested_records.join(", ") : String(p.requested_records || "");
    console.log(`Records: ${records.substring(0, 100)}`);
    console.log(`Case status: ${p.case_status}`);
    console.log(`Email: ${p.agency_email || "none"} | Portal: ${p.portal_url || "none"}`);
    console.log(`Confidence: ${p.confidence}`);

    const reasoning = typeof p.reasoning === "object" ? JSON.stringify(p.reasoning).substring(0, 500) : String(p.reasoning || "").substring(0, 500);
    console.log(`Reasoning: ${reasoning}`);

    const warnings = p.warnings ? (typeof p.warnings === "object" ? JSON.stringify(p.warnings) : String(p.warnings)) : null;
    if (warnings) console.log(`Warnings: ${warnings.substring(0, 200)}`);

    console.log(`Draft subject: ${p.draft_subject || "none"}`);
    const body = (p.draft_body_text || "").substring(0, 500);
    if (body) console.log(`Draft body: ${body}`);

    // Latest response_analysis
    const ra = await pool.query(
      "SELECT intent, confidence_score, suggested_action, extracted_fee_amount, key_points FROM response_analysis WHERE case_id = $1 ORDER BY created_at DESC LIMIT 1",
      [p.case_id]
    );
    if (ra.rows[0]) {
      const a = ra.rows[0];
      console.log(`AI Analysis: intent=${a.intent}, fee=${a.extracted_fee_amount}, action=${a.suggested_action}`);
    }

    // Latest inbound message
    const msg = await pool.query(
      "SELECT id, subject, from_email, body_text FROM messages WHERE case_id = $1 AND direction = 'inbound' ORDER BY created_at DESC LIMIT 1",
      [p.case_id]
    );
    if (msg.rows[0]) {
      const m = msg.rows[0];
      console.log(`Latest inbound #${m.id} from ${(m.from_email || "").substring(0, 50)}`);
      console.log(`  Subj: ${(m.subject || "").substring(0, 80)}`);
      console.log(`  Body: ${(m.body_text || "").substring(0, 400)}`);
    }
    console.log("");
  }

  await pool.end();
})().catch(e => { console.error(e); process.exit(1); });
