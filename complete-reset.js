/**
 * COMPLETE RESET: Clear database, reset Notion statuses, and resync
 */
require('dotenv').config();
const db = require('./services/database');
const notionService = require('./services/notion-service');
const { generateQueue } = require('./queues/email-queue');
const { Client } = require('@notionhq/client');

const notion = new Client({ auth: process.env.NOTION_API_KEY });

async function completeReset() {
    try {
        console.log('🚨 COMPLETE RESET INITIATED 🚨\n');

        await db.initialize();

        // Step 1: Clear all queues
        console.log('1️⃣ Clearing all job queues...');
        const waitingJobs = await generateQueue.getWaiting();
        const delayedJobs = await generateQueue.getDelayed();
        const activeJobs = await generateQueue.getActive();

        let clearedCount = 0;
        for (const job of [...waitingJobs, ...delayedJobs, ...activeJobs]) {
            try {
                await job.remove();
                clearedCount++;
            } catch (e) {
                console.log(`   ⚠️  Could not remove job ${job.id}: ${e.message}`);
            }
        }
        console.log(`   ✅ Cleared ${clearedCount} pending jobs\n`);

        // Step 2: Delete all database records
        console.log('2️⃣ Deleting all database records...');
        await db.query('DELETE FROM auto_reply_queue');
        await db.query('DELETE FROM analysis');
        await db.query('DELETE FROM messages');
        await db.query('DELETE FROM threads');
        await db.query('DELETE FROM generated_requests');
        await db.query('DELETE FROM cases');
        await db.query('DELETE FROM activity_log');
        console.log('   ✅ Database cleared\n');

        // Step 3: Reset ALL Notion case statuses to "Ready to Send"
        console.log('3️⃣ Resetting Notion statuses to "Ready to Send"...');

        const databaseId = process.env.NOTION_CASES_DATABASE_ID;

        // Query ALL pages in the database (not just "Ready to Send")
        let allPages = [];
        let hasMore = true;
        let startCursor = undefined;

        while (hasMore) {
            const response = await notion.databases.query({
                database_id: databaseId,
                start_cursor: startCursor
            });

            allPages = allPages.concat(response.results);
            hasMore = response.has_more;
            startCursor = response.next_cursor;
        }

        console.log(`   Found ${allPages.length} total pages in Notion\n`);

        let updatedCount = 0;
        for (const page of allPages) {
            const currentStatus = page.properties.Status?.status?.name;

            console.log(`   Updating: ${page.properties.Name?.title?.[0]?.plain_text || 'Untitled'}`);
            console.log(`      Current status: ${currentStatus || 'None'} → Ready to Send`);

            try {
                await notion.pages.update({
                    page_id: page.id,
                    properties: {
                        Status: {
                            status: {
                                name: 'Ready to Send'
                            }
                        }
                    }
                });
                updatedCount++;
            } catch (updateError) {
                console.log(`      ⚠️  Could not update: ${updateError.message}`);
            }
        }

        console.log(`\n   ✅ Updated ${updatedCount} pages to "Ready to Send"\n`);

        // Step 4: Sync from Notion
        console.log('4️⃣ Syncing from Notion...');
        const cases = await notionService.syncCasesFromNotion('Ready to Send');
        console.log(`   ✅ Synced ${cases.length} cases from Notion\n`);

        // Step 5: Process and queue cases
        console.log('5️⃣ Processing synced cases...');
        let queuedCount = 0;
        let reviewCount = 0;

        for (const caseData of cases) {
            const hasPortal = caseData.portal_url && caseData.portal_url.trim().length > 0;
            const hasEmail = caseData.agency_email && caseData.agency_email.trim().length > 0;

            console.log(`\n   Case #${caseData.id}: ${caseData.case_name}`);
            console.log(`      Agency: ${caseData.agency_name}`);
            console.log(`      State: ${caseData.state || '⚠️  AI will extract'}`);
            console.log(`      Portal: ${hasPortal ? '✅ ' + caseData.portal_url : '❌ None'}`);
            console.log(`      Email: ${hasEmail ? '✅ ' + caseData.agency_email : '❌ None'}`);

            if (!hasPortal && !hasEmail) {
                console.log(`      Status: ⚠️  FLAGGED (no contact info)`);
                await db.query(
                    'UPDATE cases SET status = $1, substatus = $2 WHERE id = $3',
                    ['needs_contact_info', 'Missing contact information', caseData.id]
                );
                reviewCount++;
            } else {
                console.log(`      Status: ✅ QUEUED`);
                await generateQueue.add('generate-and-send', {
                    caseId: caseData.id,
                    instantMode: false  // Use normal delays for realistic sending
                }, {
                    delay: queuedCount * 15000 // Stagger by 15 seconds each
                });
                queuedCount++;
            }
        }

        console.log('\n' + '='.repeat(80));
        console.log('🎉 COMPLETE RESET FINISHED 🎉');
        console.log('='.repeat(80));
        console.log(`📊 Total in Notion: ${allPages.length} pages`);
        console.log(`🔄 Reset to "Ready to Send": ${updatedCount} pages`);
        console.log(`✅ Queued for sending: ${queuedCount} cases`);
        console.log(`⚠️  Flagged for review: ${reviewCount} cases`);
        console.log('\nCases will be sent over the next few minutes (staggered).');
        console.log('='.repeat(80));

        await db.close();
        process.exit(0);

    } catch (error) {
        console.error('❌ Error:', error);
        if (error.stack) console.error(error.stack);
        process.exit(1);
    }
}

completeReset();
