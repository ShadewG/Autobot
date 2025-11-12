/**
 * Manually fix case 42 by extracting portal URL and queuing for portal submission
 */
require('dotenv').config();
const { Pool } = require('pg');
const { portalQueue } = require('./queues/email-queue');

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

async function fixCase42() {
    try {
        // Get message 85
        const messageResult = await pool.query(
            'SELECT * FROM messages WHERE id = $1',
            [85]
        );

        if (messageResult.rows.length === 0) {
            console.log('Message 85 not found!');
            await pool.end();
            process.exit(1);
        }

        const message = messageResult.rows[0];
        console.log('Message 85 found');
        console.log(`From: ${message.from_email}`);
        console.log(`Subject: ${message.subject}`);

        // Extract portal URL from the message body
        const bodyText = message.body_text || '';
        const urlMatch = bodyText.match(/https?:\/\/[^\s<>"{}|\\^`\[\]]+/gi);

        if (!urlMatch || urlMatch.length === 0) {
            console.log('❌ No URL found in message body!');
            await pool.end();
            process.exit(1);
        }

        const portalUrl = urlMatch[0].trim();
        console.log(`\n✅ Found portal URL: ${portalUrl}`);

        // Update case 42 with portal URL
        await pool.query(
            'UPDATE cases SET portal_url = $1, portal_provider = $2 WHERE id = $3',
            [portalUrl, 'GovQA', 42]
        );

        console.log('✅ Updated case 42 with portal URL');

        // Queue for portal submission
        await portalQueue.add('portal-submit', {
            caseId: 42
        }, {
            attempts: 2,
            backoff: {
                type: 'exponential',
                delay: 5000
            }
        });

        console.log('✅ Queued case 42 for portal submission');
        console.log('\nCase 42 should now automatically submit via portal!');

        await pool.end();
        process.exit(0);
    } catch (error) {
        console.error('Error:', error);
        await pool.end();
        process.exit(1);
    }
}

fixCase42();
