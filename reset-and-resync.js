/**
 * NUCLEAR RESET: Delete all cases and resync from Notion
 * WARNING: This deletes EVERYTHING and starts fresh
 */
require('dotenv').config();
const db = require('./services/database');
const notionService = require('./services/notion-service');
const { generateQueue } = require('./queues/email-queue');

async function resetAndResync() {
    try {
        console.log('🚨 NUCLEAR RESET INITIATED 🚨');
        console.log('This will DELETE ALL CASES and start fresh from Notion\n');

        await db.initialize();

        // Step 1: Clear all queues
        console.log('1️⃣ Clearing all job queues...');
        const waitingJobs = await generateQueue.getWaiting();
        const delayedJobs = await generateQueue.getDelayed();
        const activeJobs = await generateQueue.getActive();

        let clearedCount = 0;
        for (const job of [...waitingJobs, ...delayedJobs, ...activeJobs]) {
            await job.remove();
            clearedCount++;
        }
        console.log(`   ✅ Cleared ${clearedCount} pending jobs\n`);

        // Step 2: Delete all database records
        console.log('2️⃣ Deleting all database records...');

        // Delete in order to respect foreign keys
        await db.query('DELETE FROM auto_reply_queue');
        console.log('   ✅ Cleared auto_reply_queue');

        await db.query('DELETE FROM analysis');
        console.log('   ✅ Cleared analysis');

        await db.query('DELETE FROM messages');
        console.log('   ✅ Cleared messages');

        await db.query('DELETE FROM threads');
        console.log('   ✅ Cleared threads');

        await db.query('DELETE FROM generated_requests');
        console.log('   ✅ Cleared generated_requests');

        await db.query('DELETE FROM cases');
        console.log('   ✅ Cleared cases');

        await db.query('DELETE FROM activity_log');
        console.log('   ✅ Cleared activity_log\n');

        // Step 3: Sync from Notion
        console.log('3️⃣ Syncing from Notion...');
        const cases = await notionService.syncCasesFromNotion('Ready to Send');
        console.log(`   ✅ Synced ${cases.length} cases from Notion\n`);

        // Step 4: Show what we got and queue for sending
        console.log('4️⃣ Processing synced cases...');
        let queuedCount = 0;
        let reviewCount = 0;

        for (const caseData of cases) {
            const hasPortal = caseData.portal_url && caseData.portal_url.trim().length > 0;
            const hasEmail = caseData.agency_email && caseData.agency_email.trim().length > 0;

            console.log(`\n   Case #${caseData.id}: ${caseData.case_name}`);
            console.log(`      Agency: ${caseData.agency_name}`);
            console.log(`      State: ${caseData.state || '⚠️  MISSING'}`);
            console.log(`      Portal: ${hasPortal ? '✅ ' + caseData.portal_url : '❌ None'}`);
            console.log(`      Email: ${hasEmail ? '✅ ' + caseData.agency_email : '❌ None'}`);

            if (!hasPortal && !hasEmail) {
                console.log(`      Status: ⚠️  FLAGGED FOR HUMAN REVIEW (no contact info)`);
                await db.query(
                    'UPDATE cases SET status = $1, substatus = $2 WHERE id = $3',
                    ['needs_human_review', 'Missing contact information (no portal URL or email)', caseData.id]
                );
                reviewCount++;
            } else if (!caseData.state) {
                console.log(`      Status: ⚠️  FLAGGED FOR HUMAN REVIEW (missing state)`);
                await db.query(
                    'UPDATE cases SET status = $1, substatus = $2 WHERE id = $3',
                    ['needs_human_review', 'Missing state field in Notion', caseData.id]
                );
                reviewCount++;
            } else {
                console.log(`      Status: ✅ QUEUED FOR SENDING`);
                await generateQueue.add('generate-and-send', {
                    caseId: caseData.id,
                    instantMode: true
                }, {
                    delay: queuedCount * 10000 // Stagger by 10 seconds each
                });
                queuedCount++;
            }
        }

        console.log('\n' + '='.repeat(80));
        console.log('🎉 RESET COMPLETE 🎉');
        console.log('='.repeat(80));
        console.log(`📊 Total synced: ${cases.length} cases`);
        console.log(`✅ Queued for sending: ${queuedCount} cases`);
        console.log(`⚠️  Flagged for review: ${reviewCount} cases`);
        console.log('\nAll queued cases will be sent over the next few minutes (staggered).');
        console.log('='.repeat(80));

        await db.close();
        process.exit(0);

    } catch (error) {
        console.error('❌ Error:', error);
        if (error.stack) console.error(error.stack);
        process.exit(1);
    }
}

resetAndResync();
