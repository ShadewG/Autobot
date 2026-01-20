const { CronJob } = require('cron');
const notionService = require('./notion-service');
const followUpService = require('./follow-up-service');
const { generateQueue } = require('../queues/email-queue');
const db = require('./database');
const stuckResponseDetector = require('./stuck-response-detector');
const agencyNotionSync = require('./agency-notion-sync');

class CronService {
    constructor() {
        this.jobs = {};
    }

    /**
     * Start all cron jobs
     */
    start() {
        console.log('Starting cron services...');

        // Sync from Notion every 15 minutes
        this.jobs.notionSync = new CronJob('*/15 * * * *', async () => {
            try {
                console.log('Running Notion sync...');
                const cases = await notionService.syncCasesFromNotion('Ready To Send');

                // Auto-process new cases if enabled
                if (cases.length > 0) {
                    console.log(`Synced ${cases.length} new cases from Notion`);

                    for (const caseData of cases) {
                        // Queue for generation and sending
                        await generateQueue.add('generate-and-send', {
                            caseId: caseData.id
                        });
                    }

                    await db.logActivity('notion_sync', `Synced and queued ${cases.length} cases from Notion`);
                }
            } catch (error) {
                console.error('Error in Notion sync cron:', error);
            }
        }, null, true, 'America/New_York');

        // Start follow-up service
        followUpService.start();

        // Clean up old activity logs every day at midnight
        this.jobs.cleanup = new CronJob('0 0 * * *', async () => {
            try {
                console.log('Running cleanup job...');
                // Keep only 90 days of activity logs
                await db.query(`
                    DELETE FROM activity_log
                    WHERE created_at < NOW() - INTERVAL '90 days'
                `);
                console.log('Cleanup completed');
            } catch (error) {
                console.error('Error in cleanup cron:', error);
            }
        }, null, true, 'America/New_York');

        // Health check / keep-alive every 5 minutes
        this.jobs.healthCheck = new CronJob('*/5 * * * *', async () => {
            try {
                const health = await db.healthCheck();
                if (!health.healthy) {
                    console.error('Database health check failed:', health.error);
                }
            } catch (error) {
                console.error('Error in health check cron:', error);
            }
        }, null, true, 'America/New_York');

        // Check for stuck responses every 30 minutes
        this.jobs.stuckResponseCheck = new CronJob('*/30 * * * *', async () => {
            try {
                console.log('Checking for stuck responses...');
                const result = await stuckResponseDetector.detectAndFlagStuckResponses();
                if (result.flagged > 0) {
                    console.log(`⚠️ Flagged ${result.flagged} stuck response(s) for human review`);
                }
            } catch (error) {
                console.error('Error in stuck response check cron:', error);
            }
        }, null, true, 'America/New_York');

        // Sync agencies from Notion every hour
        this.jobs.agencySync = new CronJob('0 * * * *', async () => {
            try {
                console.log('Running agency sync from Notion...');
                const result = await agencyNotionSync.syncFromNotion({ fullSync: false, limit: 100 });
                console.log(`Agency sync completed: ${result.created} created, ${result.updated} updated, ${result.skipped} skipped`);
                if (result.errors.length > 0) {
                    console.warn(`Agency sync had ${result.errors.length} errors`);
                }
            } catch (error) {
                console.error('Error in agency sync cron:', error);
            }
        }, null, true, 'America/New_York');

        // Run initial agency sync on startup (delayed by 30 seconds to let DB connect)
        setTimeout(async () => {
            try {
                console.log('Running initial agency sync from Notion...');
                const result = await agencyNotionSync.syncFromNotion({ fullSync: false, limit: 200 });
                console.log(`Initial agency sync completed: ${result.created} created, ${result.updated} updated`);
            } catch (error) {
                console.error('Error in initial agency sync:', error);
            }
        }, 30000);

        console.log('✓ Notion sync: Every 15 minutes');
        console.log('✓ Follow-ups: Daily at 9 AM');
        console.log('✓ Cleanup: Daily at midnight');
        console.log('✓ Health check: Every 5 minutes');
        console.log('✓ Stuck response check: Every 30 minutes');
        console.log('✓ Agency sync: Every hour + on startup');
    }

    /**
     * Stop all cron jobs
     */
    stop() {
        console.log('Stopping cron services...');
        Object.values(this.jobs).forEach(job => job.stop());
        followUpService.stop();
        console.log('All cron jobs stopped');
    }

    /**
     * Get status of all jobs
     */
    getStatus() {
        return {
            notionSync: this.jobs.notionSync?.running || false,
            followUp: followUpService.cronJob?.running || false,
            cleanup: this.jobs.cleanup?.running || false,
            healthCheck: this.jobs.healthCheck?.running || false,
            stuckResponseCheck: this.jobs.stuckResponseCheck?.running || false
        };
    }
}

module.exports = new CronService();
