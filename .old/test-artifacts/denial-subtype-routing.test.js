#!/usr/bin/env node
/**
 * Comprehensive test for denial subtype routing changes.
 *
 * Part 1: Deterministic routing tests (mocked DB, no API calls)
 *   - Validates every denial subtype routes to the correct action type
 *   - Validates WRONG_AGENCY classification routing
 *   - Validates backwards compat (null subtype uses legacy logic)
 *
 * Part 2: Live AI tests (real API calls)
 *   - generateAgencyResearchBrief with a real-world scenario
 *   - generateReformulatedRequest with a real-world scenario
 *   - triageStuckCase upgraded to GPT-5.2
 *
 * Part 3: Full classify→decide pipeline with stubs (end-to-end logic)
 *
 * Usage: node tests/denial-subtype-routing.test.js [--live]
 *   --live  Also run live AI API tests (requires OPENAI_API_KEY)
 */

require('dotenv').config();

const passed = [];
const failed = [];
const skipped = [];

function assert(condition, name, details = '') {
  if (condition) {
    passed.push(name);
    console.log(`  ✅ ${name}`);
  } else {
    failed.push(name);
    console.log(`  ❌ ${name}${details ? ': ' + details : ''}`);
  }
}

function section(title) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`  ${title}`);
  console.log('='.repeat(60));
}

// =========================================================================
// PART 1: Deterministic routing (mocked DB)
// =========================================================================

/**
 * Build a mock state that mimics what classifyInboundNode returns
 * merged with initial graph state.
 */
function buildState(overrides = {}) {
  return {
    caseId: 25136,
    classification: 'DENIAL',
    extractedFeeAmount: null,
    sentiment: 'neutral',
    constraints: [],
    triggerType: 'agency_reply',
    autopilotMode: 'SUPERVISED',
    humanDecision: null,
    denialSubtype: null,
    requiresResponse: true,
    portalUrl: null,
    suggestedAction: null,
    reasonNoResponse: null,
    reviewAction: null,
    reviewInstruction: null,
    proposalReasoning: [],
    ...overrides
  };
}

/**
 * Mock the db module used by decide-next-action
 */
function installDbMocks(opts = {}) {
  const db = require('../services/database');

  // Save originals
  const originals = {};
  const methods = [
    'getCaseById', 'getLatestResponseAnalysis', 'updateCaseStatus',
    'updateCasePortalStatus', 'getFollowUpScheduleByCaseId',
    'updateCase'
  ];
  methods.forEach(m => { originals[m] = db[m]; });

  const caseData = {
    id: opts.caseId || 25136,
    case_name: opts.caseName || 'Fort Collins PD - John Doe BWC Footage',
    agency_name: opts.agencyName || 'Fort Collins Police Department',
    state: opts.state || 'Colorado',
    incident_location: opts.incidentLocation || 'Fort Collins, CO',
    subject_name: opts.subjectName || 'John Doe',
    requested_records: opts.requestedRecords || ['Body-worn camera footage', 'Dashcam footage', '911 calls'],
    portal_url: opts.portalUrl || null,
    agency_email: opts.agencyEmail || 'records@fcgov.com',
    contact_research_notes: opts.contactResearchNotes || null,
    status: opts.status || 'pending',
    send_date: opts.sendDate || '2025-01-15'
  };

  db.getCaseById = async () => caseData;

  db.getLatestResponseAnalysis = async () => ({
    key_points: opts.keyPoints || ['No records responsive to your request'],
    full_analysis_json: {
      denial_subtype: opts.analysisSubtype || null,
      key_points: opts.keyPoints || ['No records responsive to your request'],
      summary: opts.analysisSummary || 'Agency denied the request.'
    }
  });

  db.updateCaseStatus = async () => {};
  db.updateCasePortalStatus = async () => {};
  db.updateCase = async () => {};
  db.getFollowUpScheduleByCaseId = async () => ({ followup_count: 0 });

  return {
    restore() {
      methods.forEach(m => { db[m] = originals[m]; });
    },
    caseData
  };
}

async function testDeterministicRouting() {
  section('PART 1: Deterministic Denial Subtype Routing');

  // Require fresh each time
  const { decideNextActionNode } = require('../langgraph/nodes/decide-next-action');

  // -----------------------------------------------------------------------
  // Test 1: no_records + no prior research → RESEARCH_AGENCY
  // -----------------------------------------------------------------------
  console.log('\n--- Scenario: Fort Collins "no records" denial (Case #25136) ---');
  {
    const mocks = installDbMocks({ contactResearchNotes: null });
    const state = buildState({ denialSubtype: 'no_records' });
    const result = await decideNextActionNode(state);

    assert(result.proposalActionType === 'RESEARCH_AGENCY',
      'no_records + no research → RESEARCH_AGENCY',
      `got: ${result.proposalActionType}`);
    assert(result.requiresHuman === true,
      'no_records always gates for human');
    assert(result.pauseReason === 'DENIAL',
      'pause reason is DENIAL');
    console.log('    Reasoning:', result.proposalReasoning?.join(' | '));
    mocks.restore();
  }

  // -----------------------------------------------------------------------
  // Test 2: no_records + prior research exists → REFORMULATE_REQUEST
  // -----------------------------------------------------------------------
  console.log('\n--- Scenario: "no records" but agency already researched ---');
  {
    const mocks = installDbMocks({
      contactResearchNotes: JSON.stringify({ brief: { summary: 'Checked county sheriff too' } })
    });
    const state = buildState({ denialSubtype: 'no_records' });
    const result = await decideNextActionNode(state);

    assert(result.proposalActionType === 'REFORMULATE_REQUEST',
      'no_records + has research → REFORMULATE_REQUEST',
      `got: ${result.proposalActionType}`);
    assert(result.requiresHuman === true,
      'reformulate always gates');
    console.log('    Reasoning:', result.proposalReasoning?.join(' | '));
    mocks.restore();
  }

  // -----------------------------------------------------------------------
  // Test 3: wrong_agency → RESEARCH_AGENCY
  // -----------------------------------------------------------------------
  console.log('\n--- Scenario: Agency says "not us, try the county" ---');
  {
    const mocks = installDbMocks({
      keyPoints: ['Records not held by this agency', 'Try Larimer County Sheriff'],
      analysisSubtype: 'wrong_agency'
    });
    const state = buildState({ denialSubtype: 'wrong_agency' });
    const result = await decideNextActionNode(state);

    assert(result.proposalActionType === 'RESEARCH_AGENCY',
      'wrong_agency → RESEARCH_AGENCY',
      `got: ${result.proposalActionType}`);
    console.log('    Reasoning:', result.proposalReasoning?.join(' | '));
    mocks.restore();
  }

  // -----------------------------------------------------------------------
  // Test 4: overly_broad → REFORMULATE_REQUEST
  // -----------------------------------------------------------------------
  console.log('\n--- Scenario: "Your request is too broad, please narrow" ---');
  {
    const mocks = installDbMocks({
      keyPoints: ['Request is overly broad', 'Please narrow by date range or specific officers']
    });
    const state = buildState({ denialSubtype: 'overly_broad' });
    const result = await decideNextActionNode(state);

    assert(result.proposalActionType === 'REFORMULATE_REQUEST',
      'overly_broad → REFORMULATE_REQUEST',
      `got: ${result.proposalActionType}`);
    console.log('    Reasoning:', result.proposalReasoning?.join(' | '));
    mocks.restore();
  }

  // -----------------------------------------------------------------------
  // Test 5: ongoing_investigation → SEND_REBUTTAL (gated)
  // -----------------------------------------------------------------------
  console.log('\n--- Scenario: "Denied due to ongoing investigation" (SUPERVISED) ---');
  {
    const mocks = installDbMocks({
      keyPoints: ['Records exempt due to ongoing investigation', 'CRS 24-72-305']
    });
    const state = buildState({ denialSubtype: 'ongoing_investigation', autopilotMode: 'SUPERVISED' });
    const result = await decideNextActionNode(state);

    assert(result.proposalActionType === 'SEND_REBUTTAL',
      'ongoing_investigation (supervised) → SEND_REBUTTAL',
      `got: ${result.proposalActionType}`);
    assert(result.requiresHuman === true,
      'ongoing_investigation gated in SUPERVISED mode');
    console.log('    Reasoning:', result.proposalReasoning?.join(' | '));
    mocks.restore();
  }

  // -----------------------------------------------------------------------
  // Test 5b: ongoing_investigation + AUTO + truly weak key_points → auto-execute
  // -----------------------------------------------------------------------
  console.log('\n--- Scenario: "Ongoing investigation" in AUTO mode (truly weak key_points) ---');
  {
    const mocks = installDbMocks({
      keyPoints: ['Request denied', 'Please contact us for more info']  // No strong indicators
    });
    const state = buildState({ denialSubtype: 'ongoing_investigation', autopilotMode: 'AUTO' });
    const result = await decideNextActionNode(state);

    assert(result.proposalActionType === 'SEND_REBUTTAL',
      'ongoing_investigation (auto+weak) → SEND_REBUTTAL',
      `got: ${result.proposalActionType}`);
    assert(result.canAutoExecute === true,
      'truly weak key_points in AUTO mode can auto-execute');
    console.log('    Reasoning:', result.proposalReasoning?.join(' | '));
    mocks.restore();
  }

  // -----------------------------------------------------------------------
  // Test 5c: ongoing_investigation + AUTO + medium key_points → gates
  // -----------------------------------------------------------------------
  console.log('\n--- Scenario: "Ongoing investigation" in AUTO mode (medium - mentions investigation) ---');
  {
    const mocks = installDbMocks({
      keyPoints: ['Investigation mentioned but no statute cited']  // "investigation" is a strong indicator
    });
    const state = buildState({ denialSubtype: 'ongoing_investigation', autopilotMode: 'AUTO' });
    const result = await decideNextActionNode(state);

    assert(result.proposalActionType === 'SEND_REBUTTAL',
      'ongoing_investigation (auto+medium) → SEND_REBUTTAL',
      `got: ${result.proposalActionType}`);
    assert(result.requiresHuman === true,
      'medium-strength denial gates even in AUTO (keyword "investigation" in key_points)');
    console.log('    Reasoning:', result.proposalReasoning?.join(' | '));
    mocks.restore();
  }

  // -----------------------------------------------------------------------
  // Test 6: privacy_exemption → SEND_REBUTTAL
  // -----------------------------------------------------------------------
  console.log('\n--- Scenario: "Denied under privacy exemption" ---');
  {
    const mocks = installDbMocks({
      keyPoints: ['Records withheld under privacy exemption', 'Personal information of third parties']
    });
    const state = buildState({ denialSubtype: 'privacy_exemption' });
    const result = await decideNextActionNode(state);

    assert(result.proposalActionType === 'SEND_REBUTTAL',
      'privacy_exemption → SEND_REBUTTAL',
      `got: ${result.proposalActionType}`);
    console.log('    Reasoning:', result.proposalReasoning?.join(' | '));
    mocks.restore();
  }

  // -----------------------------------------------------------------------
  // Test 7: excessive_fees → NEGOTIATE_FEE
  // -----------------------------------------------------------------------
  console.log('\n--- Scenario: "Estimated cost is $2,500 for records search" ---');
  {
    const mocks = installDbMocks({
      keyPoints: ['Estimated cost $2,500', 'Requires deposit of $1,000']
    });
    const state = buildState({ denialSubtype: 'excessive_fees' });
    const result = await decideNextActionNode(state);

    assert(result.proposalActionType === 'NEGOTIATE_FEE',
      'excessive_fees → NEGOTIATE_FEE',
      `got: ${result.proposalActionType}`);
    assert(result.pauseReason === 'FEE_QUOTE',
      'excessive_fees pause reason is FEE_QUOTE');
    console.log('    Reasoning:', result.proposalReasoning?.join(' | '));
    mocks.restore();
  }

  // -----------------------------------------------------------------------
  // Test 8: retention_expired → ESCALATE
  // -----------------------------------------------------------------------
  console.log('\n--- Scenario: "Records purged per retention schedule" ---');
  {
    const mocks = installDbMocks({
      keyPoints: ['Records destroyed per 2-year retention schedule']
    });
    const state = buildState({ denialSubtype: 'retention_expired' });
    const result = await decideNextActionNode(state);

    assert(result.proposalActionType === 'ESCALATE',
      'retention_expired → ESCALATE',
      `got: ${result.proposalActionType}`);
    assert(result.requiresHuman === true,
      'retention_expired always gates');
    console.log('    Reasoning:', result.proposalReasoning?.join(' | '));
    mocks.restore();
  }

  // -----------------------------------------------------------------------
  // Test 9: null subtype (backwards compat) → legacy assessDenialStrength
  // -----------------------------------------------------------------------
  console.log('\n--- Scenario: Denial with no subtype (legacy path) ---');
  {
    const mocks = installDbMocks({
      keyPoints: ['Request denied', 'General denial without specifics']
    });
    const state = buildState({ denialSubtype: null });
    const result = await decideNextActionNode(state);

    assert(result.proposalActionType === 'SEND_REBUTTAL',
      'null subtype → SEND_REBUTTAL (legacy)',
      `got: ${result.proposalActionType}`);
    assert(result.proposalReasoning.some(r => r.includes('legacy routing') || r.includes('Unknown subtype')),
      'reasoning mentions legacy/unknown subtype path');
    console.log('    Reasoning:', result.proposalReasoning?.join(' | '));
    mocks.restore();
  }

  // -----------------------------------------------------------------------
  // Test 10: Subtype from analysis fallback (not in state)
  // -----------------------------------------------------------------------
  console.log('\n--- Scenario: Subtype missing from state, found in analysis ---');
  {
    const mocks = installDbMocks({
      analysisSubtype: 'no_records',
      contactResearchNotes: null
    });
    const state = buildState({ denialSubtype: null });  // Not in state!
    const result = await decideNextActionNode(state);

    assert(result.proposalActionType === 'RESEARCH_AGENCY',
      'subtype from analysis fallback → RESEARCH_AGENCY',
      `got: ${result.proposalActionType}`);
    console.log('    Reasoning:', result.proposalReasoning?.join(' | '));
    mocks.restore();
  }

  // -----------------------------------------------------------------------
  // Test 11: WRONG_AGENCY classification + requiresResponse
  // -----------------------------------------------------------------------
  console.log('\n--- Scenario: WRONG_AGENCY classification with redirect info ---');
  {
    const mocks = installDbMocks({});
    const state = buildState({
      classification: 'WRONG_AGENCY',
      denialSubtype: null,
      requiresResponse: true
    });
    const result = await decideNextActionNode(state);

    assert(result.proposalActionType === 'RESEARCH_AGENCY',
      'WRONG_AGENCY + requiresResponse → RESEARCH_AGENCY',
      `got: ${result.proposalActionType}`);
    console.log('    Reasoning:', result.proposalReasoning?.join(' | '));
    mocks.restore();
  }

  // -----------------------------------------------------------------------
  // Test 12: WRONG_AGENCY classification + no response needed
  // -----------------------------------------------------------------------
  console.log('\n--- Scenario: WRONG_AGENCY classification without redirect info ---');
  {
    const mocks = installDbMocks({});
    const state = buildState({
      classification: 'WRONG_AGENCY',
      denialSubtype: null,
      requiresResponse: false  // hits the requires_response=false gate first
    });
    const result = await decideNextActionNode(state);

    // requiresResponse=false means it should hit the early gate, not WRONG_AGENCY handler
    assert(result.proposalActionType === 'NONE' || result.isComplete === true,
      'WRONG_AGENCY + no response needed → NONE/complete',
      `got: ${result.proposalActionType}, isComplete: ${result.isComplete}`);
    console.log('    Reasoning:', result.proposalReasoning?.join(' | '));
    mocks.restore();
  }

  // -----------------------------------------------------------------------
  // Test 13: Non-denial classifications still work (regression)
  // -----------------------------------------------------------------------
  console.log('\n--- Regression: FEE_QUOTE still routes correctly ---');
  {
    const mocks = installDbMocks({});
    const state = buildState({
      classification: 'FEE_QUOTE',
      denialSubtype: null,
      extractedFeeAmount: 75,
      autopilotMode: 'AUTO'
    });
    const result = await decideNextActionNode(state);

    assert(result.proposalActionType === 'ACCEPT_FEE',
      'FEE_QUOTE $75 AUTO → ACCEPT_FEE',
      `got: ${result.proposalActionType}`);
    assert(result.canAutoExecute === true,
      'small fee auto-executes in AUTO');
    mocks.restore();
  }

  console.log('\n--- Regression: CLARIFICATION_REQUEST still routes correctly ---');
  {
    const mocks = installDbMocks({});
    const state = buildState({
      classification: 'CLARIFICATION_REQUEST',
      denialSubtype: null
    });
    const result = await decideNextActionNode(state);

    assert(result.proposalActionType === 'SEND_CLARIFICATION',
      'CLARIFICATION_REQUEST → SEND_CLARIFICATION',
      `got: ${result.proposalActionType}`);
    mocks.restore();
  }

  console.log('\n--- Regression: NO_RESPONSE still routes correctly ---');
  {
    const mocks = installDbMocks({});
    const state = buildState({
      classification: 'NO_RESPONSE',
      denialSubtype: null,
      triggerType: 'SCHEDULED_FOLLOWUP'
    });
    const result = await decideNextActionNode(state);

    assert(result.proposalActionType === 'SEND_FOLLOWUP',
      'NO_RESPONSE/SCHEDULED → SEND_FOLLOWUP',
      `got: ${result.proposalActionType}`);
    mocks.restore();
  }
}


// =========================================================================
// PART 2: Action type constant validation
// =========================================================================

async function testActionTypeConstants() {
  section('PART 2: Action Type Constants Validation');

  const AT = require('../constants/action-types');

  assert(AT.ACTION_TYPES.length === 15,
    `ACTION_TYPES has 15 entries (was 12)`,
    `got: ${AT.ACTION_TYPES.length}`);

  assert(AT.isValidActionType('RESEARCH_AGENCY'), 'RESEARCH_AGENCY is valid');
  assert(AT.isValidActionType('REFORMULATE_REQUEST'), 'REFORMULATE_REQUEST is valid');
  assert(AT.isValidActionType('SUBMIT_PORTAL'), 'SUBMIT_PORTAL is valid');

  assert(AT.alwaysRequiresGate('RESEARCH_AGENCY'), 'RESEARCH_AGENCY always gates');
  assert(AT.alwaysRequiresGate('REFORMULATE_REQUEST'), 'REFORMULATE_REQUEST always gates');
  assert(AT.alwaysRequiresGate('SUBMIT_PORTAL'), 'SUBMIT_PORTAL always gates');

  assert(!AT.requiresDraft('RESEARCH_AGENCY'), 'RESEARCH_AGENCY does NOT require draft');
  assert(!AT.requiresDraft('REFORMULATE_REQUEST'), 'REFORMULATE_REQUEST does NOT require draft');
  assert(!AT.requiresDraft('SUBMIT_PORTAL'), 'SUBMIT_PORTAL does NOT require draft');

  assert(!AT.canAutoExecute('RESEARCH_AGENCY'), 'RESEARCH_AGENCY cannot auto-execute');
  assert(!AT.canAutoExecute('REFORMULATE_REQUEST'), 'REFORMULATE_REQUEST cannot auto-execute');

  assert(AT.getActionLabel('RESEARCH_AGENCY') === 'Research Correct Agency',
    'RESEARCH_AGENCY label correct');
  assert(AT.getActionLabel('REFORMULATE_REQUEST') === 'Reformulate Request',
    'REFORMULATE_REQUEST label correct');
  assert(AT.getActionLabel('SUBMIT_PORTAL') === 'Submit via Portal',
    'SUBMIT_PORTAL label correct');

  // Legacy types still work
  assert(AT.normalizeActionType('APPROVE_FEE') === 'ACCEPT_FEE',
    'Legacy APPROVE_FEE → ACCEPT_FEE still works');
  assert(AT.normalizeActionType('SEND_FOLLOWUP') === 'SEND_FOLLOWUP',
    'Canonical SEND_FOLLOWUP unchanged');
}


// =========================================================================
// PART 3: State schema validation
// =========================================================================

async function testStateSchema() {
  section('PART 3: State Schema (denialSubtype field)');

  const { FOIACaseStateAnnotation, createInitialState } = require('../langgraph/state/case-state');

  const spec = FOIACaseStateAnnotation.spec;
  assert('denialSubtype' in spec, 'denialSubtype exists in state spec');

  // Test initial state doesn't include denialSubtype (it's on the annotation, not initial)
  const initial = createInitialState(123, 'agency_reply', { runId: 1 });
  assert(initial.caseId === 123, 'createInitialState still works');
}


// =========================================================================
// PART 4: Classify-inbound passthrough
// =========================================================================

async function testClassifyPassthrough() {
  section('PART 4: Classify-Inbound denialSubtype Passthrough');

  const { classifyInboundNode } = require('../langgraph/nodes/classify-inbound');

  // Test stubbed path — denial with subtype
  console.log('\n--- Stubbed: denial with no_records subtype ---');
  {
    const state = {
      caseId: 99999,
      latestInboundMessageId: 1,
      triggerType: 'agency_reply',
      llmStubs: {
        classify: {
          classification: 'denial',
          confidence: 0.92,
          sentiment: 'neutral',
          denial_subtype: 'no_records',
          key_points: ['No records responsive to your request'],
          requires_response: true,
          suggested_action: 'challenge'
        }
      }
    };

    // Mock db.saveResponseAnalysis to not fail
    const db = require('../services/database');
    const origSave = db.saveResponseAnalysis;
    db.saveResponseAnalysis = async () => ({ id: 1 });

    const result = await classifyInboundNode(state);

    assert(result.classification === 'DENIAL',
      'Stubbed denial → classification=DENIAL',
      `got: ${result.classification}`);
    assert(result.denialSubtype === 'no_records',
      'Stubbed denial_subtype passed through to state',
      `got: ${result.denialSubtype}`);
    assert(result.requiresResponse === true,
      'requires_response passed through');

    db.saveResponseAnalysis = origSave;
  }

  // Test stubbed path — non-denial (no subtype)
  console.log('\n--- Stubbed: acknowledgment (no subtype) ---');
  {
    const state = {
      caseId: 99999,
      latestInboundMessageId: 1,
      triggerType: 'agency_reply',
      llmStubs: {
        classify: {
          classification: 'acknowledgment',
          confidence: 0.95,
          sentiment: 'positive',
          requires_response: false
        }
      }
    };

    const db = require('../services/database');
    const origSave = db.saveResponseAnalysis;
    db.saveResponseAnalysis = async () => ({ id: 1 });

    const result = await classifyInboundNode(state);

    assert(result.classification === 'ACKNOWLEDGMENT',
      'Stubbed acknowledgment → ACKNOWLEDGMENT');
    assert(result.denialSubtype === null,
      'Non-denial has null denialSubtype');

    db.saveResponseAnalysis = origSave;
  }
}


// =========================================================================
// PART 5: Live AI API Tests
// =========================================================================

async function testLiveAI() {
  section('PART 5: Live AI API Tests (GPT-5.2)');

  if (!process.env.OPENAI_API_KEY) {
    console.log('  ⏭️  Skipping: No OPENAI_API_KEY');
    skipped.push('Live AI tests (no API key)');
    return;
  }

  const aiService = require('../services/ai-service');

  // -----------------------------------------------------------------------
  // Test: generateAgencyResearchBrief
  // -----------------------------------------------------------------------
  console.log('\n--- Live: generateAgencyResearchBrief (Fort Collins scenario) ---');
  {
    const caseData = {
      agency_name: 'Fort Collins Police Department',
      state: 'Colorado',
      incident_location: 'Fort Collins, CO',
      subject_name: 'John Doe',
      requested_records: ['Body-worn camera footage', 'Dashcam footage', '911 calls'],
      incident_date: '2024-11-15',
      additional_details: 'Traffic stop on College Ave. Subject was handcuffed and taken to hospital.'
    };

    try {
      const start = Date.now();
      const result = await aiService.generateAgencyResearchBrief(caseData);
      const elapsed = Date.now() - start;

      console.log(`    Time: ${elapsed}ms`);
      console.log(`    Summary: ${result.summary}`);
      console.log(`    Suggested agencies: ${result.suggested_agencies?.map(a => a.name).join(', ')}`);
      console.log(`    Next steps: ${result.next_steps}`);

      assert(result.summary && result.summary.length > 20,
        'Research brief has meaningful summary',
        `summary length: ${result.summary?.length}`);
      assert(Array.isArray(result.suggested_agencies),
        'Research brief has suggested_agencies array');
      assert(result.next_steps && result.next_steps.length > 10,
        'Research brief has next_steps');
    } catch (e) {
      assert(false, 'generateAgencyResearchBrief did not throw', e.message);
    }
  }

  // -----------------------------------------------------------------------
  // Test: generateReformulatedRequest
  // -----------------------------------------------------------------------
  console.log('\n--- Live: generateReformulatedRequest (no CCTV → try dispatch) ---');
  {
    const caseData = {
      agency_name: 'Fort Collins Police Department',
      state: 'Colorado',
      incident_location: '123 Main St, Fort Collins, CO',
      subject_name: 'John Doe',
      requested_records: ['CCTV footage from 123 Main St', 'Body-worn camera footage'],
      incident_date: '2024-11-15'
    };

    const denialAnalysis = {
      full_analysis_json: {
        denial_subtype: 'no_records',
        key_points: ['No CCTV records for that address', 'Agency does not operate fixed cameras at that location'],
        summary: 'Fort Collins PD states they have no CCTV at 123 Main St.'
      }
    };

    try {
      const start = Date.now();
      const result = await aiService.generateReformulatedRequest(caseData, denialAnalysis);
      const elapsed = Date.now() - start;

      console.log(`    Time: ${elapsed}ms`);
      console.log(`    New subject: ${result.subject}`);
      console.log(`    Body preview: ${result.body_text?.substring(0, 200)}...`);
      console.log(`    Strategy: ${result.strategy_notes}`);

      assert(result.subject && result.subject.length > 5,
        'Reformulated request has subject',
        `subject: "${result.subject}"`);
      assert(result.body_text && result.body_text.length > 100,
        'Reformulated request has substantial body',
        `body length: ${result.body_text?.length}`);
      // Should NOT just re-request CCTV
      const bodyLower = (result.body_text || '').toLowerCase();
      const hasDifferentRecords = bodyLower.includes('dispatch') || bodyLower.includes('cad') ||
        bodyLower.includes('incident report') || bodyLower.includes('911') ||
        bodyLower.includes('call') || bodyLower.includes('log') || bodyLower.includes('report');
      assert(hasDifferentRecords,
        'Reformulated request targets different record types (not just CCTV again)',
        `body mentions: dispatch/CAD/incident/911/report`);
    } catch (e) {
      assert(false, 'generateReformulatedRequest did not throw', e.message);
    }
  }

  // -----------------------------------------------------------------------
  // Test: triageStuckCase (upgraded model)
  // -----------------------------------------------------------------------
  console.log('\n--- Live: triageStuckCase (upgraded to GPT-5.2) ---');
  {
    const caseData = {
      case_name: 'Fort Collins PD - John Doe BWC',
      agency_name: 'Fort Collins Police Department',
      state: 'Colorado',
      status: 'needs_human_review',
      portal_url: null,
      send_date: '2025-01-15',
      updated_at: '2025-02-01'
    };

    const messages = [
      {
        direction: 'inbound',
        subject: 'RE: Public Records Request',
        body_text: 'After a diligent search, we have found no records responsive to your request. The Fort Collins Police Department does not maintain records matching your description.'
      },
      {
        direction: 'outbound',
        subject: 'Public Records Request - BWC Footage',
        body_text: 'I am requesting body-worn camera footage from a traffic stop on November 15, 2024.'
      }
    ];

    const priorProposals = [
      {
        action_type: 'SUBMIT_PORTAL',
        status: 'DISMISSED',
        reasoning: 'Submit via portal - but this was a denial, not a portal redirect'
      }
    ];

    try {
      const start = Date.now();
      const result = await aiService.triageStuckCase(caseData, messages, priorProposals);
      const elapsed = Date.now() - start;

      console.log(`    Time: ${elapsed}ms`);
      console.log(`    Action: ${result.actionType}`);
      console.log(`    Summary: ${result.summary}`);
      console.log(`    Recommendation: ${result.recommendation}`);
      console.log(`    Confidence: ${result.confidence}`);

      assert(result.actionType !== 'SUBMIT_PORTAL',
        'Triage does NOT recommend SUBMIT_PORTAL (prior dismissed)',
        `got: ${result.actionType}`);
      // SEND_FOLLOWUP is also reasonable: asking what databases were searched before rebuttaling
      assert(['SEND_REBUTTAL', 'CLOSE_CASE', 'ESCALATE', 'RESEARCH_AGENCY', 'SEND_FOLLOWUP'].includes(result.actionType),
        'Triage recommends reasonable action for "no records" denial',
        `got: ${result.actionType}`);
      assert(result.confidence > 0.3,
        'Triage has reasonable confidence',
        `got: ${result.confidence}`);
    } catch (e) {
      assert(false, 'triageStuckCase did not throw', e.message);
    }
  }
}


// =========================================================================
// PART 6: Full pipeline (classify → decide) with stubs
// =========================================================================

async function testFullPipeline() {
  section('PART 6: Full Pipeline (classify → decide) with Stubs');

  const { classifyInboundNode } = require('../langgraph/nodes/classify-inbound');
  const { decideNextActionNode } = require('../langgraph/nodes/decide-next-action');

  const db = require('../services/database');
  const origSave = db.saveResponseAnalysis;
  db.saveResponseAnalysis = async () => ({ id: 1 });

  // Scenario: Real-world Fort Collins denial
  console.log('\n--- Pipeline: Fort Collins "no records" → classify → decide ---');
  {
    const mocks = installDbMocks({ contactResearchNotes: null });

    // Step 1: Classify
    const classifyState = {
      caseId: 25136,
      latestInboundMessageId: 1,
      triggerType: 'agency_reply',
      llmStubs: {
        classify: {
          classification: 'denial',
          confidence: 0.95,
          sentiment: 'neutral',
          denial_subtype: 'no_records',
          key_points: ['No records responsive to your request', 'Diligent search conducted'],
          requires_response: true,
          suggested_action: 'challenge'
        }
      }
    };

    const classifyResult = await classifyInboundNode(classifyState);

    // Step 2: Merge classify output into state for decide
    const decideState = buildState({
      ...classifyResult,
      caseId: 25136
    });

    const decideResult = await decideNextActionNode(decideState);

    console.log(`    Classify: ${classifyResult.classification} (subtype: ${classifyResult.denialSubtype})`);
    console.log(`    Decide: ${decideResult.proposalActionType}`);
    console.log(`    Reasoning: ${decideResult.proposalReasoning?.join(' | ')}`);

    assert(classifyResult.denialSubtype === 'no_records',
      'Pipeline: classify extracts denial_subtype');
    assert(decideResult.proposalActionType === 'RESEARCH_AGENCY',
      'Pipeline: no_records + no research → RESEARCH_AGENCY',
      `got: ${decideResult.proposalActionType}`);

    mocks.restore();
  }

  // Scenario: Ongoing investigation denial
  console.log('\n--- Pipeline: Ongoing investigation denial → classify → decide ---');
  {
    const mocks = installDbMocks({
      keyPoints: ['Exempt under ongoing investigation', 'Law enforcement exemption CRS 24-72-305']
    });

    const classifyState = {
      caseId: 30001,
      latestInboundMessageId: 2,
      triggerType: 'agency_reply',
      llmStubs: {
        classify: {
          classification: 'denial',
          confidence: 0.90,
          sentiment: 'negative',
          denial_subtype: 'ongoing_investigation',
          key_points: ['Records exempt under CRS 24-72-305', 'Active criminal investigation'],
          requires_response: true
        }
      }
    };

    const classifyResult = await classifyInboundNode(classifyState);
    const decideState = buildState({
      ...classifyResult,
      caseId: 30001
    });
    const decideResult = await decideNextActionNode(decideState);

    console.log(`    Classify: ${classifyResult.classification} (subtype: ${classifyResult.denialSubtype})`);
    console.log(`    Decide: ${decideResult.proposalActionType}`);

    assert(decideResult.proposalActionType === 'SEND_REBUTTAL',
      'Pipeline: ongoing_investigation → SEND_REBUTTAL',
      `got: ${decideResult.proposalActionType}`);

    mocks.restore();
  }

  // Scenario: Overly broad denial
  console.log('\n--- Pipeline: Overly broad denial → classify → decide ---');
  {
    const mocks = installDbMocks({});

    const classifyState = {
      caseId: 30002,
      latestInboundMessageId: 3,
      triggerType: 'agency_reply',
      llmStubs: {
        classify: {
          classification: 'denial',
          confidence: 0.88,
          sentiment: 'neutral',
          denial_subtype: 'overly_broad',
          key_points: ['Request is too broad', 'Please narrow by specific date and officer'],
          requires_response: true
        }
      }
    };

    const classifyResult = await classifyInboundNode(classifyState);
    const decideState = buildState({
      ...classifyResult,
      caseId: 30002
    });
    const decideResult = await decideNextActionNode(decideState);

    console.log(`    Classify: ${classifyResult.classification} (subtype: ${classifyResult.denialSubtype})`);
    console.log(`    Decide: ${decideResult.proposalActionType}`);

    assert(decideResult.proposalActionType === 'REFORMULATE_REQUEST',
      'Pipeline: overly_broad → REFORMULATE_REQUEST',
      `got: ${decideResult.proposalActionType}`);

    mocks.restore();
  }

  db.saveResponseAnalysis = origSave;
}


// =========================================================================
// RUN ALL
// =========================================================================

async function main() {
  const runLive = process.argv.includes('--live');

  console.log('╔══════════════════════════════════════════════════════════╗');
  console.log('║   Denial Subtype Routing — Comprehensive Test Suite     ║');
  console.log('╚══════════════════════════════════════════════════════════╝');
  console.log(`  Live AI tests: ${runLive ? 'ENABLED' : 'disabled (use --live)'}`);

  await testActionTypeConstants();
  await testStateSchema();
  await testClassifyPassthrough();
  await testDeterministicRouting();
  await testFullPipeline();

  if (runLive) {
    await testLiveAI();
  } else {
    skipped.push('Live AI tests (pass --live to enable)');
  }

  // Summary
  console.log('\n' + '='.repeat(60));
  console.log('  RESULTS');
  console.log('='.repeat(60));
  console.log(`  ✅ Passed: ${passed.length}`);
  console.log(`  ❌ Failed: ${failed.length}`);
  if (skipped.length > 0) {
    console.log(`  ⏭️  Skipped: ${skipped.join(', ')}`);
  }

  if (failed.length > 0) {
    console.log('\n  FAILURES:');
    failed.forEach(f => console.log(`    ❌ ${f}`));
    process.exit(1);
  } else {
    console.log('\n  All tests passed! 🎉');
  }
}

main().catch(e => {
  console.error('Test suite crashed:', e);
  process.exit(1);
});
