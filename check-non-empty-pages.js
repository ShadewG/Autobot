/**
 * Check pages that have actual content
 */
require('dotenv').config();
const { Client } = require('@notionhq/client');

const notion = new Client({ auth: process.env.NOTION_API_KEY });

async function checkNonEmptyPages() {
    try {
        const databaseId = process.env.NOTION_CASES_DATABASE_ID;

        console.log('Finding non-empty pages...\n');

        // Get all pages
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

        console.log(`Total pages: ${allPages.length}\n`);

        // Filter to non-empty pages (have a title)
        const nonEmptyPages = allPages.filter(page => {
            const title = page.properties.Name?.title?.[0]?.plain_text;
            return title && title !== 'Untitled' && title.length > 0;
        });

        console.log(`Non-empty pages: ${nonEmptyPages.length}\n`);

        if (nonEmptyPages.length === 0) {
            console.log('No non-empty pages found!');
            process.exit(0);
        }

        // Show first 10 non-empty pages
        console.log('First 10 non-empty pages:\n');
        nonEmptyPages.slice(0, 10).forEach((page, idx) => {
            const name = page.properties.Name?.title?.[0]?.plain_text || 'Untitled';
            const liveStatus = page.properties['Live Status']?.select?.name || page.properties['Live Status']?.status?.name;
            const status = page.properties['Status']?.select?.name || page.properties['Status']?.status?.name;

            console.log(`${idx + 1}. ${name.substring(0, 70)}`);
            console.log(`   Live Status: "${liveStatus || 'null'}"`);
            console.log(`   Status: "${status || 'null'}"`);
            console.log('');
        });

        // Count by Live Status
        console.log('\nLive Status breakdown:');
        const liveStatusCounts = {};
        nonEmptyPages.forEach(page => {
            const liveStatus = page.properties['Live Status']?.select?.name || page.properties['Live Status']?.status?.name || 'null';
            liveStatusCounts[liveStatus] = (liveStatusCounts[liveStatus] || 0) + 1;
        });

        Object.entries(liveStatusCounts)
            .sort((a, b) => b[1] - a[1])
            .forEach(([status, count]) => {
                console.log(`  ${status}: ${count}`);
            });

        process.exit(0);
    } catch (error) {
        console.error('Error:', error);
        process.exit(1);
    }
}

checkNonEmptyPages();
