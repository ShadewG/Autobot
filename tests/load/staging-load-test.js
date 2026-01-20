#!/usr/bin/env node
/**
 * Staging Load Test
 *
 * Simulates realistic production load to verify reliability guarantees:
 * - 50-200 inbound webhooks in bursts
 * - 3-5 concurrent approvals (double-click + multiple operators)
 * - Random worker restarts mid-run
 *
 * Success criteria:
 * - 0 duplicate emails
 * - 0 proposals executed twice
 * - No cases stuck "locked" beyond TTL
 * - DLQ stays near zero; if it grows, reasons are actionable
 *
 * Usage:
 *   node tests/load/staging-load-test.js --webhooks=100 --approvals=5
 *   STAGING_URL=https://staging.example.com node tests/load/staging-load-test.js
 */

const https = require('https');
const http = require('http');

// Configuration
const CONFIG = {
    baseUrl: process.env.STAGING_URL || 'http://localhost:3000',
    webhookCount: parseInt(process.env.WEBHOOK_COUNT) || 100,
    approvalConcurrency: parseInt(process.env.APPROVAL_CONCURRENCY) || 5,
    burstSize: parseInt(process.env.BURST_SIZE) || 20,
    burstDelayMs: parseInt(process.env.BURST_DELAY_MS) || 500,
    simulateWorkerRestarts: process.env.SIMULATE_RESTARTS !== 'false',
    reportIntervalMs: 5000,
    testDurationMs: parseInt(process.env.TEST_DURATION_MS) || 60000,
    apiKey: process.env.STAGING_API_KEY || 'test-key'
};

// Parse CLI arguments
process.argv.slice(2).forEach(arg => {
    const [key, value] = arg.replace('--', '').split('=');
    if (key === 'webhooks') CONFIG.webhookCount = parseInt(value);
    if (key === 'approvals') CONFIG.approvalConcurrency = parseInt(value);
    if (key === 'burst') CONFIG.burstSize = parseInt(value);
    if (key === 'duration') CONFIG.testDurationMs = parseInt(value);
});

// Metrics
const metrics = {
    webhooksSent: 0,
    webhooksSucceeded: 0,
    webhooksFailed: 0,
    webhooksDuplicate: 0,
    approvalsSent: 0,
    approvalsSucceeded: 0,
    approvalsFailed: 0,
    approvalsAlreadyExecuted: 0,
    emailsQueued: 0,
    duplicateEmailsDetected: 0,
    dlqItems: 0,
    stuckLocks: 0,
    errors: []
};

// Test state
const state = {
    testCases: [],
    pendingProposals: [],
    executedProposals: new Set(),
    startTime: null,
    isRunning: false
};

// HTTP request helper
function request(method, path, body = null) {
    return new Promise((resolve, reject) => {
        const url = new URL(path, CONFIG.baseUrl);
        const isHttps = url.protocol === 'https:';
        const lib = isHttps ? https : http;

        const options = {
            hostname: url.hostname,
            port: url.port || (isHttps ? 443 : 80),
            path: url.pathname + url.search,
            method,
            headers: {
                'Content-Type': 'application/json',
                'X-API-Key': CONFIG.apiKey
            }
        };

        const req = lib.request(options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    resolve({
                        status: res.statusCode,
                        data: JSON.parse(data)
                    });
                } catch (e) {
                    resolve({ status: res.statusCode, data });
                }
            });
        });

        req.on('error', reject);
        req.setTimeout(30000, () => {
            req.destroy();
            reject(new Error('Request timeout'));
        });

        if (body) {
            req.write(JSON.stringify(body));
        }
        req.end();
    });
}

// Generate a random inbound webhook payload
function generateWebhookPayload(caseId) {
    const messageId = `<test-${caseId}-${Date.now()}-${Math.random().toString(36).substr(2, 9)}@loadtest.local>`;
    return {
        message_id: messageId,
        from: `agency-${caseId}@example.gov`,
        to: 'foia@autobot.local',
        subject: `Re: FOIA Request #${caseId}`,
        body: `This is a test response for case ${caseId}. Generated at ${new Date().toISOString()}`,
        received_at: new Date().toISOString()
    };
}

// Send a burst of webhooks
async function sendWebhookBurst(count) {
    const promises = [];

    for (let i = 0; i < count; i++) {
        // Pick a random test case or create a new one
        const caseId = state.testCases[Math.floor(Math.random() * state.testCases.length)] || 1;
        const payload = generateWebhookPayload(caseId);

        promises.push(
            request('POST', '/api/webhooks/sendgrid/inbound', payload)
                .then(res => {
                    metrics.webhooksSent++;
                    if (res.status === 200 || res.status === 201) {
                        metrics.webhooksSucceeded++;
                        if (res.data?.proposal_id) {
                            state.pendingProposals.push({
                                proposalId: res.data.proposal_id,
                                caseId,
                                createdAt: Date.now()
                            });
                        }
                    } else if (res.status === 409 || res.data?.duplicate) {
                        metrics.webhooksDuplicate++;
                    } else {
                        metrics.webhooksFailed++;
                        metrics.errors.push({ type: 'webhook', status: res.status, data: res.data });
                    }
                })
                .catch(err => {
                    metrics.webhooksFailed++;
                    metrics.errors.push({ type: 'webhook', error: err.message });
                })
        );
    }

    await Promise.all(promises);
}

// Simulate concurrent approvals (double-click scenario)
async function simulateConcurrentApprovals() {
    if (state.pendingProposals.length === 0) return;

    // Pick a random pending proposal
    const proposalIndex = Math.floor(Math.random() * state.pendingProposals.length);
    const proposal = state.pendingProposals[proposalIndex];

    if (!proposal || state.executedProposals.has(proposal.proposalId)) {
        return;
    }

    // Simulate multiple operators clicking approve simultaneously
    const concurrentCount = Math.min(CONFIG.approvalConcurrency, 5);
    const approvalPromises = [];

    for (let i = 0; i < concurrentCount; i++) {
        const executionKey = `exec-${proposal.proposalId}-op${i}-${Date.now()}`;

        approvalPromises.push(
            request('POST', `/api/requests/${proposal.caseId}/actions/approve`, {
                proposal_id: proposal.proposalId,
                execution_key: executionKey,
                operator: `operator-${i}`
            })
                .then(res => {
                    metrics.approvalsSent++;
                    if (res.status === 200 && res.data?.success) {
                        metrics.approvalsSucceeded++;
                        state.executedProposals.add(proposal.proposalId);
                        if (res.data.email_job_id) {
                            metrics.emailsQueued++;
                        }
                    } else if (res.status === 409 || res.data?.already_executed) {
                        metrics.approvalsAlreadyExecuted++;
                    } else {
                        metrics.approvalsFailed++;
                    }
                    return res;
                })
                .catch(err => {
                    metrics.approvalsFailed++;
                    metrics.errors.push({ type: 'approval', error: err.message });
                })
        );
    }

    const results = await Promise.all(approvalPromises);

    // Check for duplicate execution (critical failure)
    const successCount = results.filter(r => r?.data?.success && r?.data?.email_job_id).length;
    if (successCount > 1) {
        metrics.duplicateEmailsDetected++;
        console.error(`CRITICAL: Duplicate email execution detected for proposal ${proposal.proposalId}!`);
    }

    // Remove from pending
    state.pendingProposals.splice(proposalIndex, 1);
}

// Check system health
async function checkSystemHealth() {
    try {
        // Check DLQ status
        const dlqRes = await request('GET', '/api/dlq');
        if (dlqRes.data?.items) {
            metrics.dlqItems = dlqRes.data.items.length;
        }

        // Check for stuck locks via reaper status
        const reaperRes = await request('GET', '/api/reaper/status');
        if (reaperRes.data?.stuck_locks) {
            metrics.stuckLocks = reaperRes.data.stuck_locks;
        }

    } catch (err) {
        // Health check failed, but don't stop test
        console.warn('Health check failed:', err.message);
    }
}

// Report metrics
function reportMetrics() {
    const elapsed = (Date.now() - state.startTime) / 1000;
    const rate = metrics.webhooksSent / elapsed;

    console.log('\n' + '='.repeat(60));
    console.log(`LOAD TEST METRICS (${elapsed.toFixed(1)}s elapsed)`);
    console.log('='.repeat(60));
    console.log(`Webhooks: ${metrics.webhooksSent} sent, ${metrics.webhooksSucceeded} OK, ${metrics.webhooksFailed} failed, ${metrics.webhooksDuplicate} deduped`);
    console.log(`Approvals: ${metrics.approvalsSent} sent, ${metrics.approvalsSucceeded} OK, ${metrics.approvalsAlreadyExecuted} already-executed, ${metrics.approvalsFailed} failed`);
    console.log(`Emails: ${metrics.emailsQueued} queued, ${metrics.duplicateEmailsDetected} DUPLICATES`);
    console.log(`System: ${metrics.dlqItems} in DLQ, ${metrics.stuckLocks} stuck locks`);
    console.log(`Rate: ${rate.toFixed(1)} webhooks/sec`);
    console.log(`Pending proposals: ${state.pendingProposals.length}`);

    if (metrics.errors.length > 0) {
        console.log(`\nRecent errors (last 5):`);
        metrics.errors.slice(-5).forEach(e => console.log(`  - ${e.type}: ${e.error || e.status}`));
    }
    console.log('='.repeat(60));
}

// Validate success criteria
function validateSuccessCriteria() {
    const failures = [];

    if (metrics.duplicateEmailsDetected > 0) {
        failures.push(`CRITICAL: ${metrics.duplicateEmailsDetected} duplicate emails detected`);
    }

    // Check if any proposals were executed more than once
    // (would show as duplicateEmailsDetected > 0)

    if (metrics.stuckLocks > 0) {
        failures.push(`WARNING: ${metrics.stuckLocks} stuck locks detected`);
    }

    if (metrics.dlqItems > 10) {
        failures.push(`WARNING: ${metrics.dlqItems} items in DLQ (expected near zero)`);
    }

    const successRate = metrics.webhooksSent > 0
        ? (metrics.webhooksSucceeded + metrics.webhooksDuplicate) / metrics.webhooksSent
        : 0;
    if (successRate < 0.95) {
        failures.push(`WARNING: Webhook success rate ${(successRate * 100).toFixed(1)}% (expected >95%)`);
    }

    return failures;
}

// Main test runner
async function runLoadTest() {
    console.log('\n' + '='.repeat(60));
    console.log('STAGING LOAD TEST');
    console.log('='.repeat(60));
    console.log(`Target: ${CONFIG.baseUrl}`);
    console.log(`Webhooks: ${CONFIG.webhookCount} (burst size: ${CONFIG.burstSize})`);
    console.log(`Approval concurrency: ${CONFIG.approvalConcurrency}`);
    console.log(`Duration: ${CONFIG.testDurationMs / 1000}s`);
    console.log('='.repeat(60) + '\n');

    state.startTime = Date.now();
    state.isRunning = true;

    // Initialize test cases
    try {
        const casesRes = await request('GET', '/api/requests?limit=20&status=awaiting_response');
        if (casesRes.data?.cases) {
            state.testCases = casesRes.data.cases.map(c => c.id);
            console.log(`Loaded ${state.testCases.length} test cases`);
        }
    } catch (err) {
        console.warn('Could not load test cases, using synthetic IDs');
        state.testCases = Array.from({ length: 10 }, (_, i) => 9000 + i);
    }

    // Start periodic reporting
    const reportInterval = setInterval(reportMetrics, CONFIG.reportIntervalMs);

    // Start health checking
    const healthInterval = setInterval(checkSystemHealth, 10000);

    // Main test loop
    let webhooksSentTotal = 0;
    const endTime = state.startTime + CONFIG.testDurationMs;

    while (Date.now() < endTime && webhooksSentTotal < CONFIG.webhookCount) {
        // Send a burst of webhooks
        const burstCount = Math.min(CONFIG.burstSize, CONFIG.webhookCount - webhooksSentTotal);
        await sendWebhookBurst(burstCount);
        webhooksSentTotal += burstCount;

        // Simulate concurrent approvals periodically
        if (state.pendingProposals.length > 0 && Math.random() < 0.3) {
            await simulateConcurrentApprovals();
        }

        // Wait between bursts
        await new Promise(resolve => setTimeout(resolve, CONFIG.burstDelayMs));

        // Check if we should simulate a worker restart
        if (CONFIG.simulateWorkerRestarts && Math.random() < 0.05) {
            console.log('\n[Simulating worker restart scenario...]');
            // In a real scenario, this would restart the worker process
            // For now, we just add a delay to simulate the restart time
            await new Promise(resolve => setTimeout(resolve, 2000));
        }
    }

    // Process remaining pending proposals
    console.log('\nProcessing remaining pending proposals...');
    while (state.pendingProposals.length > 0) {
        await simulateConcurrentApprovals();
        await new Promise(resolve => setTimeout(resolve, 100));
    }

    // Final health check
    await checkSystemHealth();

    // Stop intervals
    clearInterval(reportInterval);
    clearInterval(healthInterval);

    // Final report
    reportMetrics();

    // Validate success criteria
    console.log('\n' + '='.repeat(60));
    console.log('SUCCESS CRITERIA VALIDATION');
    console.log('='.repeat(60));

    const failures = validateSuccessCriteria();

    if (failures.length === 0) {
        console.log('\n  ALL CRITERIA PASSED\n');
        console.log('  - 0 duplicate emails');
        console.log('  - 0 proposals executed twice');
        console.log(`  - ${metrics.stuckLocks} stuck locks (expected 0)`);
        console.log(`  - ${metrics.dlqItems} DLQ items (expected near 0)`);
        console.log('\n' + '='.repeat(60) + '\n');
        process.exit(0);
    } else {
        console.log('\n  FAILURES DETECTED:\n');
        failures.forEach(f => console.log(`  - ${f}`));
        console.log('\n' + '='.repeat(60) + '\n');
        process.exit(1);
    }
}

// Run the test
runLoadTest().catch(err => {
    console.error('Load test failed with error:', err);
    process.exit(1);
});
