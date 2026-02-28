const express = require('express');
const router = express.Router();
const multer = require('multer');
const axios = require('axios');
const sendgridService = require('../services/sendgrid-service');
const db = require('../services/database');
const { analysisQueue, portalQueue } = require('../queues/email-queue');
const { notify } = require('../services/event-bus');
const { transitionCaseRuntime } = require('../services/case-runtime');

// In-memory guard: track page IDs currently being imported to prevent concurrent duplicates
const _importingPages = new Set();

/**
 * Detect verification code emails and forward to Skyvern TOTP API
 * No Zapier needed - we handle it directly in our inbound email webhook
 */
async function detectAndForwardTOTP({ from, to, subject, text, html }) {
    try {
        // Check if this looks like a verification email
        const subjectLower = (subject || '').toLowerCase();
        const textLower = (text || '').toLowerCase();
        const htmlLower = (html || '').toLowerCase();

        const verificationKeywords = [
            'verification code',
            'verify your email',
            'confirmation code',
            'your code is',
            'enter this code',
            'authentication code',
            '2fa',
            'two-factor',
            'one-time password',
            'otp'
        ];

        const isVerification = verificationKeywords.some(keyword =>
            subjectLower.includes(keyword) ||
            textLower.includes(keyword) ||
            htmlLower.includes(keyword)
        );

        if (!isVerification) {
            return false; // Not a verification email
        }

        console.log(`🔐 Detected verification email from ${from}`);
        console.log(`   Subject: ${subject}`);

        // Forward to Skyvern TOTP API
        const skyvernApiKey = process.env.SKYVERN_API_KEY;
        if (!skyvernApiKey) {
            console.warn('⚠️  SKYVERN_API_KEY not set - skipping TOTP forward');
            return true;
        }

        await axios.post(
            'https://api.skyvern.com/api/v1/totp',
            {
                totp_identifier: to, // The email address that received the code
                content: text || html || '', // Email body content
                source: 'email'
            },
            {
                headers: {
                    'x-api-key': skyvernApiKey,
                    'Content-Type': 'application/json'
                },
                timeout: 5000 // Don't block email processing if Skyvern is slow
            }
        );

        console.log('✅ Forwarded verification code to Skyvern TOTP API');
        return true;

    } catch (error) {
        console.error('❌ Failed to forward TOTP to Skyvern:', error.message);
        // Don't fail the email processing if TOTP forward fails
        return false;
    }
}

// Configure multer to handle SendGrid's multipart/form-data
const upload = multer({
    storage: multer.memoryStorage(),
    limits: {
        fileSize: parseInt(process.env.INBOUND_ATTACHMENT_MAX_BYTES || `${10 * 1024 * 1024}`, 10)
    }
});

/**
 * SendGrid Inbound Parse Webhook
 * Receives emails sent to your domain
 * SendGrid sends multipart/form-data
 */
router.post('/inbound', upload.any(), async (req, res) => {
    try {
        // Signature verification (graceful degradation)
        // SendGrid Inbound Parse uses different auth than Event Webhook,
        // but if signature headers are present, verify them.
        const sigHeader = req.headers['x-twilio-email-event-webhook-signature'];
        const tsHeader = req.headers['x-twilio-email-event-webhook-timestamp'];
        if (sigHeader && tsHeader && process.env.SENDGRID_WEBHOOK_SECRET) {
            try {
                const rawBody = JSON.stringify(req.body);
                const isValid = sendgridService.verifyWebhookSignature(rawBody, sigHeader, tsHeader);
                if (!isValid) {
                    console.error('Inbound webhook signature verification failed');
                    return res.status(403).json({ error: 'Invalid webhook signature' });
                }
            } catch (sigErr) {
                console.warn('Webhook signature verification error (allowing through):', sigErr.message);
            }
        } else if (process.env.SENDGRID_WEBHOOK_SECRET && !sigHeader) {
            console.warn('SENDGRID_WEBHOOK_SECRET is set but no signature headers on inbound webhook');
        }

        console.log('Received inbound email webhook from SendGrid');

        // Log webhook hit immediately for debugging
        await db.logActivity('webhook_received', `Inbound webhook hit from ${req.body.from || req.body.sender || 'unknown'}`, {
            from: req.body.from || req.body.sender,
            to: req.body.to || req.body.recipient,
            subject: req.body.subject,
            ip: req.ip,
            user_agent: req.headers['user-agent']
        }).catch(e => console.error('Failed to log webhook hit:', e));
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
        const inboundAttachments = (req.files || []).map((file) => ({
            filename: file.originalname,
            mimetype: file.mimetype,
            buffer: file.buffer,
            size: file.size,
            encoding: file.encoding
        }));

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

        // TOTP: Check if this is a verification code email and forward to Skyvern
        const isVerificationEmail = await detectAndForwardTOTP({
            from: inboundData.from || inboundData.sender,
            to: inboundData.to || inboundData.recipient,
            subject: inboundData.subject,
            text: emailText || inboundData.text || inboundData.body_text,
            html: emailHtml || inboundData.html || inboundData.body_html
        });

        if (isVerificationEmail) {
            console.log('✅ Verification email detected and forwarded to Skyvern TOTP API');
        }

        // Process the inbound email
        const result = await sendgridService.processInboundEmail({
            from: inboundData.from || inboundData.sender,
            to: inboundData.to || inboundData.recipient,
            subject: inboundData.subject,
            text: emailText || inboundData.text || inboundData.body_text,
            html: emailHtml || inboundData.html || inboundData.body_html,
            headers: inboundData.headers || {},
            attachments: inboundAttachments
        });

        if (result.matched) {
            console.log(`Inbound email matched to case ${result.case_id}`);
            notify('info', `New inbound email matched to case ${result.case_id}`, { case_id: result.case_id });
            const alreadyProcessed = result.already_processed === true;

            // Check if this is a test mode email (instant reply)
            const isTestMode = inboundData.subject?.includes('[TEST]') ||
                              inboundData.headers?.['X-Test-Mode'] === 'true';

            if (alreadyProcessed) {
                console.log(`Duplicate inbound detected for case ${result.case_id}; skipping analysis queue.`);
            } else {
                // Queue for AI analysis (with null guard and deterministic job ID)
                if (!analysisQueue) {
                    console.error('analysisQueue is null — cannot queue analysis');
                    return res.status(503).json({ success: false, error: 'Analysis queue unavailable' });
                }
                await analysisQueue.add('analyze-response', {
                    messageId: result.message_id,
                    caseId: result.case_id,
                    instantReply: isTestMode
                }, {
                    jobId: `analyze-${result.message_id}`,
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
                // Don't re-queue portal jobs if the case was already submitted
                const portalCase = await db.getCaseById(result.case_id);
                const caseAlreadySubmitted = portalCase && ['sent', 'portal_in_progress', 'awaiting_response', 'responded', 'completed'].includes(portalCase.status);

                if (caseAlreadySubmitted) {
                    console.log(`🌐 Portal notification for case ${result.case_id} but already '${portalCase.status}' — skipping portal queue`);
                } else {
                const portalJobData = {
                    caseId: result.case_id,
                    portalUrl: result.portal_notification.portal_url,
                    provider: result.portal_notification.provider,
                    messageId: result.message_id,
                    notificationType: result.portal_notification.type,
                    instructions: result.portal_notification.instructions_excerpt || null
                };

                if (!portalJobData.portalUrl) {
                    console.warn(`🌐 Portal notification detected but no portal URL stored for case ${result.case_id}`);
                } else if (!portalQueue) {
                    console.warn(`🌐 Portal notification for case ${result.case_id} but portalQueue is null — skipping`);
                } else if (result.portal_notification.type === 'confirmation_link') {
                    await portalQueue.add('portal-submit', portalJobData, {
                        jobId: `${result.case_id}:portal-submit:${result.message_id}`,
                        attempts: 1
                    });
                    console.log(`🔁 Portal submission re-queued for case ${result.case_id} using confirmation link`);
                } else {
                    await portalQueue.add('portal-refresh', portalJobData, {
                        jobId: `${result.case_id}:portal-refresh:${result.message_id}`,
                        attempts: 3,
                        backoff: {
                            type: 'exponential',
                            delay: 60000
                        }
                    });

                    console.log(`🌐 Portal refresh queued for case ${result.case_id} (${portalJobData.provider})`);

                    if (result.portal_notification.type === 'submission_required') {
                        await portalQueue.add('portal-submit', portalJobData, {
                            jobId: `${result.case_id}:portal-submit:${result.message_id}`,
                            attempts: 1
                        });
                        console.log(`🚀 Portal submission queued for case ${result.case_id} (${portalJobData.provider})`);
                    }
                }
                } // end caseAlreadySubmitted else
            }

            res.status(200).json({
                success: true,
                message: 'Email received and queued for processing',
                case_id: result.case_id,
                test_mode: isTestMode
            });
        } else {
            console.warn('Inbound email could not be matched to a case');
            notify('warning', `Unmatched inbound email from ${inboundData.from || 'unknown'}`);

            // Save unmatched email to database for debugging
            try {
                const fromRaw = inboundData.from || inboundData.sender || 'unknown';
                const toRaw = inboundData.to || inboundData.recipient || 'unknown';
                const subjectRaw = inboundData.subject || '(no subject)';
                const textRaw = emailText || inboundData.text || inboundData.body_text || '';
                const htmlRaw = emailHtml || inboundData.html || inboundData.body_html || '';

                const unmatchedMsg = await db.query(`
                    INSERT INTO messages (direction, from_email, to_email, subject, body_text, body_html, received_at, created_at)
                    VALUES ('inbound', $1, $2, $3, $4, $5, NOW(), NOW())
                    RETURNING id
                `, [fromRaw, toRaw, subjectRaw, textRaw, htmlRaw]);

                const savedMsgId = unmatchedMsg.rows[0]?.id;

                // Retry: try portal signal matching on the saved message
                // processInboundEmail uses thread headers which aren't available here,
                // but portal signals (subdomain, request number, agency name) may still match
                try {
                    const fromEmail = sendgridService.extractEmail(fromRaw);
                    const portalInfo = sendgridService.detectPortalProviderFromEmail(fromEmail);

                    if (portalInfo) {
                        const signals = sendgridService.extractPortalMatchingSignals(
                            portalInfo.provider, fromRaw, fromEmail, subjectRaw, textRaw
                        );
                        const matchedCase = await sendgridService.matchCaseByPortalSignals(signals);

                        if (matchedCase) {
                            // Find thread for this case
                            let threadId = null;
                            const threadResult = await db.query(
                                'SELECT id FROM email_threads WHERE case_id = $1 ORDER BY created_at DESC LIMIT 1',
                                [matchedCase.id]
                            );
                            if (threadResult.rows.length > 0) {
                                threadId = threadResult.rows[0].id;
                            }

                            await db.query(
                                'UPDATE messages SET case_id = $1, thread_id = $2 WHERE id = $3',
                                [matchedCase.id, threadId, savedMsgId]
                            );
                            console.log(`Portal retry matched MSG #${savedMsgId} -> Case #${matchedCase.id} (thread ${threadId || 'NULL'})`);

                            // Queue for AI analysis since we found a match
                            if (analysisQueue) {
                                await analysisQueue.add('analyze-response', {
                                    messageId: savedMsgId,
                                    caseId: matchedCase.id,
                                    instantReply: false
                                }, {
                                    jobId: `analyze-${savedMsgId}`,
                                    delay: 2000,
                                    attempts: 3,
                                    backoff: { type: 'exponential', delay: 3000 }
                                });
                            } else {
                                console.warn('analysisQueue is null — skipping portal-retry analysis');
                            }

                            await db.logActivity('webhook_portal_retry_matched',
                                `Portal retry matched MSG #${savedMsgId} to case #${matchedCase.id} via portal signals`,
                                { message_id: savedMsgId, case_id: matchedCase.id, from: fromRaw, subject: subjectRaw }
                            );
                        } else {
                            console.log(`Portal retry: no match for MSG #${savedMsgId} (${portalInfo.provider})`);
                            await db.logActivity('webhook_unmatched', `Unmatched portal email from ${fromRaw}`, {
                                message_id: savedMsgId, from: fromRaw, to: toRaw, subject: subjectRaw, provider: portalInfo.provider
                            });
                        }
                    } else {
                        // Not a portal email, log as unmatched
                        await db.logActivity('webhook_unmatched', `Unmatched inbound from ${fromRaw}`, {
                            message_id: savedMsgId, from: fromRaw, to: toRaw, subject: subjectRaw
                        });
                    }
                } catch (retryErr) {
                    console.error('Portal retry matching failed:', retryErr.message);
                    await db.logActivity('webhook_unmatched', `Unmatched inbound from ${fromRaw} (portal retry failed)`, {
                        message_id: savedMsgId, from: fromRaw, to: toRaw, subject: subjectRaw
                    });
                }

                console.log(`Saved unmatched email with ID: ${savedMsgId}`);
            } catch (saveErr) {
                console.error('Failed to save unmatched email:', saveErr);
            }

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
                case 'dropped': {
                    console.error(`Email ${event.event}: ${event.sg_message_id}`, event.reason);
                    try {
                        const msgResult = await db.query(
                            'SELECT id, case_id FROM messages WHERE sendgrid_message_id = $1 LIMIT 1',
                            [event.sg_message_id]
                        );
                        const msg = msgResult.rows[0];

                        await db.logActivity(
                            event.event === 'bounce' ? 'email_bounced' : 'email_dropped',
                            `Email delivery failed: ${event.reason || 'Unknown reason'}`,
                            {
                                case_id: msg?.case_id || null,
                                message_id: msg?.id || null,
                                sendgrid_message_id: event.sg_message_id,
                                bounce_type: event.type,
                                reason: event.reason,
                                status_code: event.status
                            }
                        );

                        if (msg?.case_id) {
                            await transitionCaseRuntime(msg.case_id, 'CASE_ESCALATED', {
                                substatus: `Email ${event.event}: ${event.reason || 'delivery failed'}`,
                                pauseReason: 'EMAIL_FAILED',
                            });
                        }
                    } catch (err) {
                        console.error('Failed to process bounce/drop event:', err.message);
                    }
                    break;
                }
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
 * Extract a Notion page ID (32 hex chars) from a webhook payload.
 * Tries every plausible location since Notion's automation webhook format isn't well-documented.
 */
function extractNotionPageId(body) {
    if (!body || typeof body !== 'object') return null;

    const UUID_RE = /[a-f0-9]{8}-?[a-f0-9]{4}-?[a-f0-9]{4}-?[a-f0-9]{4}-?[a-f0-9]{12}/i;

    // 1. Direct top-level fields
    for (const key of ['id', 'page_id', 'pageId', 'page']) {
        const val = body[key];
        if (typeof val === 'string' && val.replace(/-/g, '').length >= 30) {
            return val.replace(/-/g, '');
        }
    }

    // 2. Nested under data (developer API webhook format)
    if (body.data && typeof body.data === 'object') {
        for (const key of ['id', 'page_id', 'pageId']) {
            const val = body.data[key];
            if (typeof val === 'string' && val.replace(/-/g, '').length >= 30) {
                return val.replace(/-/g, '');
            }
        }
    }

    // 3. entity.id (developer API webhook format: { entity: { id, type } })
    if (body.entity?.id) {
        const val = body.entity.id;
        if (typeof val === 'string' && val.replace(/-/g, '').length >= 30) {
            return val.replace(/-/g, '');
        }
    }

    // 4. Look for a URL field that contains a Notion page URL
    for (const key of ['url', 'page_url', 'URL', 'notion_url']) {
        const val = body[key] || body.data?.[key];
        if (typeof val === 'string' && val.includes('notion.so')) {
            const match = val.match(/([a-f0-9]{32})$/i) || val.match(UUID_RE);
            if (match) return match[0].replace(/-/g, '');
        }
    }

    // 5. Deep scan: look for any UUID-shaped value in top-level or one-level-deep fields
    const candidates = [];
    for (const [key, val] of Object.entries(body)) {
        if (typeof val === 'string') {
            const match = val.match(UUID_RE);
            if (match) candidates.push({ key, id: match[0].replace(/-/g, '') });
        }
        if (val && typeof val === 'object' && !Array.isArray(val)) {
            for (const [subKey, subVal] of Object.entries(val)) {
                if (typeof subVal === 'string') {
                    const match = subVal.match(UUID_RE);
                    if (match) candidates.push({ key: `${key}.${subKey}`, id: match[0].replace(/-/g, '') });
                }
            }
        }
    }

    // Prefer candidates from fields that look like IDs
    const idCandidate = candidates.find(c => /id|page/i.test(c.key));
    if (idCandidate) return idCandidate.id;
    if (candidates.length > 0) return candidates[0].id;

    return null;
}

/**
 * Notion Database Automation Webhook
 *
 * Receives a POST from Notion when a case's status changes to "Ready To Send".
 * Syncs the case into our DB and dispatches it through the Run Engine immediately.
 *
 * Setup in Notion:
 *   Database automation → When Status changes to "Ready To Send" → Send webhook
 *   URL: https://<domain>/webhooks/notion
 *   Include properties: (any — we extract page_id from the payload)
 */
router.post('/notion', express.json(), async (req, res) => {
    try {
        // Log the FULL raw payload so we can see Notion's exact format
        const rawPayload = JSON.stringify(req.body);
        console.log(`[notion-webhook] === RAW PAYLOAD ===`);
        console.log(`[notion-webhook] ${rawPayload.substring(0, 3000)}`);
        console.log(`[notion-webhook] === END PAYLOAD ===`);

        // Extract page ID — try every plausible location since Notion's format isn't documented
        const strippedId = extractNotionPageId(req.body);

        if (!strippedId) {
            console.warn('[notion-webhook] Could not extract page_id from payload');
            // Log to activity so we can inspect in the dashboard
            await db.logActivity('notion_webhook_unknown_format', 'Webhook received but could not parse page_id', {
                payload_preview: rawPayload.substring(0, 2000),
                ip: req.ip
            });
            return res.status(200).json({ success: false, reason: 'no_page_id', payload_keys: Object.keys(req.body || {}) });
        }

        // Format as UUID with hyphens (how our DB stores notion_page_id)
        const pageId = strippedId.length === 32
            ? `${strippedId.slice(0,8)}-${strippedId.slice(8,12)}-${strippedId.slice(12,16)}-${strippedId.slice(16,20)}-${strippedId.slice(20)}`
            : strippedId;

        console.log(`[notion-webhook] Extracted page ID: ${pageId}`);

        await db.logActivity('notion_webhook_received', `Notion webhook for page ${pageId}`, {
            page_id: pageId,
            ip: req.ip
        });

        // Look up case by Notion page ID (try both hyphenated and stripped formats)
        let existing = await db.getCaseByNotionId(pageId);
        if (!existing) existing = await db.getCaseByNotionId(strippedId);

        const notionService = require('../services/notion-service');

        if (!existing) {
            // Concurrent import guard — skip if already importing this page
            if (_importingPages.has(pageId)) {
                console.log(`[notion-webhook] Import already in progress for ${pageId}, skipping`);
                return res.status(200).json({ success: true, action: 'import_already_in_progress', page_id: pageId });
            }

            // Fire-and-forget: respond immediately, import in background
            _importingPages.add(pageId);
            notionService.processSinglePage(strippedId)
                .then(newCase => {
                    if (newCase && newCase.id) {
                        console.log(`[notion-webhook] Imported case ${newCase.id} from page ${pageId}`);
                        notify('info', `Notion webhook: imported case ${newCase.id}`, { case_id: newCase.id, page_id: pageId });
                    } else {
                        console.warn(`[notion-webhook] processSinglePage returned empty for page ${pageId}`);
                        db.logActivity('notion_webhook_import_failed', `Webhook import returned no case for page ${pageId}`, {
                            page_id: pageId, stripped_page_id: strippedId, reason: 'processSinglePage_returned_empty'
                        }).catch(() => {});
                    }
                })
                .catch(importErr => {
                    console.error(`[notion-webhook] Import failed for ${pageId}:`, importErr.message);
                    db.logActivity('notion_webhook_import_failed', `Import failed: ${importErr.message}`, {
                        page_id: pageId, stripped_page_id: strippedId, error: importErr.message
                    }).catch(() => {});
                })
                .finally(() => {
                    _importingPages.delete(pageId);
                });

            return res.status(200).json({ success: true, action: 'import_queued', page_id: pageId
            });
        }

        // Re-sync existing case from Notion to pick up latest property changes
        try {
            const freshData = await notionService.fetchPageById(strippedId);
            if (freshData) {
                await db.updateCase(existing.id, {
                    agency_name: freshData.agency_name || existing.agency_name,
                    agency_email: freshData.agency_email || existing.agency_email,
                    status: freshData.status === 'ready_to_send' ? 'ready_to_send' : existing.status
                });
                // Refresh from DB after update
                existing = await db.getCaseById(existing.id);
            }
        } catch (syncErr) {
            console.warn(`[notion-webhook] Re-sync failed for case ${existing.id}:`, syncErr.message);
        }

        // If case is ready_to_send, dispatch through Run Engine
        if (existing.status === 'ready_to_send') {
            const { dispatchReadyToSend } = require('../services/dispatch-helper');
            try {
                const result = await dispatchReadyToSend(existing.id, { source: 'notion_webhook' });
                console.log(`[notion-webhook] Case ${existing.id}: ${result.dispatched ? `dispatched run ${result.runId}` : `skipped (${result.reason})`}`);
                notify('info', `Notion webhook: case ${existing.id} dispatched`, { case_id: existing.id, page_id: pageId });
                return res.status(200).json({ success: true, case_id: existing.id, ...result });
            } catch (dispatchErr) {
                console.error(`[notion-webhook] Dispatch failed for case ${existing.id}:`, dispatchErr.message);
                return res.status(200).json({ success: false, case_id: existing.id, error: dispatchErr.message });
            }
        }

        console.log(`[notion-webhook] Case ${existing.id} is '${existing.status}', not ready_to_send`);
        res.status(200).json({ success: true, case_id: existing.id, status: existing.status, action: 'no_dispatch' });
    } catch (error) {
        console.error('[notion-webhook] Error:', error);
        // Always return 200 to Notion so it doesn't retry endlessly
        res.status(200).json({ success: false, error: error.message });
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
