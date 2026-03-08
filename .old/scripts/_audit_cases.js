#!/usr/bin/env node
/**
 * One-off script: Audit all active cases and check status correctness
 */
const { Pool } = require('pg');
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

(async () => {
  const res = await pool.query(`
    SELECT
      c.id,
      c.case_name,
      c.status,
      c.created_at,
      ra.intent as latest_intent,
      ra.suggested_action,
      ra.confidence_score,
      ra.created_at as analysis_date,
      m_latest.direction as latest_msg_direction,
      m_latest.subject as latest_msg_subject,
      m_latest.received_at as latest_msg_date,
      (SELECT COUNT(*) FROM messages WHERE case_id = c.id AND direction = 'inbound') as inbound_count,
      (SELECT COUNT(*) FROM messages WHERE case_id = c.id AND direction = 'outbound') as outbound_count,
      (SELECT COUNT(*) FROM proposals WHERE case_id = c.id AND status = 'pending') as pending_proposals
    FROM cases c
    LEFT JOIN LATERAL (
      SELECT ra2.intent, ra2.suggested_action, ra2.confidence_score, ra2.created_at
      FROM response_analysis ra2
      JOIN messages m2 ON ra2.message_id = m2.id
      WHERE m2.case_id = c.id
      ORDER BY ra2.created_at DESC
      LIMIT 1
    ) ra ON true
    LEFT JOIN LATERAL (
      SELECT m3.direction, m3.subject, m3.received_at
      FROM messages m3
      WHERE m3.case_id = c.id
      ORDER BY COALESCE(m3.received_at, m3.sent_at, m3.created_at) DESC
      LIMIT 1
    ) m_latest ON true
    WHERE c.status NOT IN ('completed', 'cancelled', 'rejected', 'archived', 'draft')
    ORDER BY c.id
  `);

  console.log(`Total active cases: ${res.rows.length}\n`);

  // Group by status
  const byStatus = {};
  for (const r of res.rows) {
    if (!byStatus[r.status]) byStatus[r.status] = [];
    byStatus[r.status].push(r);
  }

  // Print each group
  for (const status of Object.keys(byStatus).sort()) {
    console.log(`\n========== ${status.toUpperCase()} (${byStatus[status].length}) ==========`);
    for (const r of byStatus[status]) {
      const name = (r.case_name || '').substring(0, 70);
      const flags = [];
      if (r.latest_intent) flags.push(`intent:${r.latest_intent}`);
      if (Number(r.pending_proposals) > 0) flags.push(`${r.pending_proposals} pending proposals`);
      flags.push(`in:${r.inbound_count} out:${r.outbound_count}`);
      if (r.latest_msg_date) flags.push(`last msg: ${new Date(r.latest_msg_date).toISOString().split('T')[0]}`);
      console.log(`  #${r.id} ${name}`);
      console.log(`    ${flags.join(' | ')}`);
    }
  }

  // Flag potential issues
  console.log('\n\n========== POTENTIAL ISSUES ==========');
  let issues = 0;

  for (const r of res.rows) {
    const problems = [];

    // responded + acknowledgment = should be awaiting_response
    if (r.status === 'responded' && r.latest_intent === 'acknowledgment') {
      problems.push('responded with only acknowledgment → should be awaiting_response');
    }

    // responded + no proposals + no pending action
    if (r.status === 'responded' && Number(r.pending_proposals) === 0 && r.latest_intent && !['acknowledgment'].includes(r.latest_intent)) {
      problems.push(`responded with intent "${r.latest_intent}" but 0 pending proposals`);
    }

    // sent but has inbound messages (should be responded or awaiting_response)
    if (r.status === 'sent' && Number(r.inbound_count) > 0) {
      problems.push(`status is "sent" but has ${r.inbound_count} inbound messages`);
    }

    // needs_human_review with no pending proposals
    if (r.status === 'needs_human_review' && Number(r.pending_proposals) === 0) {
      problems.push('needs_human_review but 0 pending proposals');
    }

    // pending with outbound messages (should have progressed)
    if (r.status === 'pending' && Number(r.outbound_count) > 0) {
      problems.push(`status is "pending" but has ${r.outbound_count} outbound messages`);
    }

    if (problems.length > 0) {
      issues++;
      const name = (r.case_name || '').substring(0, 60);
      console.log(`\n  #${r.id} ${name} [${r.status}]`);
      for (const p of problems) {
        console.log(`    ⚠ ${p}`);
      }
    }
  }

  if (issues === 0) {
    console.log('  No issues found!');
  } else {
    console.log(`\n  Total cases with issues: ${issues}`);
  }

  await pool.end();
})();
