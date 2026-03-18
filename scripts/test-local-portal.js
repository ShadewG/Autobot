#!/usr/bin/env node
/**
 * Test local Playwright portal submission.
 *
 * Usage:
 *   node scripts/test-local-portal.js <portal-url> [case-id]
 *   node scripts/test-local-portal.js https://somecity.govqa.us/WEBAPP/_rs/RequestSubmission
 *   node scripts/test-local-portal.js https://somecity.govqa.us/... 123 --dry-run
 *
 * Options:
 *   --dry-run       Navigate and fill but don't submit
 *   --headed        Show the browser window (requires DISPLAY or Xvfb)
 *   --browserbase   Force Browserbase backend instead of local
 */

require('dotenv').config();

const portalUrl = process.argv[2];
if (!portalUrl) {
    console.error('Usage: node scripts/test-local-portal.js <portal-url> [case-id] [--dry-run] [--headed] [--browserbase]');
    process.exit(1);
}

const caseId = process.argv[3] && !process.argv[3].startsWith('--') ? parseInt(process.argv[3], 10) : null;
const dryRun = process.argv.includes('--dry-run');
const headed = process.argv.includes('--headed');
const useBrowserbase = process.argv.includes('--browserbase');

async function main() {
    const db = require('../services/database');
    const playwright = require('../services/portal-agent-service-playwright');

    let caseData;
    if (caseId) {
        caseData = await db.getCaseById(caseId);
        if (!caseData) {
            console.error(`Case ${caseId} not found`);
            process.exit(1);
        }
        console.log(`Using case: ${caseData.case_name} (id=${caseId})`);
    } else {
        // Minimal mock case for testing navigation
        caseData = {
            id: 0,
            case_name: 'Test Portal Run',
            portal_url: portalUrl,
            portal_provider: null,
            requester_first_name: 'Test',
            requester_last_name: 'User',
            requester_email: process.env.REQUESTS_INBOX || 'test@example.com',
        };
        console.log('No case ID — using mock case data for navigation test');
    }

    console.log(`Portal URL: ${portalUrl}`);
    console.log(`Backend: ${useBrowserbase ? 'browserbase' : 'local'}`);
    console.log(`Dry run: ${dryRun}`);
    console.log(`Headed: ${headed}`);
    console.log('---');

    const startTime = Date.now();
    try {
        const result = await playwright.submitToPortal(caseData, portalUrl, {
            dryRun,
            trackInAutobot: false,
            ensureAccount: true,
            forceAccountSetup: false,
            headless: !headed,
            browserBackend: useBrowserbase ? 'browserbase' : 'local',
        });

        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        console.log(`\n--- Result (${elapsed}s) ---`);
        console.log(JSON.stringify(result, null, 2));
        process.exit(result?.success ? 0 : 1);
    } catch (err) {
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        console.error(`\n--- Error (${elapsed}s) ---`);
        console.error(err.message || err);
        process.exit(1);
    }
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
