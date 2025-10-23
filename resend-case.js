require('dotenv').config();
const axios = require('axios');

const BASE_URL = process.env.TEST_URL || 'https://sincere-strength-production.up.railway.app';
const CASE_ID = 7;

async function resendCase() {
    console.log(`🔄 Triggering resend for Case ${CASE_ID}...\n`);

    try {
        // Trigger the case to be processed and sent
        const response = await axios.post(`${BASE_URL}/api/cases/${CASE_ID}/process`);

        console.log('✅ Case queued for processing!');
        console.log(response.data);

        console.log('\n⏳ Waiting 30 seconds for generation and sending...');
        await new Promise(resolve => setTimeout(resolve, 30000));

        // Check the case status
        const caseResponse = await axios.get(`${BASE_URL}/api/cases/${CASE_ID}`);
        console.log('\n📊 Case Status:');
        console.log(`   Status: ${caseResponse.data.case.status}`);
        console.log(`   Last sent: ${caseResponse.data.case.send_date}`);
        console.log(`   Messages: ${caseResponse.data.messages.length}`);

        const latestMessage = caseResponse.data.messages[caseResponse.data.messages.length - 1];
        console.log('\n📧 Latest message:');
        console.log(`   To: ${latestMessage.to_email}`);
        console.log(`   From: ${latestMessage.from_email}`);
        console.log(`   Subject: ${latestMessage.subject.substring(0, 80)}...`);
        console.log(`   Sent: ${latestMessage.sent_at}`);

        console.log('\n🎯 Check overlord1pvp@gmail.com and REPLY to test auto-reply!');

    } catch (error) {
        if (error.response?.status === 404) {
            console.log('❌ Process endpoint doesn\'t exist. Creating alternative...\n');
            console.log('📝 In your Notion database:');
            console.log('   1. Find the "Jacob Daily" case');
            console.log('   2. Change Status from "sent" to "Ready to Send"');
            console.log('   3. Wait 15 minutes for automatic sync');
            console.log('   OR');
            console.log('   4. Call the sync endpoint to trigger immediately\n');

            console.log('Triggering sync now...');
            const syncResponse = await axios.post(`${BASE_URL}/api/notion/sync`);
            console.log('✅ Sync complete:', syncResponse.data);
        } else {
            console.error('❌ Error:', error.response?.data || error.message);
        }
    }
}

resendCase();
