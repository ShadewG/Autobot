#!/usr/bin/env node
/**
 * Create a test run on the Railway API for dashboard viewing
 */

const API_BASE = process.env.API_BASE_URL || 'https://sincere-strength-production.up.railway.app';

// Use an existing case for testing (Raleigh PD case)
const TEST_CASE_ID = process.env.TEST_CASE_ID || 1660;

async function createTestRun() {
  const timestamp = Date.now();

  console.log('='.repeat(60));
  console.log('Creating test run on:', API_BASE);
  console.log('='.repeat(60));

  // 1. Use existing case
  console.log('\n1. Using existing case ID:', TEST_CASE_ID);
  const caseData = { id: TEST_CASE_ID };

  // 2. Ingest a test email (portal redirect scenario)
  console.log('\n2. Ingesting portal redirect email...');
  const ingestRes = await fetch(`${API_BASE}/api/requests/${caseData.id}/ingest-email`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message_id: `<test-portal-${timestamp}@prompt-test.fixture>`,
      subject: 'RE: Public Records Request',
      body_text: `Thank you for your request. The Raleigh Police Department uses NextRequest for all public records requests.

Please submit your request through our online portal at:
https://raleighnc.nextrequest.com

This will ensure faster processing and allow you to track your request status.

Thank you,
Records Division`,
      from_address: 'records@raleighpd.gov',
      message_type: 'inbound'
    })
  });

  const ingestData = await ingestRes.json();
  const messageId = ingestData.messageId || ingestData.message_id;

  if (!messageId) {
    console.error('Failed to ingest email:', ingestData);
    return;
  }
  console.log('   Message ID:', messageId);

  // 3. Trigger run-inbound
  console.log('\n3. Triggering agent run...');
  const runRes = await fetch(`${API_BASE}/api/run-engine/cases/${caseData.id}/run-inbound`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messageId: messageId,
      autopilotMode: 'SUPERVISED'
    })
  });

  const runData = await runRes.json();

  if (runData.run?.id) {
    console.log('   Run ID:', runData.run.id);
    console.log('\n' + '='.repeat(60));
    console.log('✅ SUCCESS! View your run at:');
    console.log(`   ${API_BASE}/runs/${runData.run.id}`);
    console.log('\nOr view all runs:');
    console.log(`   ${API_BASE}/runs/`);
    console.log('='.repeat(60));
  } else {
    console.error('Run creation response:', runData);
  }
}

createTestRun().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
