#!/usr/bin/env node
/**
 * One-time patch: set thread_id on messages that have case_id but missing thread_id.
 * Also re-matches MSG #316 (Iowa closure) to case #726.
 */
require('dotenv').config();
const db = require('../services/database');

async function patch() {
  // 1. Re-match MSG #316 to case #726 (now matchable via request number 26-559)
  console.log('=== Re-matching MSG #316 to case #726 ===');
  await db.query(
    'UPDATE messages SET case_id = $1 WHERE id = $2 AND case_id IS NULL',
    [726, 316]
  );
  console.log('  MSG #316 -> case_id = 726');

  // 2. Fix all messages that have case_id but no thread_id
  const broken = await db.query(`
    SELECT m.id, m.case_id, m.from_email, m.subject
    FROM messages m
    WHERE m.direction = 'inbound'
      AND m.case_id IS NOT NULL
      AND m.thread_id IS NULL
    ORDER BY m.created_at DESC
  `);

  console.log(`\n=== Fixing ${broken.rows.length} messages with case_id but no thread_id ===\n`);

  let fixed = 0;
  let noThread = 0;

  for (const msg of broken.rows) {
    // Look up the thread for this case
    const thread = await db.query(
      'SELECT id FROM email_threads WHERE case_id = $1 ORDER BY created_at DESC LIMIT 1',
      [msg.case_id]
    );

    if (thread.rows.length > 0) {
      await db.query(
        'UPDATE messages SET thread_id = $1 WHERE id = $2',
        [thread.rows[0].id, msg.id]
      );
      console.log(`  MSG #${msg.id} (case ${msg.case_id}) -> thread_id = ${thread.rows[0].id}`);
      fixed++;
    } else {
      console.log(`  MSG #${msg.id} (case ${msg.case_id}) -> NO THREAD EXISTS, skipping`);
      noThread++;
    }
  }

  console.log(`\n=== Done: ${fixed} fixed, ${noThread} no thread ===`);
  await db.close();
}

patch().catch(e => { console.error(e); process.exit(1); });
