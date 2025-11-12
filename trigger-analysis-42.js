/**
 * Manually trigger analysis for case 42, message 85
 */
require('dotenv').config();
const { analysisQueue } = require('./queues/email-queue');

async function triggerAnalysis() {
    try {
        console.log('Manually queuing analysis for case 42, message 85...');

        await analysisQueue.add('analyze-response', {
            messageId: 85,
            caseId: 42,
            instantReply: false
        }, {
            attempts: 3,
            backoff: {
                type: 'exponential',
                delay: 3000
            }
        });

        console.log('✅ Analysis job added to queue');
        console.log('The analysis worker will process this job and extract the portal URL');

        // Give it a moment then exit
        setTimeout(() => {
            console.log('\nCheck the logs to see when the analysis worker picks it up');
            process.exit(0);
        }, 2000);
    } catch (error) {
        console.error('Error:', error);
        process.exit(1);
    }
}

triggerAnalysis();
