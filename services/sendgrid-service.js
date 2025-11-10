const sgMail = require('@sendgrid/mail');
const db = require('./database');
const notionService = require('./notion-service');
const crypto = require('crypto');

const PORTAL_PROVIDERS = [
    {
        name: 'govqa',
        domains: ['govqa.us', 'custhelp.com', 'mycusthelp.com'],
        keywords: ['govqa', 'public records center', 'my request center', 'request center notification'],
        defaultPath: '/WEBAPP/_rs/(S(0))/RequestLogin.aspx?rqst=4'
    },
    {
        name: 'nextrequest',
        domains: ['nextrequest.com'],
        keywords: ['nextrequest', 'public records request portal'],
        defaultPath: '/'
    },
    {
        name: 'justfoia',
        domains: ['justfoia.com'],
        keywords: ['justfoia', 'govbuilt'],
        defaultPath: '/'
    }
];

class SendGridService {
    constructor() {
        if (process.env.SENDGRID_API_KEY) {
            sgMail.setApiKey(process.env.SENDGRID_API_KEY);
        }
        // Use the clean root domain (authenticated via em7571.foib-request.com)
        this.fromEmail = 'requests@foib-request.com';
        this.fromName = 'FOIA Request Team';
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
                replyTo: this.fromEmail,
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
                replyTo: this.fromEmail,
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
                replyTo: this.fromEmail,
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

    normalizeHeaders(rawHeaders) {
        if (!rawHeaders) {
            return {};
        }

        if (typeof rawHeaders === 'object' && !Array.isArray(rawHeaders)) {
            return Object.entries(rawHeaders).reduce((acc, [key, value]) => {
                acc[key.toLowerCase()] = value;
                return acc;
            }, {});
        }

        if (typeof rawHeaders === 'string') {
            const normalized = {};
            const lines = rawHeaders.split(/\r?\n/);
            let currentKey = null;

            for (const rawLine of lines) {
                if (!rawLine.trim()) {
                    continue;
                }

                // Header value folded over multiple lines (starts with whitespace)
                if (/^\s/.test(rawLine) && currentKey) {
                    normalized[currentKey] = `${normalized[currentKey]} ${rawLine.trim()}`;
                    continue;
                }

                const separatorIndex = rawLine.indexOf(':');
                if (separatorIndex === -1) {
                    continue;
                }

                const key = rawLine.slice(0, separatorIndex).trim().toLowerCase();
                const value = rawLine.slice(separatorIndex + 1).trim();

                if (normalized[key]) {
                    normalized[key] = `${normalized[key]}, ${value}`;
                } else {
                    normalized[key] = value;
                }

                currentKey = key;
            }

            return normalized;
        }

        return {};
    }

    getHeaderValue(headers, name) {
        if (!headers) return undefined;
        const key = name.toLowerCase();
        return headers[key];
    }

    extractHeaderIds(headerValue) {
        if (!headerValue) {
            return [];
        }

        if (Array.isArray(headerValue)) {
            return headerValue.flatMap(value => this.extractHeaderIds(value));
        }

        const value = String(headerValue);
        const matches = value.match(/<[^>]+>/g);
        if (matches && matches.length > 0) {
            return matches.map(m => m.trim());
        }

        return value
            .split(/\s+/)
            .map(part => part.trim())
            .filter(Boolean);
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

            const headers = this.normalizeHeaders(inboundData.headers);
            const messageId =
                this.getHeaderValue(headers, 'message-id') ||
                inboundData['Message-ID'] ||
                inboundData['message-id'] ||
                inboundData['messageId'] ||
                inboundData['message_id'] ||
                this.generateMessageId();

            const inReplyToHeader =
                this.getHeaderValue(headers, 'in-reply-to') ||
                inboundData['In-Reply-To'] ||
                inboundData['in_reply_to'] ||
                inboundData['in-reply-to'] ||
                inboundData['InReplyTo'];

            const referencesHeader =
                this.getHeaderValue(headers, 'references') ||
                inboundData.references ||
                inboundData['References'] ||
                inboundData['reference'] ||
                inboundData['Reference'];

            const referenceIds = this.extractHeaderIds(referencesHeader);
            const inReplyToIds = this.extractHeaderIds(inReplyToHeader);
            const inReplyToId = inReplyToIds.length > 0 ? inReplyToIds[0] : null;

            console.log('Parsed headers:', {
                messageId,
                inReplyTo: inReplyToId,
                references: referenceIds
            });

            // Find the case this email belongs to
            const caseData = await this.findCaseForInbound({
                toEmail,
                fromEmail,
                inReplyToId,
                referenceIds
            });

            if (!caseData) {
                console.warn('Could not match inbound email to a case');
                return { matched: false };
            }

            // Get or create thread
            let thread = await db.getThreadByCaseId(caseData.id);
            if (!thread) {
                const threadIdentifier = referenceIds[0] || inReplyToId || messageId;
                thread = await db.createEmailThread({
                    case_id: caseData.id,
                    thread_id: threadIdentifier,
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
            const currentMessageCount = typeof thread.message_count === 'number' ? thread.message_count : 0;
            await db.updateThread(thread.id, {
                last_message_at: new Date(),
                message_count: currentMessageCount + 1,
                status: 'responded'
            });

            // Update case
            await db.updateCaseStatus(caseData.id, 'responded', {
                last_response_date: new Date()
            });

            // Portal notification detection
            let portalNotificationInfo = null;
            const portalDetection = this.detectPortalNotification({
                fromEmail,
                subject: inboundData.subject,
                text: inboundData.text || inboundData.body_text || ''
            });

            if (portalDetection) {
                await db.markMessagePortalNotification(message.id, {
                    type: portalDetection.type,
                    provider: portalDetection.provider
                });

                const portalUrl = caseData.portal_url || portalDetection.portal_url || null;
                portalNotificationInfo = {
                    ...portalDetection,
                    portal_url: portalUrl
                };

                // If we inferred a portal URL and case is missing one, update it
                if (portalUrl && !caseData.portal_url) {
                    await db.updateCasePortalStatus(caseData.id, {
                        portal_url: portalUrl,
                        portal_provider: portalDetection.provider
                    });
                    caseData.portal_url = portalUrl;
                }

                await db.logActivity('portal_notification', `Portal update (${portalDetection.provider}) received for ${caseData.case_name}`, {
                    case_id: caseData.id,
                    message_id: message.id,
                    portal_url: portalUrl,
                    portal_provider: portalDetection.provider,
                    notification_type: portalDetection.type
                });
            }

            const feeQuote = this.detectFeeQuote({
                subject: inboundData.subject || '',
                text: inboundData.text || inboundData.body_text || inboundData.html || ''
            });

            if (feeQuote) {
                caseData = await this.handleFeeQuote(caseData, feeQuote, message.id);
            }

            // Log activity
            await db.logActivity('email_received', `Received response for case: ${caseData.case_name}`, {
                case_id: caseData.id,
                message_id: message.id
            });

            return {
                matched: true,
                case_id: caseData.id,
                message_id: message.id,
                thread_id: thread.id,
                case_portal_url: caseData.portal_url,
                portal_notification: portalNotificationInfo
            };
        } catch (error) {
            console.error('Error processing inbound email:', error);
            throw error;
        }
    }

    /**
     * Find which case an inbound email belongs to
     */
    async findCaseForInbound({ toEmail, fromEmail, inReplyToId, referenceIds = [] }) {
        try {
            const lookupIds = Array.from(new Set(
                [inReplyToId, ...referenceIds].filter(Boolean)
            ));

            for (const id of lookupIds) {
                const trimmedId = id.trim();
                if (!trimmedId) {
                    continue;
                }

                const messageMatch = await db.query(
                    'SELECT case_id FROM messages WHERE message_id = $1 LIMIT 1',
                    [trimmedId]
                );
                if (messageMatch.rows.length > 0) {
                    console.log(`Matched inbound email by message reference: ${trimmedId}`);
                    return await db.getCaseById(messageMatch.rows[0].case_id);
                }

                const threadMatch = await db.query(
                    'SELECT case_id FROM email_threads WHERE thread_id = $1 OR initial_message_id = $1 LIMIT 1',
                    [trimmedId]
                );
                if (threadMatch.rows.length > 0) {
                    console.log(`Matched inbound email by thread reference: ${trimmedId}`);
                    return await db.getCaseById(threadMatch.rows[0].case_id);
                }
            }

            // Try to match by agency email (fallback)
            console.log(`No thread match found, trying to match by agency email: ${fromEmail}`);
            const activeStatuses = [
                'sent',
                'awaiting_response',
                'needs_rebuttal',
                'pending_fee_decision',
                'needs_human_review',
                'responded'
            ];

            const cases = await db.query(
                `
                SELECT *
                FROM cases
                WHERE LOWER(agency_email) = LOWER($1)
                  AND status = ANY($2)
                ORDER BY updated_at DESC, created_at DESC
                LIMIT 1
                `,
                [fromEmail, activeStatuses]
            );

            if (cases.rows.length > 0) {
                console.log(`Matched inbound email by agency email: ${fromEmail}`);
                return cases.rows[0];
            }

            // Final fallback: any status for that agency email
            const fallback = await db.query(
                `
                SELECT *
                FROM cases
                WHERE LOWER(agency_email) = LOWER($1)
                ORDER BY updated_at DESC, created_at DESC
                LIMIT 1
                `,
                [fromEmail]
            );

            if (fallback.rows.length > 0) {
                console.log(`Fallback match on agency email regardless of status: ${fromEmail}`);
                return fallback.rows[0];
            }

            console.warn(`No matching case found for inbound email from ${fromEmail} to ${toEmail}`);
            return null;
        } catch (error) {
            console.error('Error finding case for inbound email:', error);
            return null;
        }
    }

    detectPortalNotification({ fromEmail, subject = '', text = '' }) {
        const emailDomain = (fromEmail || '').split('@')[1]?.toLowerCase() || '';
        const haystack = `${subject} ${text}`.toLowerCase();

        for (const provider of PORTAL_PROVIDERS) {
            const domainMatch = provider.domains.some((domain) => emailDomain.includes(domain));
            const keywordMatch = provider.keywords.some((keyword) => haystack.includes(keyword.toLowerCase()));

            if (domainMatch || keywordMatch) {
                const inferredDomain = domainMatch ? emailDomain.split('>').shift() : null;
                const portalUrl = inferredDomain
                    ? `https://${inferredDomain}${provider.defaultPath}`
                    : null;

                return {
                    provider: provider.name,
                    type: 'status_update',
                    portal_url: portalUrl
                };
            }
        }

        return null;
    }

    detectFeeQuote({ subject = '', text = '' }) {
        const haystack = `${subject}\n${text}`.toLowerCase();
        if (!/fee|cost|estimate|invoice|payment|charge/.test(haystack)) {
            return null;
        }

        const currencyRegex = /(?:usd|us\$|\$)\s?([\d,]+(?:\.\d{1,2})?)/gi;
        let match;
        let highest = 0;

        while ((match = currencyRegex.exec(subject + ' ' + text)) !== null) {
            const amount = parseFloat(match[1].replace(/,/g, ''));
            if (!isNaN(amount) && amount > highest) {
                highest = amount;
            }
        }

        if (highest <= 0) {
            return null;
        }

        return {
            amount: highest,
            currency: 'USD'
        };
    }

    async handleFeeQuote(caseData, feeQuote, messageId) {
        const amount = feeQuote.amount;
        let action = 'review';

        if (amount <= FEE_AUTO_APPROVE_MAX) {
            action = 'auto_approve';
        } else if (amount >= FEE_ESCALATE_MIN) {
            action = 'escalate';
        } else {
            action = 'negotiate';
        }

        let newStatus = caseData.status || 'awaiting_response';
        let substatus = caseData.substatus || '';
        let note = '';

        if (action === 'auto_approve') {
            substatus = `Fee auto-approved ($${amount.toFixed(2)})`;
            note = 'Fee within auto-approve threshold. Proceed with payment or request confirmation.';
        } else if (action === 'negotiate') {
            newStatus = 'fee_negotiation';
            substatus = `Fee quoted: $${amount.toFixed(2)} (negotiate scope)`;
            note = 'Fee above auto-approve threshold. Attempt to narrow scope or request breakdown.';
        } else {
            newStatus = 'needs_human_fee_approval';
            substatus = `Fee quoted: $${amount.toFixed(2)} (awaiting approval)`;
            note = 'Fee exceeds escalation threshold. Human decision required.';
        }

        const updatedCase = await db.updateCaseStatus(caseData.id, newStatus, {
            substatus,
            last_fee_quote_amount: amount,
            last_fee_quote_currency: feeQuote.currency,
            last_fee_quote_at: new Date()
        });

        await notionService.syncStatusToNotion(caseData.id);

        await db.logActivity('fee_quote_detected', `Fee quote $${amount.toFixed(2)} (${action})`, {
            case_id: caseData.id,
            message_id: messageId,
            fee_amount: amount,
            fee_currency: feeQuote.currency,
            action_recommended: action,
            note
        });

        return updatedCase;
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
const FEE_AUTO_APPROVE_MAX = parseFloat(process.env.FEE_AUTO_APPROVE_MAX || '100');
const FEE_ESCALATE_MIN = parseFloat(process.env.FEE_ESCALATE_MIN || '300');
