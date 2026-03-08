require('dotenv').config();

// Override DATABASE_URL for local access (Railway public URL)
if (!process.env.DATABASE_URL || process.env.DATABASE_URL.includes('railway.internal')) {
    process.env.DATABASE_URL = process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL;
}

// Ensure workflow ID is set
if (!process.env.SKYVERN_WORKFLOW_ID) {
    process.env.SKYVERN_WORKFLOW_ID = 'wpid_461535111447599002';
}

const portalAgentService = require('../services/portal-agent-service-skyvern');
const database = require('../services/database');
const fs = require('fs');
const path = require('path');

const RESULTS_DIR = path.join(__dirname, '..', 'portal-run-results');

/**
 * Run all pending portal cases one by one through Skyvern workflow.
 * Captures full output for both success and failure cases.
 */
async function runPendingPortals() {
    console.log('='.repeat(70));
    console.log('  SKYVERN PORTAL SUBMISSION - BATCH RUNNER');
    console.log('  Running pending portal cases one by one');
    console.log('='.repeat(70));
    console.log();

    // Create results directory
    if (!fs.existsSync(RESULTS_DIR)) {
        fs.mkdirSync(RESULTS_DIR, { recursive: true });
    }

    // Query pending portal cases
    console.log('Querying database for pending portal cases...\n');
    const casesResult = await database.query(`
        SELECT id, case_name, subject_name, agency_name, agency_email, state,
               incident_date, incident_location, requested_records, additional_details,
               portal_url, portal_provider, status, substatus,
               last_portal_status, last_portal_engine, deadline_date, notion_page_id
        FROM cases
        WHERE portal_url IS NOT NULL
          AND portal_url != ''
          AND portal_url NOT LIKE '%kten.com%'
          AND portal_url NOT LIKE '%mynorthernwisconsin%'
          AND portal_url NOT LIKE '%greeleytribune%'
          AND substatus ILIKE '%portal%'
          AND (last_portal_engine IS NULL OR last_portal_engine = '')
        ORDER BY id
    `);

    const cases = casesResult.rows;
    console.log(`Found ${cases.length} cases pending portal submission.\n`);

    if (cases.length === 0) {
        console.log('No pending portal cases found. Exiting.');
        process.exit(0);
    }

    // Print summary
    console.log('-'.repeat(70));
    cases.forEach((c, i) => {
        console.log(`  ${i + 1}. Case #${c.id}: ${c.case_name.substring(0, 60)}...`);
        console.log(`     Agency: ${c.agency_name} | Portal: ${c.portal_url.substring(0, 50)}...`);
    });
    console.log('-'.repeat(70));
    console.log();

    const allResults = [];
    let successCount = 0;
    let failCount = 0;

    for (let i = 0; i < cases.length; i++) {
        const caseData = cases[i];
        const caseLabel = `[${i + 1}/${cases.length}] Case #${caseData.id}`;

        console.log('\n' + '='.repeat(70));
        console.log(`  ${caseLabel}: ${caseData.case_name.substring(0, 55)}`);
        console.log(`  Agency: ${caseData.agency_name}`);
        console.log(`  Portal: ${caseData.portal_url}`);
        console.log(`  Subject: ${caseData.subject_name || 'N/A'}`);
        console.log(`  State: ${caseData.state || 'N/A'}`);
        console.log('='.repeat(70));
        console.log();

        const startTime = Date.now();
        let result = null;
        let error = null;

        try {
            console.log(`Starting Skyvern workflow submission...`);
            result = await portalAgentService.submitToPortal(caseData, caseData.portal_url, {
                dryRun: false
            });

            console.log(`\n--- SKYVERN RESULT ---`);
            console.log(JSON.stringify(result, null, 2));
            console.log(`--- END RESULT ---\n`);

            if (result.success) {
                successCount++;
                console.log(`SUCCESS for Case #${caseData.id}`);
                if (result.workflow_url) console.log(`  Workflow URL: ${result.workflow_url}`);
                if (result.recording_url) console.log(`  Recording: ${result.recording_url}`);
                if (result.extracted_data) console.log(`  Extracted data: ${JSON.stringify(result.extracted_data).substring(0, 200)}`);
            } else {
                failCount++;
                console.log(`FAILED for Case #${caseData.id}`);
                console.log(`  Error: ${result.error || 'Unknown error'}`);
                if (result.workflow_url) console.log(`  Workflow URL: ${result.workflow_url}`);
                if (result.recording_url) console.log(`  Recording: ${result.recording_url}`);
                if (result.workflow_response) {
                    console.log(`  Full workflow response:`);
                    console.log(JSON.stringify(result.workflow_response, null, 2));
                }
            }
        } catch (err) {
            failCount++;
            error = {
                message: err.message,
                stack: err.stack,
                response_data: err.response?.data || null,
                response_status: err.response?.status || null
            };
            console.log(`\nERROR for Case #${caseData.id}: ${err.message}`);
            if (err.response?.data) {
                console.log(`  API Response:`, JSON.stringify(err.response.data, null, 2));
            }
        }

        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

        // Save individual case result
        const caseResult = {
            case_id: caseData.id,
            case_name: caseData.case_name,
            agency_name: caseData.agency_name,
            portal_url: caseData.portal_url,
            state: caseData.state,
            subject_name: caseData.subject_name,
            started_at: new Date(startTime).toISOString(),
            duration_seconds: parseFloat(elapsed),
            success: result?.success || false,
            skyvern_result: result || null,
            error: error || null
        };

        allResults.push(caseResult);

        // Save per-case log
        const caseLogPath = path.join(RESULTS_DIR, `case-${caseData.id}-result.json`);
        fs.writeFileSync(caseLogPath, JSON.stringify(caseResult, null, 2));
        console.log(`\nSaved result to ${caseLogPath}`);
        console.log(`Duration: ${elapsed}s | Running total: ${successCount} success, ${failCount} failed`);

        // Pause between cases to not overwhelm Skyvern
        if (i < cases.length - 1) {
            console.log(`\nWaiting 10 seconds before next case...`);
            await new Promise(resolve => setTimeout(resolve, 10000));
        }
    }

    // Save combined results
    const summaryPath = path.join(RESULTS_DIR, `batch-run-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
    const summary = {
        run_at: new Date().toISOString(),
        total_cases: cases.length,
        success_count: successCount,
        fail_count: failCount,
        workflow_id: process.env.SKYVERN_WORKFLOW_ID,
        results: allResults
    };
    fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2));

    // Print final summary
    console.log('\n' + '='.repeat(70));
    console.log('  BATCH RUN COMPLETE');
    console.log('='.repeat(70));
    console.log(`  Total cases: ${cases.length}`);
    console.log(`  Succeeded:   ${successCount}`);
    console.log(`  Failed:      ${failCount}`);
    console.log(`  Results:     ${summaryPath}`);
    console.log();

    console.log('Per-case results:');
    allResults.forEach(r => {
        const icon = r.success ? 'OK' : 'FAIL';
        const detail = r.success
            ? (r.skyvern_result?.workflow_url || r.skyvern_result?.recording_url || 'completed')
            : (r.error?.message || r.skyvern_result?.error || 'unknown error');
        console.log(`  [${icon}] Case #${r.case_id} (${r.duration_seconds}s) - ${r.agency_name}`);
        console.log(`        ${detail.substring(0, 100)}`);
    });
    console.log('='.repeat(70));
}

runPendingPortals()
    .then(() => process.exit(0))
    .catch(err => {
        console.error('Fatal error:', err);
        process.exit(1);
    });
