require('dotenv').config();
const sgMail = require('@sendgrid/mail');

sgMail.setApiKey(process.env.SENDGRID_API_KEY);

async function testInboundFlow() {
    console.log('🧪 Testing inbound email flow...\n');
    console.log('Step 1: Sending email FROM samuel@matcher.com TO requests@foia.foib-request.com\n');

    const msg = {
        to: 'requests@foia.foib-request.com',
        from: {
            email: 'samuel@matcher.com',
            name: 'Samuel Test'
        },
        subject: 'Test Inbound Email Flow',
        text: `This is a test email to verify inbound email routing.

Sent at: ${new Date().toISOString()}

If you receive this at the webhook, the inbound parse is working!`,
        html: `<html>
<body>
    <h2>Test Inbound Email Flow</h2>
    <p>This is a test email to verify inbound email routing.</p>
    <p><strong>Sent at:</strong> ${new Date().toISOString()}</p>
    <p>If you receive this at the webhook, the inbound parse is working!</p>
</body>
</html>`
    };

    try {
        const response = await sgMail.send(msg);
        console.log('✅ Email sent successfully!');
        console.log(`   From: ${msg.from.email}`);
        console.log(`   To: ${msg.to}`);
        console.log(`   Subject: ${msg.subject}`);
        console.log(`   SendGrid Message ID: ${response[0].headers['x-message-id']}`);

        console.log('\n⏳ Now monitoring Railway logs for webhook...');
        console.log('   Looking for: POST /webhooks/inbound');
        console.log('\n📊 Check Railway logs at:');
        console.log('   https://railway.app/project/[your-project]/service/sincere-strength');
        console.log('\n⚠️  If webhook is NOT triggered within 30 seconds:');
        console.log('   - MX records may not be propagated yet');
        console.log('   - SendGrid Inbound Parse may need reconfiguration');
        console.log('   - Check SendGrid Inbound Parse stats\n');
    } catch (error) {
        console.error('❌ Error sending email:', error.response?.body || error.message);
        if (error.response?.body?.errors) {
            error.response.body.errors.forEach(err => {
                console.error(`   - ${err.message}`);
            });
        }
    }
}

testInboundFlow();
