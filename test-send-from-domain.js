require('dotenv').config();
const sgMail = require('@sendgrid/mail');

sgMail.setApiKey(process.env.SENDGRID_API_KEY);

async function sendTestEmail() {
    console.log('📧 Sending test email from foib-request.com domain...\n');

    const msg = {
        to: 'overlord1pvp@gmail.com',
        from: {
            email: 'requests@em7571.foib-request.com',
            name: 'FOIA Request Team'
        },
        replyTo: 'requests@foia.foib-request.com',
        subject: 'Test FOIA Request - Please Reply to Test Auto-Reply System',
        text: `Hello,

This is a test email to verify the auto-reply system is working correctly.

PLEASE REPLY TO THIS EMAIL with any message (e.g., "We received your request" or "Request denied") to test the automatic response system.

When you reply, the bot should automatically:
1. Receive your reply via SendGrid Inbound Parse
2. Analyze your response using GPT-5
3. Generate an appropriate auto-reply
4. Send it back to you within a few minutes

Thank you for testing!

Best regards,
FOIA Request Team`,
        html: `<html>
<body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333;">
    <p>Hello,</p>

    <p>This is a test email to verify the auto-reply system is working correctly.</p>

    <p><strong>PLEASE REPLY TO THIS EMAIL</strong> with any message (e.g., "We received your request" or "Request denied") to test the automatic response system.</p>

    <p>When you reply, the bot should automatically:</p>
    <ol>
        <li>Receive your reply via SendGrid Inbound Parse</li>
        <li>Analyze your response using GPT-5</li>
        <li>Generate an appropriate auto-reply</li>
        <li>Send it back to you within a few minutes</li>
    </ol>

    <p>Thank you for testing!</p>

    <p>Best regards,<br>
    FOIA Request Team</p>
</body>
</html>`,
        customArgs: {
            test: 'true',
            purpose: 'inbound_parse_test'
        }
    };

    try {
        const response = await sgMail.send(msg);
        console.log('✅ Email sent successfully!');
        console.log(`   From: ${msg.from.email}`);
        console.log(`   To: ${msg.to}`);
        console.log(`   Subject: ${msg.subject}`);
        console.log(`   Message ID: ${response[0].headers['x-message-id']}`);
        console.log('\n📬 Now reply to this email at overlord1pvp@gmail.com');
        console.log('   Your reply should be received at: foia@foib-request.com');
        console.log('   SendGrid will POST it to: https://sincere-strength-production.up.railway.app/webhooks/inbound');
        console.log('\n⏳ After replying, check the Railway logs to see if the webhook received it!');
    } catch (error) {
        console.error('❌ Error sending email:', error.response?.body || error.message);
        if (error.response?.body?.errors) {
            error.response.body.errors.forEach(err => {
                console.error(`   - ${err.message}`);
            });
        }
    }
}

sendTestEmail();
