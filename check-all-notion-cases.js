/**
 * Check all cases in Notion database regardless of status
 */
require('dotenv').config();
const { Client } = require('@notionhq/client');

const notion = new Client({ auth: process.env.NOTION_API_KEY });

async function checkAllCases() {
    try {
        const databaseId = process.env.NOTION_CASES_DATABASE_ID;

        console.log('Querying ALL cases in Notion...\n');

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

        console.log(`Total cases found: ${allPages.length}\n`);
        console.log('Status breakdown:');

        const statusCounts = {};
        for (const page of allPages) {
            const status = page.properties.Status?.status?.name || 'No Status';
            statusCounts[status] = (statusCounts[status] || 0) + 1;
        }

        Object.entries(statusCounts)
            .sort((a, b) => b[1] - a[1])
            .forEach(([status, count]) => {
                console.log(`  ${status}: ${count}`);
            });

        console.log('\nAll cases:');
        allPages.forEach((page, index) => {
            const name = page.properties.Name?.title?.[0]?.plain_text || 'Untitled';
            const status = page.properties.Status?.status?.name || 'No Status';
            console.log(`${index + 1}. ${name.substring(0, 60)}... | Status: ${status}`);
        });

        process.exit(0);
    } catch (error) {
        console.error('Error:', error);
        process.exit(1);
    }
}

checkAllCases();
