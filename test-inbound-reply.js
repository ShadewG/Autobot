require('dotenv').config();
const axios = require('axios');

/**
 * Test script to simulate an inbound email from an agency
 * This tests the complete auto-reply flow:
 * 1. Receive inbound email via webhook
 * 2. Analyze the response
 * 3. Generate auto-reply
 * 4. Send auto-reply
 */

async function testInboundReply() {
    console.log('🧪 Testing inbound email and auto-reply flow...\n');

    // Simulate an inbound email from Amarillo PD denying the request
    const inboundEmail = {
        from: 'APDAdmin@amarillo.gov',
        to: 'samuel@matcher.com',
        subject: 'Re: Public Records Request - Ronald Austin',
        text: `Dear Mr. Hylton,

We have received your public records request dated October 23, 2025, regarding the March 13, 2022 incident involving Ronald Austin and Gerald Chisolm.

After reviewing your request, we must inform you that the requested body-worn camera footage and surveillance video cannot be released at this time as this matter is part of an ongoing investigation. Additionally, the scope of your request is overly broad and would require an extensive amount of staff time to compile.

We are able to provide you with the basic incident report for a fee of $25. Please let us know if you would like to proceed with this limited request.

Thank you for your understanding.

Records Division
Amarillo Police Department`,
        html: '<p>Dear Mr. Hylton,</p><p>We have received your public records request...</p>',
        headers: {
            'Message-ID': '<agency-response-123@amarillo.gov>',
            'In-Reply-To': '<1761219922426.869d259565c36229@autobot.local>',
            'References': '<1761219922426.869d259565c36229@autobot.local>'
        }
    };

    try {
        // Test locally or against Railway
        const baseUrl = process.env.TEST_URL || 'https://sincere-strength-production.up.railway.app';

        console.log(`📨 Sending simulated inbound email to: ${baseUrl}/webhooks/inbound\n`);
        console.log('Email details:');
        console.log(`  From: ${inboundEmail.from}`);
        console.log(`  To: ${inboundEmail.to}`);
        console.log(`  Subject: ${inboundEmail.subject}`);
        console.log(`  References: ${inboundEmail.headers['References']}\n`);

        const response = await axios.post(
            `${baseUrl}/webhooks/inbound`,
            inboundEmail,
            {
                headers: {
                    'Content-Type': 'application/json'
                }
            }
        );

        console.log('✅ Webhook response:', response.data);

        if (response.data.case_id) {
            console.log(`\n📊 Case ${response.data.case_id} matched!`);
            console.log('\n⏳ Waiting 10 seconds for analysis and auto-reply generation...');

            await new Promise(resolve => setTimeout(resolve, 10000));

            // Check the case status
            const caseResponse = await axios.get(`${baseUrl}/api/cases/${response.data.case_id}`);
            console.log('\n📋 Case status:');
            console.log(`  Status: ${caseResponse.data.case.status}`);
            console.log(`  Messages: ${caseResponse.data.thread.message_count}`);
            console.log(`  Last message: ${caseResponse.data.thread.last_message_at}`);

            // Check for inbound message
            const inboundMessages = caseResponse.data.messages.filter(m => m.direction === 'inbound');
            console.log(`\n📥 Inbound messages: ${inboundMessages.length}`);
            if (inboundMessages.length > 0) {
                console.log('  Latest inbound:');
                console.log(`    From: ${inboundMessages[0].from_email}`);
                console.log(`    Subject: ${inboundMessages[0].subject}`);
                console.log(`    Date: ${inboundMessages[0].received_at}`);
            }

            // Check dashboard for latest messages
            console.log('\n📬 Checking for auto-reply in dashboard...');
            const dashboardResponse = await axios.get(`${baseUrl}/api/dashboard/messages?limit=5`);
            console.log(`  Total messages: ${dashboardResponse.data.count}`);

            if (dashboardResponse.data.messages.length > 0) {
                const latestMessage = dashboardResponse.data.messages[0];
                console.log(`\n  Latest message:`);
                console.log(`    Type: ${latestMessage.message_type}`);
                console.log(`    To: ${latestMessage.to_email}`);
                console.log(`    Subject: ${latestMessage.subject}`);
                console.log(`    Sent: ${latestMessage.sent_at}`);

                if (latestMessage.message_type === 'auto_reply') {
                    console.log('\n✅ AUTO-REPLY GENERATED AND SENT!');
                    console.log('\nReply preview:');
                    console.log(latestMessage.body_text.substring(0, 300) + '...');
                }
            }
        }

    } catch (error) {
        console.error('❌ Error testing inbound reply:', error.response?.data || error.message);
        if (error.response?.data) {
            console.error('Response:', JSON.stringify(error.response.data, null, 2));
        }
    }
}

testInboundReply();
