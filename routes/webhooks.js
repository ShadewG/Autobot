const express = require('express');
const router = express.Router();
const sendgridService = require('../services/sendgrid-service');
const { analysisQueue } = require('../queues/email-queue');

/**
 * SendGrid Inbound Parse Webhook
 * Receives emails sent to your domain
 */
router.post('/inbound', express.raw({ type: 'application/json', limit: '10mb' }), async (req, res) => {
    try {
        console.log('Received inbound email webhook from SendGrid');

        // Parse the incoming data
        let inboundData;

        if (req.headers['content-type']?.includes('application/json')) {
            inboundData = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
        } else if (req.headers['content-type']?.includes('multipart/form-data')) {
            // SendGrid inbound parse sends multipart data
            inboundData = req.body;
        } else {
            inboundData = req.body;
        }

        // Process the inbound email
        const result = await sendgridService.processInboundEmail({
            from: inboundData.from || inboundData.sender,
            to: inboundData.to || inboundData.recipient,
            subject: inboundData.subject,
            text: inboundData.text || inboundData.body_text,
            html: inboundData.html || inboundData.body_html,
            headers: inboundData.headers || {},
            attachments: inboundData.attachments || []
        });

        if (result.matched) {
            console.log(`Inbound email matched to case ${result.case_id}`);

            // Queue for AI analysis
            await analysisQueue.add('analyze-response', {
                messageId: result.message_id,
                caseId: result.case_id
            }, {
                delay: 5000 // 5 second delay to ensure DB is updated
            });

            res.status(200).json({
                success: true,
                message: 'Email received and queued for processing',
                case_id: result.case_id
            });
        } else {
            console.warn('Inbound email could not be matched to a case');
            res.status(200).json({
                success: true,
                message: 'Email received but could not match to a case'
            });
        }
    } catch (error) {
        console.error('Error processing inbound webhook:', error);
        res.status(500).json({
            error: 'Failed to process inbound email',
            message: error.message
        });
    }
});

/**
 * SendGrid Event Webhook
 * Receives delivery status updates
 */
router.post('/events', express.json(), async (req, res) => {
    try {
        console.log('Received event webhook from SendGrid');

        const events = Array.isArray(req.body) ? req.body : [req.body];

        for (const event of events) {
            console.log(`Event: ${event.event}, Message ID: ${event.sg_message_id}`);

            // Handle different event types
            switch (event.event) {
                case 'delivered':
                    console.log(`Email delivered: ${event.sg_message_id}`);
                    break;
                case 'bounce':
                case 'dropped':
                    console.error(`Email failed: ${event.sg_message_id}`, event.reason);
                    // TODO: Update case status and alert
                    break;
                case 'open':
                    console.log(`Email opened: ${event.sg_message_id}`);
                    break;
            }
        }

        res.status(200).json({ success: true });
    } catch (error) {
        console.error('Error processing event webhook:', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * Test webhook endpoint
 */
router.post('/test', express.json(), async (req, res) => {
    res.json({
        success: true,
        message: 'Webhook endpoint is working',
        received: req.body
    });
});

module.exports = router;
