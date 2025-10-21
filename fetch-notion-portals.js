/**
 * Fetch portal URLs from Notion database
 */

require('dotenv').config();
const { Client } = require('@notionhq/client');

const notion = new Client({ auth: process.env.NOTION_API_KEY });
const databaseId = process.env.NOTION_CASES_DATABASE_ID;

async function fetchPortalUrls() {
    console.log('🔍 Fetching portal URLs from Notion...\n');

    try {
        // Query all pages from the database
        let allResults = [];
        let hasMore = true;
        let startCursor = undefined;

        while (hasMore) {
            const response = await notion.databases.query({
                database_id: databaseId,
                start_cursor: startCursor,
                page_size: 100
            });

            allResults = allResults.concat(response.results);
            hasMore = response.has_more;
            startCursor = response.next_cursor;
        }

        console.log(`Found ${allResults.length} total entries in Notion\n`);

        // Extract portal URLs
        const portals = [];

        for (const page of allResults) {
            const props = page.properties;

            // Try different possible property names for portal URL
            let portalUrl = null;
            const urlProperties = [
                'Portal URL',
                'Portal Link',
                'Portal',
                'FOIA Portal',
                'Submission Portal',
                'Request Portal',
                'Agency Portal',
                'URL'
            ];

            for (const propName of urlProperties) {
                if (props[propName]) {
                    const prop = props[propName];
                    if (prop.url) {
                        portalUrl = prop.url;
                        break;
                    } else if (prop.rich_text && prop.rich_text.length > 0) {
                        portalUrl = prop.rich_text[0].plain_text;
                        break;
                    }
                }
            }

            if (portalUrl && portalUrl.startsWith('http')) {
                // Get agency name for reference
                let agencyName = 'Unknown';
                const agencyProps = ['Agency Name', 'Agency', 'Department', 'Police Department'];

                for (const propName of agencyProps) {
                    if (props[propName]) {
                        const prop = props[propName];
                        if (prop.title && prop.title.length > 0) {
                            agencyName = prop.title[0].plain_text;
                            break;
                        } else if (prop.rich_text && prop.rich_text.length > 0) {
                            agencyName = prop.rich_text[0].plain_text;
                            break;
                        }
                    }
                }

                portals.push({
                    url: portalUrl,
                    agency: agencyName,
                    notionId: page.id
                });
            }
        }

        console.log(`✅ Found ${portals.length} entries with portal URLs\n`);

        // Show first few
        console.log('Sample portals:');
        portals.slice(0, 5).forEach((p, i) => {
            console.log(`${i + 1}. ${p.agency}`);
            console.log(`   ${p.url}\n`);
        });

        // Save to file
        const fs = require('fs');
        fs.writeFileSync(
            'portal-urls.json',
            JSON.stringify(portals, null, 2)
        );

        console.log(`\n📝 Saved ${portals.length} portal URLs to portal-urls.json`);

        return portals;

    } catch (error) {
        console.error('❌ Error fetching from Notion:', error.message);

        if (error.code === 'object_not_found') {
            console.error('\nThe database was not found. Check:');
            console.error('1. NOTION_CASES_DATABASE_ID is correct in .env');
            console.error('2. The Notion integration has access to this database');
        }

        throw error;
    }
}

// Run if executed directly
if (require.main === module) {
    fetchPortalUrls()
        .then(portals => {
            console.log(`\n✅ Success! Found ${portals.length} portals`);
            process.exit(0);
        })
        .catch(error => {
            console.error('\n❌ Failed:', error.message);
            process.exit(1);
        });
}

module.exports = { fetchPortalUrls };
