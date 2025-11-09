require('dotenv').config();
const sgMail = require('@sendgrid/mail');

async function testSendGrid() {
    console.log('=== SendGrid Direct Test ===\n');

    // Set API key
    const apiKey = process.env.SENDGRID_API_KEY;
    if (!apiKey) {
        console.error('❌ SENDGRID_API_KEY not found in environment');
        process.exit(1);
    }

    console.log('✅ API Key found:', apiKey.substring(0, 10) + '...');
    sgMail.setApiKey(apiKey);

    // Test 1: Send from requests@foia.foib-request.com (hardcoded in service)
    console.log('\n📧 Test 1: Sending from requests@foia.foib-request.com');
    const msg1 = {
        to: 'shadewofficial@gmail.com',
        from: {
            email: 'requests@foia.foib-request.com',
            name: 'FOIA Request Team'
        },
        replyTo: 'requests@foia.foib-request.com',
        subject: 'SendGrid Test - requests@foia.foib-request.com',
        text: 'This is a test email from requests@foia.foib-request.com',
        html: '<p>This is a test email from <strong>requests@foia.foib-request.com</strong></p>'
    };

    try {
        const response = await sgMail.send(msg1);
        console.log('✅ SUCCESS!');
        console.log('   Status:', response[0].statusCode);
        console.log('   Message ID:', response[0].headers['x-message-id']);
    } catch (error) {
        console.error('❌ FAILED!');
        console.error('   Error Code:', error.code);
        console.error('   Error Message:', error.message);
        if (error.response) {
            console.error('   Response Body:', JSON.stringify(error.response.body, null, 2));
        }
    }

    // Test 2: Send from samuel@matcher.com (from .env)
    console.log('\n📧 Test 2: Sending from samuel@matcher.com (from .env)');
    const msg2 = {
        to: 'shadewofficial@gmail.com',
        from: {
            email: 'samuel@matcher.com',
            name: 'MATCHER Legal Department'
        },
        replyTo: 'samuel@matcher.com',
        subject: 'SendGrid Test - samuel@matcher.com',
        text: 'This is a test email from samuel@matcher.com',
        html: '<p>This is a test email from <strong>samuel@matcher.com</strong></p>'
    };

    try {
        const response = await sgMail.send(msg2);
        console.log('✅ SUCCESS!');
        console.log('   Status:', response[0].statusCode);
        console.log('   Message ID:', response[0].headers['x-message-id']);
    } catch (error) {
        console.error('❌ FAILED!');
        console.error('   Error Code:', error.code);
        console.error('   Error Message:', error.message);
        if (error.response) {
            console.error('   Response Body:', JSON.stringify(error.response.body, null, 2));
        }
    }

    console.log('\n=== Test Complete ===\n');
}

testSendGrid().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
});
