/**
 * Test case 56 contact information
 */
require('dotenv').config();
const { Pool } = require('pg');
const { normalizePortalUrl, isSupportedPortalUrl } = require('./utils/portal-utils');
const { isValidEmail } = require('./utils/contact-utils');

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

async function testCase56Contact() {
    try {
        const result = await pool.query(
            'SELECT id, name, portal_url, portal_email, agency_email, alternate_agency_email FROM cases WHERE id = $1',
            [56]
        );

        if (result.rows.length === 0) {
            console.log('Case 56 not found in database');
            await pool.end();
            process.exit(0);
        }

        const caseData = result.rows[0];
        console.log('=== Case 56 Contact Information ===\n');
        console.log(`ID: ${caseData.id}`);
        console.log(`Name: ${caseData.name}`);
        console.log(`\n--- Portal Information ---`);
        console.log(`Raw Portal URL: "${caseData.portal_url || 'NULL'}"`);

        const portalUrl = normalizePortalUrl(caseData.portal_url);
        console.log(`Normalized Portal URL: "${portalUrl || 'NULL'}"`);

        if (portalUrl) {
            const isSupported = isSupportedPortalUrl(portalUrl);
            console.log(`Is Supported: ${isSupported}`);
            if (!isSupported) {
                console.log(`⚠️ Portal URL exists but is NOT in the supported list!`);
            }
        } else {
            console.log(`⚠️ No portal URL found!`);
        }

        console.log(`\n--- Email Information ---`);
        console.log(`Portal Email: "${caseData.portal_email || 'NULL'}"`);
        console.log(`  Valid: ${isValidEmail(caseData.portal_email)}`);

        console.log(`Agency Email: "${caseData.agency_email || 'NULL'}"`);
        console.log(`  Valid: ${isValidEmail(caseData.agency_email)}`);

        console.log(`Alternate Agency Email: "${caseData.alternate_agency_email || 'NULL'}"`);
        console.log(`  Valid: ${isValidEmail(caseData.alternate_agency_email)}`);

        // Simulate the pickBestEmail logic
        const candidates = [];
        if (caseData.agency_email && isValidEmail(caseData.agency_email)) {
            candidates.push(caseData.agency_email.trim());
        }
        if (caseData.alternate_agency_email && isValidEmail(caseData.alternate_agency_email)) {
            candidates.push(caseData.alternate_agency_email.trim());
        }

        console.log(`\n--- Queue Logic Analysis ---`);
        console.log(`Best Email (pickBestEmail): "${candidates[0] || 'NULL'}"`);

        const hasPortal = portalUrl && isSupportedPortalUrl(portalUrl);
        const hasEmail = candidates.length > 0;

        console.log(`\nWould submit via portal: ${hasPortal}`);
        console.log(`Would submit via email: ${!hasPortal && hasEmail}`);
        console.log(`Would mark as needs_human_review: ${!hasPortal && !hasEmail}`);

        if (!hasPortal && !hasEmail) {
            console.log(`\n❌ THIS IS WHY IT'S MARKED AS "No valid portal or email contact detected"`);
        }

        await pool.end();
        process.exit(0);
    } catch (error) {
        console.error('Error:', error);
        await pool.end();
        process.exit(1);
    }
}

testCase56Contact();
