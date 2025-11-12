/**
 * Test querying Notion for "Ready to Send" status
 */
require('dotenv').config();
const { Client } = require('@notionhq/client');

const notion = new Client({ auth: process.env.NOTION_API_KEY });

async function testLiveStatusQuery() {
    try {
        const databaseId = process.env.NOTION_CASES_DATABASE_ID;

        console.log('Testing Live Status query...\n');
        console.log(`Database ID: ${databaseId}`);
        console.log(`Live Status Property: ${process.env.NOTION_LIVE_STATUS_PROPERTY || 'Live Status'}\n`);

        // First, get database schema
        console.log('1. Fetching database schema...');
        const database = await notion.databases.retrieve({
            database_id: databaseId
        });

        const liveStatusProp = process.env.NOTION_LIVE_STATUS_PROPERTY || 'Live Status';
        const statusProp = process.env.NOTION_STATUS_PROPERTY || 'Status';

        console.log(`\nAvailable properties:`);
        Object.keys(database.properties).forEach(propName => {
            const prop = database.properties[propName];
            console.log(`  - ${propName} (${prop.type})`);
        });

        console.log(`\n2. Checking "${liveStatusProp}" property...`);
        const liveStatusInfo = database.properties[liveStatusProp];
        if (liveStatusInfo) {
            console.log(`   Found: type = ${liveStatusInfo.type}`);
            if (liveStatusInfo.status) {
                console.log(`   Status options:`, liveStatusInfo.status.options.map(o => o.name));
            }
            if (liveStatusInfo.select) {
                console.log(`   Select options:`, liveStatusInfo.select.options.map(o => o.name));
            }
        } else {
            console.log(`   NOT FOUND - falling back to "${statusProp}"`);
            const statusInfo = database.properties[statusProp];
            if (statusInfo) {
                console.log(`   Found: type = ${statusInfo.type}`);
                if (statusInfo.status) {
                    console.log(`   Status options:`, statusInfo.status.options.map(o => o.name));
                }
                if (statusInfo.select) {
                    console.log(`   Select options:`, statusInfo.select.options.map(o => o.name));
                }
            }
        }

        // Try query with status type
        console.log(`\n3. Trying query with "status" filter...`);
        try {
            const response1 = await notion.databases.query({
                database_id: databaseId,
                filter: {
                    property: liveStatusInfo ? liveStatusProp : statusProp,
                    status: {
                        equals: 'Ready to Send'
                    }
                }
            });
            console.log(`   Result: Found ${response1.results.length} pages`);
            if (response1.results.length > 0) {
                response1.results.slice(0, 3).forEach(page => {
                    const name = page.properties.Name?.title?.[0]?.plain_text || 'Untitled';
                    console.log(`      - ${name}`);
                });
            }
        } catch (err) {
            console.log(`   Error: ${err.message}`);
        }

        // Try query with select type
        console.log(`\n4. Trying query with "select" filter...`);
        try {
            const response2 = await notion.databases.query({
                database_id: databaseId,
                filter: {
                    property: liveStatusInfo ? liveStatusProp : statusProp,
                    select: {
                        equals: 'Ready to Send'
                    }
                }
            });
            console.log(`   Result: Found ${response2.results.length} pages`);
            if (response2.results.length > 0) {
                response2.results.slice(0, 3).forEach(page => {
                    const name = page.properties.Name?.title?.[0]?.plain_text || 'Untitled';
                    console.log(`      - ${name}`);
                });
            }
        } catch (err) {
            console.log(`   Error: ${err.message}`);
        }

        // Query ALL pages and check their status values
        console.log(`\n5. Checking first 10 pages for their actual status values...`);
        const allPages = await notion.databases.query({
            database_id: databaseId,
            page_size: 10
        });

        allPages.results.forEach(page => {
            const name = page.properties.Name?.title?.[0]?.plain_text || 'Untitled';
            const liveStatus = page.properties[liveStatusProp]?.status?.name || page.properties[liveStatusProp]?.select?.name;
            const legacyStatus = page.properties[statusProp]?.status?.name || page.properties[statusProp]?.select?.name;
            console.log(`   ${name.substring(0, 50)}`);
            console.log(`      ${liveStatusProp}: ${liveStatus || 'null'}`);
            console.log(`      ${statusProp}: ${legacyStatus || 'null'}`);
        });

        process.exit(0);
    } catch (error) {
        console.error('Error:', error);
        process.exit(1);
    }
}

testLiveStatusQuery();
