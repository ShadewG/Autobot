/**
 * Check case 56 portal detection
 */
require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

async function checkCase56() {
    try {
        const result = await pool.query(
            'SELECT id, name, portal_url, portal_email, additional_details, full_page_text FROM cases WHERE id = $1',
            [56]
        );

        if (result.rows.length === 0) {
            console.log('Case 56 not found in database');
            process.exit(0);
        }

        const caseData = result.rows[0];
        console.log('=== Case 56 Details ===\n');
        console.log(`ID: ${caseData.id}`);
        console.log(`Name: ${caseData.name}`);
        console.log(`\nPortal URL: ${caseData.portal_url || 'NULL'}`);
        console.log(`Portal Email: ${caseData.portal_email || 'NULL'}`);
        console.log(`\nAdditional Details (first 500 chars):`);
        console.log(caseData.additional_details ? caseData.additional_details.substring(0, 500) : 'NULL');
        console.log(`\nFull Page Text (first 500 chars):`);
        console.log(caseData.full_page_text ? caseData.full_page_text.substring(0, 500) : 'NULL');

        // Check for portal patterns
        const allText = [
            caseData.additional_details || '',
            caseData.full_page_text || ''
        ].join('\n');

        console.log(`\n=== Portal Detection Analysis ===`);

        // Check for URLs
        const urlPattern = /https?:\/\/[^\s<>"{}|\\^`\[\]]+/gi;
        const urls = allText.match(urlPattern) || [];
        console.log(`\nFound ${urls.length} URLs:`);
        urls.forEach(url => console.log(`  - ${url}`));

        // Check for email addresses
        const emailPattern = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/gi;
        const emails = allText.match(emailPattern) || [];
        console.log(`\nFound ${emails.length} email addresses:`);
        emails.forEach(email => console.log(`  - ${email}`));

        // Check for portal-specific keywords
        const portalKeywords = ['portal', 'records request', 'public records', 'request form', 'submit', 'foia'];
        console.log(`\nPortal-related keywords found:`);
        portalKeywords.forEach(keyword => {
            if (allText.toLowerCase().includes(keyword)) {
                console.log(`  - "${keyword}" found`);
            }
        });

        await pool.end();
        process.exit(0);
    } catch (error) {
        console.error('Error:', error);
        await pool.end();
        process.exit(1);
    }
}

checkCase56();
