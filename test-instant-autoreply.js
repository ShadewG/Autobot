require('dotenv').config();
const axios = require('axios');

const BASE_URL = process.env.TEST_URL || 'https://sincere-strength-production.up.railway.app';

async function testInstantAutoReply() {
    console.log('🧪 Testing instant auto-reply system...\n');

    try {
        // Step 1: Send test email
        console.log('📧 Step 1: Sending test email to overlord1pvp@gmail.com...');
        const sendResponse = await axios.post(`${BASE_URL}/api/test/send-and-reply`);

        console.log('✅ Test email sent!\n');
        console.log('Case ID:', sendResponse.data.case_id);
        console.log('Message ID:', sendResponse.data.message_id);
        console.log('Sent to:', sendResponse.data.sent_to);

        console.log('\n📋 Instructions:');
        sendResponse.data.instructions.forEach(instruction => {
            console.log(`   ${instruction}`);
        });

        console.log('\n⚠️  NOTE:', sendResponse.data.note);

        const caseId = sendResponse.data.case_id;

        // Step 2: Wait for user to reply
        console.log('\n\n⏸️  WAITING FOR YOUR REPLY...');
        console.log('   Check overlord1pvp@gmail.com for the test email');
        console.log('   Reply with any message (e.g., "Request denied")');
        console.log('   The bot will analyze and auto-reply INSTANTLY\n');

        console.log('💡 To check test status, run:');
        console.log(`   curl ${BASE_URL}/api/test/status/${caseId}\n`);

        // Poll for status every 10 seconds
        console.log('🔄 Polling for responses every 10 seconds...\n');

        let previousMessageCount = 1; // We sent 1 message

        for (let i = 0; i < 60; i++) { // Poll for up to 10 minutes
            await new Promise(resolve => setTimeout(resolve, 10000)); // Wait 10 seconds

            try {
                const statusResponse = await axios.get(`${BASE_URL}/api/test/status/${caseId}`);
                const messageCount = statusResponse.data.messages.length;

                if (messageCount > previousMessageCount) {
                    console.log(`\n🆕 New message detected! (${messageCount} total messages)\n`);

                    // Show the latest messages
                    const latestMessages = statusResponse.data.messages.slice(previousMessageCount);
                    latestMessages.forEach((msg, idx) => {
                        console.log(`Message ${previousMessageCount + idx + 1}:`);
                        console.log(`  Direction: ${msg.direction}`);
                        console.log(`  From: ${msg.from_email}`);
                        console.log(`  To: ${msg.to_email}`);
                        console.log(`  Type: ${msg.message_type}`);
                        console.log(`  Subject: ${msg.subject}`);
                        console.log(`  Body: ${msg.body_text?.substring(0, 200)}...`);
                        console.log('');
                    });

                    previousMessageCount = messageCount;

                    // Check if we got an auto-reply
                    const autoReplies = statusResponse.data.summary.auto_replies;
                    if (autoReplies > 0) {
                        console.log('✅ AUTO-REPLY SENT SUCCESSFULLY!\n');
                        console.log('📊 Test Summary:');
                        console.log(`   Total messages: ${statusResponse.data.summary.total_messages}`);
                        console.log(`   Outbound: ${statusResponse.data.summary.outbound}`);
                        console.log(`   Inbound: ${statusResponse.data.summary.inbound}`);
                        console.log(`   Auto-replies: ${statusResponse.data.summary.auto_replies}`);
                        console.log('\n🎉 Test completed successfully!');
                        process.exit(0);
                    }
                } else {
                    process.stdout.write('.');
                }
            } catch (error) {
                console.log('\n⚠️  Error checking status:', error.message);
            }
        }

        console.log('\n\n⏱️  Timeout reached (10 minutes)');
        console.log('   If you replied, check Railway logs to see what happened');
        console.log(`   Or check status: ${BASE_URL}/api/test/status/${caseId}`);

    } catch (error) {
        console.error('❌ Error:', error.response?.data || error.message);
    }
}

testInstantAutoReply();
