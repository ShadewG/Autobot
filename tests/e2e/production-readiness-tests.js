#!/usr/bin/env node
/**
 * Production Readiness Test Suite
 *
 * Comprehensive E2E tests for FOIA Agent system.
 * Run with: node tests/e2e/production-readiness-tests.js [--api-url=URL]
 */

const https = require('https');
const http = require('http');

// Configuration
const API_URL = process.env.API_URL || process.argv.find(a => a.startsWith('--api-url='))?.split('=')[1] || 'http://localhost:3000';
const TIMEOUT_MS = 30000;

// Test results storage
const results = {
  passed: 0,
  failed: 0,
  skipped: 0,
  tests: [],
  startTime: new Date(),
  endTime: null
};

// Utilities
function log(msg, level = 'info') {
  const timestamp = new Date().toISOString().slice(11, 19);
  const prefix = { info: '  ', pass: '✅', fail: '❌', warn: '⚠️', skip: '⏭️' }[level] || '  ';
  console.log(`[${timestamp}] ${prefix} ${msg}`);
}

async function apiCall(method, path, body = null) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, API_URL);
    const isHttps = url.protocol === 'https:';
    const client = isHttps ? https : http;

    const options = {
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname + url.search,
      method,
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      timeout: TIMEOUT_MS
    };

    const req = client.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = data ? JSON.parse(data) : {};
          resolve({ status: res.statusCode, data: json });
        } catch (e) {
          resolve({ status: res.statusCode, data: data, parseError: true });
        }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Request timeout'));
    });

    if (body) {
      req.write(JSON.stringify(body));
    }
    req.end();
  });
}

async function waitForRunCompletion(runId, maxWaitMs = 60000) {
  const startTime = Date.now();
  while (Date.now() - startTime < maxWaitMs) {
    const { data } = await apiCall('GET', `/api/runs/${runId}`);
    if (!data.run) return { status: 'not_found', run: null };

    const status = data.run.status;
    if (['completed', 'failed', 'paused', 'gated', 'skipped'].includes(status)) {
      return { status, run: data.run, proposals: data.proposals };
    }
    await new Promise(r => setTimeout(r, 1000));
  }
  return { status: 'timeout', run: null };
}

function recordTest(name, passed, details = {}) {
  const status = passed === null ? 'skipped' : (passed ? 'passed' : 'failed');
  results.tests.push({ name, status, details, timestamp: new Date() });
  if (passed === true) results.passed++;
  else if (passed === false) results.failed++;
  else results.skipped++;

  log(`${name}: ${status.toUpperCase()}`, passed === true ? 'pass' : (passed === false ? 'fail' : 'skip'));
  if (!passed && details.error) {
    log(`  Error: ${details.error}`, 'warn');
  }
}

// ============================================================================
// TEST SETUP
// ============================================================================

async function setupTestCases() {
  log('Setting up test environment...', 'info');

  try {
    const { status, data } = await apiCall('GET', '/api/cases?limit=1');
    if (status !== 200) {
      throw new Error(`API check failed: ${status}`);
    }
    log(`API connected: ${API_URL}`, 'info');
  } catch (e) {
    log(`Cannot connect to API: ${e.message}`, 'fail');
    return false;
  }

  try {
    const { data } = await apiCall('GET', '/api/cases?limit=50');
    if (!data.cases || data.cases.length === 0) {
      log('No cases found in database', 'warn');
      return false;
    }

    // Filter for "clean" cases not in gated/review state for behavior tests
    const cleanCases = data.cases.filter(c =>
      (!c.submission_method || c.submission_method === 'email') &&
      c.status !== 'needs_human_review' &&
      !c.requires_human
    );

    // Also get any email cases (for smoke tests that don't need clean state)
    const allEmailCases = data.cases.filter(c => !c.submission_method || c.submission_method === 'email');

    const testCases = {
      email: allEmailCases.slice(0, 5),
      clean: cleanCases.slice(0, 10),  // Cases not in gated state for behavior tests
      portal: data.cases.filter(c => c.submission_method === 'portal').slice(0, 2),
      all: data.cases.slice(0, 10)
    };

    log(`Found ${data.cases.length} cases (${testCases.email.length} email, ${testCases.clean.length} clean, ${testCases.portal.length} portal)`, 'info');
    return testCases;
  } catch (e) {
    log(`Failed to get cases: ${e.message}`, 'fail');
    return false;
  }
}

// ============================================================================
// SECTION 1: SMOKE TESTS
// ============================================================================

async function runSmokeTests(testCases) {
  console.log('\n' + '='.repeat(60));
  console.log('SECTION 1: SMOKE TESTS');
  console.log('='.repeat(60));

  // T1 — Start an initial run
  const t1Case = testCases.email[0];
  if (t1Case) {
    try {
      log(`T1: Starting initial run for case ${t1Case.id}...`);

      const { status, data } = await apiCall('POST', `/api/cases/${t1Case.id}/run-initial`, {
        autopilotMode: 'SUPERVISED',
        llmStubs: {
          draft: { subject: '[TEST] Initial Request', body: 'Test initial request body' }
        }
      });

      if (status === 202 && data.run) {
        const result = await waitForRunCompletion(data.run.id, 30000);
        const passed = result.status !== 'timeout' && result.status !== 'running';
        recordTest('T1: Initial run completes', passed, {
          runId: data.run.id,
          finalStatus: result.status
        });
      } else if (status === 409) {
        recordTest('T1: Initial run completes', null, { skipped: 'Active run exists' });
      } else {
        recordTest('T1: Initial run completes', false, { status, error: data.error });
      }
    } catch (e) {
      recordTest('T1: Initial run completes', false, { error: e.message });
    }
  }

  // T2 — Process inbound with simulate-response
  const t2Case = testCases.email[1] || testCases.email[0];
  if (t2Case) {
    try {
      log(`T2: Testing inbound processing for case ${t2Case.id}...`);

      const { status, data } = await apiCall('POST', `/api/test/cases/${t2Case.id}/simulate-response`, {
        classification: 'fee_request',
        body: 'The fee for your request is $50.00. Please confirm.',
        extracted_fee: 50,
        trigger_agent: false  // We'll test the agent separately
      });

      if ((status === 200 || status === 201) && data.data?.message_id) {
        // Now trigger the inbound processing
        const { status: runStatus, data: runData } = await apiCall('POST', `/api/cases/${t2Case.id}/run-inbound`, {
          messageId: data.data.message_id,
          autopilotMode: 'SUPERVISED',
          llmStubs: {
            classify: { classification: 'FEE_QUOTE', fee_amount: 50, sentiment: 'neutral' },
            draft: { subject: 'RE: Fee', body: 'We accept.' }
          }
        });

        if (runStatus === 202 && runData.run) {
          const result = await waitForRunCompletion(runData.run.id, 30000);
          recordTest('T2: Inbound processing', result.status !== 'timeout', {
            finalStatus: result.status,
            proposalsCreated: result.proposals?.length || 0
          });
        } else {
          recordTest('T2: Inbound processing', runStatus === 409, {
            note: runStatus === 409 ? 'Concurrent run blocked' : 'Failed',
            status: runStatus
          });
        }
      } else {
        recordTest('T2: Inbound processing', null, { skipped: 'Message creation failed', status });
      }
    } catch (e) {
      recordTest('T2: Inbound processing', false, { error: e.message });
    }
  }

  // T3 — Fetch runs list
  const t3Case = testCases.all[0];
  if (t3Case) {
    try {
      log(`T3: Fetching runs list for case ${t3Case.id}...`);
      const { status, data } = await apiCall('GET', `/api/cases/${t3Case.id}/runs`);
      recordTest('T3: Runs list endpoint', status === 200, {
        runCount: data.runs?.length || 0
      });
    } catch (e) {
      recordTest('T3: Runs list endpoint', false, { error: e.message });
    }
  }
}

// ============================================================================
// SECTION 2: CORE BEHAVIOR MATRIX
// ============================================================================

async function runBehaviorTests(testCases) {
  console.log('\n' + '='.repeat(60));
  console.log('SECTION 2: CORE BEHAVIOR MATRIX');
  console.log('='.repeat(60));

  // Use clean cases (not in gated state) for behavior tests
  // Each test type uses a different case to avoid state conflicts
  const cleanCases = testCases.clean || [];
  if (cleanCases.length === 0) {
    log('No clean (non-gated) test cases available. All cases may be in needs_human_review state.', 'warn');
    log('Falling back to email cases...', 'warn');
  }

  // Assign different cases for different test types
  const feeTestCase = cleanCases[0] || testCases.email[0];
  const denialTestCase = cleanCases[1] || testCases.email[1] || feeTestCase;
  const clarificationTestCase = cleanCases[2] || testCases.email[2] || feeTestCase;
  const sentimentTestCase = cleanCases[3] || testCases.email[3] || feeTestCase;
  const recordsTestCase = cleanCases[4] || testCases.email[4] || feeTestCase;

  if (!feeTestCase) {
    log('No test case available', 'warn');
    return;
  }

  log(`Using cases: fee=${feeTestCase?.id}, denial=${denialTestCase?.id}, clarification=${clarificationTestCase?.id}, sentiment=${sentimentTestCase?.id}`, 'info');

  // T4 — Fee request routing (thresholds)
  const feeTests = [
    { amount: 15, autoMode: 'AUTO', expectedAction: 'ACCEPT_FEE', shouldAutoExec: true },
    { amount: 50, autoMode: 'AUTO', expectedAction: 'ACCEPT_FEE', shouldAutoExec: true },
    { amount: 125, autoMode: 'SUPERVISED', expectedAction: 'ACCEPT_FEE', shouldAutoExec: false },
    { amount: 250, autoMode: 'SUPERVISED', expectedAction: 'ACCEPT_FEE', shouldAutoExec: false },
    { amount: 750, autoMode: 'SUPERVISED', expectedAction: 'NEGOTIATE_FEE', shouldAutoExec: false }
  ];

  log(`T4: Testing fee thresholds on case ${feeTestCase.id}...`);
  const feeResults = [];

  for (const test of feeTests) {
    try {
      // Create message
      const { status: msgStatus, data: msgData } = await apiCall('POST', `/api/test/cases/${feeTestCase.id}/simulate-response`, {
        classification: 'fee_request',
        body: `Your fee is $${test.amount}.00`,
        extracted_fee: test.amount,
        trigger_agent: false
      });

      if ((msgStatus !== 200 && msgStatus !== 201) || !msgData.data?.message_id) {
        feeResults.push({ amount: test.amount, status: 'skip', reason: 'Message creation failed' });
        continue;
      }

      // Run inbound
      const { status, data } = await apiCall('POST', `/api/cases/${feeTestCase.id}/run-inbound`, {
        messageId: msgData.data.message_id,
        autopilotMode: test.autoMode,
        llmStubs: {
          classify: { classification: 'FEE_QUOTE', fee_amount: test.amount, sentiment: 'neutral' },
          draft: { subject: 'Fee Response', body: `Response to $${test.amount} fee.` }
        }
      });

      if (status === 202 && data.run) {
        const result = await waitForRunCompletion(data.run.id, 30000);
        const proposal = result.proposals?.[0];

        feeResults.push({
          amount: test.amount,
          status: result.status,
          actionType: proposal?.action_type,
          requiresHuman: proposal?.requires_human,
          pauseReason: proposal?.pause_reason,
          matchesExpected: proposal?.action_type === test.expectedAction
        });
      } else {
        feeResults.push({ amount: test.amount, status: status === 409 ? 'blocked' : 'error' });
      }

      await new Promise(r => setTimeout(r, 500));
    } catch (e) {
      feeResults.push({ amount: test.amount, status: 'error', error: e.message });
    }
  }

  const feeTestsPassed = feeResults.filter(r => r.matchesExpected).length;
  recordTest('T4: Fee threshold routing', feeTestsPassed >= 3, {
    passed: feeTestsPassed,
    total: feeResults.length,
    details: feeResults
  });

  // T5 — Weak denial → rebuttal
  try {
    log(`T5: Testing weak denial on case ${denialTestCase.id}...`);

    const { data: msgData } = await apiCall('POST', `/api/test/cases/${denialTestCase.id}/simulate-response`, {
      classification: 'denial',
      body: 'Your request is denied. Please use our online portal instead.',
      trigger_agent: false
    });

    if (msgData.data?.message_id) {
      const { status, data } = await apiCall('POST', `/api/cases/${denialTestCase.id}/run-inbound`, {
        messageId: msgData.data.message_id,
        autopilotMode: 'AUTO',
        llmStubs: {
          classify: { classification: 'DENIAL', sentiment: 'neutral' },
          draft: { subject: 'RE: Denial', body: 'Legal rebuttal.' }
        }
      });

      if (status === 202 && data.run) {
        const result = await waitForRunCompletion(data.run.id, 30000);
        const proposal = result.proposals?.[0];
        recordTest('T5: Weak denial rebuttal', proposal?.action_type === 'SEND_REBUTTAL', {
          actionType: proposal?.action_type
        });
      }
    }
  } catch (e) {
    recordTest('T5: Weak denial rebuttal', false, { error: e.message });
  }

  // T6 — Strong denial → human gate
  try {
    log(`T6: Testing strong denial on case ${denialTestCase.id}...`);

    const { data: msgData } = await apiCall('POST', `/api/test/cases/${denialTestCase.id}/simulate-response`, {
      classification: 'denial',
      body: 'Denied pursuant to law enforcement exemption under statute 132-1.4. Active ongoing investigation.',
      trigger_agent: false
    });

    if (msgData.data?.message_id) {
      const { status, data } = await apiCall('POST', `/api/cases/${denialTestCase.id}/run-inbound`, {
        messageId: msgData.data.message_id,
        autopilotMode: 'AUTO',
        llmStubs: {
          classify: { classification: 'DENIAL', sentiment: 'neutral', key_points: ['law enforcement'] },
          draft: { subject: 'RE: Denial', body: 'Strong rebuttal.' }
        }
      });

      if (status === 202 && data.run) {
        const result = await waitForRunCompletion(data.run.id, 30000);
        const proposal = result.proposals?.[0];
        recordTest('T6: Strong denial gate', proposal?.requires_human === true, {
          requiresHuman: proposal?.requires_human,
          pauseReason: proposal?.pause_reason
        });
      }
    }
  } catch (e) {
    recordTest('T6: Strong denial gate', false, { error: e.message });
  }

  // T7 — Clarification request (CRITICAL - previously broken)
  try {
    log(`T7: Testing clarification request on case ${clarificationTestCase.id} (CRITICAL)...`);

    const { data: msgData } = await apiCall('POST', `/api/test/cases/${clarificationTestCase.id}/simulate-response`, {
      classification: 'more_info_needed',
      body: 'We need more information. Please provide the incident date and case number.',
      trigger_agent: false
    });

    if (msgData.data?.message_id) {
      const startTime = Date.now();
      const { status, data } = await apiCall('POST', `/api/cases/${clarificationTestCase.id}/run-inbound`, {
        messageId: msgData.data.message_id,
        autopilotMode: 'SUPERVISED',
        llmStubs: {
          classify: { classification: 'CLARIFICATION_REQUEST', sentiment: 'neutral' },
          draft: { subject: 'RE: Additional Info', body: 'Here is the information.' }
        }
      });

      if (status === 202 && data.run) {
        const result = await waitForRunCompletion(data.run.id, 60000);
        const duration = Date.now() - startTime;
        const passed = result.status !== 'timeout' && result.status !== 'running';

        recordTest('T7: Clarification request (CRITICAL)', passed, {
          finalStatus: result.status,
          durationMs: duration,
          stuck: result.status === 'running' ? 'YES - STUCK!' : 'No',
          actionType: result.proposals?.[0]?.action_type
        });
      }
    }
  } catch (e) {
    recordTest('T7: Clarification request (CRITICAL)', false, { error: e.message });
  }

  // T8 — Hostile sentiment → escalation
  try {
    log(`T8: Testing hostile sentiment on case ${sentimentTestCase.id}...`);

    const { data: msgData } = await apiCall('POST', `/api/test/cases/${sentimentTestCase.id}/simulate-response`, {
      classification: 'denial',
      body: 'This is an outrageous and frivolous request! Stop wasting our time!',
      trigger_agent: false
    });

    if (msgData.data?.message_id) {
      const { status, data } = await apiCall('POST', `/api/cases/${sentimentTestCase.id}/run-inbound`, {
        messageId: msgData.data.message_id,
        autopilotMode: 'AUTO',
        llmStubs: {
          classify: { classification: 'DENIAL', sentiment: 'hostile' },
          draft: { subject: 'RE: Response', body: 'Professional response.' }
        }
      });

      if (status === 202 && data.run) {
        const result = await waitForRunCompletion(data.run.id, 30000);
        const proposal = result.proposals?.[0];
        recordTest('T8: Hostile sentiment gate', proposal?.requires_human === true, {
          requiresHuman: proposal?.requires_human
        });
      }
    }
  } catch (e) {
    recordTest('T8: Hostile sentiment gate', false, { error: e.message });
  }

  // T9 — Portal case (skip if no portal cases)
  const portalCase = testCases.portal[0];
  if (portalCase) {
    recordTest('T9: Portal case no email', null, { skipped: 'Portal test requires manual setup' });
  } else {
    recordTest('T9: Portal case no email', null, { skipped: 'No portal case available' });
  }

  // T10 — Records ready → no proposal
  try {
    log(`T10: Testing records ready on case ${recordsTestCase.id}...`);

    const { data: msgData } = await apiCall('POST', `/api/test/cases/${recordsTestCase.id}/simulate-response`, {
      classification: 'delivery',
      body: 'Your records are ready for pickup.',
      trigger_agent: false
    });

    if (msgData.data?.message_id) {
      const { status, data } = await apiCall('POST', `/api/cases/${recordsTestCase.id}/run-inbound`, {
        messageId: msgData.data.message_id,
        autopilotMode: 'AUTO',
        llmStubs: { classify: { classification: 'RECORDS_READY', sentiment: 'positive' } }
      });

      if (status === 202 && data.run) {
        const result = await waitForRunCompletion(data.run.id, 30000);
        recordTest('T10: Records ready no proposal', (result.proposals?.length || 0) === 0, {
          proposalCount: result.proposals?.length || 0
        });
      }
    }
  } catch (e) {
    recordTest('T10: Records ready no proposal', false, { error: e.message });
  }
}

// ============================================================================
// SECTION 3: HUMAN DECISION TESTS
// ============================================================================

async function runDecisionTests(testCases) {
  console.log('\n' + '='.repeat(60));
  console.log('SECTION 3: HUMAN DECISION TESTS');
  console.log('='.repeat(60));

  try {
    const { data } = await apiCall('GET', '/api/proposals?status=PENDING_APPROVAL&limit=5');

    if (!data.proposals || data.proposals.length === 0) {
      log('No pending proposals available', 'warn');
      recordTest('T11: Approve decision', null, { skipped: 'No pending proposals' });
      recordTest('T12: Adjust decision', null, { skipped: 'No pending proposals' });
      recordTest('T13: Dismiss decision', null, { skipped: 'No pending proposals' });
      return;
    }

    const proposals = data.proposals;

    // T11 — Approve
    if (proposals[0]) {
      try {
        log(`T11: Testing APPROVE on proposal ${proposals[0].id}...`);
        const { status, data: approveData } = await apiCall('POST', `/api/proposals/${proposals[0].id}/decision`, {
          action: 'APPROVE',
          reason: 'Test approval'
        });

        // The decision endpoint returns 202 with a run_id - we need to wait for it to complete
        if (status === 202 && approveData.run?.id) {
          log(`T11: Waiting for resume run ${approveData.run.id} to complete...`);
          const runResult = await waitForRunCompletion(approveData.run.id, 30000);
          log(`T11: Resume run status: ${runResult.status}`);
        } else {
          // Fallback: wait a bit if no run_id returned
          await new Promise(r => setTimeout(r, 3000));
        }

        const { data: checkData } = await apiCall('GET', `/api/proposals/${proposals[0].id}`);
        // After APPROVE, status should be EXECUTED, DECISION_RECEIVED, or APPROVED (not PENDING_APPROVAL)
        const validStatuses = ['EXECUTED', 'DECISION_RECEIVED', 'APPROVED'];
        const passed = validStatuses.includes(checkData.proposal?.status);

        recordTest('T11: Approve decision', passed, {
          newStatus: checkData.proposal?.status,
          expectedStatuses: validStatuses
        });
      } catch (e) {
        recordTest('T11: Approve decision', false, { error: e.message });
      }
    }

    // T12 — Adjust
    if (proposals[1]) {
      try {
        log(`T12: Testing ADJUST on proposal ${proposals[1].id}...`);
        const { status, data: adjustData } = await apiCall('POST', `/api/proposals/${proposals[1].id}/decision`, {
          action: 'ADJUST',
          instruction: 'Make tone more formal'
        });

        // Handle 409 (already processed) as skip, not failure
        if (status === 409) {
          recordTest('T12: Adjust decision', null, {
            skipped: 'Proposal already processed',
            status,
            currentStatus: adjustData.current_status
          });
        } else {
          recordTest('T12: Adjust decision', status === 202, { status });
        }
      } catch (e) {
        recordTest('T12: Adjust decision', false, { error: e.message });
      }
    } else {
      recordTest('T12: Adjust decision', null, { skipped: 'Not enough proposals' });
    }

    // T13 — Dismiss
    if (proposals[2]) {
      try {
        log(`T13: Testing DISMISS on proposal ${proposals[2].id}...`);
        const { status, data: dismissData } = await apiCall('POST', `/api/proposals/${proposals[2].id}/decision`, {
          action: 'DISMISS',
          reason: 'Test dismissal'
        });

        // Handle 409 (already processed) - not a failure, just means proposal was already actioned
        if (status === 409) {
          recordTest('T13: Dismiss decision', null, {
            skipped: 'Proposal already processed',
            status,
            currentStatus: dismissData.current_status
          });
        } else {
          const { data: checkData } = await apiCall('GET', `/api/proposals/${proposals[2].id}`);
          recordTest('T13: Dismiss decision', checkData.proposal?.status === 'DISMISSED', {
            httpStatus: status,
            finalStatus: checkData.proposal?.status
          });
        }
      } catch (e) {
        recordTest('T13: Dismiss decision', false, { error: e.message });
      }
    } else {
      recordTest('T13: Dismiss decision', null, { skipped: 'Not enough proposals' });
    }
  } catch (e) {
    log(`Failed to get proposals: ${e.message}`, 'fail');
  }
}

// ============================================================================
// SECTION 4: IDEMPOTENCY TESTS
// ============================================================================

async function runIdempotencyTests(testCases) {
  console.log('\n' + '='.repeat(60));
  console.log('SECTION 4: IDEMPOTENCY TESTS');
  console.log('='.repeat(60));

  const testCase = testCases.email[0];
  if (!testCase) return;

  // T14 — Duplicate inbound protection
  try {
    log('T14: Testing duplicate inbound protection...');

    const { data: msgData } = await apiCall('POST', `/api/test/cases/${testCase.id}/simulate-response`, {
      classification: 'acknowledgment',
      body: 'We received your request.',
      trigger_agent: false
    });

    if (msgData.data?.message_id) {
      // First submission
      const result1 = await apiCall('POST', `/api/cases/${testCase.id}/run-inbound`, {
        messageId: msgData.data.message_id,
        autopilotMode: 'SUPERVISED',
        llmStubs: { classify: { classification: 'ACKNOWLEDGMENT' } }
      });

      await new Promise(r => setTimeout(r, 1500));

      // Second submission
      const result2 = await apiCall('POST', `/api/cases/${testCase.id}/run-inbound`, {
        messageId: msgData.data.message_id,
        autopilotMode: 'SUPERVISED',
        llmStubs: { classify: { classification: 'ACKNOWLEDGMENT' } }
      });

      const secondBlocked = result2.status === 409;
      recordTest('T14: Duplicate inbound protection', secondBlocked, {
        firstStatus: result1.status,
        secondStatus: result2.status,
        note: secondBlocked ? 'Correctly blocked' : 'FAILED - Should have blocked'
      });
    }
  } catch (e) {
    recordTest('T14: Duplicate inbound protection', false, { error: e.message });
  }

  // T15 — Unique proposal keys
  try {
    log('T15: Testing proposal key uniqueness...');
    const { data } = await apiCall('GET', '/api/proposals?limit=20');

    if (data.proposals?.length > 0) {
      const keys = data.proposals.map(p => p.proposal_key).filter(Boolean);
      const uniqueKeys = new Set(keys);
      recordTest('T15: Unique proposal keys', keys.length === uniqueKeys.size, {
        total: keys.length,
        unique: uniqueKeys.size
      });
    } else {
      recordTest('T15: Unique proposal keys', null, { skipped: 'No proposals' });
    }
  } catch (e) {
    recordTest('T15: Unique proposal keys', false, { error: e.message });
  }

  // T16 — Followup idempotency
  try {
    log('T16: Testing followup idempotency...');
    const { data } = await apiCall('GET', '/api/followups?status=scheduled&limit=1');

    if (data.followups?.length > 0) {
      const followup = data.followups[0];
      const result1 = await apiCall('POST', `/api/followups/${followup.id}/trigger`);
      await new Promise(r => setTimeout(r, 500));
      const result2 = await apiCall('POST', `/api/followups/${followup.id}/trigger`);

      const passed = result1.status === 202 && (result2.status === 409 || result2.data.run?.id === result1.data.run?.id);
      recordTest('T16: Followup idempotency', passed, {
        firstStatus: result1.status,
        secondStatus: result2.status
      });
    } else {
      recordTest('T16: Followup idempotency', null, { skipped: 'No followups' });
    }
  } catch (e) {
    recordTest('T16: Followup idempotency', false, { error: e.message });
  }
}

// ============================================================================
// SECTION 5: LOAD TESTS
// ============================================================================

async function runLoadTests(testCases) {
  console.log('\n' + '='.repeat(60));
  console.log('SECTION 5: LOAD TESTS (Abbreviated)');
  console.log('='.repeat(60));

  // T17 — Burst test (10 requests)
  try {
    log('T17: Burst test (10 requests)...');
    const startTime = Date.now();

    const promises = testCases.all.slice(0, 10).map(async (c) => {
      try {
        const { status } = await apiCall('GET', `/api/cases/${c.id}/runs`);
        return { caseId: c.id, status: status === 200 ? 'ok' : 'error' };
      } catch (e) {
        return { caseId: c.id, status: 'error' };
      }
    });

    const results = await Promise.all(promises);
    const duration = Date.now() - startTime;
    const errors = results.filter(r => r.status === 'error').length;

    recordTest('T17: Burst test', errors === 0, {
      requests: results.length,
      errors,
      durationMs: duration
    });
  } catch (e) {
    recordTest('T17: Burst test', false, { error: e.message });
  }

  // T18 — Check for stuck runs
  try {
    log('T18: Checking for stuck runs...');
    const { data } = await apiCall('GET', '/api/runs?status=running&limit=50');

    const stuckRuns = (data.runs || []).filter(r => {
      if (!r.started_at) return false;
      return (Date.now() - new Date(r.started_at).getTime()) > 120000;
    });

    recordTest('T18: No stuck runs', stuckRuns.length === 0, {
      running: data.runs?.length || 0,
      stuck: stuckRuns.length,
      stuckIds: stuckRuns.map(r => r.id)
    });
  } catch (e) {
    recordTest('T18: No stuck runs', false, { error: e.message });
  }
}

// ============================================================================
// REPORT
// ============================================================================

function generateReport() {
  results.endTime = new Date();
  const durationSec = (results.endTime - results.startTime) / 1000;

  console.log('\n' + '='.repeat(60));
  console.log('PRODUCTION READINESS TEST REPORT');
  console.log('='.repeat(60));

  console.log(`\nRun: ${results.startTime.toISOString()}`);
  console.log(`Duration: ${durationSec.toFixed(1)}s`);
  console.log(`API: ${API_URL}`);

  console.log('\n--- SUMMARY ---');
  console.log(`Total: ${results.tests.length}`);
  console.log(`Passed: ${results.passed} ✅`);
  console.log(`Failed: ${results.failed} ❌`);
  console.log(`Skipped: ${results.skipped} ⏭️`);

  const passRate = results.tests.length > 0 ?
    ((results.passed / (results.tests.length - results.skipped)) * 100).toFixed(1) : 0;
  console.log(`Pass Rate: ${passRate}%`);

  console.log('\n--- RESULTS ---\n');

  results.tests.forEach((test, i) => {
    const icon = test.status === 'passed' ? '✅' : (test.status === 'failed' ? '❌' : '⏭️');
    console.log(`${i + 1}. ${icon} ${test.name}`);
    if (test.details && Object.keys(test.details).length > 0) {
      console.log(`   ${JSON.stringify(test.details)}`);
    }
  });

  console.log('\n--- CRITERIA ---\n');

  const criteria = [
    { name: '0 stuck runs', test: 'stuck' },
    { name: 'Clarification completes', test: 'Clarification' },
    { name: 'Fee thresholds work', test: 'Fee threshold' },
    { name: 'Duplicate protection', test: 'Duplicate' }
  ];

  criteria.forEach(c => {
    const test = results.tests.find(t => t.name.includes(c.test));
    const passed = test?.status === 'passed';
    console.log(`${passed ? '✅' : '❌'} ${c.name}`);
  });

  const allPassed = results.failed === 0;
  console.log(`\n${allPassed ? '🎉 READY FOR PRODUCTION' : '⚠️ REVIEW REQUIRED'}`);

  return results;
}

// ============================================================================
// MAIN
// ============================================================================

async function main() {
  console.log('🧪 FOIA Agent Production Readiness Tests');
  console.log(`API: ${API_URL}\n`);

  const testCases = await setupTestCases();
  if (!testCases) {
    process.exit(1);
  }

  await runSmokeTests(testCases);
  await runBehaviorTests(testCases);
  await runDecisionTests(testCases);
  await runIdempotencyTests(testCases);
  await runLoadTests(testCases);

  const report = generateReport();
  process.exit(report.failed > 0 ? 1 : 0);
}

main().catch(e => {
  console.error('Test runner failed:', e);
  process.exit(1);
});
