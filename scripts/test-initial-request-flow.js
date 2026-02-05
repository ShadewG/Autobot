#!/usr/bin/env node
/**
 * Test Initial Request Flow
 *
 * This script tests the first part of the FOIA automation pipeline:
 * 1. Import case from Notion (or use existing case)
 * 2. Trigger initial request generation (LangGraph)
 * 3. Review the generated proposal
 * 4. Approve and send the email
 *
 * Responses are stored when they arrive via webhook but not auto-processed.
 * This limits failure points for testing.
 *
 * Usage:
 *   node scripts/test-initial-request-flow.js [options]
 *
 * Options:
 *   --case-id=<id>       Use existing case ID instead of importing
 *   --notion-url=<url>   Import from specific Notion page URL
 *   --sync-notion        Sync all "Ready To Send" cases from Notion
 *   --dry-run            Don't actually send emails (default in dev)
 *   --auto-approve       Automatically approve proposals
 *   --watch              Watch for inbound responses after sending
 */

const API_BASE = process.env.API_BASE_URL || 'http://localhost:3000';

// Parse command line arguments
const args = process.argv.slice(2).reduce((acc, arg) => {
  if (arg.startsWith('--')) {
    const [key, value] = arg.slice(2).split('=');
    acc[key] = value || true;
  }
  return acc;
}, {});

async function fetchJson(url, options = {}) {
  const res = await fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...options.headers
    }
  });
  const data = await res.json();
  if (!res.ok && !data.success) {
    throw new Error(data.error || `HTTP ${res.status}`);
  }
  return data;
}

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function getCaseToTest() {
  // Option 1: Use existing case ID
  if (args['case-id']) {
    const caseId = parseInt(args['case-id']);
    console.log(`\n[1] Using existing case ID: ${caseId}`);

    const caseData = await fetchJson(`${API_BASE}/api/cases/${caseId}`);
    if (!caseData.success) {
      throw new Error(`Case ${caseId} not found`);
    }

    console.log(`   Case: ${caseData.case.case_name}`);
    console.log(`   Agency: ${caseData.case.agency_name}`);
    console.log(`   Email: ${caseData.case.agency_email}`);
    console.log(`   Status: ${caseData.case.status}`);

    return caseData.case;
  }

  // Option 2: Import from specific Notion URL
  if (args['notion-url']) {
    console.log(`\n[1] Importing from Notion URL...`);
    console.log(`   URL: ${args['notion-url']}`);

    const result = await fetchJson(`${API_BASE}/api/cases/import-notion`, {
      method: 'POST',
      body: JSON.stringify({ notion_url: args['notion-url'] })
    });

    console.log(`   Imported: ${result.case.case_name}`);
    console.log(`   Agency: ${result.case.agency_name}`);
    console.log(`   Email: ${result.case.agency_email}`);

    return result.case;
  }

  // Option 3: Sync all Ready To Send cases from Notion
  if (args['sync-notion']) {
    console.log(`\n[1] Syncing "Ready To Send" cases from Notion...`);

    const result = await fetchJson(`${API_BASE}/api/sync/notion`, {
      method: 'POST',
      body: JSON.stringify({ status: 'Ready To Send' })
    });

    if (!result.cases?.length) {
      throw new Error('No cases found with "Ready To Send" status in Notion');
    }

    console.log(`   Synced ${result.synced} cases`);
    result.cases.forEach(c => {
      console.log(`   - [${c.id}] ${c.case_name} (${c.agency})`);
    });

    // Get full case details for first case
    const fullCase = await fetchJson(`${API_BASE}/api/cases/${result.cases[0].id}`);
    return fullCase.case;
  }

  // Default: List ready_to_send cases in database
  console.log(`\n[1] Looking for ready_to_send cases in database...`);

  const result = await fetchJson(`${API_BASE}/api/cases?status=ready_to_send&limit=5`);

  if (!result.cases?.length) {
    console.log('   No ready_to_send cases found.');
    console.log('\n   Options:');
    console.log('   --notion-url=<url>  Import from Notion page');
    console.log('   --sync-notion       Sync from Notion database');
    console.log('   --case-id=<id>      Use existing case ID');
    process.exit(1);
  }

  console.log(`   Found ${result.cases.length} cases:`);
  result.cases.forEach(c => {
    console.log(`   - [${c.id}] ${c.case_name} (${c.agency_name})`);
  });

  // Return first case
  return result.cases[0];
}

async function triggerInitialRequest(caseId) {
  console.log(`\n[2] Triggering initial request generation...`);
  console.log(`   Case ID: ${caseId}`);
  console.log(`   Mode: SUPERVISED (requires approval)`);

  const result = await fetchJson(`${API_BASE}/api/run-engine/cases/${caseId}/run-initial`, {
    method: 'POST',
    body: JSON.stringify({
      autopilotMode: 'SUPERVISED'
    })
  });

  console.log(`   Run ID: ${result.run.id}`);
  console.log(`   Status: ${result.run.status}`);
  console.log(`   Thread: ${result.run.thread_id}`);

  return result.run;
}

async function waitForProposal(runId, maxWaitMs = 60000) {
  console.log(`\n[3] Waiting for proposal generation...`);

  const startTime = Date.now();
  let proposal = null;

  while (Date.now() - startTime < maxWaitMs) {
    const result = await fetchJson(`${API_BASE}/api/run-engine/runs/${runId}`);

    if (result.run.status === 'failed') {
      throw new Error(`Run failed: ${result.run.error}`);
    }

    if (result.proposals?.length > 0) {
      proposal = result.proposals[0];
      break;
    }

    if (result.run.status === 'completed' && !result.proposals?.length) {
      console.log(`   Run completed but no proposals created`);
      return null;
    }

    process.stdout.write('.');
    await sleep(2000);
  }

  if (!proposal) {
    throw new Error('Timeout waiting for proposal');
  }

  console.log(`\n   Proposal created!`);
  console.log(`   ID: ${proposal.id}`);
  console.log(`   Action: ${proposal.action_type}`);
  console.log(`   Status: ${proposal.status}`);

  return proposal;
}

function displayProposal(proposal) {
  console.log('\n' + '='.repeat(60));
  console.log('GENERATED FOIA REQUEST');
  console.log('='.repeat(60));
  console.log(`\nSubject: ${proposal.draft_subject}`);
  console.log('\nBody:');
  console.log('-'.repeat(60));
  console.log(proposal.draft_body_text?.substring(0, 2000) || '(empty)');
  if (proposal.draft_body_text?.length > 2000) {
    console.log(`\n... (truncated, ${proposal.draft_body_text.length} chars total)`);
  }
  console.log('-'.repeat(60));
  console.log(`\nConfidence: ${proposal.confidence || 'N/A'}`);
  console.log(`Risk Flags: ${JSON.stringify(proposal.risk_flags) || 'none'}`);
  console.log(`Reasoning: ${proposal.reasoning || 'N/A'}`);
  console.log('='.repeat(60));
}

async function approveProposal(proposalId) {
  console.log(`\n[4] Approving proposal ${proposalId}...`);

  const result = await fetchJson(`${API_BASE}/api/run-engine/proposals/${proposalId}/decision`, {
    method: 'POST',
    body: JSON.stringify({
      action: 'APPROVE',
      reason: 'Test run approval'
    })
  });

  console.log(`   Decision submitted`);
  console.log(`   Resume run ID: ${result.run?.id || 'N/A'}`);

  return result;
}

async function waitForExecution(runId, maxWaitMs = 60000) {
  console.log(`\n[5] Waiting for email execution...`);

  const startTime = Date.now();

  while (Date.now() - startTime < maxWaitMs) {
    const result = await fetchJson(`${API_BASE}/api/run-engine/runs/${runId}`);

    if (result.run.status === 'completed') {
      console.log(`   Email sent successfully!`);
      return result;
    }

    if (result.run.status === 'failed') {
      throw new Error(`Execution failed: ${result.run.error}`);
    }

    process.stdout.write('.');
    await sleep(2000);
  }

  throw new Error('Timeout waiting for execution');
}

async function watchForResponses(caseId, durationMs = 300000) {
  console.log(`\n[6] Watching for inbound responses...`);
  console.log(`   Will monitor for ${Math.round(durationMs / 60000)} minutes`);
  console.log(`   Press Ctrl+C to stop\n`);

  let lastMessageCount = 0;
  const startTime = Date.now();

  while (Date.now() - startTime < durationMs) {
    try {
      // Use the thread endpoint to get messages
      const result = await fetchJson(`${API_BASE}/api/cases/${caseId}/thread`);

      const inboundMessages = (result.messages || []).filter(m => m.direction === 'inbound');
      const messageCount = inboundMessages.length;

      if (messageCount > lastMessageCount) {
        const newMessages = inboundMessages.slice(lastMessageCount);
        newMessages.forEach(msg => {
          console.log('\n' + '='.repeat(60));
          console.log('NEW INBOUND RESPONSE RECEIVED');
          console.log('='.repeat(60));
          console.log(`From: ${msg.from_email}`);
          console.log(`Subject: ${msg.subject}`);
          console.log(`Received: ${msg.received_at || msg.created_at}`);
          console.log(`Message ID: ${msg.id}`);
          console.log('-'.repeat(60));
          console.log(msg.body_text?.substring(0, 500) || '(empty)');
          console.log('='.repeat(60));
        });
        lastMessageCount = messageCount;
      }

    } catch (e) {
      // Ignore errors during watch (thread may not exist yet)
    }

    await sleep(10000); // Check every 10 seconds
  }

  console.log('\n   Watch period ended');
}

async function main() {
  console.log('='.repeat(60));
  console.log('FOIA INITIAL REQUEST TEST RUN');
  console.log('='.repeat(60));
  console.log(`API Base: ${API_BASE}`);
  console.log(`Dry Run: ${args['dry-run'] ? 'YES (emails not sent)' : 'NO (emails will be sent!)'}`);
  console.log(`Auto Approve: ${args['auto-approve'] ? 'YES' : 'NO (manual review)'}`);

  try {
    // Step 1: Get a case to test
    const testCase = await getCaseToTest();

    if (!testCase.agency_email) {
      console.error('\n   ERROR: Case has no agency_email - cannot send request');
      console.log('   Please update the case or Notion page with a valid email');
      process.exit(1);
    }

    // Step 2: Trigger initial request
    const run = await triggerInitialRequest(testCase.id);

    // Step 3: Wait for proposal
    const proposal = await waitForProposal(run.id);

    if (!proposal) {
      console.log('\n   No proposal generated - check logs for errors');
      process.exit(1);
    }

    // Display the generated request
    displayProposal(proposal);

    // Step 4: Approve (or wait for manual approval)
    if (proposal.status === 'PENDING_APPROVAL') {
      if (args['auto-approve']) {
        await approveProposal(proposal.id);

        // Step 5: Wait for execution
        const resumeResult = await fetchJson(`${API_BASE}/api/run-engine/runs?case_id=${testCase.id}&limit=1`);
        const resumeRun = resumeResult.runs?.[0];

        if (resumeRun) {
          await waitForExecution(resumeRun.id);
        }
      } else {
        console.log('\n[4] MANUAL APPROVAL REQUIRED');
        console.log('   Proposal is waiting for your approval.');
        console.log(`   Proposal ID: ${proposal.id}`);
        console.log(`\n   To approve via API:`);
        console.log(`   curl -X POST ${API_BASE}/api/run-engine/proposals/${proposal.id}/decision \\`);
        console.log(`     -H "Content-Type: application/json" \\`);
        console.log(`     -d '{"action": "APPROVE"}'`);
        console.log('\n   Or approve via dashboard at:');
        console.log(`   ${API_BASE}/proposals/${proposal.id}`);

        if (!args['watch']) {
          process.exit(0);
        }
      }
    }

    // Step 6: Watch for responses (optional)
    if (args['watch']) {
      await watchForResponses(testCase.id);
    }

    console.log('\n' + '='.repeat(60));
    console.log('TEST RUN COMPLETE');
    console.log('='.repeat(60));
    console.log(`\nCase ID: ${testCase.id}`);
    console.log(`Case Name: ${testCase.case_name}`);
    console.log(`\nNext steps:`);
    console.log(`1. Check the agency inbox for your email`);
    console.log(`2. Responses will arrive via SendGrid webhook`);
    console.log(`3. View case status: ${API_BASE}/cases/${testCase.id}`);
    console.log(`4. View run history: ${API_BASE}/api/run-engine/cases/${testCase.id}/runs`);

  } catch (error) {
    console.error('\n   ERROR:', error.message);
    process.exit(1);
  }
}

main();
