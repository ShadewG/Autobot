const { Queue, Worker } = require('bullmq');
const Redis = require('ioredis');
const sendgridService = require('../services/sendgrid-service');
const aiService = require('../services/ai-service');
const db = require('../services/database');
const notionService = require('../services/notion-service');

// Redis connection
const connection = new Redis(process.env.REDIS_URL, {
    maxRetriesPerRequest: null
});

// Create queues
const emailQueue = new Queue('email-queue', { connection });
const analysisQueue = new Queue('analysis-queue', { connection });
const generateQueue = new Queue('generate-queue', { connection });

/**
 * Add random delay to appear more human
 */
function getRandomDelay() {
    // Random delay between 2-10 minutes (in milliseconds)
    const minDelay = 2 * 60 * 1000;
    const maxDelay = 10 * 60 * 1000;
    return Math.floor(Math.random() * (maxDelay - minDelay + 1)) + minDelay;
}

/**
 * Check if current time is within business hours
 */
function isBusinessHours(timezone = 'America/New_York') {
    const now = new Date();
    const hour = now.getHours();
    const day = now.getDay();

    const startHour = parseInt(process.env.BUSINESS_HOURS_START) || 9;
    const endHour = parseInt(process.env.BUSINESS_HOURS_END) || 17;

    // Check if weekend
    if (day === 0 || day === 6) {
        return false;
    }

    // Check if within business hours
    return hour >= startHour && hour < endHour;
}

/**
 * Calculate delay to next business hours if needed
 */
function delayToBusinessHours() {
    if (isBusinessHours()) {
        return 0;
    }

    const now = new Date();
    const hour = now.getHours();
    const startHour = parseInt(process.env.BUSINESS_HOURS_START) || 9;

    // If after hours, wait until next business day start
    let hoursToWait;
    if (hour >= 17) {
        hoursToWait = 24 - hour + startHour;
    } else {
        hoursToWait = startHour - hour;
    }

    return hoursToWait * 60 * 60 * 1000;
}

// ===== EMAIL QUEUE WORKER =====
const emailWorker = new Worker('email-queue', async (job) => {
    console.log(`Processing email job: ${job.id}`, job.data);

    const { type, caseId, toEmail, subject, content, originalMessageId } = job.data;

    try {
        let result;

        switch (type) {
            case 'initial_request':
                result = await sendgridService.sendFOIARequest(caseId, content, subject, toEmail);

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
    console.log(`Processing analysis job: ${job.id}`);

    const { messageId, caseId } = job.data;

    try {
        const messageData = await db.getMessageById(messageId);
        const caseData = await db.getCaseById(caseId);

        if (!messageData || !caseData) {
            throw new Error('Message or case not found');
        }

        // Analyze the response
        const analysis = await aiService.analyzeResponse(messageData, caseData);

        // Update Notion with summary
        if (analysis.summary) {
            await notionService.addAISummaryToNotion(caseId, analysis.summary);
        }

        // Check if we should auto-reply
        if (analysis.requires_action && process.env.ENABLE_AUTO_REPLY === 'true') {
            const autoReply = await aiService.generateAutoReply(messageData, analysis, caseData);

            if (autoReply.should_auto_reply) {
                // Queue the auto-reply with a delay
                await emailQueue.add('send-auto-reply', {
                    type: 'auto_reply',
                    caseId: caseId,
                    toEmail: messageData.from_email,
                    subject: messageData.subject,
                    content: autoReply.reply_text,
                    originalMessageId: messageData.message_id
                }, {
                    delay: getRandomDelay() / 2 // Shorter delay for replies (1-5 min)
                });

                console.log('Auto-reply queued for case:', caseId);
            } else if (autoReply.requires_approval) {
                // Store in approval queue
                await db.query(
                    `INSERT INTO auto_reply_queue (message_id, case_id, generated_reply, confidence_score, requires_approval)
                     VALUES ($1, $2, $3, $4, true)`,
                    [messageId, caseId, autoReply.reply_text, autoReply.confidence]
                );

                console.log('Auto-reply requires approval for case:', caseId);
            }
        }

        return analysis;
    } catch (error) {
        console.error('Analysis job failed:', error);
        throw error;
    }
}, { connection });

// ===== GENERATE QUEUE WORKER =====
const generateWorker = new Worker('generate-queue', async (job) => {
    console.log(`Processing generation job: ${job.id}`);

    const { caseId } = job.data;

    try {
        const caseData = await db.getCaseById(caseId);

        if (!caseData) {
            throw new Error(`Case ${caseId} not found`);
        }

        // Generate FOIA request
        const generated = await aiService.generateFOIARequest(caseData);

        // Create subject line
        const subject = `Public Records Request - ${caseData.subject_name || 'Information Request'}`;

        // Queue the email to be sent with random delay
        const delay = getRandomDelay() + delayToBusinessHours();

        await emailQueue.add('send-initial-request', {
            type: 'initial_request',
            caseId: caseId,
            toEmail: caseData.agency_email,
            subject: subject,
            content: generated.request_text
        }, {
            delay: delay
        });

        console.log(`Generated and queued email for case ${caseId}, will send in ${Math.round(delay / 1000 / 60)} minutes`);

        return {
            success: true,
            case_id: caseId,
            queued_for_send: true,
            delay_minutes: Math.round(delay / 1000 / 60)
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
