/**
 * Check what properties exist on the pages
 */
require('dotenv').config();
const { Client } = require('@notionhq/client');

const notion = new Client({ auth: process.env.NOTION_API_KEY });

async function checkProperties() {
    try {
        const databaseId = process.env.NOTION_CASES_DATABASE_ID;

        console.log('Checking database properties...\n');

        // Get database schema
        const database = await notion.databases.retrieve({
            database_id: databaseId
        });

        console.log('Database title:', database.title?.[0]?.plain_text || 'Unknown');
        console.log('\nAll properties in database:');
        Object.keys(database.properties).forEach(propName => {
            const prop = database.properties[propName];
            console.log(`  - "${propName}" (${prop.type})`);
        });

        // Get first page
        const pages = await notion.databases.query({
            database_id: databaseId,
            page_size: 1
        });

        if (pages.results.length > 0) {
            const page = pages.results[0];
            console.log('\n\nFirst page properties with values:');
            Object.entries(page.properties).forEach(([name, prop]) => {
                let value = 'null';
                switch (prop.type) {
                    case 'title':
                        value = prop.title?.[0]?.plain_text || 'null';
                        break;
                    case 'select':
                        value = prop.select?.name || 'null';
                        break;
                    case 'status':
                        value = prop.status?.name || 'null';
                        break;
                    case 'rich_text':
                        value = prop.rich_text?.[0]?.plain_text || 'null';
                        break;
                    case 'date':
                        value = prop.date?.start || 'null';
                        break;
                }
                if (value !== 'null') {
                    console.log(`  "${name}": ${value}`);
                }
            });
        }

        process.exit(0);
    } catch (error) {
        console.error('Error:', error);
        process.exit(1);
    }
}

checkProperties();
