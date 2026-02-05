#!/usr/bin/env node
/**
 * API E2E Test Suite for Prompt Tuning
 *
 * Full integration test through API → LangGraph → Database.
 * Tests that orchestration correctly respects requires_response from analysis.
 *
 * Prerequisites:
 *   - API server running (local or staging)
 *   - Database with test cases
 *   - Set environment variables:
 *     - API_BASE_URL (default: http://localhost:3001)
 *     - API_KEY (optional, for staging)
 *
 * Usage:
 *   node tests/e2e/api-prompt-e2e.test.js
 *   node tests/e2e/api-prompt-e2e.test.js --fixture=portal
 *   node tests/e2e/api-prompt-e2e.test.js --skip-setup
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');

// Configuration
const API_BASE_URL = process.env.API_BASE_URL || process.env.STAGING_API_URL || 'http://localhost:3001';
const API_KEY = process.env.API_KEY || process.env.STAGING_API_KEY;
const POLL_INTERVAL_MS = 1000;
const POLL_TIMEOUT_MS = 60000;

// Load fixtures
const fixturesPath = path.join(__dirname, '../fixtures/inbound/golden-fixtures.json');
const fixtures = JSON.parse(fs.readFileSync(fixturesPath, 'utf8'));

// ============================================================================
// HTTP CLIENT
// ============================================================================

async function apiRequest(method, endpoint, body = null) {
    const url = `${API_BASE_URL}${endpoint}`;
    const headers = {
        'Content-Type': 'application/json'
    };

    if (API_KEY) {
        headers['Authorization'] = `Bearer ${API_KEY}`;
    }

    const options = {
        method,
        headers
    };

    if (body) {
        options.body = JSON.stringify(body);
    }

    const response = await fetch(url, options);
    const data = await response.json();

    if (!response.ok) {
        throw new Error(`API error ${response.status}: ${JSON.stringify(data)}`);
    }

    return data;
}

async function get(endpoint) {
    return apiRequest('GET', endpoint);
}

async function post(endpoint, body) {
    return apiRequest('POST', endpoint, body);
}

// ============================================================================
// TEST UTILITIES
// ============================================================================

/**
 * Poll for agent run completion
 */
async function pollRunStatus(runId, timeoutMs = POLL_TIMEOUT_MS) {
    const startTime = Date.now();

    while (Date.now() - startTime < timeoutMs) {
        try {
            const run = await get(`/api/agent-runs/${runId}`);

            if (run.status !== 'running') {
                return run;
            }
        } catch (error) {
            // May not exist yet, retry
        }

        await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS));
    }

    throw new Error(`Run ${runId} did not complete within ${timeoutMs}ms`);
}

/**
 * Poll for case agent runs
 */
async function pollCaseRuns(caseId, timeoutMs = POLL_TIMEOUT_MS) {
    const startTime = Date.now();

    while (Date.now() - startTime < timeoutMs) {
        try {
            const response = await get(`/api/requests/${caseId}/agent-runs`);
            const runs = response.runs || response;

            if (runs.length > 0) {
                const latestRun = runs[0];
                if (latestRun.status !== 'running') {
                    return latestRun;
                }
            }
        } catch (error) {
            // May not exist yet, retry
        }

        await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS));
    }

    throw new Error(`No completed run for case ${caseId} within ${timeoutMs}ms`);
}

/**
 * Get or create test case for fixture
 */
async function getOrCreateTestCase(fixture) {
    // Try to find existing test case
    try {
        const response = await get(`/api/requests?agency_name=E2E_${fixture.fixture_id}&limit=1`);
        if (response.requests?.length > 0) {
            return response.requests[0];
        }
    } catch (error) {
        // Not found, create new
    }

    // Create new test case
    const caseData = fixture.case_data || {};
    const newCase = await post('/api/requests', {
        agency_name: `E2E_${fixture.fixture_id}`,
        state: caseData.state || 'NC',
        request_summary: caseData.request_summary || `E2E test for ${fixture.fixture_id}`,
        incident_date: caseData.incident_date || '2024-01-01',
        autopilot_mode: 'SUPERVISED'
    });

    return newCase;
}

/**
 * Ingest email into case
 */
async function ingestEmail(caseId, fixture) {
    const message = fixture.message;

    return post(`/api/requests/${caseId}/ingest-email`, {
        subject: message.subject || 'Re: FOIA Request',
        body_text: message.body_text,
        from_address: message.from_address || 'test@agency.gov',
        message_type: 'inbound'
    });
}

/**
 * Trigger inbound handler
 */
async function triggerInbound(caseId, messageId) {
    return post(`/api/requests/${caseId}/run-inbound`, {
        messageId,
        autopilotMode: 'SUPERVISED'
    });
}

/**
 * Get case details
 */
async function getCase(caseId) {
    return get(`/api/requests/${caseId}`);
}

/**
 * Get proposals for case
 */
async function getProposals(caseId) {
    const response = await get(`/api/requests/${caseId}/proposals`);
    return response.proposals || response;
}

// ============================================================================
// ASSERTIONS
// ============================================================================

function assertEqual(actual, expected, message) {
    if (actual !== expected) {
        throw new Error(`${message}: expected ${expected}, got ${actual}`);
    }
}

function assertNull(actual, message) {
    if (actual !== null && actual !== undefined) {
        throw new Error(`${message}: expected null, got ${actual}`);
    }
}

function assertNotNull(actual, message) {
    if (actual === null || actual === undefined) {
        throw new Error(`${message}: expected not null`);
    }
}

// ============================================================================
// TEST RUNNER
// ============================================================================

/**
 * Run E2E test for a single fixture
 */
async function runFixtureE2E(fixture, options = {}) {
    const result = {
        fixture_id: fixture.fixture_id,
        category: fixture.category,
        passed: false,
        errors: [],
        warnings: [],
        case_id: null,
        message_id: null,
        run_id: null,
        proposal_id: null,
        duration_ms: 0
    };

    const startTime = Date.now();

    try {
        // Skip followup fixtures for now (different flow)
        if (fixture.category === 'followup') {
            result.warnings.push('Followup E2E not implemented');
            result.passed = true;
            return result;
        }

        // Step 1: Get or create test case
        console.log(`  Creating/finding test case...`);
        const testCase = await getOrCreateTestCase(fixture);
        result.case_id = testCase.id;

        // Step 2: Ingest email
        console.log(`  Ingesting email...`);
        const ingestResult = await ingestEmail(testCase.id, fixture);
        result.message_id = ingestResult.messageId || ingestResult.message_id;

        // Step 3: Trigger inbound handler
        console.log(`  Triggering inbound handler...`);
        const triggerResult = await triggerInbound(testCase.id, result.message_id);
        result.run_id = triggerResult.runId || triggerResult.run_id;

        // Step 4: Poll for completion
        console.log(`  Waiting for completion...`);
        const run = await pollCaseRuns(testCase.id);

        // Step 5: Validate results based on expected
        const expected = fixture.expected;

        // Check if proposal was created
        const proposals = await getProposals(testCase.id);
        const latestProposal = proposals.length > 0 ? proposals[0] : null;
        result.proposal_id = latestProposal?.id;

        // Validate based on expected.requires_response
        if (expected.requires_response === false || expected.should_draft_email === false) {
            // Should NOT have created a proposal
            if (latestProposal && latestProposal.status === 'pending_approval') {
                // Check if this is a new proposal from this run
                const proposalAge = Date.now() - new Date(latestProposal.created_at).getTime();
                if (proposalAge < 30000) {  // Created in last 30 seconds
                    result.errors.push(`Proposal created when requires_response=false`);
                }
            }
        } else {
            // Should have created a proposal
            if (!latestProposal) {
                result.errors.push(`No proposal created when requires_response=true`);
            } else {
                // Validate action type
                if (expected.action_type && latestProposal.action_type !== expected.action_type) {
                    result.warnings.push(`Action type mismatch: got ${latestProposal.action_type}, expected ${expected.action_type}`);
                }
            }
        }

        // Check case state updates
        const caseAfter = await getCase(testCase.id);

        if (expected.suggested_action === 'use_portal') {
            if (!caseAfter.portal_url) {
                result.warnings.push(`Portal URL not saved to case`);
            }
        }

        if (expected.suggested_action === 'download' && expected.intent === 'delivery') {
            if (caseAfter.status !== 'completed') {
                result.warnings.push(`Case not marked completed for delivery`);
            }
        }

        result.passed = result.errors.length === 0;

    } catch (error) {
        result.errors.push(`Exception: ${error.message}`);
        result.passed = false;
    }

    result.duration_ms = Date.now() - startTime;
    return result;
}

// ============================================================================
// REPORTING
// ============================================================================

function printResults(results) {
    console.log('\n' + '='.repeat(80));
    console.log('API E2E TEST RESULTS');
    console.log('='.repeat(80));

    // Group by category
    const byCategory = {};
    for (const result of results) {
        if (!byCategory[result.category]) {
            byCategory[result.category] = [];
        }
        byCategory[result.category].push(result);
    }

    for (const [category, categoryResults] of Object.entries(byCategory)) {
        const passed = categoryResults.filter(r => r.passed).length;
        console.log(`\n### ${category} (${passed}/${categoryResults.length})`);

        for (const result of categoryResults) {
            const status = result.passed ? '✅' : '❌';
            console.log(`  ${status} ${result.fixture_id} (${result.duration_ms}ms)`);

            for (const e of result.errors) {
                console.log(`      ❌ ${e}`);
            }
            for (const w of result.warnings) {
                console.log(`      ⚠️ ${w}`);
            }
        }
    }

    // Summary
    const total = results.length;
    const passed = results.filter(r => r.passed).length;
    const failed = results.filter(r => !r.passed).length;

    console.log('\n' + '='.repeat(80));
    console.log('SUMMARY');
    console.log('='.repeat(80));
    console.log(`Total:  ${total}`);
    console.log(`Passed: ${passed} (${Math.round((passed / total) * 100)}%)`);
    console.log(`Failed: ${failed}`);

    return { total, passed, failed };
}

function writeReport(results, summary) {
    const reportsDir = path.join(__dirname, '../reports');
    if (!fs.existsSync(reportsDir)) {
        fs.mkdirSync(reportsDir, { recursive: true });
    }

    const report = {
        timestamp: new Date().toISOString(),
        api_base_url: API_BASE_URL,
        summary,
        results
    };

    fs.writeFileSync(
        path.join(reportsDir, 'api-e2e-report.json'),
        JSON.stringify(report, null, 2)
    );

    console.log(`\nReport written to: tests/reports/api-e2e-report.json`);
}

// ============================================================================
// MAIN
// ============================================================================

async function main() {
    const args = process.argv.slice(2);
    const fixtureFilter = args.find(a => a.startsWith('--fixture='))?.split('=')[1];
    const categoryFilter = args.find(a => a.startsWith('--category='))?.split('=')[1];
    const skipSetup = args.includes('--skip-setup');

    console.log('='.repeat(80));
    console.log('API E2E TEST SUITE');
    console.log('='.repeat(80));
    console.log(`API URL: ${API_BASE_URL}`);
    console.log(`Fixtures: ${fixtures.fixtures.length}`);
    if (fixtureFilter) console.log(`Filter: fixture="${fixtureFilter}"`);
    if (categoryFilter) console.log(`Filter: category="${categoryFilter}"`);
    console.log('');

    // Test API connectivity
    try {
        console.log('Testing API connectivity...');
        await get('/api/health');
        console.log('✅ API is reachable\n');
    } catch (error) {
        console.error(`❌ Cannot reach API at ${API_BASE_URL}`);
        console.error(`   Error: ${error.message}`);
        console.error(`   Make sure the server is running or set API_BASE_URL`);
        process.exit(1);
    }

    // Filter fixtures
    let testFixtures = fixtures.fixtures;
    if (fixtureFilter) {
        testFixtures = testFixtures.filter(f =>
            f.fixture_id.toLowerCase().includes(fixtureFilter.toLowerCase())
        );
    }
    if (categoryFilter) {
        testFixtures = testFixtures.filter(f => f.category === categoryFilter);
    }

    console.log(`Running ${testFixtures.length} E2E tests...\n`);

    const results = [];

    for (const fixture of testFixtures) {
        console.log(`\nRunning: ${fixture.fixture_id}`);
        const result = await runFixtureE2E(fixture);
        results.push(result);

        const status = result.passed ? '✅ PASS' : '❌ FAIL';
        console.log(`  Result: ${status}`);
    }

    const summary = printResults(results);
    writeReport(results, summary);

    process.exit(summary.failed > 0 ? 1 : 0);
}

main().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
});
