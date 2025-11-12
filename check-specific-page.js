/**
 * Check specific Notion page
 */
require('dotenv').config();
const { Client } = require('@notionhq/client');

const notion = new Client({ auth: process.env.NOTION_API_KEY });

async function checkPage() {
    try {
        // Extract page ID from URL
        const pageId = '22387c20-070a-8067-84e5-c0a508e197f3';

        console.log(`Checking page: ${pageId}\n`);

        const page = await notion.pages.retrieve({ page_id: pageId });

        console.log('Page properties:');
        Object.entries(page.properties).forEach(([name, prop]) => {
            console.log(`\n  ${name} (${prop.type}):`);

            switch (prop.type) {
                case 'title':
                    console.log(`    Value: ${prop.title?.[0]?.plain_text || 'null'}`);
                    break;
                case 'rich_text':
                    console.log(`    Value: ${prop.rich_text?.[0]?.plain_text || 'null'}`);
                    break;
                case 'select':
                    console.log(`    Value: ${prop.select?.name || 'null'}`);
                    break;
                case 'status':
                    console.log(`    Value: ${prop.status?.name || 'null'}`);
                    break;
                case 'date':
                    console.log(`    Value: ${prop.date?.start || 'null'}`);
                    break;
                case 'number':
                    console.log(`    Value: ${prop.number || 'null'}`);
                    break;
                case 'email':
                    console.log(`    Value: ${prop.email || 'null'}`);
                    break;
                case 'url':
                    console.log(`    Value: ${prop.url || 'null'}`);
                    break;
                case 'relation':
                    console.log(`    Relations: ${prop.relation?.length || 0}`);
                    break;
                default:
                    console.log(`    (complex type)`);
            }
        });

        // Now check if it matches our query
        console.log('\n\n=== CHECKING QUERY ===\n');

        const databaseId = process.env.NOTION_CASES_DATABASE_ID;
        const liveStatusProp = process.env.NOTION_LIVE_STATUS_PROPERTY || 'Live Status';

        console.log(`Database ID: ${databaseId}`);
        console.log(`Live Status Property: ${liveStatusProp}`);
        console.log(`Looking for value: "Ready to Send"`);

        // Get database schema first
        const database = await notion.databases.retrieve({ database_id: databaseId });
        const propInfo = database.properties[liveStatusProp];

        console.log(`\nProperty type in schema: ${propInfo?.type || 'NOT FOUND'}`);

        if (propInfo) {
            const filterKey = propInfo.type === 'status' ? 'status' : 'select';
            console.log(`Using filter key: ${filterKey}`);

            try {
                const response = await notion.databases.query({
                    database_id: databaseId,
                    filter: {
                        property: liveStatusProp,
                        [filterKey]: {
                            equals: 'Ready to Send'
                        }
                    }
                });

                console.log(`\nQuery result: ${response.results.length} pages found`);

                const foundThisPage = response.results.find(p => p.id === page.id);
                if (foundThisPage) {
                    console.log('✅ This page WAS found in the query!');
                } else {
                    console.log('❌ This page was NOT found in the query');
                    console.log('\nPages that were found:');
                    response.results.slice(0, 5).forEach(p => {
                        const name = p.properties.Name?.title?.[0]?.plain_text || 'Untitled';
                        console.log(`  - ${name}`);
                    });
                }
            } catch (queryError) {
                console.error('Query error:', queryError.message);
            }
        }

        process.exit(0);
    } catch (error) {
        console.error('Error:', error);
        process.exit(1);
    }
}

checkPage();
