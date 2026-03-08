/**
 * Debug script: reproduce the silent import failure for Notion page 26387c20-070a-8018-8e87-fa83136f07c5
 *
 * Usage: DATABASE_PUBLIC_URL=... NOTION_API_KEY=... node scripts/_debug_notion_import.js
 */

const PAGE_ID = '26387c20-070a-8018-8e87-fa83136f07c5';
const STRIPPED_ID = PAGE_ID.replace(/-/g, '');

async function main() {
    // Override DATABASE_URL with public URL for local access
    if (process.env.DATABASE_PUBLIC_URL) {
        process.env.DATABASE_URL = process.env.DATABASE_PUBLIC_URL;
    }

    console.log('=== Debug Notion Import ===');
    console.log('Page ID:', PAGE_ID);
    console.log('Stripped ID:', STRIPPED_ID);
    console.log('DATABASE_URL set:', !!process.env.DATABASE_URL);
    console.log('NOTION_API_KEY set:', !!process.env.NOTION_API_KEY);
    console.log('');

    // Step 1: Check if case already exists
    const db = require('../services/database');
    console.log('--- Step 1: Check if case already exists ---');
    try {
        const existing1 = await db.getCaseByNotionId(PAGE_ID);
        const existing2 = await db.getCaseByNotionId(STRIPPED_ID);
        console.log('Exists (hyphenated):', existing1 ? `YES - case ${existing1.id}` : 'NO');
        console.log('Exists (stripped):', existing2 ? `YES - case ${existing2.id}` : 'NO');
        if (existing1 || existing2) {
            console.log('\nCase already exists, processSinglePage would return early.');
            const c = existing1 || existing2;
            console.log('Case details:', JSON.stringify({ id: c.id, case_name: c.case_name, status: c.status, created_at: c.created_at }, null, 2));
            process.exit(0);
        }
    } catch (err) {
        console.error('DB lookup error:', err.message);
    }
    console.log('');

    // Step 2: Check webhook activity logs
    console.log('--- Step 2: Check webhook activity logs ---');
    try {
        const logs = await db.query(
            `SELECT id, action, description, details, created_at
             FROM activity_log
             WHERE (details::text LIKE $1 OR details::text LIKE $2 OR description LIKE $3)
             ORDER BY created_at DESC LIMIT 10`,
            [`%${PAGE_ID}%`, `%${STRIPPED_ID}%`, `%${PAGE_ID}%`]
        );
        if (logs.rows.length > 0) {
            console.log(`Found ${logs.rows.length} activity log entries:`);
            for (const row of logs.rows) {
                console.log(`  [${row.created_at}] ${row.action}: ${row.description}`);
                if (row.details) {
                    const d = typeof row.details === 'string' ? JSON.parse(row.details) : row.details;
                    console.log(`    Details:`, JSON.stringify(d, null, 4));
                }
            }
        } else {
            console.log('No activity logs found for this page ID');
        }
    } catch (err) {
        console.error('Activity log query error:', err.message);
    }
    console.log('');

    // Step 3: Try fetching the Notion page directly
    console.log('--- Step 3: Fetch Notion page directly ---');
    const { Client } = require('@notionhq/client');
    const notion = new Client({ auth: process.env.NOTION_API_KEY });

    let page;
    try {
        page = await notion.pages.retrieve({ page_id: STRIPPED_ID });
        console.log('Page retrieved successfully');
        console.log('Page ID:', page.id);
        console.log('Archived:', page.archived);
        console.log('Created:', page.created_time);
        console.log('Last edited:', page.last_edited_time);
        console.log('Parent type:', page.parent?.type);
        console.log('Parent database:', page.parent?.database_id);
        console.log('');

        // Print all property names and types
        console.log('Properties:');
        for (const [name, prop] of Object.entries(page.properties)) {
            let value = '<empty>';
            if (prop.type === 'title') value = prop.title?.[0]?.plain_text || '<no title>';
            else if (prop.type === 'rich_text') value = prop.rich_text?.map(t => t.plain_text).join('') || '<empty>';
            else if (prop.type === 'select') value = prop.select?.name || '<none>';
            else if (prop.type === 'multi_select') value = prop.multi_select?.map(s => s.name).join(', ') || '<none>';
            else if (prop.type === 'status') value = prop.status?.name || '<none>';
            else if (prop.type === 'date') value = prop.date?.start || '<none>';
            else if (prop.type === 'url') value = prop.url || '<none>';
            else if (prop.type === 'email') value = prop.email || '<none>';
            else if (prop.type === 'relation') value = `[${prop.relation?.length || 0} relations] ${prop.relation?.map(r => r.id).join(', ')}`;
            else if (prop.type === 'people') value = prop.people?.map(p => p.name || p.id).join(', ') || '<none>';
            else if (prop.type === 'checkbox') value = prop.checkbox;
            else if (prop.type === 'number') value = prop.number;
            else if (prop.type === 'rollup') value = `[rollup: ${prop.rollup?.type}]`;
            else if (prop.type === 'formula') value = `[formula: ${JSON.stringify(prop.formula)}]`;
            else value = `[${prop.type}]`;

            console.log(`  "${name}" (${prop.type}): ${value}`);
        }
    } catch (err) {
        console.error('Failed to fetch Notion page:', err.message);
        console.error('Full error:', err);
        process.exit(1);
    }
    console.log('');

    // Step 4: Call processSinglePage and capture the full error
    console.log('--- Step 4: Call processSinglePage ---');
    try {
        const notionService = require('../services/notion-service');
        const result = await notionService.processSinglePage(STRIPPED_ID);

        if (result) {
            console.log('SUCCESS: processSinglePage returned a case');
            console.log('Case ID:', result.id);
            console.log('Case name:', result.case_name);
            console.log('Status:', result.status);
            console.log('Agency:', result.agency_name);
            console.log('Email:', result.agency_email);
            console.log('State:', result.state);
        } else {
            console.log('FAILURE: processSinglePage returned null/undefined');
            console.log('Return value:', result);
        }
    } catch (err) {
        console.error('ERROR in processSinglePage:');
        console.error('Message:', err.message);
        console.error('Code:', err.code);
        console.error('');
        console.error('Full stack trace:');
        console.error(err.stack);
        console.error('');

        // If it's a DB error, show more details
        if (err.detail) console.error('DB Detail:', err.detail);
        if (err.constraint) console.error('DB Constraint:', err.constraint);
        if (err.table) console.error('DB Table:', err.table);
        if (err.column) console.error('DB Column:', err.column);
        if (err.dataType) console.error('DB DataType:', err.dataType);
        if (err.where) console.error('DB Where:', err.where);
        if (err.hint) console.error('DB Hint:', err.hint);

        // If Notion API error
        if (err.status) console.error('HTTP Status:', err.status);
        if (err.body) console.error('Response body:', JSON.stringify(err.body, null, 2));
    }

    // Cleanup
    try {
        await db.pool.end();
    } catch (_) {}
    process.exit(0);
}

main().catch(err => {
    console.error('Unhandled error:', err);
    process.exit(1);
});
