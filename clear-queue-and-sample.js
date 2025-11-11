/**
 * Clear generate queue and generate a sample request
 */
require('dotenv').config();
const db = require('./services/database');
const aiService = require('./services/ai-service');
const { generateQueue } = require('./queues/email-queue');

async function clearQueueAndGenerateSample() {
    try {
        console.log('🔍 Initializing database...');
        await db.initialize();

        // 1. Clear generate queue
        console.log('\n🗑️ Clearing all pending jobs from generate queue...');
        const waitingJobs = await generateQueue.getWaiting();
        const delayedJobs = await generateQueue.getDelayed();

        let clearedCount = 0;
        for (const job of waitingJobs) {
            await job.remove();
            clearedCount++;
        }
        for (const job of delayedJobs) {
            await job.remove();
            clearedCount++;
        }

        console.log(`✅ Cleared ${clearedCount} pending jobs from generate queue`);

        // 2. Get recently sent cases
        console.log('\n📋 Fetching recently sent cases...');
        const result = await db.query(`
            SELECT id, case_name, subject_name, agency_name, send_date
            FROM cases
            WHERE status = 'sent'
            ORDER BY send_date DESC
            LIMIT 5
        `);

        if (result.rows.length === 0) {
            console.log('❌ No sent cases found');
            process.exit(0);
        }

        console.log(`\nFound ${result.rows.length} recently sent cases:`);
        result.rows.forEach((c, i) => {
            console.log(`  ${i + 1}. Case #${c.id}: ${c.case_name} (sent ${new Date(c.send_date).toLocaleDateString()})`);
        });

        // 3. Generate sample from first case
        const sampleCase = result.rows[0];
        console.log(`\n📝 Generating sample FOIA request for Case #${sampleCase.id}...`);

        const caseData = await db.getCaseById(sampleCase.id);
        const generated = await aiService.generateFOIARequest(caseData);

        const simpleName = (caseData.subject_name || 'Information Request')
            .split(' - ')[0]
            .split('(')[0]
            .trim();
        const subject = `Public Records Request - ${simpleName}`;

        console.log('\n' + '='.repeat(80));
        console.log('SAMPLE FOIA REQUEST');
        console.log('='.repeat(80));
        console.log(`\nCase: ${caseData.case_name}`);
        console.log(`Agency: ${caseData.agency_name}`);
        console.log(`Email: ${caseData.agency_email}`);
        console.log(`Portal: ${caseData.portal_url || 'None'}`);
        console.log(`\nSubject: ${subject}`);
        console.log('\n' + '-'.repeat(80));
        console.log('REQUEST TEXT:');
        console.log('-'.repeat(80));
        console.log(generated.request_text);
        console.log('\n' + '='.repeat(80));

        await db.close();
        process.exit(0);

    } catch (error) {
        console.error('Error:', error);
        process.exit(1);
    }
}

clearQueueAndGenerateSample();
