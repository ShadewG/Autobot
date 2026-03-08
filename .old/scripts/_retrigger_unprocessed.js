/**
 * Retrigger processing for unprocessed inbound messages.
 * Only processes the LATEST unprocessed message per case (processing one triggers the graph which sees all).
 */
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

const BASE_URL = process.env.BASE_URL || 'https://sincere-strength-production.up.railway.app';

async function main() {
    // Get the latest unprocessed inbound message per case
    const result = await pool.query(`
        SELECT DISTINCT ON (m.case_id)
            m.id as message_id, m.case_id, m.subject, m.from_email,
            c.status as case_status, c.agency_name
        FROM messages m
        JOIN cases c ON c.id = m.case_id
        WHERE m.direction = 'inbound'
          AND m.processed_at IS NULL
          AND m.last_error IS NULL
        ORDER BY m.case_id, m.received_at DESC NULLS LAST
    `);

    console.log(`Found ${result.rows.length} cases with unprocessed inbound messages\n`);

    let triggered = 0;
    let skipped = 0;
    let failed = 0;

    for (const row of result.rows) {
        console.log(`Case #${row.case_id} (${row.case_status}) - ${row.agency_name}`);
        console.log(`  Latest unprocessed: Msg #${row.message_id} - ${(row.subject || '').substring(0, 60)}`);

        try {
            const response = await fetch(`${BASE_URL}/api/monitor/message/${row.message_id}/trigger-ai`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ force_new_run: true })
            });

            const data = await response.json();
            if (data.success) {
                console.log(`  ✅ Triggered - Run #${data.run?.id}\n`);
                triggered++;
            } else {
                console.log(`  ❌ Failed: ${data.error}\n`);
                failed++;
            }
        } catch (err) {
            console.log(`  ❌ Error: ${err.message}\n`);
            failed++;
        }

        // Small delay to avoid overwhelming the server
        await new Promise(r => setTimeout(r, 2000));
    }

    console.log(`\n=== DONE ===`);
    console.log(`Triggered: ${triggered}, Skipped: ${skipped}, Failed: ${failed}`);

    await pool.end();
}

main().catch(err => { console.error(err); process.exit(1); });
