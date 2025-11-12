/**
 * Check if message 85 has an analysis record
 */
require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

async function checkAnalysis() {
    try {
        // Check if analyses table exists
        const tableCheck = await pool.query(`
            SELECT EXISTS (
                SELECT FROM information_schema.tables
                WHERE table_name = 'analyses'
            );
        `);

        if (!tableCheck.rows[0].exists) {
            console.log('❌ analyses table does not exist');
            await pool.end();
            process.exit(0);
        }

        // Check for analysis of message 85
        const result = await pool.query(
            'SELECT * FROM analyses WHERE message_id = $1',
            [85]
        );

        if (result.rows.length === 0) {
            console.log('❌ NO ANALYSIS RECORD for message 85');
            console.log('This means the analysis queue job either:');
            console.log('  1. Was never created');
            console.log('  2. Failed silently');
            console.log('  3. Is still pending in the queue');
        } else {
            console.log('✅ Analysis record found:');
            console.log(JSON.stringify(result.rows[0], null, 2));
        }

        await pool.end();
        process.exit(0);
    } catch (error) {
        console.error('Error:', error);
        await pool.end();
        process.exit(1);
    }
}

checkAnalysis();
