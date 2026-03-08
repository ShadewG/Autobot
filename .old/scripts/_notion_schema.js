require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const { Client } = require('@notionhq/client');

async function main() {
  const apiKey = process.env.NOTION_API_KEY;
  const databaseId = process.env.NOTION_CASES_DATABASE_ID;

  if (!apiKey) throw new Error('Missing NOTION_API_KEY in .env');
  if (!databaseId) throw new Error('Missing NOTION_CASES_DATABASE_ID in .env');

  const notion = new Client({ auth: apiKey });
  const db = await notion.databases.retrieve({ database_id: databaseId });

  const properties = Object.entries(db.properties)
    .map(([name, prop]) => ({ name, type: prop.type }))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));

  console.log(`\nDatabase: ${db.title.map(t => t.plain_text).join('')}`);
  console.log(`ID: ${databaseId}`);
  console.log(`Total properties: ${properties.length}\n`);
  console.log('─'.repeat(60));

  for (const { name, type } of properties) {
    console.log(`${name}: ${type}`);
  }

  console.log('─'.repeat(60));
  console.log(`\n${properties.length} properties total`);
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
