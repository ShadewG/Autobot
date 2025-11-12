/**
 * Debug Notion query - find out exactly what's going on
 */
require('dotenv').config();
const { Client } = require('@notionhq/client');

const notion = new Client({ auth: process.env.NOTION_API_KEY });

async function debugQuery() {
    try {
        const databaseId = process.env.NOTION_CASES_DATABASE_ID;

        console.log('=== NOTION QUERY DEBUG ===\n');
        console.log(`Database ID: ${databaseId}`);
        console.log(`Looking for property: "Live Status"`);
        console.log(`Looking for value: "Ready to Send"`);

        // Get first 10 pages to see what's there
        console.log('\n1. Getting all pages (no filter)...\n');
        const allResponse = await notion.databases.query({
            database_id: databaseId,
            page_size: 10
        });

        console.log(`Found ${allResponse.results.length} pages total\n`);

        allResponse.results.forEach((page, idx) => {
            const name = page.properties.Name?.title?.[0]?.plain_text || 'Untitled';
            const liveStatus = page.properties['Live Status']?.select?.name;
            console.log(`${idx + 1}. ${name.substring(0, 60)}`);
            console.log(`   Live Status: "${liveStatus || 'null'}"`);
        });

        // Now try the filtered query
        console.log('\n\n2. Trying filtered query...\n');

        try {
            const filteredResponse = await notion.databases.query({
                database_id: databaseId,
                filter: {
                    property: 'Live Status',
                    select: {
                        equals: 'Ready to Send'
                    }
                }
            });

            console.log(`✅ Query succeeded! Found ${filteredResponse.results.length} pages\n`);

            if (filteredResponse.results.length > 0) {
                console.log('Pages with "Ready to Send":');
                filteredResponse.results.forEach((page, idx) => {
                    const name = page.properties.Name?.title?.[0]?.plain_text || 'Untitled';
                    console.log(`  ${idx + 1}. ${name}`);
                });
            } else {
                console.log('⚠️  Query succeeded but found 0 pages');
                console.log('\nPossible issues:');
                console.log('  - Value is not exactly "Ready to Send" (check capitalization/spaces)');
                console.log('  - Property name is not exactly "Live Status"');
                console.log('  - No pages actually have that status');
            }

        } catch (filterError) {
            console.error('❌ Filtered query failed:', filterError.message);
        }

        process.exit(0);
    } catch (error) {
        console.error('Error:', error);
        process.exit(1);
    }
}

debugQuery();
