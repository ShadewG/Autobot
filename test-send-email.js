require('dotenv').config();
const sendgridService = require('./services/sendgrid-service');

async function sendTestEmail() {
    console.log('🤖 Sending test FOIA request to you...\n');

    const testRequest = `Hello,

I'm requesting records under the Illinois Freedom of Information Act (5 ILCS 140) related to a test case for our automated FOIA system.

This is a test email. Please reply with any of the following to test the bot's responses:

1. "Your request is overly broad" - to test denial rebuttal
2. "Thank you, we received your request" - to test acknowledgment
3. "The cost will be $250" - to test fee handling
4. Any other response to see how the bot handles it

Please provide records electronically. I accept standard redactions for faces, license plates, PII, juveniles, and medical information.

This request is for non-commercial, documentary testing purposes.

Best regards,

Samuel Hylton
Email: samuel@matcher.com
Matcher
3021 21st Ave W
Apt 202
Seattle, WA 98199`;

    try {
        // Send email directly using SendGrid
        const sgMail = require('@sendgrid/mail');
        sgMail.setApiKey(process.env.SENDGRID_API_KEY);

        const msg = {
            to: 'shadewofficial@gmail.com',  // Your email
            from: {
                email: 'samuel@matcher.com',
                name: 'Samuel Hylton - Matcher FOIA Bot'
            },
            replyTo: 'samuel@matcher.com',
            subject: 'Test FOIA Request - Please Reply to Test Auto-Reply',
            text: testRequest,
            html: testRequest.replace(/\n/g, '<br>'),
            trackingSettings: {
                clickTracking: { enable: false },
                openTracking: { enable: false }
            }
        };

        const result = await sgMail.send(msg);

        console.log('✅ Test email sent successfully!');
        console.log('📧 TO: shadewofficial@gmail.com');
        console.log('📧 FROM: samuel@matcher.com');
        console.log('📋 SUBJECT: Test FOIA Request - Please Reply to Test Auto-Reply');
        console.log('\n📬 Message ID:', result[0].headers['x-message-id']);
        console.log('\n✨ Now reply to that email and the bot will auto-respond!');
        console.log('⏰ Make sure AUTO_REPLY_DELAY_MINUTES=0 is set for immediate testing\n');

    } catch (error) {
        console.error('❌ Error sending email:', error);
        if (error.response) {
            console.error('SendGrid error:', error.response.body);
        }
    }
}

sendTestEmail().catch(console.error);
