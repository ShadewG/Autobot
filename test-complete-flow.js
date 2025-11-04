require('dotenv').config();

async function testCompleteFlow() {
    console.log('🧪 Testing complete auto-reply flow...\n');

    // Step 1: Trigger the test endpoint to create case and send email
    console.log('Step 1: Creating test case and sending email to overlord1pvp@gmail.com...');
    const response = await fetch('https://sincere-strength-production.up.railway.app/api/test/send-and-reply', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
    });

    const result = await response.json();

    if (!result.success) {
        console.error('❌ Failed to create test case:', result.error);
        return;
    }

    console.log('✅ Test case created successfully!');
    console.log(`   Case ID: ${result.case_id}`);
    console.log(`   Message ID: ${result.message_id}`);
    console.log(`   Sent to: ${result.sent_to}\n`);

    console.log('📧 Next steps:');
    console.log('   1. Check overlord1pvp@gmail.com for the test email');
    console.log('   2. Reply to the email with any message (e.g., "Request denied")');
    console.log('   3. Watch Railway logs for webhook trigger');
    console.log('   4. Check for instant auto-reply in overlord1pvp@gmail.com inbox\n');

    console.log('🔍 Monitoring case status...');

    // Step 2: Monitor the case status
    let attempts = 0;
    const maxAttempts = 60; // 5 minutes

    while (attempts < maxAttempts) {
        await new Promise(resolve => setTimeout(resolve, 5000)); // Wait 5 seconds
        attempts++;

        const statusResponse = await fetch(`https://sincere-strength-production.up.railway.app/api/test/status/${result.case_id}`);
        const status = await statusResponse.json();

        console.log(`\n[Attempt ${attempts}/${maxAttempts}] Case status check:`);
        console.log(`   Total messages: ${status.summary.total_messages}`);
        console.log(`   Outbound: ${status.summary.outbound}`);
        console.log(`   Inbound: ${status.summary.inbound}`);
        console.log(`   Auto-replies: ${status.summary.auto_replies}`);

        if (status.summary.inbound > 0) {
            console.log('\n✅ INBOUND EMAIL RECEIVED!');
            console.log('   The webhook successfully matched the reply to the test case.');

            if (status.summary.auto_replies > 0) {
                console.log('\n🎉 AUTO-REPLY SENT!');
                console.log('   Check overlord1pvp@gmail.com for the auto-reply.');
                console.log('\n✅ COMPLETE FLOW WORKING! 🚀');
                break;
            } else {
                console.log('\n⏳ Waiting for auto-reply to be generated and sent...');
            }
        }

        if (attempts === maxAttempts) {
            console.log('\n⏰ Timeout reached. No inbound email detected yet.');
            console.log('   Make sure to reply to the test email at overlord1pvp@gmail.com');
        }
    }
}

testCompleteFlow().catch(console.error);
