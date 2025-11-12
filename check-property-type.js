/**
 * Check the type and details of the Live Status property
 */
require('dotenv').config();
const { Client } = require('@notionhq/client');

const notion = new Client({ auth: process.env.NOTION_API_KEY });

async function checkPropertyType() {
    try {
        const databaseId = process.env.NOTION_CASES_DATABASE_ID;

        console.log('Fetching database schema...\n');

        const database = await notion.databases.retrieve({
            database_id: databaseId
        });

        console.log(`Database: ${database.title?.[0]?.plain_text || 'Unknown'}\n`);

        // Check Live Status property
        const liveStatusProp = database.properties['Live Status'];
        if (liveStatusProp) {
            console.log('=== Live Status Property ===');
            console.log(`Type: ${liveStatusProp.type}`);
            console.log(`Full property:`, JSON.stringify(liveStatusProp, null, 2));

            if (liveStatusProp[liveStatusProp.type]?.options) {
                console.log(`\nOptions:`);
                liveStatusProp[liveStatusProp.type].options.forEach(opt => {
                    console.log(`  - "${opt.name}"`);
                });
            }
        } else {
            console.log('Live Status property not found!');
        }

        // Also check the legacy Status property
        console.log('\n=== Legacy Status Property ===');
        const statusProp = database.properties['Status'];
        if (statusProp) {
            console.log(`Type: ${statusProp.type}`);
            console.log(`Full property:`, JSON.stringify(statusProp, null, 2));

            if (statusProp[statusProp.type]?.options) {
                console.log(`\nOptions:`);
                statusProp[statusProp.type].options.forEach(opt => {
                    console.log(`  - "${opt.name}"`);
                });
            }
        } else {
            console.log('Status property not found');
        }

        process.exit(0);
    } catch (error) {
        console.error('Error:', error);
        process.exit(1);
    }
}

checkPropertyType();
