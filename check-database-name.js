/**
 * Check what database we're actually querying
 */
require('dotenv').config();
const { Client } = require('@notionhq/client');

const notion = new Client({ auth: process.env.NOTION_API_KEY });

async function checkDatabaseName() {
    try {
        const databaseId = process.env.NOTION_CASES_DATABASE_ID;

        console.log(`Database ID: ${databaseId}\n`);

        const database = await notion.databases.retrieve({
            database_id: databaseId
        });

        console.log(`Database Name: ${database.title?.[0]?.plain_text || 'Unknown'}`);
        console.log(`URL: https://notion.so/${databaseId.replace(/-/g, '')}`);

        process.exit(0);
    } catch (error) {
        console.error('Error:', error);
        process.exit(1);
    }
}

checkDatabaseName();
