const { Queue, Worker } = require('bullmq');
const sendgridService = require('../services/sendgrid-service');
const aiService = require('../services/ai-service');
const db = require('../services/database');
const notionService = require('../services/notion-service');
const discordService = require('../services/discord-service');
const foiaCaseAgent = require('../services/foia-case-agent');
const portalAgentSkyvern = require('../services/portal-agent-service-skyvern');
const caseLockService = require('../services/case-lock-service');
const logger = require('../services/logger');
const {
    getRedisConnection,
    getJobOptions,
    generateEmailJobId,
    moveToDeadLetterQueue
} = require('./queue-config');
const { normalizePortalUrl, isSupportedPortalUrl } = require('../utils/portal-utils');
const { isValidEmail } = require('../utils/contact-utils');

// LangGraph agent queue (lazy loaded to avoid circular deps)
let agentQueueModule = null;
function getAgentQueueModule() {
    if (!agentQueueModule) {
        agentQueueModule = require('./agent-queue');
    }
    return agentQueueModule;
}

// Feature flag for LangGraph migration - HARDCODED TO TRUE
const USE_LANGGRAPH = true;

const FEE_AUTO_APPROVE_MAX = parseFloat(process.env.FEE_AUTO_APPROVE_MAX || '100');

const FORCE_INSTANT_EMAILS = (() => {
    if (process.env.FORCE_INSTANT_EMAILS === 'true') return true;
    if (process.env.FORCE_INSTANT_EMAILS === 'false') return false;
    if (process.env.TESTING_MODE === 'true') return true;
    return true;
})();

// Get shared Redis connection
const connection = getRedisConnection();

// Get standardized job options for each queue type
const emailJobOptions = getJobOptions('email');
const analysisJobOptions = getJobOptions('analysis');
const generationJobOptions = getJobOptions('generation');
const portalJobOptions = getJobOptions('portal');

// Create queues with standardized options
const emailQueue = new Queue('email-queue', {
    connection,
    defaultJobOptions: emailJobOptions
});
const analysisQueue = new Queue('analysis-queue', {
    connection,
    defaultJobOptions: analysisJobOptions
});
const generateQueue = new Queue('generate-queue', {
    connection,
    defaultJobOptions: generationJobOptions
});
const portalQueue = new Queue('portal-queue', {
    connection,
    defaultJobOptions: portalJobOptions
});

/**
 * Generate human-like delay for auto-replies (2-10 hours)
 * Avoids immediate responses that look automated
 * Set AUTO_REPLY_DELAY_MINUTES env var to override (use 0 for immediate testing)
 */
function getHumanLikeDelay() {
    if (FORCE_INSTANT_EMAILS) {
        console.log('FORCE_INSTANT_EMAILS enabled, skipping human-like delay');
        return 0;
    }

    // Check for testing override
    if (process.env.AUTO_REPLY_DELAY_MINUTES !== undefined) {
        const minutes = parseInt(process.env.AUTO_REPLY_DELAY_MINUTES);
        console.log(`Using override delay: ${minutes} minutes`);
        return minutes * 60 * 1000;
    }

    const now = new Date();
    const hour = now.getHours();

    // During business hours (9am-5pm), reply faster (2-4 hours)
    if (hour >= 9 && hour < 17) {
        return (2 + Math.random() * 2) * 60 * 60 * 1000; // 2-4 hours
    }

    // Outside business hours, wait until next business day morning
    const tomorrow = new Date(now);
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setHours(9 + Math.random() * 2, Math.random() * 60, 0, 0); // 9-11am

    return tomorrow.getTime() - now.getTime();
}

function pickBestEmail(caseData) {
    const candidates = [];

    if (caseData.agency_email && isValidEmail(caseData.agency_email)) {
        candidates.push(caseData.agency_email.trim());
    }

    if (caseData.alternate_agency_email && isValidEmail(caseData.alternate_agency_email)) {
        candidates.push(caseData.alternate_agency_email.trim());
    }

    const testingMode = process.env.TESTING_MODE === 'true';
    const defaultEmail = process.env.DEFAULT_TEST_EMAIL;
    if (testingMode && defaultEmail && isValidEmail(defaultEmail)) {
        candidates.push(defaultEmail.trim());
    }

    return candidates[0] || null;
}

// Delays removed for initial requests - send immediately
// Auto-replies use human-like delays

// ===== EMAIL QUEUE WORKER =====
const emailWorker = new Worker('email-queue', async (job) => {
    console.log(`Processing email job: ${job.id}`, job.data);

    const { type, caseId, toEmail, subject, content, originalMessageId, instantReply } = job.data;

    try {
        let result;

        switch (type) {
            case 'initial_request':
                result = await sendgridService.sendFOIARequest(caseId, content, subject, toEmail, instantReply || false);

                // Update case status
                await db.updateCaseStatus(caseId, 'sent', {
                    send_date: new Date()
                });

                // Update Notion
                await notionService.syncStatusToNotion(caseId);

                // Notify Discord
                const caseData = await db.getCaseById(caseId);
                await discordService.notifyRequestSent(caseData, 'email');

                // Schedule follow-up
                const thread = await db.getThreadByCaseId(caseId);

                if (thread) {
                    await db.createFollowUpSchedule({
                        case_id: caseId,
                        thread_id: thread.id,
                        next_followup_date: caseData.deadline_date,
                        followup_count: 0
                    });
                }

                await db.logActivity('email_sent', `Sent initial FOIA request for case ${caseId}`, {
                    case_id: caseId
                });
                break;

            case 'follow_up':
                result = await sendgridService.sendFollowUp(
                    caseId,
                    content,
                    subject,
                    toEmail,
                    originalMessageId
                );

                await db.logActivity('followup_sent', `Sent follow-up for case ${caseId}`, {
                    case_id: caseId
                });
                break;

            case 'auto_reply':
                result = await sendgridService.sendAutoReply(
                    caseId,
                    content,
                    subject,
                    toEmail,
                    originalMessageId
                );

                await db.logActivity('auto_reply_sent', `Sent auto-reply for case ${caseId}`, {
                    case_id: caseId
                });

                // Notify Discord
                const caseDataAutoReply = await db.getCaseById(caseId);
                await discordService.notifyAutoReplySent(caseDataAutoReply, 'Standard');
                break;

            default:
                throw new Error(`Unknown email type: ${type}`);
        }

        // Update proposal status if we have a proposalId
        if (job.data.proposalId) {
            await db.markProposalExecuted(job.data.proposalId, job.id);
        }

        return result;
    } catch (error) {
        const log = logger.forWorker('email-queue', job.id);
        log.error(`Email job failed (attempt ${job.attemptsMade}/${emailJobOptions.attempts})`, {
            error: error.message,
            caseId
        });

        // If this is the final attempt, it will be moved to DLQ by the failed handler
        throw error;
    }
}, { connection });

// Handle email worker failures - move to DLQ after max attempts
emailWorker.on('failed', async (job, error) => {
    if (job.attemptsMade >= emailJobOptions.attempts) {
        await moveToDeadLetterQueue('email-queue', job, error);
    }
});

// ===== ANALYSIS QUEUE WORKER =====
const analysisWorker = new Worker('analysis-queue', async (job) => {
    console.log(`🔍 Processing analysis job: ${job.id}`);
    console.log(`   Message ID: ${job.data.messageId}, Case ID: ${job.data.caseId}`);

    const { messageId, caseId } = job.data;

    try {
        const messageData = await db.getMessageById(messageId);
        const caseData = await db.getCaseById(caseId);

        if (!messageData || !caseData) {
            console.error(`❌ Message or case not found - Message: ${!!messageData}, Case: ${!!caseData}`);
            throw new Error('Message or case not found');
        }

        console.log(`📧 Analyzing message from: ${messageData.from_email}`);
        console.log(`   Subject: ${messageData.subject}`);

        // Analyze the response
        const analysis = await aiService.analyzeResponse(messageData, caseData);

        console.log(`📊 Analysis complete:`);
        console.log(`   Intent: ${analysis.intent}`);
        console.log(`   Requires action: ${analysis.requires_action}`);
        console.log(`   Sentiment: ${analysis.sentiment}`);

        // Update Notion with summary
        if (analysis.summary) {
            await notionService.addAISummaryToNotion(caseId, analysis.summary);
            console.log(`✅ Updated Notion with summary`);
        }

        // Notify Discord about response received
        await discordService.notifyResponseReceived(caseData, analysis);

        const portalInstruction = messageData.portal_notification &&
            messageData.portal_notification_type === 'submission_required';

        if (portalInstruction) {
            console.log(`🌐 Portal instruction detected for case ${caseId}; pivoting to portal workflow (no email reply).`);
            const portalStatusNote = 'Agency requested portal submission';
            await db.updateCaseStatus(caseId, 'needs_human_review', {
                substatus: 'portal_submission_required',
                substatus: portalStatusNote,
                last_portal_status: portalStatusNote,
                last_portal_status_at: new Date()
            });
            await db.logActivity('portal_instruction_received', portalStatusNote, {
                case_id: caseId,
                message_id: messageId,
                portal_url: caseData.portal_url
            });
            await notionService.syncStatusToNotion(caseId);
            return analysis;
        }

        // ===== HYBRID AGENT APPROACH =====
        // Use agent for complex cases, deterministic flow for simple ones
        const useAgent = true; // Agent always enabled for complex cases

        const feeAmount = parseFloat(analysis.extracted_fee_amount || '0') || 0;
        const needsFeeNegotiation = (
            analysis.intent === 'fee_request' &&
            feeAmount > FEE_AUTO_APPROVE_MAX
        );

        // Determine if this is a complex case that should use the agent
        const isComplexCase = (
            analysis.intent === 'denial' ||
            analysis.intent === 'more_info_needed' ||
            needsFeeNegotiation ||
            (caseData.previous_attempts && caseData.previous_attempts >= 2) ||
            analysis.sentiment === 'hostile'
        );

        console.log(`\n🤖 Agent Status:`);
        console.log(`   Complex case: ${isComplexCase}`);
        console.log(`   Reason: ${analysis.intent}${feeAmount ? ` ($${feeAmount})` : ''}`);
        console.log(`   LangGraph enabled: ${USE_LANGGRAPH}`);

        // If this is a complex case, let the agent handle it
        if (isComplexCase) {
            const agentLog = logger.forAgent(caseId, 'agency_reply');

            // === LANGGRAPH PATH ===
            if (USE_LANGGRAPH) {
                agentLog.info('Queuing to LangGraph agent for complex case handling');

                try {
                    const { enqueueAgentJob } = getAgentQueueModule();
                    const agentJob = await enqueueAgentJob(caseId, 'INBOUND_MESSAGE', {
                        messageId: messageId,
                        analysisJobId: job.id
                    });

                    agentLog.info(`LangGraph agent job queued: ${agentJob.id}`);

                    // Mark case as being handled by agent
                    await db.query(
                        'UPDATE cases SET agent_handled = true WHERE id = $1',
                        [caseId]
                    );

                    // Don't run deterministic flow - LangGraph will handle everything
                    return analysis;
                } catch (agentError) {
                    agentLog.error(`Failed to queue LangGraph agent: ${agentError.message}`);
                    // Fall through to legacy agent or deterministic flow
                }
            }

            // === LEGACY AGENT PATH ===
            agentLog.info('Delegating to legacy FOIA Agent for complex case handling');

            // Use case lock to ensure only one agent runs at a time (Deliverable 2)
            const lockResult = await caseLockService.withCaseLock(
                caseId,
                'agency_reply',
                async (runId) => {
                    agentLog.info(`Agent run ${runId} acquired lock`);

                    const agentResult = await foiaCaseAgent.handleCase(caseId, {
                        type: 'agency_reply',
                        messageId: messageId,
                        runId: runId
                    });

                    agentLog.info(`Agent run ${runId} completed`, {
                        iterations: agentResult.iterations
                    });

                    // Mark case as handled by agent
                    await db.query(
                        'UPDATE cases SET agent_handled = true WHERE id = $1',
                        [caseId]
                    );

                    return agentResult;
                },
                { messageId, jobId: job.id }
            );

            if (lockResult.skipped) {
                agentLog.warn('Agent run skipped - case locked by another process');
                logger.agentRunEvent('skipped', {
                    case_id: caseId,
                    id: lockResult.runId,
                    trigger_type: 'agency_reply',
                    status: 'skipped_locked'
                });
                // Continue with deterministic flow as a fallback
            } else if (!lockResult.success) {
                agentLog.error(`Agent failed: ${lockResult.error}`);
                // Continue with deterministic flow below as fallback
            } else {
                agentLog.info('Agent completed, now running auto-reply logic');
            }
        } else {
            console.log(`ℹ️  Simple case (${analysis.intent}), using deterministic flow`);
        }

        // ===== DETERMINISTIC FLOW (Original Logic) =====
        // NEVER auto-reply if there's a portal_url - portal submission only
        if (caseData.portal_url) {
            console.log(`🚫 BLOCKED: Case ${caseId} has portal_url - NO AUTO-REPLY will be sent`);
            console.log(`🌐 Portal URL: ${caseData.portal_url}`);
            return analysis;
        }

        // Check if we should auto-reply (enabled by default)
        const autoReplyEnabled = process.env.ENABLE_AUTO_REPLY === 'true';
        const caseNeedsHuman = caseData.status?.startsWith('needs_human');
        console.log(`⚙️ Auto-reply enabled: ${autoReplyEnabled}`);

        if (analysis.requires_action && autoReplyEnabled && !caseNeedsHuman) {
            console.log(`🤖 Generating auto-reply...`);
            const autoReply = await aiService.generateAutoReply(messageData, analysis, caseData);

            console.log(`📝 Auto-reply generation result:`);
            console.log(`   Should auto-reply: ${autoReply.should_auto_reply}`);
            console.log(`   Confidence: ${autoReply.confidence}`);
            console.log(`   Requires approval: ${autoReply.requires_approval || false}`);

            if (autoReply.should_auto_reply) {
                // Check if this is a test mode case (instant reply)
                const isTestMode = messageData.sendgrid_message_id?.includes('test-') ||
                                  job.data.instantReply === true;

                // Add natural delay (2-10 hours) to seem human, or instant for test mode
                const instantAutoReply = FORCE_INSTANT_EMAILS || isTestMode;
                const naturalDelay = instantAutoReply ? 0 : getHumanLikeDelay();

                await emailQueue.add('send-auto-reply', {
                    type: 'auto_reply',
                    caseId: caseId,
                    toEmail: messageData.from_email,
                    subject: messageData.subject,
                    content: autoReply.reply_text,
                    originalMessageId: messageData.message_id
                }, {
                    delay: naturalDelay
                });

                const delayMsg = naturalDelay === 0
                    ? (isTestMode ? 'instantly (TEST MODE)' : 'instantly (FORCE_INSTANT_EMAILS)')
                    : `in ${Math.round(naturalDelay / 1000 / 60)} minutes`;
                console.log(`✅ Auto-reply queued for case ${caseId} (will send ${delayMsg})`);
            } else if (autoReply.requires_approval) {
                // Store in approval queue
                await db.query(
                    `INSERT INTO auto_reply_queue (message_id, case_id, generated_reply, confidence_score, requires_approval)
                     VALUES ($1, $2, $3, $4, true)
                     ON CONFLICT (message_id) DO UPDATE SET
                        generated_reply = $3,
                        confidence_score = $4`,
                    [messageId, caseId, autoReply.reply_text, autoReply.confidence]
                );

                console.log(`⏸️ Auto-reply requires approval for case ${caseId} (confidence: ${autoReply.confidence})`);
            } else {
                console.log(`❌ Auto-reply NOT being sent:`);
                console.log(`   should_auto_reply: ${autoReply.should_auto_reply}`);
                console.log(`   confidence: ${autoReply.confidence}`);
                console.log(`   requires_approval: ${autoReply.requires_approval}`);
                console.log(`   Full auto-reply object:`, JSON.stringify(autoReply, null, 2));
            }
        } else {
            console.log(`⚠️ Skipping auto-reply generation:`);
            console.log(`   analysis.requires_action: ${analysis.requires_action}`);
            console.log(`   autoReplyEnabled: ${autoReplyEnabled}`);
            console.log(`   caseNeedsHuman: ${caseNeedsHuman}`);
            console.log(`   Full analysis object:`, JSON.stringify(analysis, null, 2));
        }

        return analysis;
    } catch (error) {
        console.error('❌ Analysis job failed:', error);
        console.error('   Error message:', error.message);
        console.error('   Error stack:', error.stack);
        throw error;
    }
}, {
    connection,
    lockDuration: 300000, // 5 minutes - legal research can take time
    lockRenewTime: 60000  // Renew lock every minute
});

// ===== GENERATE QUEUE WORKER =====
const generateWorker = new Worker('generate-queue', async (job) => {
    console.log(`Processing generation job: ${job.id}`);

    const { caseId, instantMode } = job.data;

    try {
        const caseData = await db.getCaseById(caseId);

        if (!caseData) {
            throw new Error(`Case ${caseId} not found`);
        }

        const portalUrl = normalizePortalUrl(caseData.portal_url);
        const contactEmail = pickBestEmail(caseData);
        let portalHandled = false;
        let portalError = null;

        if (portalUrl && isSupportedPortalUrl(portalUrl)) {
            console.log(`🌐 Attempting portal submission for case ${caseId} via ${portalUrl}`);
            try {
                const portalResult = await portalAgentSkyvern.submitToPortal(caseData, portalUrl, {
                    maxSteps: 50,
                    dryRun: false
                });

                if (portalResult && portalResult.success) {
                    const submissionStatus = portalResult.submission_status || portalResult.status || 'submitted';
                    const portalEngine = portalResult.engine || 'skyvern';
                    const workflowUrl = portalResult.workflow_url || null;
                    const taskUrl = workflowUrl
                        ? workflowUrl
                        : (portalResult.taskId ? `https://app.skyvern.com/tasks/${portalResult.taskId}` : null);
                    const recordingUrl = portalResult.recording_url || taskUrl || null;
                    const portalRunId = portalResult.runId || portalResult.taskId || null;

                    await db.updateCaseStatus(caseId, 'sent', {
                        substatus: `Portal submission completed (${submissionStatus})`,
                        send_date: new Date()
                    });
                    await db.updateCasePortalStatus(caseId, {
                        portal_url: portalUrl,
                        portal_provider: caseData.portal_provider || 'Auto-detected',
                        last_portal_status: submissionStatus,
                        last_portal_status_at: new Date(),
                        last_portal_engine: portalEngine,
                        last_portal_run_id: portalRunId,
                        last_portal_details: JSON.stringify(portalResult.extracted_data || {}),
                        last_portal_task_url: taskUrl,
                        last_portal_recording_url: recordingUrl
                    });

                    await notionService.syncStatusToNotion(caseId);

                    await db.logActivity('portal_submission', `Portal submission completed for case ${caseId}`, {
                        case_id: caseId,
                        portal_url: portalUrl,
                        portal_provider: caseData.portal_provider || 'Auto-detected',
                        engine: portalEngine,
                        run_id: portalRunId,
                        task_url: taskUrl,
                        recording_url: recordingUrl,
                        submission_status: submissionStatus,
                        confirmation_number: portalResult.confirmation_number || null
                    });

                    // Notify Discord about portal submission
                    await discordService.notifyPortalSubmission(caseData, {
                        success: true,
                        portalUrl: portalUrl,
                        steps: portalResult.steps || 0
                    });
                    await discordService.notifyRequestSent(caseData, 'portal');

                    portalHandled = true;
                    console.log(`✅ Portal submission succeeded for case ${caseId}`);

                    return {
                        success: true,
                        case_id: caseId,
                        queued_for_send: false,
                        sent_via_portal: true,
                        portal_engine: 'skyvern'
                    };
                }
            } catch (error) {
                portalError = error;
                console.error(`⚠️ Portal submission failed for case ${caseId}, falling back to email:`, error.message);
                await db.logActivity('portal_submission_failed', `Portal submission failed for case ${caseId}: ${error.message}`, {
                    case_id: caseId,
                    portal_url: portalUrl,
                    error: error.message
                });
            }
        } else if (portalUrl) {
            console.log(`⚠️ Portal URL provided for case ${caseId} but domain unsupported. Falling back to email.`);
            await db.logActivity(
                'portal_unsupported_domain',
                `Portal URL present but unsupported for case ${caseId}`,
                { case_id: caseId, portal_url: portalUrl }
            );
        } else {
            console.log(`ℹ️ No portal URL for case ${caseId}. Proceeding with email flow.`);
        }

        // If portal submission did not occur/succeed, fall back to email flow
        if (!portalHandled) {
            // NEVER fall back to email if there's a portal_url - portal submission only
            if (portalUrl) {
                console.log(`🚫 BLOCKED: Case ${caseId} has portal_url but portal submission failed - NO EMAIL fallback`);
                console.log(`🌐 Portal URL: ${portalUrl}`);
                console.log(`⚠️ Portal error: ${portalError?.message || 'Unknown error or unsupported domain'}`);
                await db.updateCaseStatus(caseId, 'needs_human_review', {
                    substatus: 'Portal submission failed - requires human intervention'
                });
                await notionService.syncStatusToNotion(caseId);
                await db.logActivity('portal_requires_human', `Portal submission failed for case ${caseId}, no email fallback`, {
                    case_id: caseId,
                    portal_url: portalUrl,
                    error: portalError?.message || 'Unknown error or unsupported domain'
                });
                return {
                    success: false,
                    case_id: caseId,
                    queued_for_send: false,
                    sent_via_portal: false,
                    portal_failed: true,
                    requires_human_review: true
                };
            }

            if (portalError) {
                console.log(`📧 Continuing with email for case ${caseId} after portal error.`);
            }

            if (!contactEmail) {
                console.warn(`❌ No valid email contact for case ${caseId}. Marking for human review.`);
                await db.updateCaseStatus(caseId, 'needs_human_review', {
                    substatus: 'No valid portal or email contact detected'
                });
                await notionService.syncStatusToNotion(caseId);
                await db.logActivity('contact_missing', 'No portal/email contact available. Pending human review.', {
                    case_id: caseId
                });

                return {
                    success: false,
                    case_id: caseId,
                    queued_for_send: false,
                    sent_via_portal: false,
                    missing_contact: true
                };
            }
            // Generate FOIA request
            const generated = await aiService.generateFOIARequest(caseData);

            // Create simple subject line (just the person's name, no extra details)
            const simpleName = (caseData.subject_name || 'Information Request')
                .split(' - ')[0]  // Take only the name part before any dash
                .split('(')[0]    // Remove any parenthetical info
                .trim();
            const subject = `Public Records Request - ${simpleName}`;

            // Queue the email to be sent immediately (no delays)
            await emailQueue.add('send-initial-request', {
                type: 'initial_request',
                caseId: caseId,
                toEmail: contactEmail,
                subject: subject,
                content: generated.request_text,
                instantReply: instantMode || false  // Pass instant mode flag
            });

            console.log(`Generated and queued email for case ${caseId}, sending immediately`);

            return {
                success: true,
                case_id: caseId,
                queued_for_send: true,
                delay_minutes: 0,
                sent_via_portal: false
            };
        }
    } catch (error) {
        console.error('Generation job failed:', error);
        throw error;
    }
}, { connection });

async function runPortalStatusJob({ job, caseId, portalUrl, provider, messageId, notificationType }) {
    console.log(`Processing portal status job: ${job.id}`, job.data);

    try {
        const caseData = await db.getCaseById(caseId);
        if (!caseData) {
            throw new Error(`Case ${caseId} not found`);
        }

        const targetUrl = portalUrl || caseData.portal_url;
        if (!targetUrl) {
            throw new Error(`No portal URL available for case ${caseId}`);
        }

        const account = await db.getPortalAccountByUrl(targetUrl);
        if (!account) {
            console.log(`⚠️  Skipping portal status for case ${caseId} - no saved account yet`);
            await db.logActivity('portal_status_skipped', 'Skipping portal status check (no saved account)', {
                case_id: caseId,
                portal_url: targetUrl,
                portal_provider: provider,
                notification_type: notificationType,
                message_id: messageId
            });
            return {
                success: false,
                skipped: true,
                reason: 'no_saved_account'
            };
        }

        const result = await portalAgentSkyvern.checkPortalStatus(caseData, targetUrl, {
            provider
        });

        if (!result.success) {
            throw new Error(result.error || 'Portal status check failed');
        }

        const statusText =
            result.statusText ||
            result.extracted_data?.status ||
            result.extracted_data?.status_text ||
            'Portal responded';

        const taskUrl = result.taskId ? `https://app.skyvern.com/tasks/${result.taskId}` : null;

        await db.updateCasePortalStatus(caseId, {
            portal_url: targetUrl,
            portal_provider: provider || caseData.portal_provider || null,
            last_portal_status: statusText,
            last_portal_status_at: new Date(),
            last_portal_engine: 'skyvern',
            last_portal_run_id: result.taskId || result.runId || null,
            last_portal_details: result.extracted_data ? JSON.stringify(result.extracted_data) : null,
            last_portal_task_url: taskUrl,
            last_portal_recording_url: result.recording_url || taskUrl,
            last_portal_account_email: result.accountEmail || caseData.last_portal_account_email || null
        });

        await db.logActivity('portal_status_synced', `Portal status updated: ${statusText}`, {
            case_id: caseId,
            portal_url: targetUrl,
            portal_provider: provider,
            notification_type: notificationType,
            message_id: messageId,
            run_id: result.taskId || result.runId || null,
            recording_url: result.recording_url || taskUrl,
            task_url: taskUrl
        });

        await notionService.syncStatusToNotion(caseId);

        return result;
    } catch (error) {
        console.error(`Portal status job ${job.id} failed:`, error);
        await db.logActivity('portal_status_failed', `Portal status refresh failed: ${error.message}`, {
            case_id: caseId,
            portal_url: portalUrl,
            portal_provider: provider,
            notification_type: notificationType,
            message_id: messageId
        });
        throw error;
    }
}

async function runPortalSubmissionJob({ job, caseId, portalUrl, provider, instructions }) {
    console.log(`Processing portal submission job: ${job.id}`, job.data);

    try {
        const caseData = await db.getCaseById(caseId);
        if (!caseData) {
            throw new Error(`Case ${caseId} not found`);
        }

        const targetUrl = portalUrl || caseData.portal_url;
        if (!targetUrl) {
            throw new Error(`No portal URL available for case ${caseId}`);
        }

        // Mark case as portal in progress if not already sent
        if (caseData.status !== 'sent') {
            await db.updateCaseStatus(caseId, 'portal_in_progress', {
                substatus: 'Agency requested portal submission',
                last_portal_status: 'Portal submission queued',
                last_portal_status_at: new Date()
            });
        }

        const result = await portalAgentSkyvern.submitToPortal(caseData, targetUrl, {
            maxSteps: 60,
            dryRun: false,
            instructions
        });

        if (!result || !result.success) {
            throw new Error(result?.error || 'Portal submission failed');
        }

        const engineUsed = result.engine || 'skyvern';
        const statusText = result.status || 'submitted';
        const taskUrl = result.taskId ? `https://app.skyvern.com/tasks/${result.taskId}` : null;
        const sendDate = caseData.send_date || new Date();

        await db.updateCaseStatus(caseId, 'sent', {
            substatus: `Portal submission completed (${statusText})`,
            send_date: sendDate
        });

        await db.updateCasePortalStatus(caseId, {
            portal_url: targetUrl,
            portal_provider: provider || caseData.portal_provider || 'Auto-detected',
            last_portal_status: `Submission completed (${statusText})`,
            last_portal_status_at: new Date(),
            last_portal_engine: engineUsed,
            last_portal_run_id: result.taskId || result.runId || null,
            last_portal_details: result.extracted_data ? JSON.stringify(result.extracted_data) : null,
            last_portal_task_url: taskUrl,
            last_portal_recording_url: result.recording_url || taskUrl,
            last_portal_account_email: result.accountEmail || caseData.last_portal_account_email || null
        });

        await notionService.syncStatusToNotion(caseId);

        await db.logActivity('portal_submission', `Portal submission completed for case ${caseId}`, {
            case_id: caseId,
            portal_url: targetUrl,
            portal_provider: provider || caseData.portal_provider || 'Auto-detected',
            instructions,
            run_id: result.taskId || result.runId || null,
            recording_url: result.recording_url || taskUrl,
            task_url: taskUrl,
            engine: engineUsed
        });

        await discordService.notifyPortalSubmission(caseData, {
            success: true,
            portalUrl: targetUrl,
            steps: result.steps || 0
        });

        await discordService.notifyRequestSent(caseData, 'portal');

        return result;
    } catch (error) {
        console.error(`Portal submission job ${job.id} failed:`, error);
        await db.logActivity('portal_submission_failed', `Portal submission failed: ${error.message}`, {
            case_id: caseId,
            portal_url: portalUrl,
            portal_provider: provider,
            instructions
        });
        throw error;
    }
}

const portalWorker = new Worker('portal-queue', async (job) => {
    if (job.name === 'portal-submit') {
        return runPortalSubmissionJob({
            job,
            caseId: job.data.caseId,
            portalUrl: job.data.portalUrl,
            provider: job.data.provider,
            instructions: job.data.instructions
        });
    }

    return runPortalStatusJob({
        job,
        caseId: job.data.caseId,
        portalUrl: job.data.portalUrl,
        provider: job.data.provider,
        messageId: job.data.messageId,
        notificationType: job.data.notificationType
    });
}, { connection, concurrency: 1 });

// Error handlers
emailWorker.on('failed', (job, err) => {
    console.error(`Email job ${job.id} failed:`, err);
});

analysisWorker.on('failed', (job, err) => {
    console.error(`Analysis job ${job.id} failed:`, err);
});

generateWorker.on('failed', (job, err) => {
    console.error(`Generation job ${job.id} failed:`, err);
});
portalWorker.on('failed', (job, err) => {
    console.error(`Portal job ${job.id} failed:`, err);
});

// Success handlers
emailWorker.on('completed', (job) => {
    console.log(`Email job ${job.id} completed successfully`);
});

analysisWorker.on('completed', (job) => {
    console.log(`Analysis job ${job.id} completed successfully`);
});

generateWorker.on('completed', (job) => {
    console.log(`Generation job ${job.id} completed successfully`);
});
portalWorker.on('completed', (job) => {
    console.log(`Portal job ${job.id} completed successfully`);
});

// Exports
module.exports = {
    emailQueue,
    analysisQueue,
    generateQueue,
    portalQueue,
    emailWorker,
    analysisWorker,
    generateWorker,
    portalWorker
};
