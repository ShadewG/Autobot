const { CronJob } = require('cron');
const db = require('./database');
const aiService = require('./ai-service');
const { emailQueue } = require('../queues/email-queue');
const notionService = require('./notion-service');

class FollowUpService {
    constructor() {
        this.maxFollowups = parseInt(process.env.MAX_FOLLOWUPS) || 2;
        this.followupDelayDays = parseInt(process.env.FOLLOWUP_DELAY_DAYS) || 7;
        this.cronJob = null;
    }

    /**
     * Start the cron job to check for due follow-ups
     */
    start() {
        // Run daily at 9 AM
        this.cronJob = new CronJob('0 9 * * *', async () => {
            console.log('Running follow-up check...');
            await this.processFollowUps();
        }, null, true, 'America/New_York');

        console.log('Follow-up scheduler started (runs daily at 9 AM)');
    }

    /**
     * Stop the cron job
     */
    stop() {
        if (this.cronJob) {
            this.cronJob.stop();
            console.log('Follow-up scheduler stopped');
        }
    }

    /**
     * Process all due follow-ups
     */
    async processFollowUps() {
        try {
            const dueFollowups = await db.getDueFollowUps();
            console.log(`Found ${dueFollowups.length} due follow-ups`);

            for (const followup of dueFollowups) {
                try {
                    await this.sendFollowUp(followup);
                } catch (error) {
                    console.error(`Error sending follow-up for case ${followup.case_id}:`, error);
                }
            }

            // Also check for overdue cases without follow-up schedules
            await this.checkOverdueCases();

            return dueFollowups.length;
        } catch (error) {
            console.error('Error processing follow-ups:', error);
            throw error;
        }
    }

    /**
     * Send a follow-up email
     */
    async sendFollowUp(followupSchedule) {
        try {
            const caseData = await db.getCaseById(followupSchedule.case_id);
            const thread = await db.getThreadById(followupSchedule.thread_id);

            if (!caseData || !thread) {
                console.error(`Case or thread not found for follow-up ${followupSchedule.id}`);
                return;
            }

            // Check if max follow-ups reached
            if (followupSchedule.followup_count >= this.maxFollowups) {
                console.log(`Max follow-ups reached for case ${caseData.id}, marking as max_reached`);

                await db.updateFollowUpSchedule(followupSchedule.id, {
                    status: 'max_reached'
                });

                // Send alert (could integrate Slack here)
                await db.logActivity('followup_max_reached',
                    `Case ${caseData.case_name} has reached max follow-ups with no response`,
                    { case_id: caseData.id }
                );

                return;
            }

            // Generate follow-up text
            const followupText = await aiService.generateFollowUp(
                caseData,
                followupSchedule.followup_count
            );

            const subject = thread.subject || `Public Records Request - ${caseData.subject_name}`;

            // Queue the follow-up email
            await emailQueue.add('send-followup', {
                type: 'follow_up',
                caseId: caseData.id,
                toEmail: caseData.agency_email,
                subject: subject,
                content: followupText,
                originalMessageId: thread.initial_message_id
            }, {
                delay: this.getRandomDelay()
            });

            // Update follow-up schedule
            const nextDate = new Date();
            nextDate.setDate(nextDate.getDate() + this.followupDelayDays);

            await db.updateFollowUpSchedule(followupSchedule.id, {
                followup_count: followupSchedule.followup_count + 1,
                last_followup_sent_at: new Date(),
                next_followup_date: nextDate,
                status: 'sent'
            });

            // Update case status
            await db.updateCaseStatus(caseData.id, 'awaiting_response', {
                days_overdue: this.calculateDaysOverdue(caseData.deadline_date)
            });

            // Update Notion
            await notionService.syncStatusToNotion(caseData.id);

            console.log(`Follow-up #${followupSchedule.followup_count + 1} queued for case ${caseData.id}`);

            // Log activity
            await db.logActivity('followup_queued',
                `Follow-up #${followupSchedule.followup_count + 1} queued for case ${caseData.case_name}`,
                { case_id: caseData.id }
            );
        } catch (error) {
            console.error('Error sending follow-up:', error);
            throw error;
        }
    }

    /**
     * Check for overdue cases that don't have follow-up schedules
     */
    async checkOverdueCases() {
        try {
            const result = await db.query(`
                SELECT c.*
                FROM cases c
                LEFT JOIN follow_up_schedule f ON c.id = f.case_id
                WHERE c.status IN ('sent', 'awaiting_response')
                AND c.deadline_date < NOW()
                AND (f.id IS NULL OR f.status = 'max_reached')
            `);

            const overdueCases = result.rows;
            console.log(`Found ${overdueCases.length} overdue cases without active follow-ups`);

            for (const caseData of overdueCases) {
                // Calculate days overdue
                const daysOverdue = this.calculateDaysOverdue(caseData.deadline_date);

                // Update case
                await db.updateCaseStatus(caseData.id, 'awaiting_response', {
                    days_overdue: daysOverdue
                });

                // Update Notion
                await notionService.syncStatusToNotion(caseData.id);

                // Create follow-up schedule if none exists
                const thread = await db.getThreadByCaseId(caseData.id);
                if (thread) {
                    const existingSchedule = await db.query(
                        'SELECT * FROM follow_up_schedule WHERE case_id = $1 AND thread_id = $2',
                        [caseData.id, thread.id]
                    );

                    if (existingSchedule.rows.length === 0) {
                        await db.createFollowUpSchedule({
                            case_id: caseData.id,
                            thread_id: thread.id,
                            next_followup_date: new Date(), // Send ASAP
                            followup_count: 0,
                            auto_send: true
                        });

                        console.log(`Created follow-up schedule for overdue case ${caseData.id}`);
                    }
                }
            }
        } catch (error) {
            console.error('Error checking overdue cases:', error);
        }
    }

    /**
     * Calculate days overdue from deadline
     */
    calculateDaysOverdue(deadline) {
        if (!deadline) return 0;

        const deadlineDate = new Date(deadline);
        const today = new Date();
        const diffTime = today - deadlineDate;
        const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));

        return Math.max(0, diffDays);
    }

    /**
     * Get random delay for follow-up (2-10 minutes)
     */
    getRandomDelay() {
        // No delay in testing mode
        if (process.env.TESTING_MODE === 'true' || process.env.NODE_ENV === 'development') {
            return 0;
        }

        const minDelay = 2 * 60 * 1000;
        const maxDelay = 10 * 60 * 1000;
        return Math.floor(Math.random() * (maxDelay - minDelay + 1)) + minDelay;
    }

    /**
     * Manually trigger follow-up check (for testing)
     */
    async manualCheck() {
        console.log('Manual follow-up check triggered');
        return await this.processFollowUps();
    }
}

module.exports = new FollowUpService();
