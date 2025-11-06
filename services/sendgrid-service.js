const sgMail = require('@sendgrid/mail');
const db = require('./database');
const crypto = require('crypto');

class SendGridService {
    constructor() {
        if (process.env.SENDGRID_API_KEY) {
            sgMail.setApiKey(process.env.SENDGRID_API_KEY);
        }
        this.fromEmail = process.env.SENDGRID_FROM_EMAIL;
        this.fromName = process.env.SENDGRID_FROM_NAME || 'FOIA Request Team';
    }

    /**
     * Send a FOIA request email
     */
    async sendFOIARequest(caseId, requestText, subject, toEmail, instantMode = false) {
        try {
            const caseData = await db.getCaseById(caseId);
            if (!caseData) {
                throw new Error(`Case ${caseId} not found`);
            }

            // Generate unique message ID for tracking
            const messageId = this.generateMessageId();
            const threadId = this.generateThreadId(caseId);

            // Build headers - add X-Test-Mode if instant mode
            const headers = {
                'Message-ID': messageId,
                'In-Reply-To': threadId,
                'References': threadId
            };
            if (instantMode) {
                headers['X-Test-Mode'] = 'true';
            }

            const msg = {
                to: toEmail,
                from: {
                    email: this.fromEmail,
                    name: this.fromName
                },
                replyTo: 'requests@foia.foib-request.com',
                subject: subject,
                text: requestText,
                html: this.formatEmailHtml(requestText),
                headers: headers,
                customArgs: {
                    case_id: caseId.toString(),
                    message_type: 'initial_request'
                },
                trackingSettings: {
                    clickTracking: { enable: false },
                    openTracking: { enable: true }
                }
            };

            const response = await sgMail.send(msg);
            console.log('Email sent successfully:', response[0].statusCode);

            // Store in database
            await this.logSentMessage({
                case_id: caseId,
                message_id: messageId,
                sendgrid_message_id: response[0].headers['x-message-id'],
                to_email: toEmail,
                subject: subject,
                body_text: requestText,
                body_html: this.formatEmailHtml(requestText),
                message_type: 'initial_request',
                thread_id: threadId
            });

            return {
                success: true,
                message_id: messageId,
                thread_id: threadId,
                sendgrid_response: response[0]
            };
        } catch (error) {
            console.error('Error sending email:', error);
            await db.logActivity('email_send_failed', `Failed to send email for case ${caseId}`, {
                case_id: caseId,
                error: error.message
            });
            throw error;
        }
    }

    /**
     * Send a follow-up email
     */
    async sendFollowUp(caseId, followUpText, subject, toEmail, originalMessageId) {
        try {
            const messageId = this.generateMessageId();
            const threadId = originalMessageId || this.generateThreadId(caseId);

            const msg = {
                to: toEmail,
                from: {
                    email: this.fromEmail,
                    name: this.fromName
                },
                replyTo: 'requests@foia.foib-request.com',
                subject: `Re: ${subject}`,
                text: followUpText,
                html: this.formatEmailHtml(followUpText),
                headers: {
                    'Message-ID': messageId,
                    'In-Reply-To': threadId,
                    'References': threadId
                },
                customArgs: {
                    case_id: caseId.toString(),
                    message_type: 'follow_up'
                }
            };

            const response = await sgMail.send(msg);
            console.log('Follow-up sent successfully:', response[0].statusCode);

            await this.logSentMessage({
                case_id: caseId,
                message_id: messageId,
                sendgrid_message_id: response[0].headers['x-message-id'],
                to_email: toEmail,
                subject: `Re: ${subject}`,
                body_text: followUpText,
                body_html: this.formatEmailHtml(followUpText),
                message_type: 'follow_up',
                thread_id: threadId
            });

            return {
                success: true,
                message_id: messageId,
                thread_id: threadId
            };
        } catch (error) {
            console.error('Error sending follow-up:', error);
            throw error;
        }
    }

    /**
     * Send an auto-reply
     */
    async sendAutoReply(caseId, replyText, subject, toEmail, inReplyToMessageId) {
        try {
            const messageId = this.generateMessageId();

            // Don't add "Re:" if subject already starts with it
            const replySubject = subject.startsWith('Re:') ? subject : `Re: ${subject}`;

            // Get thread data to build proper References header
            const thread = await db.query(
                'SELECT * FROM email_threads WHERE case_id = $1',
                [caseId]
            );

            let referencesHeader = inReplyToMessageId;
            if (thread.rows.length > 0 && thread.rows[0].initial_message_id) {
                // Include both the initial message and the one we're replying to
                referencesHeader = `${thread.rows[0].initial_message_id} ${inReplyToMessageId}`;
            }

            const msg = {
                to: toEmail,
                from: {
                    email: this.fromEmail,
                    name: this.fromName
                },
                replyTo: 'requests@foia.foib-request.com',
                subject: replySubject,
                text: replyText,
                html: this.formatEmailHtml(replyText),
                headers: {
                    'Message-ID': messageId,
                    'In-Reply-To': inReplyToMessageId,
                    'References': referencesHeader
                },
                customArgs: {
                    case_id: caseId.toString(),
                    message_type: 'auto_reply'
                }
            };

            const response = await sgMail.send(msg);
            console.log('Auto-reply sent successfully:', response[0].statusCode);

            await this.logSentMessage({
                case_id: caseId,
                message_id: messageId,
                sendgrid_message_id: response[0].headers['x-message-id'],
                to_email: toEmail,
                subject: replySubject,
                body_text: replyText,
                body_html: this.formatEmailHtml(replyText),
                message_type: 'auto_reply',
                thread_id: inReplyToMessageId
            });

            return {
                success: true,
                message_id: messageId
            };
        } catch (error) {
            console.error('Error sending auto-reply:', error);
            throw error;
        }
    }

    /**
     * Extract email address from "Name <email@domain.com>" format
     */
    extractEmail(emailString) {
        if (!emailString) return null;
        const match = emailString.match(/<(.+?)>/);
        return match ? match[1] : emailString;
    }

    /**
     * Process inbound email from SendGrid webhook
     */
    async processInboundEmail(inboundData) {
        try {
            console.log('Processing inbound email from:', inboundData.from);

            // Extract email addresses from "Name <email>" format
            const fromEmail = this.extractEmail(inboundData.from);
            const toEmail = this.extractEmail(inboundData.to);

            console.log('Extracted from email:', fromEmail);
            console.log('Extracted to email:', toEmail);

            // Extract relevant data
            const messageId = inboundData.headers['Message-ID'] || this.generateMessageId();
            const inReplyTo = inboundData.headers['In-Reply-To'];
            const references = inboundData.headers['References'];

            // Find the case this email belongs to
            const caseData = await this.findCaseForInbound(toEmail, fromEmail, references);

            if (!caseData) {
                console.warn('Could not match inbound email to a case');
                return { matched: false };
            }

            // Get or create thread
            let thread = await db.getThreadByCaseId(caseData.id);
            if (!thread) {
                thread = await db.createEmailThread({
                    case_id: caseData.id,
                    thread_id: references || messageId,
                    subject: inboundData.subject,
                    agency_email: fromEmail,
                    initial_message_id: messageId,
                    status: 'active'
                });
            }

            // Store the received message
            const message = await db.createMessage({
                thread_id: thread.id,
                case_id: caseData.id,
                message_id: messageId,
                direction: 'inbound',
                from_email: fromEmail,
                to_email: toEmail,
                subject: inboundData.subject,
                body_text: inboundData.text,
                body_html: inboundData.html,
                has_attachments: (inboundData.attachments && inboundData.attachments.length > 0),
                attachment_count: inboundData.attachments?.length || 0,
                message_type: 'response',
                received_at: new Date()
            });

            // Update thread
            await db.updateThread(thread.id, {
                last_message_at: new Date(),
                message_count: thread.message_count + 1,
                status: 'responded'
            });

            // Update case
            await db.updateCaseStatus(caseData.id, 'responded', {
                last_response_date: new Date()
            });

            // Log activity
            await db.logActivity('email_received', `Received response for case: ${caseData.case_name}`, {
                case_id: caseData.id,
                message_id: message.id
            });

            return {
                matched: true,
                case_id: caseData.id,
                message_id: message.id,
                thread_id: thread.id
            };
        } catch (error) {
            console.error('Error processing inbound email:', error);
            throw error;
        }
    }

    /**
     * Find which case an inbound email belongs to
     */
    async findCaseForInbound(toEmail, fromEmail, references) {
        try {
            // First try to match by thread references (In-Reply-To or References header)
            if (references) {
                // Try to match against message_id directly
                const messageMatch = await db.query(
                    'SELECT case_id FROM messages WHERE message_id = $1 LIMIT 1',
                    [references]
                );
                if (messageMatch.rows.length > 0) {
                    console.log(`Matched inbound email by message_id: ${references}`);
                    return await db.getCaseById(messageMatch.rows[0].case_id);
                }

                // Try to match against email_threads.thread_id
                const threadMatch = await db.query(
                    'SELECT case_id FROM email_threads WHERE thread_id = $1 LIMIT 1',
                    [references]
                );
                if (threadMatch.rows.length > 0) {
                    console.log(`Matched inbound email by thread_id: ${references}`);
                    return await db.getCaseById(threadMatch.rows[0].case_id);
                }
            }

            // Try to match by agency email (fallback)
            console.log(`No thread match found, trying to match by agency email: ${fromEmail}`);
            const cases = await db.query(
                'SELECT * FROM cases WHERE agency_email = $1 AND status IN ($2, $3) ORDER BY created_at DESC LIMIT 1',
                [fromEmail, 'sent', 'awaiting_response']
            );

            if (cases.rows.length > 0) {
                console.log(`Matched inbound email by agency email: ${fromEmail}`);
            }

            return cases.rows[0] || null;
        } catch (error) {
            console.error('Error finding case for inbound email:', error);
            return null;
        }
    }

    /**
     * Log a sent message to database
     */
    async logSentMessage(messageData) {
        try {
            // Get or create thread
            let thread = await db.getThreadByCaseId(messageData.case_id);

            if (!thread) {
                thread = await db.createEmailThread({
                    case_id: messageData.case_id,
                    thread_id: messageData.thread_id,
                    subject: messageData.subject,
                    agency_email: messageData.to_email,
                    initial_message_id: messageData.message_id,
                    status: 'active'
                });
            }

            // Create message record
            const message = await db.createMessage({
                thread_id: thread.id,
                case_id: messageData.case_id,
                message_id: messageData.message_id,
                sendgrid_message_id: messageData.sendgrid_message_id,
                direction: 'outbound',
                from_email: this.fromEmail,
                to_email: messageData.to_email,
                subject: messageData.subject,
                body_text: messageData.body_text,
                body_html: messageData.body_html,
                message_type: messageData.message_type,
                sent_at: new Date()
            });

            // Update thread
            await db.updateThread(thread.id, {
                last_message_at: new Date(),
                message_count: thread.message_count + 1
            });

            return message;
        } catch (error) {
            console.error('Error logging sent message:', error);
            throw error;
        }
    }

    /**
     * Generate a unique message ID
     */
    generateMessageId() {
        const timestamp = Date.now();
        const random = crypto.randomBytes(8).toString('hex');
        return `<${timestamp}.${random}@autobot.local>`;
    }

    /**
     * Generate a thread ID for a case
     */
    generateThreadId(caseId) {
        const timestamp = Date.now();
        return `<case-${caseId}-${timestamp}@autobot.local>`;
    }

    /**
     * Format email body as HTML
     */
    formatEmailHtml(text) {
        // Simple formatting: convert line breaks to <br> and wrap in basic HTML
        const formatted = text.replace(/\n/g, '<br>');
        return `
<!DOCTYPE html>
<html>
<head>
    <meta charset="utf-8">
    <style>
        body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
        .email-content { max-width: 600px; margin: 0 auto; padding: 20px; }
    </style>
</head>
<body>
    <div class="email-content">
        ${formatted}
    </div>
</body>
</html>`;
    }

    /**
     * Verify SendGrid webhook signature
     */
    verifyWebhookSignature(payload, signature, timestamp) {
        if (!process.env.SENDGRID_WEBHOOK_SECRET) {
            console.warn('SENDGRID_WEBHOOK_SECRET not set, skipping verification');
            return true;
        }

        const expectedSignature = crypto
            .createHmac('sha256', process.env.SENDGRID_WEBHOOK_SECRET)
            .update(timestamp + payload)
            .digest('base64');

        return signature === expectedSignature;
    }
}

module.exports = new SendGridService();
