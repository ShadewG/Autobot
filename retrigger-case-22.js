require('dotenv').config();
const db = require('./services/database');
const { analysisQueue } = require('./queues/email-queue');

/**
 * Re-trigger analysis for case #22
 * This will re-process the inbound message and send an auto-reply
 */
async function retriggerCase22() {
    try {
        console.log('🔄 Looking up case #22 and its inbound messages...');

        // Get the latest inbound message for case #22
        const result = await db.query(
            `SELECT m.id, m.message_id, m.case_id, m.from_email, m.subject, m.created_at
             FROM messages m
             WHERE m.case_id = 22
             AND m.direction = 'inbound'
             ORDER BY m.created_at DESC
             LIMIT 1`
        );

        if (result.rows.length === 0) {
            console.error('❌ No inbound messages found for case #22');
            process.exit(1);
        }

        const message = result.rows[0];
        console.log(`✅ Found inbound message:`);
        console.log(`   Message ID: ${message.id}`);
        console.log(`   From: ${message.from_email}`);
        console.log(`   Subject: ${message.subject}`);
        console.log(`   Received: ${message.created_at}`);

        console.log('\n🚀 Re-queueing message for analysis...');

        // Queue for analysis with instant reply
        await analysisQueue.add('analyze-response', {
            messageId: message.id,
            caseId: message.case_id,
            instantReply: true  // Process immediately
        }, {
            delay: 0,
            attempts: 3,
            backoff: {
                type: 'exponential',
                delay: 3000
            }
        });

        console.log('✅ Message re-queued for analysis!');
        console.log('   The analysis worker will process it and send an auto-reply');
        console.log('\n💡 You can monitor progress in Railway logs or the test dashboard');

        // Wait a moment to ensure job is queued
        await new Promise(resolve => setTimeout(resolve, 2000));

        console.log('\n✅ Done! Check Railway logs for processing status.');
        process.exit(0);
    } catch (error) {
        console.error('❌ Error:', error);
        process.exit(1);
    }
}

// Run it
retriggerCase22();
