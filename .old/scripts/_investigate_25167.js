#!/usr/bin/env node
const { Pool } = require('pg');
const pool = new Pool({ connectionString: 'postgresql://postgres:EsoRieVyRUVqLZEaGcecTqCDALRGxXXH@switchback.proxy.rlwy.net:39529/railway' });

(async () => {
    // Proposals for case 25167
    const props = await pool.query('SELECT * FROM proposals WHERE case_id = 25167 ORDER BY created_at');
    console.log(`=== PROPOSALS FOR CASE #25167 (${props.rows.length}) ===`);
    for (const p of props.rows) {
        console.log(`Proposal #${p.id} [${p.status}] ${p.created_at.toISOString().slice(0,16)}`);
        for (const [k, v] of Object.entries(p)) {
            if (v === null || k === 'id' || k === 'case_id' || k === 'created_at' || k === 'updated_at') continue;
            const display = typeof v === 'string' ? v.slice(0, 200) : v;
            console.log(`  ${k}: ${display}`);
        }
        console.log();
    }

    // Activity log
    const acts = await pool.query(
        `SELECT * FROM activity_log WHERE details::text LIKE '%25167%' ORDER BY created_at DESC LIMIT 25`
    );
    console.log('=== ACTIVITY LOG ===');
    for (const a of acts.rows) {
        console.log(`${a.created_at.toISOString().slice(0,16)} ${a.event_type}`);
        console.log(`  ${(a.description || '').slice(0, 150)}`);
        if (a.details) {
            const d = typeof a.details === 'string' ? JSON.parse(a.details) : a.details;
            if (d.suggested_action) console.log(`  suggested_action: ${d.suggested_action}`);
            if (d.intent) console.log(`  intent: ${d.intent}`);
            if (d.classification) console.log(`  classification: ${d.classification}`);
            if (d.reason) console.log(`  reason: ${d.reason}`);
        }
    }

    // auto_reply_queue
    const arq = await pool.query('SELECT * FROM auto_reply_queue WHERE case_id = 25167 ORDER BY created_at');
    console.log(`\n=== AUTO_REPLY_QUEUE (${arq.rows.length}) ===`);
    for (const q of arq.rows) {
        console.log(`Queue #${q.id} [${q.status}] ${q.created_at.toISOString().slice(0,16)}`);
        for (const [k, v] of Object.entries(q)) {
            if (v === null || k === 'id' || k === 'case_id' || k === 'created_at' || k === 'updated_at') continue;
            const display = typeof v === 'string' ? v.slice(0, 200) : v;
            console.log(`  ${k}: ${display}`);
        }
        console.log();
    }

    // Check the timeline events / case status history
    const timeline = await pool.query(
        `SELECT event_type, description, created_at, details FROM activity_log
         WHERE details::text LIKE '%25167%'
         AND (event_type LIKE '%proposal%' OR event_type LIKE '%no_response%' OR event_type LIKE '%decide%' OR event_type LIKE '%classify%' OR event_type LIKE '%analysis%')
         ORDER BY created_at`
    );
    console.log(`\n=== DECISION TIMELINE ===`);
    for (const t of timeline.rows) {
        console.log(`${t.created_at.toISOString().slice(0,16)} ${t.event_type}`);
        console.log(`  ${(t.description || '').slice(0, 200)}`);
        if (t.details) {
            const d = typeof t.details === 'string' ? JSON.parse(t.details) : t.details;
            for (const [k, v] of Object.entries(d)) {
                if (k === 'case_id' || k === 'message_id' || k === 'thread_id') continue;
                if (v !== null && v !== undefined) {
                    const display = typeof v === 'string' ? v.slice(0, 150) : JSON.stringify(v).slice(0, 150);
                    console.log(`    ${k}: ${display}`);
                }
            }
        }
    }

    await pool.end();
})();
