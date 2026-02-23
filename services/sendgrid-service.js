const sgMail = require('@sendgrid/mail');
const db = require('./database');
const notionService = require('./notion-service');
const aiService = require('./ai-service');
const crypto = require('crypto');
const { extractUrls } = require('../utils/contact-utils');
const {
    PORTAL_PROVIDERS,
    PORTAL_EMAIL_DOMAINS,
    normalizePortalUrl,
    detectPortalProviderByUrl,
    isSupportedPortalUrl
} = require('../utils/portal-utils');

class SendGridService {
    constructor() {
        if (process.env.SENDGRID_API_KEY) {
            sgMail.setApiKey(process.env.SENDGRID_API_KEY);
        }
        // Use the clean root domain (authenticated via em7571.foib-request.com)
        this.defaultFromEmail = 'requests@foib-request.com';
        this.fromName = 'FOIA Request Team';
    }

    /**
     * Resolve the FROM email for a case.
     * If the case has a user_id, use that user's email; otherwise fall back to default.
     */
    async getFromEmail(caseId) {
        if (caseId) {
            try {
                const caseData = await db.query('SELECT user_id FROM cases WHERE id = $1', [caseId]);
                const userId = caseData.rows[0]?.user_id;
                if (userId) {
                    const user = await db.getUserById(userId);
                    if (user?.email && user.active) {
                        return user.email;
                    }
                }
            } catch (err) {
                console.warn('Failed to resolve user email for case', caseId, err.message);
            }
        }
        return this.defaultFromEmail;
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

            const fromEmail = await this.getFromEmail(caseId);

            const msg = {
                to: toEmail,
                from: {
                    email: fromEmail,
                    name: this.fromName
                },
                replyTo: fromEmail,
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

            const fromEmail = await this.getFromEmail(caseId);

            const msg = {
                to: toEmail,
                from: {
                    email: fromEmail,
                    name: this.fromName
                },
                replyTo: fromEmail,
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

            const fromEmail = await this.getFromEmail(caseId);

            const msg = {
                to: toEmail,
                from: {
                    email: fromEmail,
                    name: this.fromName
                },
                replyTo: fromEmail,
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
            let caseData = await this.findCaseForInbound({
                toEmail,
                fromEmail,
                fromFull: inboundData.from,
                subject: inboundData.subject,
                text: inboundData.text || inboundData.body_text || '',
                inReplyToId,
                referenceIds
            });

            if (!caseData) {
                console.warn('Could not match inbound email to a case');
                return { matched: false };
            }

            // --- Post-match: Extract and store request number if missing ---
            if (caseData && !caseData.portal_request_number) {
                const bodyText = inboundData.text || inboundData.body_text || '';
                const detectedNR = this.extractRequestNumber(`${inboundData.subject || ''}\n${bodyText}`);
                if (detectedNR) {
                    try {
                        const result = await db.query(
                            'UPDATE cases SET portal_request_number = $1 WHERE id = $2 AND (portal_request_number IS NULL OR portal_request_number = \'\')',
                            [detectedNR, caseData.id]
                        );
                        if (result.rowCount > 0) {
                            caseData.portal_request_number = detectedNR;
                            console.log(`Stored portal_request_number "${detectedNR}" for case #${caseData.id}`);
                            await db.logActivity('nr_captured', `Request number ${detectedNR} captured from inbound email`, {
                                case_id: caseData.id,
                                request_number: detectedNR
                            });
                        }
                    } catch (e) {
                        console.warn('Failed to save portal_request_number post-match:', e.message);
                    }
                }
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

            let messageAlreadyExists = false;
            let message = null;

            try {
                // Store the received message
                message = await db.createMessage({
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
            } catch (error) {
                if (error.code === '23505') {
                    messageAlreadyExists = true;
                    console.warn(`Duplicate inbound message_id detected (${messageId}), reusing existing record`);
                    message = await db.getMessageByMessageIdentifier(messageId);
                    if (!message) {
                        throw error; // Should never happen, but fail loudly if it does
                    }
                } else {
                    throw error;
                }
            }

            if (!message) {
                throw new Error('Failed to persist inbound message');
            }

            // If this is a duplicate and we've already analyzed it, short-circuit to avoid double processing
            if (messageAlreadyExists) {
                const existingAnalysis = await db.getAnalysisByMessageId(message.id);
                if (existingAnalysis) {
                    console.log(`Inbound message ${messageId} already analyzed (analysis #${existingAnalysis.id}), skipping duplicate processing`);
                    return {
                        matched: true,
                        case_id: caseData.id,
                        message_id: message.id,
                        thread_id: thread.id,
                        case_portal_url: caseData.portal_url,
                        portal_notification: null,
                        already_processed: true
                    };
                }
            }

            // Update thread metadata (only bump message_count when this is a brand-new message)
            const currentMessageCount = typeof thread.message_count === 'number' ? thread.message_count : 0;
            const threadUpdate = {
                last_message_at: new Date(),
                status: 'responded'
            };
            if (!messageAlreadyExists) {
                threadUpdate.message_count = currentMessageCount + 1;
            }
            await db.updateThread(thread.id, threadUpdate);

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

            const confirmationDetection = this.detectNextRequestConfirmation({
                subject: inboundData.subject,
                text: inboundData.text || inboundData.body_text || '',
                html: inboundData.html || inboundData.body_html || ''
            });

            if (confirmationDetection) {
                const confirmationUrl = confirmationDetection.portal_url;

                await db.markMessagePortalNotification(message.id, {
                    type: 'confirmation_link',
                    provider: 'nextrequest'
                });

                await db.updateCasePortalStatus(caseData.id, {
                    portal_url: confirmationUrl,
                    portal_provider: 'nextrequest',
                    last_portal_status: 'Confirmation link received',
                    last_portal_status_at: new Date(),
                    last_portal_details: JSON.stringify({
                        confirmation_url: confirmationUrl,
                        source_message_id: message.id
                    })
                });

                await db.updateCaseStatus(caseData.id, 'portal_in_progress', {
                    substatus: 'Confirmation link received - retrying portal submission'
                });

                caseData.portal_url = confirmationUrl;

                portalNotificationInfo = {
                    provider: 'nextrequest',
                    type: 'confirmation_link',
                    portal_url: confirmationUrl,
                    instructions_excerpt: confirmationDetection.instructions_excerpt
                };

                await db.logActivity('portal_confirmation_link', `NextRequest confirmation link received for ${caseData.case_name}`, {
                    case_id: caseData.id,
                    message_id: message.id,
                    portal_url: confirmationUrl
                });
            }

            // Fee detection removed: the AI pipeline (analyzeResponse → classify-inbound
            // → email-queue → decide-next-action) handles fee_request intent with BWC denial
            // checks, thresholds, and proper proposals. The old regex detectFeeQuote() ran
            // before AI analysis and short-circuited the smarter pipeline.

            // Feature 6: Save attachments to disk
            if (inboundData.attachments?.length > 0 && !messageAlreadyExists) {
                const fsPromises = require('fs').promises;
                const path = require('path');
                const attachmentDir = process.env.ATTACHMENT_DIR || '/data/attachments';

                for (const att of inboundData.attachments) {
                    try {
                        const dir = path.join(attachmentDir, String(caseData.id));
                        await fsPromises.mkdir(dir, { recursive: true });
                        const safeFilename = (att.filename || 'unnamed').replace(/[^a-zA-Z0-9._-]/g, '_');
                        const storagePath = path.join(dir, `${message.id}_${safeFilename}`);
                        if (att.buffer) {
                            await fsPromises.writeFile(storagePath, att.buffer);
                        }
                        await db.createAttachment({
                            message_id: message.id,
                            case_id: caseData.id,
                            filename: att.filename || 'unnamed',
                            content_type: att.mimetype || 'application/octet-stream',
                            size_bytes: att.size || (att.buffer ? att.buffer.length : 0),
                            storage_path: storagePath
                        });
                    } catch (attErr) {
                        console.error(`Failed to save attachment ${att.filename}:`, attErr.message);
                    }
                }
            }

            // Log activity
            await db.logActivity('email_received', `Received response for case: ${caseData.case_name}`, {
                case_id: caseData.id,
                message_id: message.id,
                deduplicated_retry: messageAlreadyExists
            });

            return {
                matched: true,
                case_id: caseData.id,
                message_id: message.id,
                thread_id: thread.id,
                case_portal_url: caseData.portal_url,
                portal_notification: portalNotificationInfo,
                already_processed: false
            };
        } catch (error) {
            console.error('Error processing inbound email:', error);
            throw error;
        }
    }

    /**
     * Extract portal request numbers from email text.
     * Patterns: #26-544, Request 26-544, R-26-544, Tracking: 26-544, PD-2026-665
     */
    extractRequestNumber(text) {
        if (!text) return null;
        const patterns = [
            /(?:Request|Tracking|Ref|Reference|Confirmation)[:\s#]*([A-Z]{0,5}-?\d{2,4}-\d+)/i,
            /#([A-Z]{0,5}-?\d{2,4}-\d+)/i,
            /R-(\d{2,4}-\d+)/i,
            /(?:Request|Tracking|Ref)[:\s#]*(\d{3,})/i,
            /#(\d{4,})/i
        ];
        for (const pattern of patterns) {
            const match = text.match(pattern);
            if (match) return match[1];
        }
        return null;
    }

    /**
     * Score and disambiguate multiple candidate cases for an inbound email.
     * Returns the highest-scoring candidate.
     */
    async disambiguateCandidates(candidates, { subject, bodyText, fromEmail }) {
        if (!candidates || candidates.length === 0) return null;
        if (candidates.length === 1) return candidates[0];

        const requestNumber = this.extractRequestNumber(`${subject || ''}\n${bodyText || ''}`);
        const subjectWords = (subject || '').toLowerCase().split(/\s+/).filter(w => w.length > 3);

        const scored = await Promise.all(candidates.map(async (c) => {
            let score = 0;

            // Request number match (instant winner) — supports comma-separated list
            if (requestNumber && c.portal_request_number) {
                const storedNums = c.portal_request_number.replace(/\s/g, '').split(',');
                if (storedNums.includes(requestNumber)) {
                    score += 100;
                }
            }

            // Temporal proximity: minutes since last outbound
            const lastOutbound = await db.getLastOutboundTime(c.id);
            if (lastOutbound) {
                const minutesAgo = (Date.now() - new Date(lastOutbound).getTime()) / 60000;
                score += Math.max(0, 50 - minutesAgo / 10);
            }

            // Status affinity
            const statusScores = {
                portal_in_progress: 20,
                awaiting_response: 15,
                sent: 10
            };
            score += statusScores[c.status] || 0;

            // Subject keyword overlap with case fields
            const caseText = `${c.requested_records || ''} ${c.agency_name || ''} ${c.case_name || ''}`.toLowerCase();
            let keywordScore = 0;
            for (const word of subjectWords) {
                if (caseText.includes(word)) keywordScore += 2;
            }
            score += Math.min(keywordScore, 10);

            return { candidate: c, score };
        }));

        scored.sort((a, b) => b.score - a.score);
        const winner = scored[0];
        if (scored.length > 1) {
            console.log(`Disambiguation scores: ${scored.map(s => `case #${s.candidate.id}=${s.score.toFixed(1)}`).join(', ')}`);
        }
        return winner.candidate;
    }

    /**
     * Find which case an inbound email belongs to
     */
    async findCaseForInbound({ toEmail, fromEmail, fromFull, subject, text, inReplyToId, referenceIds = [] }) {
        try {
            // Resolve recipient user from TO address for user-scoped routing
            const recipientUser = await db.getUserByEmail(toEmail);
            const userId = recipientUser?.id || null;
            if (userId) {
                console.log(`Inbound TO ${toEmail} resolved to user #${userId} (${recipientUser.name})`);
            }

            // --- Tier 1: Thread matching (In-Reply-To / References) ---
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
                    const matchedCase = await db.getCaseById(messageMatch.rows[0].case_id);
                    if (userId && matchedCase && matchedCase.user_id && matchedCase.user_id !== userId) {
                        console.warn(`Thread match case #${matchedCase.id} belongs to user ${matchedCase.user_id}, but inbound is for user ${userId} — returning match anyway (strong signal)`);
                    }
                    console.log(`Matched inbound email by message reference: ${trimmedId}`);
                    return matchedCase;
                }

                const threadMatch = await db.query(
                    'SELECT case_id FROM email_threads WHERE thread_id = $1 OR initial_message_id = $1 LIMIT 1',
                    [trimmedId]
                );
                if (threadMatch.rows.length > 0) {
                    const matchedCase = await db.getCaseById(threadMatch.rows[0].case_id);
                    if (userId && matchedCase && matchedCase.user_id && matchedCase.user_id !== userId) {
                        console.warn(`Thread match case #${matchedCase.id} belongs to user ${matchedCase.user_id}, but inbound is for user ${userId} — returning match anyway (strong signal)`);
                    }
                    console.log(`Matched inbound email by thread reference: ${trimmedId}`);
                    return matchedCase;
                }
            }

            // --- Tier 1.5: Portal email matching ---
            const portalInfo = this.detectPortalProviderFromEmail(fromEmail);
            if (portalInfo) {
                console.log(`Portal email detected: provider=${portalInfo.provider}, subdomain=${portalInfo.subdomain || 'none'}`);
                const signals = this.extractPortalMatchingSignals(portalInfo.provider, fromFull, fromEmail, subject, text);
                console.log('Portal matching signals:', JSON.stringify(signals));
                const portalMatch = await this.matchCaseByPortalSignals(signals);
                if (portalMatch) {
                    console.log(`Matched inbound email by portal signals (${portalInfo.provider}): case #${portalMatch.id}`);
                    // Persist request number if we extracted one (atomic to avoid race conditions)
                    if (signals.requestNumber) {
                        try {
                            await db.query(
                                `UPDATE cases SET portal_request_number = CASE
                                    WHEN portal_request_number IS NULL OR portal_request_number = '' THEN $1
                                    WHEN $1 = ANY(string_to_array(REPLACE(portal_request_number, ' ', ''), ',')) THEN portal_request_number
                                    ELSE portal_request_number || ',' || $1
                                 END
                                 WHERE id = $2`,
                                [signals.requestNumber, portalMatch.id]
                            );
                        } catch (e) {
                            console.warn('Failed to save portal_request_number:', e.message);
                        }
                    }
                    return portalMatch;
                }
            }

            // --- Tier 1.75: Request number cross-reference ---
            const detectedReqNum = this.extractRequestNumber(`${subject || ''}\n${text || ''}`);
            if (detectedReqNum) {
                // Supports comma-separated portal_request_number: check each number individually
                const reqNumMatch = await db.query(
                    `SELECT * FROM cases
                     WHERE portal_request_number IS NOT NULL
                       AND EXISTS (
                           SELECT 1 FROM unnest(string_to_array(REPLACE(portal_request_number, ' ', ''), ',')) AS rn
                           WHERE $1 LIKE '%' || rn || '%' OR $2 LIKE '%' || rn || '%'
                       )
                       AND ($3::int IS NULL OR user_id = $3 OR user_id IS NULL)
                     ORDER BY updated_at DESC
                     LIMIT 5`,
                    [subject || '', (text || '').substring(0, 2000), userId]
                );
                if (reqNumMatch.rows.length === 1) {
                    console.log(`Matched inbound email by request number (Tier 1.75): ${detectedReqNum} → case #${reqNumMatch.rows[0].id}`);
                    return reqNumMatch.rows[0];
                }
                if (reqNumMatch.rows.length > 1) {
                    const winner = await this.disambiguateCandidates(reqNumMatch.rows, { subject, bodyText: text, fromEmail });
                    if (winner) {
                        console.log(`Matched inbound email by request number + disambiguation (Tier 1.75): ${detectedReqNum} → case #${winner.id}`);
                        return winner;
                    }
                }
            }

            // --- Tier 2: Agency email matching (active cases) ---
            console.log(`No thread/portal match found, trying to match by agency email: ${fromEmail}`);
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
                  AND ($3::int IS NULL OR user_id = $3 OR user_id IS NULL)
                ORDER BY
                  CASE WHEN user_id = $3 THEN 0 ELSE 1 END,
                  updated_at DESC, created_at DESC
                LIMIT 10
                `,
                [fromEmail, activeStatuses, userId]
            );

            if (cases.rows.length === 1) {
                console.log(`Matched inbound email by agency email: ${fromEmail}`);
                return cases.rows[0];
            }
            if (cases.rows.length > 1) {
                const winner = await this.disambiguateCandidates(cases.rows, { subject, bodyText: text, fromEmail });
                if (winner) {
                    console.log(`Matched inbound email by agency email + disambiguation: ${fromEmail} → case #${winner.id}`);
                    return winner;
                }
            }

            // --- Tier 2.5: Domain-level matching (active cases) ---
            // Agencies often send from noreply@, records@, or other addresses on the same domain
            const fromDomain = fromEmail.split('@')[1]?.toLowerCase();
            if (fromDomain) {
                const domainMatch = await db.query(
                    `
                    SELECT *
                    FROM cases
                    WHERE LOWER(agency_email) LIKE $1
                      AND status = ANY($2)
                      AND ($3::int IS NULL OR user_id = $3 OR user_id IS NULL)
                    ORDER BY
                      CASE WHEN user_id = $3 THEN 0 ELSE 1 END,
                      updated_at DESC, created_at DESC
                    LIMIT 10
                    `,
                    [`%@${fromDomain}`, activeStatuses, userId]
                );

                if (domainMatch.rows.length === 1) {
                    console.log(`Matched inbound email by agency domain: ${fromDomain} (from ${fromEmail}, case has ${domainMatch.rows[0].agency_email})`);
                    return domainMatch.rows[0];
                }
                if (domainMatch.rows.length > 1) {
                    const winner = await this.disambiguateCandidates(domainMatch.rows, { subject, bodyText: text, fromEmail });
                    if (winner) {
                        console.log(`Matched inbound email by agency domain + disambiguation: ${fromDomain} → case #${winner.id}`);
                        return winner;
                    }
                }
            }

            // --- Tier 3: Agency email fallback (any status) ---
            const fallback = await db.query(
                `
                SELECT *
                FROM cases
                WHERE LOWER(agency_email) = LOWER($1)
                  AND ($2::int IS NULL OR user_id = $2 OR user_id IS NULL)
                ORDER BY
                  CASE WHEN user_id = $2 THEN 0 ELSE 1 END,
                  updated_at DESC, created_at DESC
                LIMIT 10
                `,
                [fromEmail, userId]
            );

            if (fallback.rows.length === 1) {
                console.log(`Fallback match on agency email regardless of status: ${fromEmail}`);
                return fallback.rows[0];
            }
            if (fallback.rows.length > 1) {
                const winner = await this.disambiguateCandidates(fallback.rows, { subject, bodyText: text, fromEmail });
                if (winner) {
                    console.log(`Fallback match on agency email + disambiguation: ${fromEmail} → case #${winner.id}`);
                    return winner;
                }
            }

            // --- Tier 3.5: Domain-level fallback (any status) ---
            if (fromDomain) {
                const domainFallback = await db.query(
                    `
                    SELECT *
                    FROM cases
                    WHERE LOWER(agency_email) LIKE $1
                      AND ($2::int IS NULL OR user_id = $2 OR user_id IS NULL)
                    ORDER BY
                      CASE WHEN user_id = $2 THEN 0 ELSE 1 END,
                      updated_at DESC, created_at DESC
                    LIMIT 10
                    `,
                    [`%@${fromDomain}`, userId]
                );

                if (domainFallback.rows.length === 1) {
                    console.log(`Domain fallback match (any status): ${fromDomain} → case #${domainFallback.rows[0].id}`);
                    return domainFallback.rows[0];
                }
                if (domainFallback.rows.length > 1) {
                    const winner = await this.disambiguateCandidates(domainFallback.rows, { subject, bodyText: text, fromEmail });
                    if (winner) {
                        console.log(`Domain fallback match + disambiguation (any status): ${fromDomain} → case #${winner.id}`);
                        return winner;
                    }
                }
            }

            // --- Save unmatched portal signal for deferred matching ---
            const unmatchedPortalInfo = this.detectPortalProviderFromEmail(fromEmail);
            if (unmatchedPortalInfo || detectedReqNum) {
                try {
                    // Find the message_id if we can (best-effort lookup)
                    let messageDbId = null;
                    const msgLookup = await db.query(
                        `SELECT id FROM messages WHERE from_email = $1 AND subject = $2 ORDER BY received_at DESC LIMIT 1`,
                        [fromEmail, subject || '']
                    );
                    if (msgLookup.rows.length > 0) {
                        messageDbId = msgLookup.rows[0].id;
                    }

                    await db.saveUnmatchedPortalSignal({
                        message_id: messageDbId,
                        from_email: fromEmail,
                        from_domain: fromDomain,
                        subject: subject,
                        detected_request_number: detectedReqNum || null,
                        portal_provider: unmatchedPortalInfo?.provider || null,
                        portal_subdomain: unmatchedPortalInfo?.subdomain || null
                    });
                    console.log(`Saved unmatched portal signal: from=${fromEmail}, reqNum=${detectedReqNum || 'none'}, provider=${unmatchedPortalInfo?.provider || 'none'}`);
                } catch (e) {
                    console.warn('Failed to save unmatched portal signal:', e.message);
                }
            }

            console.warn(`No matching case found for inbound email from ${fromEmail} to ${toEmail}`);
            return null;
        } catch (error) {
            console.error('Error finding case for inbound email:', error);
            return null;
        }
    }

    /**
     * Detect if an email comes from a known portal notification system.
     * Returns { provider, subdomain } or null.
     */
    detectPortalProviderFromEmail(fromEmail) {
        if (!fromEmail) return null;
        const atIndex = fromEmail.indexOf('@');
        if (atIndex === -1) return null;

        const localPart = fromEmail.substring(0, atIndex).toLowerCase();
        const domain = fromEmail.substring(atIndex + 1).toLowerCase();

        // Check exact domain first, then parent domains
        // e.g. "fortcollinspoliceco@request.justfoia.com" → domain "request.justfoia.com"
        for (const [emailDomain, config] of Object.entries(PORTAL_EMAIL_DOMAINS)) {
            if (domain === emailDomain || domain.endsWith('.' + emailDomain)) {
                const subdomain = config.subdomainFromLocalPart ? localPart : null;
                return { provider: config.provider, subdomain };
            }
        }

        return null;
    }

    /**
     * Extract matching signals from a portal notification email.
     * Returns an object with: { provider, subdomain, requestNumber, agencyName, bodySubdomain }
     */
    extractPortalMatchingSignals(provider, fromFull, fromEmail, subject, text) {
        const signals = { provider, subdomain: null, requestNumber: null, agencyName: null, bodySubdomain: null };
        const subjectStr = subject || '';
        const textStr = text || '';

        if (provider === 'justfoia') {
            // Subdomain from email local part: fortcollinspoliceco@request.justfoia.com
            const atIndex = (fromEmail || '').indexOf('@');
            if (atIndex > 0) {
                signals.subdomain = fromEmail.substring(0, atIndex).toLowerCase();
            }
            // Request number from subject: "Fort Collins Police - ... Request PD-2026-665"
            const reqMatch = subjectStr.match(/Request\s+([A-Z]{1,5}-\d{4}-\d+)/i);
            if (reqMatch) {
                signals.requestNumber = reqMatch[1];
            }
        } else if (provider === 'govqa') {
            // Subdomain from email local part: subdomain@mycusthelp.net
            const atIndex = (fromEmail || '').indexOf('@');
            if (atIndex > 0) {
                signals.subdomain = fromEmail.substring(0, atIndex).toLowerCase();
            }
        } else if (provider === 'nextrequest') {
            // Agency name from display name: "City of Austin via NextRequest"
            const fromFullStr = fromFull || '';
            const viaMatch = fromFullStr.match(/^["']?(.+?)\s+via\s+NextRequest/i);
            if (viaMatch) {
                signals.agencyName = viaMatch[1].trim().replace(/^["']|["']$/g, '');
            }

            // Agency name from subject: "Your City of Austin public records request"
            if (!signals.agencyName) {
                const subjAgencyMatch = subjectStr.match(/Your\s+(.+?)\s+public\s+records\s+request/i);
                if (subjAgencyMatch) {
                    signals.agencyName = subjAgencyMatch[1].trim();
                }
            }

            // Request number from subject: "#XX-NNN" or "#NNNNN"
            const reqNumMatch = subjectStr.match(/#([A-Z0-9]+-\d+|\d{3,})/i);
            if (reqNumMatch) {
                signals.requestNumber = reqNumMatch[1];
            }

            // Subdomain from body URLs: https://austin.nextrequest.com/...
            const urlPattern = /https?:\/\/([a-z0-9-]+)\.nextrequest\.com/gi;
            let urlMatch;
            const bodyToScan = `${subjectStr}\n${textStr}`;
            while ((urlMatch = urlPattern.exec(bodyToScan)) !== null) {
                const sub = urlMatch[1].toLowerCase();
                if (sub !== 'www' && sub !== 'api' && sub !== 'app' && sub !== 'messages') {
                    signals.bodySubdomain = sub;
                    break;
                }
            }
        } else if (provider === 'civicplus') {
            // Request number from subject — require keyword anchor to avoid matching bare dates
            const reqMatch = subjectStr.match(/(?:Request|Tracking|Ref|Confirmation)[:\s#]+([A-Z]{1,5}-\d{2,4}-\d+)/i)
                          || subjectStr.match(/#([A-Z0-9]+-\d+|\d{4,})/i);
            if (reqMatch) {
                signals.requestNumber = reqMatch[1];
            }

            // Agency name from display name: "City of Example CivicPlus"
            const fromFullStr = fromFull || '';
            const civicMatch = fromFullStr.match(/^["']?(.+?)(?:\s+(?:via\s+)?CivicPlus|\s*<)/i);
            if (civicMatch) {
                signals.agencyName = civicMatch[1].trim().replace(/^["']|["']$/g, '');
            }
        }

        return signals;
    }

    /**
     * Match a case using portal-specific signals with cascading priority.
     * Returns case data or null.
     */
    async matchCaseByPortalSignals(signals) {
        const activeStatuses = [
            'sent', 'awaiting_response', 'portal_in_progress', 'needs_rebuttal',
            'pending_fee_decision', 'needs_human_review', 'responded'
        ];

        // Priority 1: Subdomain match against portal_url (JustFOIA / GovQA)
        if (signals.subdomain && (signals.provider === 'justfoia' || signals.provider === 'govqa')) {
            const portalDomain = signals.provider === 'justfoia'
                ? `${signals.subdomain}.justfoia.com`
                : `${signals.subdomain}.`;  // GovQA subdomains vary: subdomain.mycusthelp.net, etc.

            const subdomainMatch = await db.query(
                `SELECT * FROM cases
                 WHERE LOWER(portal_url) LIKE $1
                   AND status = ANY($2)
                 ORDER BY
                   CASE WHEN portal_request_number = $3 THEN 0 ELSE 1 END,
                   CASE WHEN status = 'portal_in_progress' THEN 0 ELSE 1 END,
                   updated_at DESC
                 LIMIT 1`,
                [`%${portalDomain}%`, activeStatuses, signals.requestNumber || '']
            );
            if (subdomainMatch.rows.length > 0) {
                console.log(`Portal match: subdomain "${signals.subdomain}" → case #${subdomainMatch.rows[0].id}`);
                return subdomainMatch.rows[0];
            }

            // Fallback: any status
            const subdomainFallback = await db.query(
                `SELECT * FROM cases
                 WHERE LOWER(portal_url) LIKE $1
                 ORDER BY
                   CASE WHEN portal_request_number = $2 THEN 0 ELSE 1 END,
                   updated_at DESC
                 LIMIT 1`,
                [`%${portalDomain}%`, signals.requestNumber || '']
            );
            if (subdomainFallback.rows.length > 0) {
                console.log(`Portal match (any-status fallback): subdomain "${signals.subdomain}" → case #${subdomainFallback.rows[0].id}`);
                return subdomainFallback.rows[0];
            }

            // Fuzzy subdomain match: email local part and portal URL subdomain may differ
            // e.g. email "sanmarcostexas@mycusthelp.net" vs portal "sanmarcostx.mycusthelp.com"
            // Try matching portal_url containing the first 6+ chars of the subdomain
            if (signals.subdomain.length >= 6) {
                const prefix = signals.subdomain.substring(0, 6);
                const fuzzyMatch = await db.query(
                    `SELECT * FROM cases
                     WHERE LOWER(portal_url) LIKE $1
                       AND portal_provider = $2
                       AND status = ANY($3)
                     ORDER BY updated_at DESC
                     LIMIT 1`,
                    [`%${prefix}%`, signals.provider, activeStatuses]
                );
                if (fuzzyMatch.rows.length > 0) {
                    console.log(`Portal match (fuzzy subdomain "${prefix}*"): case #${fuzzyMatch.rows[0].id}`);
                    return fuzzyMatch.rows[0];
                }

                const fuzzyFallback = await db.query(
                    `SELECT * FROM cases
                     WHERE LOWER(portal_url) LIKE $1
                       AND portal_provider = $2
                     ORDER BY updated_at DESC
                     LIMIT 1`,
                    [`%${prefix}%`, signals.provider]
                );
                if (fuzzyFallback.rows.length > 0) {
                    console.log(`Portal match (fuzzy subdomain any-status "${prefix}*"): case #${fuzzyFallback.rows[0].id}`);
                    return fuzzyFallback.rows[0];
                }
            }
        }

        // Priority 2: Request number match (supports comma-separated list)
        if (signals.requestNumber) {
            const reqMatch = await db.query(
                `SELECT * FROM cases
                 WHERE (portal_request_number = $1
                        OR $1 = ANY(string_to_array(REPLACE(portal_request_number, ' ', ''), ',')))
                   AND status = ANY($2)
                 ORDER BY
                   CASE WHEN portal_request_number = $1 THEN 0 ELSE 1 END,
                   updated_at DESC
                 LIMIT 1`,
                [signals.requestNumber, activeStatuses]
            );
            if (reqMatch.rows.length > 0) {
                console.log(`Portal match: request number "${signals.requestNumber}" → case #${reqMatch.rows[0].id}`);
                return reqMatch.rows[0];
            }

            // Fallback: any status
            const reqFallback = await db.query(
                `SELECT * FROM cases
                 WHERE (portal_request_number = $1
                        OR $1 = ANY(string_to_array(REPLACE(portal_request_number, ' ', ''), ',')))
                 ORDER BY updated_at DESC
                 LIMIT 1`,
                [signals.requestNumber]
            );
            if (reqFallback.rows.length > 0) {
                console.log(`Portal match (any-status): request number "${signals.requestNumber}" → case #${reqFallback.rows[0].id}`);
                return reqFallback.rows[0];
            }
        }

        // Priority 3: Agency name match (NextRequest, CivicPlus)
        if (signals.agencyName) {
            const exactMatch = await db.query(
                `SELECT * FROM cases
                 WHERE LOWER(agency_name) = LOWER($1)
                   AND status = ANY($2)
                 ORDER BY
                   CASE WHEN status = 'portal_in_progress' THEN 0 ELSE 1 END,
                   updated_at DESC
                 LIMIT 1`,
                [signals.agencyName, activeStatuses]
            );
            if (exactMatch.rows.length > 0) {
                console.log(`Portal match: agency name "${signals.agencyName}" → case #${exactMatch.rows[0].id}`);
                return exactMatch.rows[0];
            }

            // Fuzzy: LIKE %name%
            const fuzzyMatch = await db.query(
                `SELECT * FROM cases
                 WHERE LOWER(agency_name) LIKE $1
                   AND status = ANY($2)
                 ORDER BY
                   CASE WHEN status = 'portal_in_progress' THEN 0 ELSE 1 END,
                   updated_at DESC
                 LIMIT 1`,
                [`%${signals.agencyName.toLowerCase()}%`, activeStatuses]
            );
            if (fuzzyMatch.rows.length > 0) {
                console.log(`Portal match: fuzzy agency name "${signals.agencyName}" → case #${fuzzyMatch.rows[0].id}`);
                return fuzzyMatch.rows[0];
            }

            // City-name extraction: "Shreveport, LA" → "shreveport"
            // Handles: "City, ST", "Augusta, Georgia", "Winnebago County - Sheriff, WI"
            const cityName = signals.agencyName
                .replace(/,\s*[A-Z]{2}\s*$/i, '')  // strip ", LA" / ", TX" etc
                .replace(/,\s*\w+$/i, '')  // strip ", Georgia" / ", Texas" etc (full state name)
                .replace(/\s*-\s*(Sheriff|Police|PD|SO|Clerk|Records)\b.*$/i, '')  // strip "- Sheriff" etc
                .replace(/\s+(County|City|Parish|Borough|Township)\s*$/i, '')  // strip trailing type
                .trim().toLowerCase();

            if (cityName.length >= 5) {
                // Match city name against agency_name — scoped to cases with matching portal provider
                // to prevent false positives (e.g., "salem" matching unrelated cases)
                const providerDomains = {
                    nextrequest: 'nextrequest.com',
                    justfoia: 'justfoia.com',
                    govqa: 'mycusthelp',
                    civicplus: 'civicplus'
                };
                const providerDomain = providerDomains[signals.provider] || '';

                if (providerDomain) {
                    const cityMatch = await db.query(
                        `SELECT * FROM cases
                         WHERE LOWER(agency_name) LIKE $1
                           AND LOWER(portal_url) LIKE $3
                           AND status = ANY($2)
                         ORDER BY
                           CASE WHEN status = 'portal_in_progress' THEN 0 ELSE 1 END,
                           updated_at DESC
                         LIMIT 1`,
                        [`%${cityName}%`, activeStatuses, `%${providerDomain}%`]
                    );
                    if (cityMatch.rows.length > 0) {
                        console.log(`Portal match: city name "${cityName}" + provider ${signals.provider} → case #${cityMatch.rows[0].id}`);
                        return cityMatch.rows[0];
                    }
                }

                // Match city name against portal_url for NextRequest
                if (signals.provider === 'nextrequest') {
                    const portalUrlMatch = await db.query(
                        `SELECT * FROM cases
                         WHERE LOWER(portal_url) LIKE $1
                           AND LOWER(portal_url) LIKE '%nextrequest.com%'
                           AND status = ANY($2)
                         ORDER BY
                           CASE WHEN status = 'portal_in_progress' THEN 0 ELSE 1 END,
                           updated_at DESC
                         LIMIT 1`,
                        [`%${cityName}%`, activeStatuses]
                    );
                    if (portalUrlMatch.rows.length > 0) {
                        console.log(`Portal match: city "${cityName}" in portal_url → case #${portalUrlMatch.rows[0].id}`);
                        return portalUrlMatch.rows[0];
                    }
                }
            }
        }

        // Priority 4: Body URL subdomain (NextRequest fallback)
        if (signals.bodySubdomain) {
            const bodySubMatch = await db.query(
                `SELECT * FROM cases
                 WHERE LOWER(portal_url) LIKE $1
                   AND status = ANY($2)
                 ORDER BY
                   CASE WHEN status = 'portal_in_progress' THEN 0 ELSE 1 END,
                   updated_at DESC
                 LIMIT 1`,
                [`%${signals.bodySubdomain}.nextrequest.com%`, activeStatuses]
            );
            if (bodySubMatch.rows.length > 0) {
                console.log(`Portal match: body URL subdomain "${signals.bodySubdomain}" → case #${bodySubMatch.rows[0].id}`);
                return bodySubMatch.rows[0];
            }

            // Fallback: any status
            const bodySubFallback = await db.query(
                `SELECT * FROM cases
                 WHERE LOWER(portal_url) LIKE $1
                 ORDER BY updated_at DESC
                 LIMIT 1`,
                [`%${signals.bodySubdomain}.nextrequest.com%`]
            );
            if (bodySubFallback.rows.length > 0) {
                console.log(`Portal match (any-status): body URL subdomain "${signals.bodySubdomain}" → case #${bodySubFallback.rows[0].id}`);
                return bodySubFallback.rows[0];
            }
        }

        return null;
    }

    detectPortalNotification({ fromEmail, subject = '', text = '' }) {
        const emailDomain = (fromEmail || '').split('@')[1]?.toLowerCase() || '';
        const haystack = `${subject} ${text}`.toLowerCase();

        let pendingPortalNotification = null;

        for (const provider of PORTAL_PROVIDERS) {
            const domainMatch = provider.domains.some((domain) => emailDomain.includes(domain));
            const keywordMatch = provider.keywords.some((keyword) => haystack.includes(keyword.toLowerCase()));

            if (domainMatch || keywordMatch) {
                const inferredDomain = domainMatch ? emailDomain.split('>').shift() : null;
                const portalUrl = inferredDomain
                    ? `https://${inferredDomain}${provider.defaultPath}`
                    : null;

                const instructionHints = ['submit', 'portal', 'request center', 'use the portal', 'request can be found'];
                const textHasInstructions = instructionHints.some((hint) => haystack.includes(hint));
                const requiresSubmission = keywordMatch || textHasInstructions;

                pendingPortalNotification = {
                    provider: provider.name,
                    type: requiresSubmission ? 'submission_required' : 'status_update',
                    portal_url: portalUrl
                };
                break;
            }
        }

        // Fallback: scan body for explicit portal URLs/instructions
        const combinedText = `${subject}\n${text}`;
        const urls = extractUrls(combinedText) || [];
        const portalKeywordHints = ['portal', 'public records', 'request center', 'submit', 'nextrequest', 'govqa', 'justfoia'];

        for (const rawUrl of urls) {
            const normalized = normalizePortalUrl(rawUrl);
            if (!normalized || !isSupportedPortalUrl(normalized)) {
                continue;
            }

            const lowerUrl = normalized.toLowerCase();
            const provider = detectPortalProviderByUrl(normalized);
            const hasKeyword = portalKeywordHints.some(keyword => lowerUrl.includes(keyword));

            if (!provider && !hasKeyword) {
                continue;
            }

            return {
                provider: provider?.name || 'manual_portal',
                type: 'submission_required',
                portal_url: normalized,
                instructions_excerpt: this.extractPortalInstructionSnippet(combinedText, rawUrl)
            };
        }

        return pendingPortalNotification;
    }

    detectNextRequestConfirmation({ subject = '', text = '', html = '' }) {
        const combinedText = [subject, text, html].filter(Boolean).join('\n');
        if (!combinedText) {
            return null;
        }

        const lower = combinedText.toLowerCase();
        const hasProviderCue = lower.includes('nextrequest');
        const hasConfirmationCue = lower.includes('confirm your') ||
            lower.includes('confirmation link') ||
            lower.includes('confirmation instructions') ||
            lower.includes('/confirmation');

        if (!hasProviderCue || !hasConfirmationCue) {
            return null;
        }

        const urls = extractUrls(combinedText) || [];
        for (const rawUrl of urls) {
            const normalized = normalizePortalUrl(rawUrl);
            if (!normalized) continue;
            const lowered = normalized.toLowerCase();
            if (!lowered.includes('nextrequest.com')) continue;
            if (lowered.includes('/confirmation')) {
                return {
                    portal_url: normalized,
                    instructions_excerpt: this.extractPortalInstructionSnippet(combinedText, rawUrl)
                };
            }
        }

        return null;
    }

    extractPortalInstructionSnippet(text, url) {
        if (!text || !url) return null;
        const index = text.indexOf(url);
        if (index === -1) return null;

        const start = Math.max(0, index - 120);
        const end = Math.min(text.length, index + url.length + 120);
        return text.substring(start, end).trim();
    }

    sanitizeAgencyText(text = '') {
        if (!text) return '';
        let sanitized = text.replace(/\r/g, '');
        const markers = [
            '\nFrom:',
            '\nFROM:',
            '\nOn ',
            '\nSent:',
            '\n-----Original Message-----',
            '-----Original Message-----'
        ];
        let cutIndex = sanitized.length;
        for (const marker of markers) {
            const idx = sanitized.indexOf(marker);
            if (idx !== -1 && idx < cutIndex) {
                cutIndex = idx;
            }
        }
        sanitized = sanitized.substring(0, cutIndex).trim();
        if (!sanitized) {
            sanitized = text.trim();
        }
        const filteredLines = sanitized
            .split('\n')
            .map(line => line.trimEnd())
            .filter(line => line && !line.trim().startsWith('>'));
        return filteredLines.join('\n').trim();
    }

    detectFeeQuote({ subject = '', text = '' }) {
        const cleanedText = this.sanitizeAgencyText(text);
        const haystack = `${subject}\n${cleanedText}`.toLowerCase();
        if (!/fee|cost|estimate|invoice|payment|charge/.test(haystack)) {
            return null;
        }

        const currencyRegex = /(?:usd|us\$|\$)\s?([\d,]+(?:\.\d{1,2})?)/gi;
        let match;
        let highest = 0;

        while ((match = currencyRegex.exec(subject + ' ' + cleanedText)) !== null) {
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
        let recommendedAction = 'negotiate';

        if (amount <= FEE_AUTO_APPROVE_MAX) {
            recommendedAction = 'accept';
        } else if (amount >= FEE_ESCALATE_MIN) {
            recommendedAction = 'escalate';
        }

        let updatedCase;
        const statusFields = {
            substatus: `Fee quoted: $${amount.toFixed(2)} (recommendation: ${recommendedAction})`,
            last_fee_quote_amount: amount,
            last_fee_quote_currency: feeQuote.currency,
            last_fee_quote_at: new Date()
        };

        try {
            updatedCase = await db.updateCaseStatus(caseData.id, 'needs_human_fee_approval', statusFields);
        } catch (error) {
            if (error.code === '42703' && error.message.includes('last_fee_quote')) {
                console.warn('Fee columns missing in database; storing status without fee metadata.');
                const fallbackFields = {
                    substatus: statusFields.substatus
                };
                updatedCase = await db.updateCaseStatus(caseData.id, 'needs_human_fee_approval', fallbackFields);
            } else {
                throw error;
            }
        }

        await notionService.syncStatusToNotion(caseData.id);

        await this.queueFeeResponseDraft({
            caseData: updatedCase,
            feeQuote,
            messageId,
            recommendedAction
        });

        await db.logActivity('fee_quote_detected', `Fee quote $${amount.toFixed(2)} (${recommendedAction})`, {
            case_id: caseData.id,
            message_id: messageId,
            fee_amount: amount,
            fee_currency: feeQuote.currency,
            action_recommended: recommendedAction
        });

        return updatedCase;
    }

    async queueFeeResponseDraft({ caseData, feeQuote, messageId, recommendedAction = 'negotiate', instructions = null }) {
        try {
            const draft = await aiService.generateFeeResponse(caseData, {
                feeAmount: feeQuote.amount,
                currency: feeQuote.currency,
                recommendedAction,
                instructions
            });

            const metadata = {
                fee_amount: feeQuote.amount,
                fee_currency: feeQuote.currency,
                recommended_action: recommendedAction,
                instructions: instructions,
                generated_at: new Date().toISOString()
            };

            const entry = await db.createAutoReplyQueueEntry({
                message_id: messageId,
                case_id: caseData.id,
                generated_reply: draft.reply_text,
                confidence_score: 0.9,
                requires_approval: true,
                response_type: 'fee_negotiation',
                metadata: metadata,
                last_regenerated_at: new Date()
            });

            await db.logActivity('fee_response_prepared', `Fee response draft queued (${recommendedAction})`, {
                case_id: caseData.id,
                message_id: messageId,
                auto_reply_queue_id: entry.id,
                metadata
            });

            return entry;
        } catch (error) {
            console.error('Error queueing fee response draft:', error);
            await db.logActivity('fee_response_failed', `Failed to draft fee response: ${error.message}`, {
                case_id: caseData.id,
                message_id: messageId
            });
            throw error;
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

            // Create message record — use per-case user email if available
            const resolvedFrom = await this.getFromEmail(messageData.case_id);
            const message = await db.createMessage({
                thread_id: thread.id,
                case_id: messageData.case_id,
                message_id: messageData.message_id,
                sendgrid_message_id: messageData.sendgrid_message_id,
                direction: 'outbound',
                from_email: resolvedFrom,
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

            // Generate and save a one-sentence summary (non-blocking)
            try {
                const summary = await aiService.generateMessageSummary(messageData.subject, messageData.body_text);
                if (summary) await db.query('UPDATE messages SET summary = $1 WHERE id = $2', [summary, message.id]);
            } catch (_) { /* non-critical */ }

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
     * Generic send email method for executor adapter
     *
     * Phase 4: Used by the email executor for all outbound emails.
     *
     * @param {Object} params
     * @param {string} params.to - Recipient email
     * @param {string} params.subject - Email subject
     * @param {string} params.text - Plain text body
     * @param {string} params.html - HTML body
     * @param {string} params.inReplyTo - In-Reply-To header (for threading)
     * @param {string} params.references - References header (for threading)
     * @param {number} params.caseId - Case ID for tracking (optional)
     * @param {string} params.messageType - Message type for customArgs (optional)
     * @returns {Object} { success, messageId, statusCode }
     */
    async sendEmail(params) {
        const {
            to, subject, text, html,
            inReplyTo, references,
            caseId, messageType = 'reply',
            attachments
        } = params;

        try {
            const messageId = this.generateMessageId();
            const fromEmail = await this.getFromEmail(caseId);

            const msg = {
                to,
                from: {
                    email: fromEmail,
                    name: this.fromName
                },
                replyTo: fromEmail,
                subject,
                text,
                html: html || this.formatEmailHtml(text),
                headers: {
                    'Message-ID': messageId,
                    ...(inReplyTo && { 'In-Reply-To': inReplyTo }),
                    ...(references && { 'References': references })
                },
                customArgs: {
                    ...(caseId && { case_id: caseId.toString() }),
                    message_type: messageType
                },
                ...(attachments?.length > 0 && { attachments }),
                trackingSettings: {
                    clickTracking: { enable: false },
                    openTracking: { enable: true }
                }
            };

            const response = await sgMail.send(msg);
            console.log('Email sent successfully:', response[0].statusCode);

            // Log to database if we have a case ID
            if (caseId) {
                await this.logSentMessage({
                    case_id: caseId,
                    message_id: messageId,
                    sendgrid_message_id: response[0].headers['x-message-id'],
                    to_email: to,
                    subject,
                    body_text: text,
                    body_html: html || this.formatEmailHtml(text),
                    message_type: messageType,
                    thread_id: inReplyTo
                });
            }

            return {
                success: true,
                messageId,
                sendgridMessageId: response[0].headers['x-message-id'],
                statusCode: response[0].statusCode
            };
        } catch (error) {
            console.error('Error sending email:', error);
            if (caseId) {
                await db.logActivity('email_send_failed', `Failed to send email for case ${caseId}`, {
                    case_id: caseId,
                    error: error.message
                });
            }
            throw error;
        }
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
