#!/usr/bin/env node
require('dotenv').config();
const db = require('../services/database');

(async () => {
  const result = await db.query(`
    SELECT m.id, m.from_email, m.subject, m.case_id, m.thread_id, m.created_at
    FROM messages m
    WHERE m.direction = 'inbound'
      AND (m.case_id IS NULL OR m.thread_id IS NULL)
      AND m.to_email NOT LIKE '%autobot.test%'
      AND m.from_email NOT LIKE '%example.com%'
      AND m.from_email NOT LIKE '%test-debug%'
      AND m.subject NOT LIKE '%Debug Test%'
      AND m.subject NOT LIKE '%SOULMATE%'
      AND m.subject NOT LIKE '%Representation%'
      AND m.subject NOT LIKE '%Validation Service%'
    ORDER BY m.created_at DESC
    LIMIT 20
  `);

  for (const row of result.rows) {
    let status = 'OTHER';
    if (row.case_id && row.thread_id == null) status = 'HAS_CASE_NO_THREAD';
    if (row.case_id == null && row.thread_id == null) status = 'FULLY_UNMATCHED';
    console.log(`--- MSG #${row.id} [${status}] ---`);
    console.log(`  From: ${row.from_email}`);
    console.log(`  Subject: ${row.subject}`);
    console.log(`  Case: ${row.case_id ?? 'NULL'} | Thread: ${row.thread_id ?? 'NULL'}`);
    console.log(`  Date: ${row.created_at}`);
    console.log('');
  }
  await db.close();
})().catch(e => { console.error(e); process.exit(1); });
