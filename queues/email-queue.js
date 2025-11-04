const { Queue, Worker } = require('bullmq');
const Redis = require('ioredis');
const sendgridService = require('../services/sendgrid-service');
const aiService = require('../services/ai-service');
const db = require('../services/database');
const notionService = require('../services/notion-service');

// Redis connection
if (!process.env.REDIS_URL) {
    console.error('❌ REDIS_URL environment variable is not set!');
    console.error('Please set REDIS_URL in Railway environment variables.');
    console.error('It should look like: redis://default:password@host:port');
}

const connection = new Redis(process.env.REDIS_URL || 'redis://localhost:6379', {
    maxRetriesPerRequest: null,
    retryStrategy(times) {
        if (times > 3) {
            console.error('❌ Redis connection failed after 3 attempts');
            return null; // Stop retrying
        }
        const delay = Math.min(times * 50, 2000);
        return delay;
    }
});

connection.on('connect', () => {
    console.log('✅ Redis connected successfully');
});

connection.on('error', (err) => {
    console.error('❌ Redis connection error:', err.message);
});

// Create queues
const emailQueue = new Queue('email-queue', { connection });
const analysisQueue = new Queue('analysis-queue', { connection });
const generateQueue = new Queue('generate-queue', { connection });

/**
 * Generate human-like delay for auto-replies (2-10 hours)
 * Avoids immediate responses that look automated
 * Set AUTO_REPLY_DELAY_MINUTES env var to override (use 0 for immediate testing)
 */
function getHumanLikeDelay() {
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

                // Schedule follow-up
                const caseData = await db.getCaseById(caseId);
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
                break;

            default:
                throw new Error(`Unknown email type: ${type}`);
        }

        return result;
    } catch (error) {
        console.error('Email job failed:', error);
        throw error;
    }
}, { connection });

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

        // Check if we should auto-reply (enabled by default)
        const autoReplyEnabled = process.env.ENABLE_AUTO_REPLY !== 'false';
        console.log(`⚙️ Auto-reply enabled: ${autoReplyEnabled}`);

        if (analysis.requires_action && autoReplyEnabled) {
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
                const naturalDelay = isTestMode ? 0 : getHumanLikeDelay();

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

                const delayMsg = isTestMode ? 'instantly (TEST MODE)' : `in ${Math.round(naturalDelay / 1000 / 60)} minutes`;
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
            console.log(`   Full analysis object:`, JSON.stringify(analysis, null, 2));
        }

        return analysis;
    } catch (error) {
        console.error('❌ Analysis job failed:', error);
        console.error('   Error message:', error.message);
        console.error('   Error stack:', error.stack);
        throw error;
    }
}, { connection });

// ===== GENERATE QUEUE WORKER =====
const generateWorker = new Worker('generate-queue', async (job) => {
    console.log(`Processing generation job: ${job.id}`);

    const { caseId, instantMode } = job.data;

    try {
        const caseData = await db.getCaseById(caseId);

        if (!caseData) {
            throw new Error(`Case ${caseId} not found`);
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
            toEmail: caseData.agency_email,
            subject: subject,
            content: generated.request_text,
            instantReply: instantMode || false  // Pass instant mode flag
        });

        console.log(`Generated and queued email for case ${caseId}, sending immediately`);

        return {
            success: true,
            case_id: caseId,
            queued_for_send: true,
            delay_minutes: 0
        };
    } catch (error) {
        console.error('Generation job failed:', error);
        throw error;
    }
}, { connection });

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

// Exports
module.exports = {
    emailQueue,
    analysisQueue,
    generateQueue,
    emailWorker,
    analysisWorker,
    generateWorker
};
