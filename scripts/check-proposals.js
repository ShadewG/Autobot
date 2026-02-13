const { Client } = require('pg');

const DATABASE_URL = process.env.DATABASE_URL || "postgresql://postgres:EsoRieVyRUVqLZEaGcecTqCDALRGxXXH@switchback.proxy.rlwy.net:39529/railway";

async function main() {
  const client = new Client({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } });
  await client.connect();

  // First: what proposals exist in the #142-147 range?
  console.log('=== PROPOSALS #142-#147 ===\n');
  const proposals = await client.query(`
    SELECT p.*, c.case_name, c.agency_name, c.status as case_status, c.send_date, c.state
    FROM proposals p
    JOIN cases c ON p.case_id = c.id
    WHERE p.id BETWEEN 142 AND 147
    ORDER BY p.id
  `);

  if (proposals.rows.length === 0) {
    console.log('  No proposals found in range #142-#147.\n');

    // Check the latest proposals
    console.log('=== LATEST 10 PROPOSALS ===\n');
    const latest = await client.query(`
      SELECT p.id, p.case_id, p.action_type, p.status, p.reasoning, p.created_at,
             p.draft_subject, LEFT(p.draft_body_text, 300) as body_preview,
             c.case_name, c.agency_name, c.status as case_status
      FROM proposals p
      JOIN cases c ON p.case_id = c.id
      ORDER BY p.id DESC
      LIMIT 10
    `);
    for (const row of latest.rows) {
      console.log(`--- Proposal #${row.id} (${row.status}) ---`);
      console.log(`  Case #${row.case_id}: ${row.case_name} | Agency: ${row.agency_name}`);
      console.log(`  Case Status: ${row.case_status}`);
      console.log(`  Action: ${row.action_type}`);
      console.log(`  Subject: ${row.draft_subject}`);
      console.log(`  Reasoning: ${JSON.stringify(row.reasoning)?.substring(0, 300)}`);
      console.log(`  Body Preview: ${row.body_preview?.substring(0, 200)}`);
      console.log(`  Created: ${row.created_at}`);
      console.log();
    }

    // Also check for any pending_review proposals
    console.log('=== ALL PENDING_REVIEW PROPOSALS ===\n');
    const pending = await client.query(`
      SELECT p.id, p.case_id, p.action_type, p.status, p.created_at,
             c.case_name
      FROM proposals p
      JOIN cases c ON p.case_id = c.id
      WHERE p.status = 'pending_review'
      ORDER BY p.id
    `);
    if (pending.rows.length === 0) {
      console.log('  No pending_review proposals found.\n');
    } else {
      for (const row of pending.rows) {
        console.log(`  #${row.id} Case #${row.case_id} (${row.case_name}) - ${row.action_type}`);
      }
    }
  } else {
    for (const row of proposals.rows) {
      console.log(`--- Proposal #${row.id} (${row.status}) ---`);
      console.log(`  Case ID: ${row.case_id} | Case: ${row.case_name}`);
      console.log(`  Agency: ${row.agency_name} | State: ${row.state}`);
      console.log(`  Case Status: ${row.case_status} | Send Date: ${row.send_date}`);
      console.log(`  Action: ${row.action_type}`);
      console.log(`  Subject: ${row.draft_subject}`);
      console.log(`  Reasoning: ${JSON.stringify(row.reasoning)?.substring(0, 400)}`);
      console.log(`  Body Preview: ${row.draft_body_text?.substring(0, 400)}`);
      console.log(`  Confidence: ${row.confidence} | Can Auto-Execute: ${row.can_auto_execute}`);
      console.log(`  Risk Flags: ${JSON.stringify(row.risk_flags)}`);
      console.log(`  Warnings: ${JSON.stringify(row.warnings)}`);
      console.log(`  Created: ${row.created_at}`);
      if (row.approved_at) console.log(`  Approved: ${row.approved_at} by ${row.approved_by}`);
      if (row.executed_at) console.log(`  Executed: ${row.executed_at}`);
      if (row.human_decided_at) console.log(`  Human Decision: ${JSON.stringify(row.human_decision)} at ${row.human_decided_at}`);
      console.log();
    }
  }

  // Get the case IDs we care about
  const targetProposals = proposals.rows.length > 0 ? proposals.rows : (await client.query(`
    SELECT p.id, p.case_id FROM proposals p ORDER BY p.id DESC LIMIT 10
  `)).rows;

  const caseIds = [...new Set(targetProposals.map(r => r.case_id))];
  console.log(`\nInvestigating case IDs: ${caseIds.join(', ')}\n`);

  // Messages for these cases
  console.log('=== MESSAGE HISTORY ===\n');
  const messages = await client.query(`
    SELECT m.id, m.case_id, m.direction, m.subject, m.from_email, m.to_email,
           LEFT(m.body_text, 300) as body_preview,
           COALESCE(m.received_at, m.sent_at, m.created_at) as msg_date
    FROM messages m
    WHERE m.case_id = ANY($1)
    ORDER BY m.case_id, COALESCE(m.received_at, m.sent_at, m.created_at) DESC
  `, [caseIds]);

  let currentCaseId = null;
  for (const row of messages.rows) {
    if (row.case_id !== currentCaseId) {
      currentCaseId = row.case_id;
      console.log(`\n--- Messages for Case #${row.case_id} ---`);
    }
    console.log(`  [${row.direction}] ${row.msg_date}`);
    console.log(`    From: ${row.from_email} -> To: ${row.to_email}`);
    console.log(`    Subject: ${row.subject}`);
    console.log(`    Preview: ${row.body_preview?.substring(0, 250)}`);
    console.log();
  }

  // Check cases table columns first
  const caseCols = await client.query(`
    SELECT column_name FROM information_schema.columns
    WHERE table_name = 'cases' AND column_name LIKE '%portal%'
    ORDER BY ordinal_position
  `);
  const portalCols = caseCols.rows.map(r => r.column_name);
  console.log(`\nPortal-related columns in cases: ${portalCols.join(', ')}\n`);

  // Portal status
  console.log('=== CASE STATUS & PORTAL INFO ===\n');
  const portalColsStr = portalCols.length > 0 ? ', ' + portalCols.map(c => 'c.' + c).join(', ') : '';
  const caseInfo = await client.query(`
    SELECT c.id, c.case_name, c.agency_name, c.status as case_status, c.send_date${portalColsStr}
    FROM cases c
    WHERE c.id = ANY($1)
    ORDER BY c.id
  `, [caseIds]);

  for (const row of caseInfo.rows) {
    console.log(`  Case #${row.id}: ${row.case_name}`);
    console.log(`    Agency: ${row.agency_name}`);
    console.log(`    Case Status: ${row.case_status} | Send Date: ${row.send_date}`);
    for (const col of portalCols) {
      console.log(`    ${col}: ${row[col]}`);
    }
    console.log();
  }

  // Activity log
  console.log('=== RECENT ACTIVITY LOG ===\n');
  const activity = await client.query(`
    SELECT al.case_id, al.action, LEFT(al.details::text, 250) as details, al.created_at
    FROM activity_log al
    WHERE al.case_id = ANY($1)
    ORDER BY al.case_id, al.created_at DESC
  `, [caseIds]);

  currentCaseId = null;
  for (const row of activity.rows) {
    if (row.case_id !== currentCaseId) {
      currentCaseId = row.case_id;
      console.log(`\n--- Activity for Case #${row.case_id} ---`);
    }
    console.log(`  [${row.created_at}] ${row.action}: ${row.details?.substring(0, 200)}`);
  }

  // All proposals for these cases (to see history)
  console.log('\n\n=== ALL PROPOSALS FOR THESE CASES ===\n');
  const allProposals = await client.query(`
    SELECT p.id, p.case_id, p.action_type, p.status,
           LEFT(p.reasoning::text, 200) as reasoning,
           p.draft_subject,
           p.created_at, p.approved_at, p.executed_at
    FROM proposals p
    WHERE p.case_id = ANY($1)
    ORDER BY p.case_id, p.created_at DESC
  `, [caseIds]);

  currentCaseId = null;
  for (const row of allProposals.rows) {
    if (row.case_id !== currentCaseId) {
      currentCaseId = row.case_id;
      console.log(`\n--- All Proposals for Case #${row.case_id} ---`);
    }
    console.log(`  #${row.id} ${row.action_type} (${row.status}) - Created: ${row.created_at}`);
    console.log(`    Subject: ${row.draft_subject}`);
    console.log(`    Reasoning: ${row.reasoning}`);
    if (row.approved_at) console.log(`    Approved: ${row.approved_at}`);
    if (row.executed_at) console.log(`    Executed: ${row.executed_at}`);
  }

  await client.end();
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
