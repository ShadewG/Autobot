require('dotenv').config();
const Redis = require('ioredis');
const { Queue } = require('bullmq');

async function checkWorkerStatus() {
    console.log('🔍 Checking BullMQ worker status...\n');

    try {
        // Connect to Redis
        const connection = new Redis(process.env.REDIS_URL, {
            maxRetriesPerRequest: null
        });

        console.log('✅ Redis connected');

        // Check each queue
        const emailQueue = new Queue('email-queue', { connection });
        const analysisQueue = new Queue('analysis-queue', { connection });
        const generateQueue = new Queue('generate-queue', { connection });

        console.log('\n📊 Queue Status:');

        const emailCounts = await emailQueue.getJobCounts();
        console.log(`\n  Email Queue:`);
        console.log(`    - Waiting: ${emailCounts.waiting}`);
        console.log(`    - Active: ${emailCounts.active}`);
        console.log(`    - Completed: ${emailCounts.completed}`);
        console.log(`    - Failed: ${emailCounts.failed}`);

        const analysisCounts = await analysisQueue.getJobCounts();
        console.log(`\n  Analysis Queue:`);
        console.log(`    - Waiting: ${analysisCounts.waiting}`);
        console.log(`    - Active: ${analysisCounts.active}`);
        console.log(`    - Completed: ${analysisCounts.completed}`);
        console.log(`    - Failed: ${analysisCounts.failed}`);

        const generateCounts = await generateQueue.getJobCounts();
        console.log(`\n  Generate Queue:`);
        console.log(`    - Waiting: ${generateCounts.waiting}`);
        console.log(`    - Active: ${generateCounts.active}`);
        console.log(`    - Completed: ${generateCounts.completed}`);
        console.log(`    - Failed: ${generateCounts.failed}`);

        // Get failed jobs to see errors
        if (generateCounts.failed > 0) {
            console.log('\n❌ Failed Generate Jobs:');
            const failed = await generateQueue.getFailed(0, 5);
            for (const job of failed) {
                console.log(`\n  Job ${job.id}:`);
                console.log(`    Case ID: ${job.data.caseId}`);
                console.log(`    Error: ${job.failedReason}`);
                if (job.stacktrace && job.stacktrace.length > 0) {
                    console.log(`    Stack: ${job.stacktrace[0].substring(0, 200)}`);
                }
            }
        }

        if (emailCounts.failed > 0) {
            console.log('\n❌ Failed Email Jobs:');
            const failed = await emailQueue.getFailed(0, 5);
            for (const job of failed) {
                console.log(`\n  Job ${job.id}:`);
                console.log(`    Type: ${job.data.type}`);
                console.log(`    Case ID: ${job.data.caseId}`);
                console.log(`    Error: ${job.failedReason}`);
            }
        }

        // Check waiting jobs
        if (generateCounts.waiting > 0) {
            console.log('\n⏳ Waiting Generate Jobs:');
            const waiting = await generateQueue.getWaiting(0, 5);
            for (const job of waiting) {
                console.log(`\n  Job ${job.id}:`);
                console.log(`    Case ID: ${job.data.caseId}`);
            }
        }

        await connection.quit();
        console.log('\n✅ Check complete');

    } catch (error) {
        console.error('❌ Error:', error.message);
        console.error(error.stack);
    }
}

checkWorkerStatus();
