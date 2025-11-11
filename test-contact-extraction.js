/**
 * Test AI contact extraction for cases 34, 35, 36
 */
require('dotenv').config();
const db = require('./services/database');
const notionService = require('./services/notion-service');

async function testContactExtraction() {
    try {
        await db.initialize();

        const caseIds = [34, 35, 36];

        for (const caseId of caseIds) {
            console.log('\n' + '='.repeat(80));
            console.log(`TESTING CASE #${caseId}`);
            console.log('='.repeat(80));

            // Get current case data
            const caseData = await db.getCaseById(caseId);
            console.log(`\nCase: ${caseData.case_name}`);
            console.log(`Agency: ${caseData.agency_name}`);
            console.log(`State: ${caseData.state}`);

            // Check if it has a police_dept_id to fetch from Notion
            const notionPageId = caseData.notion_page_id;

            if (!notionPageId || notionPageId.startsWith('test-')) {
                console.log('\n❌ No valid Notion page ID - skipping');
                continue;
            }

            console.log(`\nNotion Page ID: ${notionPageId}`);

            // Fetch from Notion and see what AI extracts
            try {
                console.log('\n🔍 Fetching from Notion and running AI contact extraction...');

                // This will trigger the AI extraction
                const enrichedData = await notionService.fetchPageById(notionPageId);

                console.log('\n📊 AI EXTRACTION RESULTS:');
                console.log(`   Portal URL: ${enrichedData.portal_url || '❌ None found'}`);
                console.log(`   Email: ${enrichedData.agency_email || '❌ None found'}`);
                console.log(`   Agency Name: ${enrichedData.agency_name || 'Unknown'}`);

                if (!enrichedData.portal_url && !enrichedData.agency_email) {
                    console.log('\n⚠️  NO CONTACT INFO FOUND - Would flag for human review');
                } else if (enrichedData.portal_url) {
                    console.log('\n✅ PORTAL FOUND - Would use portal submission');
                } else {
                    console.log('\n✅ EMAIL FOUND - Would use email submission');
                }

            } catch (fetchError) {
                console.error('\n❌ Error fetching from Notion:', fetchError.message);
            }
        }

        console.log('\n' + '='.repeat(80));
        console.log('CONTACT EXTRACTION TEST COMPLETE');
        console.log('='.repeat(80));

        await db.close();
        process.exit(0);

    } catch (error) {
        console.error('Error:', error);
        if (error.stack) console.error(error.stack);
        process.exit(1);
    }
}

testContactExtraction();
