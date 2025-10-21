/**
 * Quick test of SendGrid API key
 */

require('dotenv').config();
const sgMail = require('@sendgrid/mail');

const SENDGRID_API_KEY = process.env.SENDGRID_API_KEY;
const FROM_EMAIL = process.env.SENDGRID_FROM_EMAIL || 'samuel@matcher.com';
const TO_EMAIL = process.env.DEFAULT_TEST_EMAIL || 'shadewofficial@gmail.com';

if (!SENDGRID_API_KEY) {
    console.error('❌ SENDGRID_API_KEY not set in environment variables');
    process.exit(1);
}

sgMail.setApiKey(SENDGRID_API_KEY);

async function testSendGrid() {
    console.log('🧪 Testing SendGrid API Key...\n');
    console.log(`From: ${FROM_EMAIL}`);
    console.log(`To: ${TO_EMAIL}`);
    console.log(`API Key: ${SENDGRID_API_KEY.substring(0, 20)}...\n`);

    const msg = {
        to: TO_EMAIL,
        from: FROM_EMAIL,
        subject: '🧪 SendGrid Test - Autobot MVP',
        text: 'This is a test email from your Autobot MVP system to verify SendGrid is working.',
        html: `
            <div style="font-family: Arial, sans-serif; padding: 20px;">
                <h1>✅ SendGrid Test Successful!</h1>
                <p>This is a test email from your Autobot MVP system.</p>
                <p>If you're reading this, SendGrid is working correctly!</p>
                <hr>
                <p style="color: #666; font-size: 12px;">
                    Sent from Autobot MVP<br>
                    Time: ${new Date().toISOString()}
                </p>
            </div>
        `
    };

    try {
        console.log('Sending test email...');
        const response = await sgMail.send(msg);

        console.log('\n✅ SUCCESS!');
        console.log('Status Code:', response[0].statusCode);
        console.log('Response:', response[0].headers);
        console.log('\nEmail sent successfully! Check shadewofficial@gmail.com');

        return true;
    } catch (error) {
        console.error('\n❌ ERROR!');
        console.error('Message:', error.message);

        if (error.response) {
            console.error('Status:', error.response.status);
            console.error('Body:', error.response.body);
        }

        return false;
    }
}

testSendGrid()
    .then(success => {
        process.exit(success ? 0 : 1);
    })
    .catch(error => {
        console.error('Unexpected error:', error);
        process.exit(1);
    });
