/**
 * Trigger REAL Trigger.dev tasks (not local step calls)
 *
 * Creates test data in DB, then uses tasks.trigger() to invoke
 * actual Trigger.dev runs in the prod environment.
 *
 * Test 1: process-inbound with an ACKNOWLEDGMENT email → completes immediately (no email sent)
 * Test 2: process-initial-request for a new case → drafts + sends real FOIA request
 *
 * Usage:
 *   node scripts/_trigger_real_tests.js
 */

require('dotenv').config({ path: '.env.test', override: true });
if (process.env.DATABASE_PUBLIC_URL) {
  process.env.DATABASE_URL = process.env.DATABASE_PUBLIC_URL;
}

const { tasks } = require('@trigger.dev/sdk');
const db = require('../services/database');

const ts = Date.now();

// ─── Test 1: Inbound Acknowledgment (should complete without sending email) ─

async function setupInboundTest() {
  console.log('\n━━━ Test 1: Inbound Acknowledgment ━━━');
  console.log('Expected: classify as ACKNOWLEDGMENT → decision NONE → task COMPLETED');

  const caseRow = await db.createCase({
    notion_page_id: `test-real-ack-${ts}`,
    case_name: 'Real Test - Acknowledgment Flow',
    subject_name: 'James Wilson',
    agency_name: 'Austin Police Department',
    agency_email: 'records@austintexas.gov',
    state: 'TX',
    requested_records: ['Body camera footage from incident on 12/01/2024', 'Incident report #2024-APD-88291'],
    status: 'awaiting_response',
  });

  const threadRow = await db.createEmailThread({
    case_id: caseRow.id,
    thread_id: `thread-real-ack-${ts}`,
    subject: 'RE: Public Records Request - Wilson',
    agency_email: 'records@austintexas.gov',
  });

  // Outbound (our initial request)
  await db.createMessage({
    thread_id: threadRow.id,
    case_id: caseRow.id,
    message_id: `<outbound-real-ack-${ts}@matcher.com>`,
    direction: 'outbound',
    from_email: 'samuel@matcher.com',
    to_email: 'records@austintexas.gov',
    subject: 'Public Records Request - James Wilson',
    body_text: 'Dear Records Custodian,\n\nI am requesting body camera footage and incident report #2024-APD-88291.\n\nThank you,\nSamuel Hylton',
    message_type: 'initial_request',
    sent_at: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000),
  });

  // Inbound (agency acknowledgment)
  const msgRow = await db.createMessage({
    thread_id: threadRow.id,
    case_id: caseRow.id,
    message_id: `<inbound-real-ack-${ts}@austintexas.gov>`,
    direction: 'inbound',
    from_email: 'records@austintexas.gov',
    to_email: 'samuel@matcher.com',
    subject: 'RE: Public Records Request - Wilson',
    body_text: `Dear Mr. Hylton,

This is to acknowledge receipt of your public records request regarding James Wilson, received on February 22, 2025.

Your request has been assigned tracking number PRR-2025-04821. Per the Texas Public Information Act (Chapter 552 of the Texas Government Code), we have ten business days to respond to your request.

We are currently reviewing the records you have requested and will provide a substantive response within the statutory timeframe. If we require additional time or need to consult with the Office of the Attorney General, we will notify you promptly.

For status inquiries, please reference your tracking number PRR-2025-04821.

Sincerely,
Records Division
Austin Police Department`,
    message_type: 'response',
    received_at: new Date(),
  });

  console.log(`  Created case #${caseRow.id}, message #${msgRow.id}`);
  return { caseId: caseRow.id, messageId: msgRow.id };
}

// ─── Test 2: Initial Request (drafts and sends a real FOIA email) ─

async function setupInitialRequestTest() {
  console.log('\n━━━ Test 2: Initial Request (SUPERVISED) ━━━');
  console.log('Expected: draft FOIA request → create proposal → WAITING for human approval');

  const caseRow = await db.createCase({
    notion_page_id: `test-real-init-${ts}`,
    case_name: 'Real Test - Initial Request Flow',
    subject_name: 'Maria Gonzalez',
    agency_name: 'Miami-Dade Police Department',
    agency_email: 'overlord1pvp@gmail.com', // test email so we don't spam real agencies
    state: 'FL',
    requested_records: [
      'Arrest report for Maria Gonzalez, booking #2024-MD-55032',
      'Body-worn camera footage from arrest on 10/15/2024',
      'Incident report and supplemental reports',
    ],
    status: 'ready_to_send',
  });

  console.log(`  Created case #${caseRow.id} (sending to test email: overlord1pvp@gmail.com)`);
  return { caseId: caseRow.id };
}

// ─── Main ─

async function main() {
  console.log('╔══════════════════════════════════════════════════╗');
  console.log('║  Triggering REAL Trigger.dev Tasks (prod env)   ║');
  console.log('╚══════════════════════════════════════════════════╝');

  try {
    // Setup test data
    const inbound = await setupInboundTest();
    const initial = await setupInitialRequestTest();

    // Trigger real tasks
    console.log('\n━━━ Triggering tasks via Trigger.dev SDK ━━━');

    const inboundHandle = await tasks.trigger('process-inbound', {
      caseId: inbound.caseId,
      messageId: inbound.messageId,
      autopilotMode: 'SUPERVISED',
    });
    console.log(`  ✓ process-inbound triggered: ${inboundHandle.id}`);

    const initialHandle = await tasks.trigger('process-initial-request', {
      caseId: initial.caseId,
      autopilotMode: 'SUPERVISED',
    });
    console.log(`  ✓ process-initial-request triggered: ${initialHandle.id}`);

    console.log('\n━━━ Run IDs ━━━');
    console.log(`  Inbound (acknowledgment): ${inboundHandle.id}`);
    console.log(`  Initial request:          ${initialHandle.id}`);
    console.log('\n  Monitor at: https://cloud.trigger.dev');
    console.log(`  The inbound task should COMPLETE quickly (no email needed).`);
    console.log(`  The initial request task will WAIT for human approval (SUPERVISED mode).`);

    // Store run IDs and case IDs for cleanup
    console.log(`\n  Case IDs for cleanup: ${inbound.caseId}, ${initial.caseId}`);

  } catch (err) {
    console.error('ERROR:', err.message);
    console.error(err.stack);
  } finally {
    try { await db.close(); } catch (e) { /* ignore */ }
  }
}

main();
