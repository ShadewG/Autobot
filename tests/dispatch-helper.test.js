#!/usr/bin/env node
/**
 * Dispatch Helper Tests
 *
 * Tests the shared dispatch-to-Run-Engine function used by reactive dispatch,
 * cron sweep, and Notion sync. Fully isolated — no real DB, Redis, or network.
 */

const path = require('path');
const assert = require('assert');
const sinon = require('sinon');

// ============================================================
// STUB SETUP — pre-seed require cache before loading dispatch-helper
// ============================================================

const dbStub = {
    getCaseById: sinon.stub(),
    getActiveRunForCase: sinon.stub(),
    createAgentRunFull: sinon.stub(),
    updateAgentRun: sinon.stub(),
    logActivity: sinon.stub()
};

const notifyStub = sinon.stub();
const enqueueStub = sinon.stub();

// Resolve the exact paths that dispatch-helper.js will require()
const helperPath = path.resolve(__dirname, '../services/dispatch-helper.js');
const dbPath = path.resolve(__dirname, '../services/database.js');
const eventBusPath = path.resolve(__dirname, '../services/event-bus.js');
const loggerPath = path.resolve(__dirname, '../services/logger.js');
const agentQueuePath = path.resolve(__dirname, '../queues/agent-queue.js');

// Pre-seed require cache with stubs
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: dbStub };
require.cache[eventBusPath] = { id: eventBusPath, filename: eventBusPath, loaded: true, exports: { notify: notifyStub } };
require.cache[loggerPath] = { id: loggerPath, filename: loggerPath, loaded: true, exports: { info: () => {}, warn: () => {}, error: () => {} } };
require.cache[agentQueuePath] = { id: agentQueuePath, filename: agentQueuePath, loaded: true, exports: { enqueueInitialRequestJob: enqueueStub } };

// Now load dispatch-helper — it will pick up our cached stubs
const { dispatchReadyToSend } = require(helperPath);

// ============================================================
// HELPERS
// ============================================================

function resetStubs() {
    dbStub.getCaseById.reset();
    dbStub.getActiveRunForCase.reset();
    dbStub.createAgentRunFull.reset();
    dbStub.updateAgentRun.reset();
    dbStub.logActivity.reset();
    notifyStub.reset();
    enqueueStub.reset();
}

const results = [];
function log(test, pass, detail = '') {
    const icon = pass ? '\u2705' : '\u274C';
    results.push({ test, pass, detail });
    console.log(`  ${icon} ${test}${detail ? ` — ${detail}` : ''}`);
}

// ============================================================
// TESTS
// ============================================================

async function testHappyPath() {
    console.log('\n--- 1. HAPPY PATH ---');
    resetStubs();

    dbStub.getCaseById.resolves({ id: 100, status: 'ready_to_send', case_name: 'Test Case' });
    dbStub.getActiveRunForCase.resolves(null);
    dbStub.createAgentRunFull.resolves({ id: 42, langgraph_thread_id: 'initial:100:123' });
    enqueueStub.resolves({ id: 'job-1' });
    dbStub.logActivity.resolves();

    const result = await dispatchReadyToSend(100, { source: 'reactive' });

    log('Returns dispatched: true', result.dispatched === true);
    log('Returns runId', result.runId === 42);
    log('Creates agent_run with correct params', dbStub.createAgentRunFull.calledOnce);
    const createArgs = dbStub.createAgentRunFull.firstCall.args[0];
    log('agent_run has case_id', createArgs.case_id === 100);
    log('agent_run has trigger_type', createArgs.trigger_type === 'initial_request');
    log('agent_run has status queued', createArgs.status === 'queued');
    log('Enqueues job', enqueueStub.calledOnce);
    log('Logs activity', dbStub.logActivity.calledOnce);
    log('Notifies', notifyStub.calledOnce);
}

async function testDedupActiveRun() {
    console.log('\n--- 2. DEDUP — ACTIVE RUN EXISTS ---');
    resetStubs();

    dbStub.getCaseById.resolves({ id: 100, status: 'ready_to_send', case_name: 'Test Case' });
    dbStub.getActiveRunForCase.resolves({ id: 77 });

    const result = await dispatchReadyToSend(100, { source: 'cron_sweep' });

    log('Returns dispatched: false', result.dispatched === false);
    log('Reason is active_run_exists', result.reason === 'active_run_exists');
    log('Returns existing runId', result.runId === 77);
    log('Does not create agent_run', dbStub.createAgentRunFull.notCalled);
    log('Does not enqueue', enqueueStub.notCalled);
}

async function testSkipAlreadyAdvanced() {
    console.log('\n--- 3. SKIP — ALREADY ADVANCED STATUS ---');
    resetStubs();

    dbStub.getCaseById.resolves({ id: 100, status: 'sent', case_name: 'Test Case' });

    const result = await dispatchReadyToSend(100);

    log('Returns dispatched: false', result.dispatched === false);
    log('Reason is already_sent', result.reason === 'already_sent');
    log('Does not check for active run', dbStub.getActiveRunForCase.notCalled);
    log('Does not create agent_run', dbStub.createAgentRunFull.notCalled);
}

async function testCaseNotFound() {
    console.log('\n--- 4. NOT FOUND ---');
    resetStubs();

    dbStub.getCaseById.resolves(null);

    const result = await dispatchReadyToSend(999);

    log('Returns dispatched: false', result.dispatched === false);
    log('Reason is case_not_found', result.reason === 'case_not_found');
    log('Does not check for active run', dbStub.getActiveRunForCase.notCalled);
}

async function testEnqueueFailureCleanup() {
    console.log('\n--- 5. ENQUEUE FAILURE — RUN MARKED FAILED ---');
    resetStubs();

    dbStub.getCaseById.resolves({ id: 100, status: 'ready_to_send', case_name: 'Test Case' });
    dbStub.getActiveRunForCase.resolves(null);
    dbStub.createAgentRunFull.resolves({ id: 42, langgraph_thread_id: 'initial:100:123' });
    enqueueStub.rejects(new Error('Redis down'));
    dbStub.updateAgentRun.resolves();

    let threw = false;
    try {
        await dispatchReadyToSend(100, { source: 'reactive' });
    } catch (err) {
        threw = true;
        log('Error propagates', err.message === 'Redis down');
    }

    log('Threw an error', threw);
    log('Run marked as failed', dbStub.updateAgentRun.calledOnce);
    const updateArgs = dbStub.updateAgentRun.firstCall.args;
    log('Correct runId in update', updateArgs[0] === 42);
    log('Status set to failed', updateArgs[1].status === 'failed');
    log('Error message recorded', updateArgs[1].error.includes('Redis down'));
}

async function testSourceMetadata() {
    console.log('\n--- 6. SOURCE METADATA ---');
    resetStubs();

    dbStub.getCaseById.resolves({ id: 200, status: 'ready_to_send', case_name: 'Notion Case' });
    dbStub.getActiveRunForCase.resolves(null);
    dbStub.createAgentRunFull.resolves({ id: 55, langgraph_thread_id: 'initial:200:456' });
    enqueueStub.resolves({ id: 'job-2' });
    dbStub.logActivity.resolves();

    await dispatchReadyToSend(200, { source: 'notion_sync' });

    const createArgs = dbStub.createAgentRunFull.firstCall.args[0];
    log('Metadata contains source', createArgs.metadata?.source === 'notion_sync');

    const logArgs = dbStub.logActivity.firstCall.args;
    log('Activity log type is dispatch_run_created', logArgs[0] === 'dispatch_run_created');
    log('Activity log meta has source', logArgs[2]?.source === 'notion_sync');
    log('Activity log meta has run_id', logArgs[2]?.run_id === 55);

    const notifyArgs = notifyStub.firstCall.args;
    log('Notify message contains source', notifyArgs[1].includes('notion_sync'));
}

// ============================================================
// RUNNER
// ============================================================

async function main() {
    console.log('=== Dispatch Helper Tests ===');

    await testHappyPath();
    await testDedupActiveRun();
    await testSkipAlreadyAdvanced();
    await testCaseNotFound();
    await testEnqueueFailureCleanup();
    await testSourceMetadata();

    console.log('\n=== SUMMARY ===');
    const passed = results.filter(r => r.pass).length;
    const failed = results.filter(r => !r.pass).length;
    console.log(`${passed} passed, ${failed} failed out of ${results.length} assertions`);

    if (failed > 0) {
        console.log('\nFailed:');
        results.filter(r => !r.pass).forEach(r => console.log(`  \u2717 ${r.test}: ${r.detail}`));
        process.exit(1);
    }

    console.log('\nAll tests passed!');
}

main().catch(err => {
    console.error('Test runner error:', err);
    process.exit(1);
});
