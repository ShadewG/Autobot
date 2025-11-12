/**
 * Find all pages with non-empty Live Status
 */
require('dotenv').config();
const { Client } = require('@notionhq/client');

const notion = new Client({ auth: process.env.NOTION_API_KEY });

async function findLiveStatus() {
    try {
        const databaseId = process.env.NOTION_CASES_DATABASE_ID;

        console.log('Searching for pages with non-empty Live Status...\n');

        // Query for pages where Live Status is not empty
        try {
            const response = await notion.databases.query({
                database_id: databaseId,
                filter: {
                    property: 'Live Status',
                    select: {
                        is_not_empty: true
                    }
                }
            });

            console.log(`Found ${response.results.length} pages with non-empty Live Status\n`);

            if (response.results.length === 0) {
                console.log('No pages found with Live Status set!');
            } else {
                console.log('Pages with Live Status:');
                response.results.forEach((page, idx) => {
                    const name = page.properties.Name?.title?.[0]?.plain_text || 'Untitled';
                    const liveStatus = page.properties['Live Status']?.select?.name || page.properties['Live Status']?.status?.name;
                    console.log(`${idx + 1}. ${name.substring(0, 70)}`);
                    console.log(`   Live Status: "${liveStatus}"`);
                    console.log(`   Page ID: ${page.id}`);
                    console.log('');
                });

                // Group by status value
                console.log('\nLive Status value breakdown:');
                const statusCounts = {};
                response.results.forEach(page => {
                    const liveStatus = page.properties['Live Status']?.select?.name || page.properties['Live Status']?.status?.name || 'unknown';
                    statusCounts[liveStatus] = (statusCounts[liveStatus] || 0) + 1;
                });

                Object.entries(statusCounts)
                    .sort((a, b) => b[1] - a[1])
                    .forEach(([status, count]) => {
                        console.log(`  "${status}": ${count}`);
                    });
            }

        } catch (filterError) {
            console.error('Filter query failed:', filterError.message);
            console.log('\nTrying to get all pages and filter manually...');

            let allPages = [];
            let hasMore = true;
            let startCursor = undefined;

            while (hasMore && allPages.length < 100) {
                const response = await notion.databases.query({
                    database_id: databaseId,
                    start_cursor: startCursor,
                    page_size: 100
                });
                allPages = allPages.concat(response.results);
                hasMore = response.has_more;
                startCursor = response.next_cursor;
            }

            const pagesWithStatus = allPages.filter(page => {
                const liveStatus = page.properties['Live Status']?.select?.name || page.properties['Live Status']?.status?.name;
                return liveStatus && liveStatus.length > 0;
            });

            console.log(`\nFound ${pagesWithStatus.length} pages with Live Status out of ${allPages.length} total\n`);

            pagesWithStatus.slice(0, 20).forEach((page, idx) => {
                const name = page.properties.Name?.title?.[0]?.plain_text || 'Untitled';
                const liveStatus = page.properties['Live Status']?.select?.name || page.properties['Live Status']?.status?.name;
                console.log(`${idx + 1}. ${name.substring(0, 70)}`);
                console.log(`   Live Status: "${liveStatus}"`);
                console.log('');
            });
        }

        process.exit(0);
    } catch (error) {
        console.error('Error:', error);
        process.exit(1);
    }
}

findLiveStatus();
