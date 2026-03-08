#!/usr/bin/env node
/**
 * Test the LangGraph decision logic for correctness.
 * Simulates various state inputs and verifies decision outputs.
 *
 * Tests the fixes for:
 * - FEE_QUOTE with null/NaN/negative amounts
 * - Freeform suggestedAction normalization
 * - Stale nextNode after error
 * - humanDecision default case
 * - requiresResponse override for response-requiring actions
 */

// Mock dependencies before requiring the module
const mockDb = {
  getCaseById: async () => ({ id: 1, agency_name: 'Test PD', autopilot_mode: 'SUPERVISED' }),
  getMessagesByCaseId: async () => [],
  getLatestResponseAnalysis: async () => ({ key_points: [], full_analysis_json: {} }),
  getLatestPendingProposal: async () => null,
  getFollowUpScheduleByCaseId: async () => ({ followup_count: 0 }),
  updateCaseStatus: async () => {},
  updateCase: async () => {},
  updateCasePortalStatus: async () => {},
  query: async () => ({ rows: [] }),
  logActivity: async () => {}
};

const mockLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  forAgent: () => mockLogger
};

// Override requires
const Module = require('module');
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function(request, parent) {
  if (request.includes('database')) return 'mock-database';
  if (request.includes('logger')) return 'mock-logger';
  if (request.includes('executor-adapter')) return 'mock-executor';
  return originalResolve.call(this, request, parent);
};

require.cache['mock-database'] = { id: 'mock-database', filename: 'mock-database', loaded: true, exports: mockDb };
require.cache['mock-logger'] = { id: 'mock-logger', filename: 'mock-logger', loaded: true, exports: mockLogger };
require.cache['mock-executor'] = { id: 'mock-executor', filename: 'mock-executor', loaded: true, exports: { createPortalTask: async () => ({}) } };

// Now require the actual module
const { decideNextActionNode } = require('../langgraph/nodes/decide-next-action');

let passed = 0;
let failed = 0;

async function test(name, state, check) {
  try {
    const result = await decideNextActionNode(state);
    const ok = check(result);
    if (ok) {
      passed++;
      console.log(`  PASS: ${name}`);
    } else {
      failed++;
      console.log(`  FAIL: ${name}`);
      console.log(`    Result:`, JSON.stringify({
        proposalActionType: result.proposalActionType,
        canAutoExecute: result.canAutoExecute,
        requiresHuman: result.requiresHuman,
        isComplete: result.isComplete,
        nextNode: result.nextNode
      }));
    }
  } catch (e) {
    failed++;
    console.log(`  ERROR: ${name}: ${e.message}`);
  }
}

(async () => {
  console.log('=== Decision Logic Tests ===\n');

  // --- FEE_QUOTE edge cases ---
  console.log('FEE_QUOTE edge cases:');

  await test('FEE_QUOTE with null amount → gate for human', {
    caseId: 1, classification: 'FEE_QUOTE', extractedFeeAmount: null,
    autopilotMode: 'SUPERVISED'
  }, r => r.proposalActionType === 'NEGOTIATE_FEE' && r.requiresHuman === true);

  await test('FEE_QUOTE with NaN amount → gate for human', {
    caseId: 1, classification: 'FEE_QUOTE', extractedFeeAmount: 'not-a-number',
    autopilotMode: 'SUPERVISED'
  }, r => r.proposalActionType === 'NEGOTIATE_FEE' && r.requiresHuman === true);

  await test('FEE_QUOTE with negative amount → gate for human', {
    caseId: 1, classification: 'FEE_QUOTE', extractedFeeAmount: -50,
    autopilotMode: 'SUPERVISED'
  }, r => r.proposalActionType === 'NEGOTIATE_FEE' && r.requiresHuman === true);

  await test('FEE_QUOTE with $0 → gate for human', {
    caseId: 1, classification: 'FEE_QUOTE', extractedFeeAmount: 0,
    autopilotMode: 'SUPERVISED'
  }, r => r.proposalActionType === 'ACCEPT_FEE' && r.requiresHuman === true);

  await test('FEE_QUOTE with valid $50 AUTO → auto-accept', {
    caseId: 1, classification: 'FEE_QUOTE', extractedFeeAmount: 50,
    autopilotMode: 'AUTO'
  }, r => r.proposalActionType === 'ACCEPT_FEE' && r.canAutoExecute === true);

  await test('FEE_QUOTE with $200 SUPERVISED → gate accept', {
    caseId: 1, classification: 'FEE_QUOTE', extractedFeeAmount: 200,
    autopilotMode: 'SUPERVISED'
  }, r => r.proposalActionType === 'ACCEPT_FEE' && r.requiresHuman === true);

  await test('FEE_QUOTE with $600 → negotiate', {
    caseId: 1, classification: 'FEE_QUOTE', extractedFeeAmount: 600,
    autopilotMode: 'SUPERVISED'
  }, r => r.proposalActionType === 'NEGOTIATE_FEE' && r.requiresHuman === true);

  // --- requiresResponse override ---
  console.log('\nrequiresResponse override:');

  await test('send_rebuttal overrides requires_response=false', {
    caseId: 1, classification: 'DENIAL', requiresResponse: false,
    suggestedAction: 'send_rebuttal', autopilotMode: 'SUPERVISED'
  }, r => r.proposalActionType === 'SEND_REBUTTAL' && r.isComplete !== true);

  await test('respond+DENIAL overrides requires_response=false', {
    caseId: 1, classification: 'DENIAL', requiresResponse: false,
    suggestedAction: 'respond', autopilotMode: 'SUPERVISED'
  }, r => r.proposalActionType === 'SEND_REBUTTAL' && r.isComplete !== true);

  await test('wait does NOT override requires_response=false', {
    caseId: 1, classification: 'ACKNOWLEDGMENT', requiresResponse: false,
    suggestedAction: 'wait', autopilotMode: 'SUPERVISED'
  }, r => r.isComplete === true && r.proposalActionType === 'NONE');

  await test('negotiate_fee overrides requires_response=false', {
    caseId: 1, classification: 'FEE_QUOTE', requiresResponse: false,
    suggestedAction: 'negotiate_fee', extractedFeeAmount: 200,
    autopilotMode: 'SUPERVISED'
  }, r => r.proposalActionType !== 'NONE' && r.isComplete !== true);

  // --- humanDecision edge cases ---
  console.log('\nhumanDecision edge cases:');

  await test('Unknown humanDecision action → escalate + clear', {
    caseId: 1, classification: 'DENIAL',
    humanDecision: { action: 'SOME_UNKNOWN_ACTION' },
    autopilotMode: 'SUPERVISED'
  }, r => r.proposalActionType === 'ESCALATE' && r.humanDecision === null);

  await test('APPROVE humanDecision → execute', {
    caseId: 1, classification: 'DENIAL',
    humanDecision: { action: 'APPROVE' },
    proposalActionType: 'SEND_REBUTTAL',
    autopilotMode: 'SUPERVISED'
  }, r => r.canAutoExecute === true && r.nextNode === 'execute_action');

  await test('DISMISS humanDecision → complete', {
    caseId: 1, classification: 'DENIAL',
    humanDecision: { action: 'DISMISS' },
    autopilotMode: 'SUPERVISED'
  }, r => r.isComplete === true);

  // --- Classification handlers ---
  console.log('\nClassification handlers:');

  await test('DENIAL without subtype → SEND_REBUTTAL', {
    caseId: 1, classification: 'DENIAL', autopilotMode: 'SUPERVISED'
  }, r => r.proposalActionType === 'SEND_REBUTTAL');

  await test('CLARIFICATION_REQUEST → SEND_CLARIFICATION', {
    caseId: 1, classification: 'CLARIFICATION_REQUEST', autopilotMode: 'SUPERVISED'
  }, r => r.proposalActionType === 'SEND_CLARIFICATION');

  await test('PARTIAL_APPROVAL → RESPOND_PARTIAL_APPROVAL', {
    caseId: 1, classification: 'PARTIAL_APPROVAL', autopilotMode: 'SUPERVISED'
  }, r => r.proposalActionType === 'RESPOND_PARTIAL_APPROVAL');

  await test('HOSTILE → ESCALATE', {
    caseId: 1, classification: 'HOSTILE', autopilotMode: 'SUPERVISED'
  }, r => r.proposalActionType === 'ESCALATE');

  await test('UNKNOWN → ESCALATE', {
    caseId: 1, classification: 'UNKNOWN', autopilotMode: 'SUPERVISED'
  }, r => r.proposalActionType === 'ESCALATE');

  await test('RECORDS_READY → complete with NONE', {
    caseId: 1, classification: 'RECORDS_READY', autopilotMode: 'SUPERVISED'
  }, r => r.isComplete === true && r.proposalActionType === 'NONE');

  await test('ACKNOWLEDGMENT → complete, awaiting_response', {
    caseId: 1, classification: 'ACKNOWLEDGMENT', autopilotMode: 'SUPERVISED'
  }, r => r.isComplete === true && r.proposalActionType === 'NONE');

  await test('NO_RESPONSE → SEND_FOLLOWUP', {
    caseId: 1, classification: 'NO_RESPONSE', triggerType: 'SCHEDULED_FOLLOWUP',
    autopilotMode: 'SUPERVISED'
  }, r => r.proposalActionType === 'SEND_FOLLOWUP');

  console.log(`\n${passed} passed, ${failed} failed out of ${passed + failed} tests`);
  process.exit(failed > 0 ? 1 : 0);
})();
