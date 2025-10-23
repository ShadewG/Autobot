require('dotenv').config();
const axios = require('axios');

const BASE_URL = process.env.TEST_URL || 'https://sincere-strength-production.up.railway.app';

async function testRealCaseFlow() {
    console.log('🧪 Testing complete auto-reply flow with real case...\n');

    try {
        // Step 1: Trigger a real case from Notion
        console.log('📋 Step 1: Add a case in Notion with status "Ready to Send"');
        console.log('   Agency Email: overlord1pvp@gmail.com');
        console.log('   Then trigger sync by calling /api/notion/sync\n');

        const syncResponse = await axios.post(`${BASE_URL}/api/notion/sync`);
        console.log('✅ Notion sync triggered:', syncResponse.data);

        if (syncResponse.data.newCases > 0) {
            console.log(`\n📨 ${syncResponse.data.newCases} new case(s) will be queued for sending!`);
            console.log('   Wait ~30 seconds for generation and sending...\n');

            await new Promise(resolve => setTimeout(resolve, 30000));

            // Check what was sent
            const messagesResponse = await axios.get(`${BASE_URL}/api/dashboard/messages?limit=3`);
            console.log('📬 Latest messages sent:');
            messagesResponse.data.messages.forEach(m => {
                console.log(`\n  Message ID: ${m.id}`);
                console.log(`  To: ${m.to_email}`);
                console.log(`  Subject: ${m.subject}`);
                console.log(`  Sent: ${m.sent_at}`);
            });

            console.log('\n\n🎯 NOW: Check overlord1pvp@gmail.com and REPLY to the email!');
            console.log('   Your reply will trigger the auto-reply system.\n');
        } else {
            console.log('\n⚠️  No new cases found. Please:');
            console.log('   1. Go to your Notion database');
            console.log('   2. Create a new case or update an existing one');
            console.log('   3. Set Status = "Ready to Send"');
            console.log('   4. Set Agency Email = overlord1pvp@gmail.com');
            console.log('   5. Run this script again');
        }

    } catch (error) {
        console.error('❌ Error:', error.response?.data || error.message);
    }
}

testRealCaseFlow();
