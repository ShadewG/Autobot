const express = require('express');
const router = express.Router();
const multer = require('multer');
const sendgridService = require('../services/sendgrid-service');
const { analysisQueue, portalQueue } = require('../queues/email-queue');

// Configure multer to handle SendGrid's multipart/form-data
const upload = multer();

/**
 * SendGrid Inbound Parse Webhook
 * Receives emails sent to your domain
 * SendGrid sends multipart/form-data
 */
router.post('/inbound', upload.none(), async (req, res) => {
    try {
        console.log('Received inbound email webhook from SendGrid');
        console.log('Content-Type:', req.headers['content-type']);
        console.log('Body keys:', Object.keys(req.body));
        console.log('From:', req.body.from);
        console.log('To:', req.body.to);
        console.log('Subject:', req.body.subject);
        console.log('Text field:', req.body.text ? `${req.body.text.substring(0, 100)}...` : 'NULL');
        console.log('HTML field:', req.body.html ? `${req.body.html.substring(0, 100)}...` : 'NULL');
        console.log('All body fields:', JSON.stringify(req.body, null, 2));

        // SendGrid sends data as form fields
        const inboundData = req.body;

        // Parse the raw email to extract text and HTML
        let emailText = null;
        let emailHtml = null;

        if (inboundData.email) {
            // Extract plain text from multipart email
            const textMatch = inboundData.email.match(/Content-Type: text\/plain[\s\S]*?\r?\n\r?\n([\s\S]*?)(?=\r?\n--)/);
            if (textMatch) {
                // Decode quoted-printable encoding
                emailText = textMatch[1]
                    .replace(/=\r?\n/g, '') // Remove soft line breaks
                    .replace(/=([0-9A-F]{2})/g, (match, hex) => String.fromCharCode(parseInt(hex, 16)))
                    .trim();
            }

            // Extract HTML from multipart email
            const htmlMatch = inboundData.email.match(/Content-Type: text\/html[\s\S]*?\r?\n\r?\n([\s\S]*?)(?=\r?\n--)/);
            if (htmlMatch) {
                // Decode quoted-printable encoding
                emailHtml = htmlMatch[1]
                    .replace(/=\r?\n/g, '') // Remove soft line breaks
                    .replace(/=([0-9A-F]{2})/g, (match, hex) => String.fromCharCode(parseInt(hex, 16)))
                    .trim();
            }
        }

        console.log('Extracted text:', emailText ? emailText.substring(0, 100) : 'NULL');
        console.log('Extracted HTML:', emailHtml ? emailHtml.substring(0, 100) : 'NULL');

        // Process the inbound email
        const result = await sendgridService.processInboundEmail({
            from: inboundData.from || inboundData.sender,
            to: inboundData.to || inboundData.recipient,
            subject: inboundData.subject,
            text: emailText || inboundData.text || inboundData.body_text,
            html: emailHtml || inboundData.html || inboundData.body_html,
            headers: inboundData.headers || {},
            attachments: inboundData.attachments || []
        });

        if (result.matched) {
            console.log(`Inbound email matched to case ${result.case_id}`);
            const alreadyProcessed = result.already_processed === true;

            // Check if this is a test mode email (instant reply)
            const isTestMode = inboundData.subject?.includes('[TEST]') ||
                              inboundData.headers?.['X-Test-Mode'] === 'true';

            if (alreadyProcessed) {
                console.log(`Duplicate inbound detected for case ${result.case_id}; skipping analysis queue.`);
            } else {
                // Queue for AI analysis
                await analysisQueue.add('analyze-response', {
                    messageId: result.message_id,
                    caseId: result.case_id,
                    instantReply: isTestMode
                }, {
                    delay: isTestMode ? 0 : 2000, // faster processing, but still ensure DB commit
                    attempts: 3,
                    backoff: {
                        type: 'exponential',
                        delay: 3000
                    }
                });

                console.log(`Analysis queued for case ${result.case_id}${isTestMode ? ' (TEST MODE - instant reply)' : ''}`);
            }

            if (!alreadyProcessed && result.portal_notification) {
                const portalJobData = {
                    caseId: result.case_id,
                    portalUrl: result.portal_notification.portal_url,
                    provider: result.portal_notification.provider,
                    messageId: result.message_id,
                    notificationType: result.portal_notification.type,
                    instructions: result.portal_notification.instructions_excerpt || null
                };

                if (portalJobData.portalUrl) {
                    await portalQueue.add('portal-refresh', portalJobData, {
                        attempts: 3,
                        backoff: {
                            type: 'exponential',
                            delay: 60000
                        }
                    });

                    console.log(`🌐 Portal refresh queued for case ${result.case_id} (${portalJobData.provider})`);

                    if (result.portal_notification.type === 'submission_required') {
                        await portalQueue.add('portal-submit', portalJobData, {
                            attempts: 1
                        });
                        console.log(`🚀 Portal submission queued for case ${result.case_id} (${portalJobData.provider})`);
                    }
                } else {
                    console.warn(`🌐 Portal notification detected but no portal URL stored for case ${result.case_id}`);
                }
            }

            res.status(200).json({
                success: true,
                message: 'Email received and queued for processing',
                case_id: result.case_id,
                test_mode: isTestMode
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
