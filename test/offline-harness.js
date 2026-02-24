#!/usr/bin/env node

/**
 * Offline Test Harness for LangGraph Agent
 *
 * Runs the FOIA case graph pipeline offline with canned data.
 * Zero external dependencies — no DB, no API keys, no SendGrid.
 *
 * Usage:
 *   node test/offline-harness.js                    # Run all scenarios
 *   node test/offline-harness.js --scenario=02      # Run one scenario
 *   node test/offline-harness.js --verbose          # Show full state after each node
 *   node test/offline-harness.js --node=decide      # Test decide_next_action node only
 *   node test/offline-harness.js --graph            # Run through compiled graph (integration)
 *   node test/offline-harness.js --interactive      # Interactive sandbox mode
 */

// ============================================================================
// STEP 1: Inject mocks BEFORE any graph code loads
// ============================================================================

const { injectMocks, clearMocks } = require('./mock-services');
const mocks = injectMocks();

// Now safe to require graph code — they'll resolve to our mocks
const { createInitialState } = require('../langgraph/state/case-state');
const { loadContextNode } = require('../langgraph/nodes/load-context');
const { classifyInboundNode } = require('../langgraph/nodes/classify-inbound');
const { updateConstraintsNode } = require('../langgraph/nodes/update-constraints');
const { decideNextActionNode } = require('../langgraph/nodes/decide-next-action');
const { draftResponseNode } = require('../langgraph/nodes/draft-response');
const { safetyCheckNode } = require('../langgraph/nodes/safety-check');

// ============================================================================
// CLI Argument Parsing
// ============================================================================

const args = process.argv.slice(2);
const flags = {};
for (const arg of args) {
  if (arg.startsWith('--')) {
    const [key, value] = arg.slice(2).split('=');
    flags[key] = value || true;
  }
}

const VERBOSE = !!flags.verbose;
const SCENARIO_FILTER = flags.scenario || null;
const NODE_ONLY = flags.node || null;
const GRAPH_MODE = !!flags.graph;
const INTERACTIVE = !!flags.interactive;

// ============================================================================
// Load Scenarios
// ============================================================================

const scenarios = require('./scenarios');

// ============================================================================
// State Helpers
// ============================================================================

/**
 * Merge node output into current state, respecting LangGraph reducer semantics.
 * Key rules:
 * - `logs` and `errors` are append-only arrays
 * - `proposalReasoning` is append-only
 * - `undefined` values preserve previous state (for preserving reducers)
 * - Everything else overwrites
 */
function mergeState(currentState, nodeOutput) {
  const merged = { ...currentState };

  for (const [key, value] of Object.entries(nodeOutput)) {
    if (value === undefined) continue; // Preserve previous value

    if (key === 'logs' && Array.isArray(value)) {
      merged.logs = [...(merged.logs || []), ...value];
    } else if (key === 'errors' && Array.isArray(value)) {
      merged.errors = [...(merged.errors || []), ...value];
    } else if (key === 'proposalReasoning' && Array.isArray(value)) {
      merged.proposalReasoning = [...(merged.proposalReasoning || []), ...value];
    } else {
      merged[key] = value;
    }
  }

  return merged;
}

// ============================================================================
// Pretty Printer
// ============================================================================

const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const CYAN = '\x1b[36m';
const MAGENTA = '\x1b[35m';

function pad(str, len) {
  return str.padEnd(len);
}

function printScenarioHeader(scenario, index) {
  console.log('');
  console.log(`${BOLD}=== ${String(index + 1).padStart(2, '0')}: ${scenario.name} ===${RESET}`);
  console.log(`${DIM}    ${scenario.description}${RESET}`);
  console.log('');
}

function printNodeResult(nodeName, state, prevState) {
  const prefix = `  ${CYAN}[${pad(nodeName, 20)}]${RESET}`;

  switch (nodeName) {
    case 'load_context': {
      const caseData = mocks.db._stores.cases.values().next().value;
      const agencyName = caseData?.agency_name || 'unknown';
      console.log(`${prefix} Loaded case ${state.caseId} (${agencyName})`);
      if (state.constraints?.length) {
        console.log(`${prefix} Constraints: ${state.constraints.join(', ')}`);
      }
      break;
    }
    case 'classify_inbound': {
      const conf = state.classificationConfidence || 0;
      const sent = state.sentiment || 'unknown';
      console.log(`${prefix} ${state.classification} (${conf.toFixed(2)}) sentiment=${sent}`);
      if (state.denialSubtype) {
        console.log(`${prefix} denial_subtype: ${state.denialSubtype}`);
      }
      if (state.extractedFeeAmount != null) {
        console.log(`${prefix} fee: $${state.extractedFeeAmount}`);
      }
      if (state.requiresResponse === false) {
        console.log(`${prefix} requires_response=false (${state.reasonNoResponse || state.suggestedAction || 'no reason'})`);
      }
      break;
    }
    case 'update_constraints': {
      const newConstraints = (state.constraints || []).filter(
        c => !(prevState.constraints || []).includes(c)
      );
      if (newConstraints.length > 0) {
        console.log(`${prefix} +${newConstraints.join(', +')}`);
      } else {
        console.log(`${prefix} No new constraints`);
      }
      break;
    }
    case 'decide_next_action': {
      const action = state.proposalActionType || 'NONE';
      const gated = state.requiresHuman ? 'gated' : 'auto';
      const reason = state.pauseReason || state.classification || '';
      console.log(`${prefix} ${BOLD}${action}${RESET} (${gated}${reason ? ', reason: ' + reason : ''})`);
      if (state.proposalReasoning?.length) {
        console.log(`${prefix} ${DIM}Reasoning:${RESET}`);
        for (const r of state.proposalReasoning) {
          console.log(`${prefix}   ${DIM}• ${r}${RESET}`);
        }
      }
      break;
    }
    case 'draft_response': {
      if (state.draftSubject) {
        console.log(`${prefix} Subject: "${state.draftSubject}"`);
      } else {
        console.log(`${prefix} No draft needed`);
      }
      break;
    }
    case 'safety_check': {
      const flags = state.riskFlags || [];
      const warns = state.warnings || [];
      if (flags.length === 0 && warns.length === 0) {
        console.log(`${prefix} ${GREEN}Passed${RESET} (no flags, no warnings)`);
      } else {
        console.log(`${prefix} ${YELLOW}${flags.length} flags, ${warns.length} warnings${RESET}`);
        for (const f of flags) console.log(`${prefix}   Flag: ${f}`);
        for (const w of warns) console.log(`${prefix}   Warn: ${w}`);
      }
      break;
    }
    default:
      console.log(`${prefix} Done`);
  }

  if (VERBOSE) {
    // Print the last few logs from state
    const newLogs = (state.logs || []).slice(-(state.logs || []).length + (prevState.logs || []).length);
    for (const log of newLogs) {
      console.log(`${prefix} ${DIM}  > ${log}${RESET}`);
    }
  }
}

function printResult(state, scenario, passed) {
  const action = state.proposalActionType || 'NONE';
  const human = state.requiresHuman ? 'requiresHuman=true' : 'requiresHuman=false';
  const auto = state.canAutoExecute ? 'canAutoExecute=true' : 'canAutoExecute=false';
  const complete = state.isComplete ? ', isComplete=true' : '';

  // Stop indicator
  if (state.requiresHuman && !state.isComplete) {
    console.log(`  ${YELLOW}[STOPPED]${RESET}            requiresHuman=true (gate_or_execute skipped in node mode)`);
  }

  console.log('');
  console.log(`  ${BOLD}RESULT:${RESET} ${action} (${human}, ${auto}${complete})`);

  if (passed) {
    console.log(`  ${GREEN}${BOLD}STATUS: PASS${RESET}`);
  } else {
    console.log(`  ${RED}${BOLD}STATUS: FAIL${RESET}`);
    // Show what was expected vs actual
    const exp = scenario.expected;
    if (exp.proposalActionType && exp.proposalActionType !== action) {
      console.log(`  ${RED}  Expected action: ${exp.proposalActionType}, got: ${action}${RESET}`);
    }
    if (exp.requiresHuman !== undefined && exp.requiresHuman !== state.requiresHuman) {
      console.log(`  ${RED}  Expected requiresHuman: ${exp.requiresHuman}, got: ${state.requiresHuman}${RESET}`);
    }
    if (exp.canAutoExecute !== undefined && exp.canAutoExecute !== state.canAutoExecute) {
      console.log(`  ${RED}  Expected canAutoExecute: ${exp.canAutoExecute}, got: ${state.canAutoExecute}${RESET}`);
    }
    if (exp.isComplete !== undefined && exp.isComplete !== state.isComplete) {
      console.log(`  ${RED}  Expected isComplete: ${exp.isComplete}, got: ${state.isComplete}${RESET}`);
    }
  }
}

function printErrors(state) {
  if (state.errors?.length) {
    console.log('');
    console.log(`  ${RED}ERRORS:${RESET}`);
    for (const err of state.errors) {
      console.log(`  ${RED}  • ${err}${RESET}`);
    }
  }
}

// ============================================================================
// Assertion
// ============================================================================

function checkExpectations(state, expected) {
  const failures = [];

  if (expected.proposalActionType !== undefined) {
    if (state.proposalActionType !== expected.proposalActionType) {
      failures.push(`proposalActionType: expected=${expected.proposalActionType}, actual=${state.proposalActionType}`);
    }
  }

  if (expected.requiresHuman !== undefined) {
    if (state.requiresHuman !== expected.requiresHuman) {
      failures.push(`requiresHuman: expected=${expected.requiresHuman}, actual=${state.requiresHuman}`);
    }
  }

  if (expected.canAutoExecute !== undefined) {
    if (state.canAutoExecute !== expected.canAutoExecute) {
      failures.push(`canAutoExecute: expected=${expected.canAutoExecute}, actual=${state.canAutoExecute}`);
    }
  }

  if (expected.isComplete !== undefined) {
    if (state.isComplete !== expected.isComplete) {
      failures.push(`isComplete: expected=${expected.isComplete}, actual=${state.isComplete}`);
    }
  }

  return failures;
}

// ============================================================================
// Node-Level Runner
// ============================================================================

/**
 * Run a single scenario through nodes sequentially.
 * Stops before gate_or_execute for gated scenarios.
 */
async function runScenarioNodeLevel(scenario, index) {
  printScenarioHeader(scenario, index);

  // Reset and seed mock DB
  mocks.db.reset();
  mocks.db.seed(scenario.seed);

  // Build initial state
  const overrides = scenario.stateOverrides || {};
  let state = createInitialState(
    scenario.seed.case.id,
    overrides.triggerType || 'agency_reply',
    {
      messageId: overrides.latestInboundMessageId || null,
      runId: overrides.runId || null,
      autopilotMode: scenario.seed.case.autopilot_mode || 'SUPERVISED',
      llmStubs: scenario.llmStubs || null,
      scheduledKey: overrides.scheduledKey || null,
      caseAgencyId: overrides.caseAgencyId || null,
    }
  );

  // Apply any additional state overrides not covered by createInitialState
  if (overrides.classification) state.classification = overrides.classification;
  if (overrides.sentiment) state.sentiment = overrides.sentiment;

  // Initialize default state fields that createInitialState doesn't set
  state.constraints = state.constraints || [];
  state.scopeItems = state.scopeItems || [];
  state.proposalReasoning = state.proposalReasoning || [];
  state.riskFlags = state.riskFlags || [];
  state.warnings = state.warnings || [];

  // Define node pipeline
  const nodes = [
    { name: 'load_context', fn: loadContextNode },
    { name: 'classify_inbound', fn: classifyInboundNode },
    { name: 'update_constraints', fn: updateConstraintsNode },
    { name: 'decide_next_action', fn: decideNextActionNode },
  ];

  // Run nodes sequentially
  for (const node of nodes) {
    const prevState = { ...state };
    try {
      const output = await node.fn(state);
      state = mergeState(state, output);
      printNodeResult(node.name, state, prevState);
    } catch (err) {
      console.log(`  ${RED}[${node.name}] ERROR: ${err.message}${RESET}`);
      if (VERBOSE) console.log(err.stack);
      state.errors = [...(state.errors || []), `${node.name}: ${err.message}`];
      break;
    }

    // If the graph would terminate (isComplete or NONE action), stop
    if (state.isComplete) {
      break;
    }
  }

  // If action requires draft, run draft + safety
  if (!state.isComplete && state.proposalActionType && state.nextNode === 'draft_response') {
    // Draft
    const prevDraft = { ...state };
    try {
      const draftOutput = await draftResponseNode(state);
      state = mergeState(state, draftOutput);
      printNodeResult('draft_response', state, prevDraft);
    } catch (err) {
      console.log(`  ${RED}[draft_response] ERROR: ${err.message}${RESET}`);
      state.errors = [...(state.errors || []), `draft_response: ${err.message}`];
    }

    // Safety check
    if (state.draftBodyText || state.draftSubject) {
      const prevSafety = { ...state };
      try {
        const safetyOutput = await safetyCheckNode(state);
        state = mergeState(state, safetyOutput);
        printNodeResult('safety_check', state, prevSafety);
      } catch (err) {
        console.log(`  ${RED}[safety_check] ERROR: ${err.message}${RESET}`);
        state.errors = [...(state.errors || []), `safety_check: ${err.message}`];
      }
    }
  }

  // Check expectations
  const failures = checkExpectations(state, scenario.expected);
  const passed = failures.length === 0;

  printResult(state, scenario, passed);
  printErrors(state);

  return { scenario, state, passed, failures };
}

// ============================================================================
// Node-Only Runner (--node=decide)
// ============================================================================

/**
 * Skip load_context/classify_inbound and construct decide_next_action
 * input state directly from seed data. Useful for rapidly iterating
 * on routing logic.
 */
async function runScenarioNodeOnly(scenario, index) {
  printScenarioHeader(scenario, index);

  // Reset and seed mock DB
  mocks.db.reset();
  mocks.db.seed(scenario.seed);

  const overrides = scenario.stateOverrides || {};
  const classify = scenario.llmStubs?.classify || {};

  // Build state as if load_context + classify_inbound already ran
  let state = {
    caseId: scenario.seed.case.id,
    threadId: `case:${scenario.seed.case.id}`,
    runId: overrides.runId || null,
    triggerType: overrides.triggerType || 'agency_reply',
    latestInboundMessageId: overrides.latestInboundMessageId || null,
    scheduledKey: overrides.scheduledKey || null,
    autopilotMode: scenario.seed.case.autopilot_mode || 'SUPERVISED',
    // From classify_inbound
    classification: (classify.classification || 'UNKNOWN').toUpperCase(),
    classificationConfidence: classify.confidence || 0.9,
    sentiment: classify.sentiment || 'neutral',
    extractedFeeAmount: classify.fee_amount != null ? Number(classify.fee_amount) : null,
    extractedDeadline: classify.deadline || null,
    denialSubtype: classify.denial_subtype || null,
    requiresResponse: classify.requires_response !== undefined ? classify.requires_response : true,
    portalUrl: classify.portal_url || null,
    suggestedAction: classify.suggested_action || null,
    reasonNoResponse: classify.reason_no_response || null,
    // From load_context
    constraints: scenario.seed.case.constraints_jsonb || [],
    scopeItems: scenario.seed.case.scope_items_jsonb || [],
    // Defaults
    proposalReasoning: [],
    logs: [`[node-only] Direct input for decide_next_action`],
    errors: [],
    isComplete: false,
    llmStubs: scenario.llmStubs || null,
  };

  // Run decide_next_action only
  const prevState = { ...state };
  try {
    const output = await decideNextActionNode(state);
    state = mergeState(state, output);
    printNodeResult('decide_next_action', state, prevState);
  } catch (err) {
    console.log(`  ${RED}[decide_next_action] ERROR: ${err.message}${RESET}`);
    state.errors = [...(state.errors || []), `decide_next_action: ${err.message}`];
  }

  const failures = checkExpectations(state, scenario.expected);
  const passed = failures.length === 0;

  printResult(state, scenario, passed);
  printErrors(state);

  return { scenario, state, passed, failures };
}

// ============================================================================
// Graph-Level Runner (--graph)
// ============================================================================

async function runScenarioGraphLevel(scenario, index) {
  printScenarioHeader(scenario, index);

  // Reset and seed mock DB
  mocks.db.reset();
  mocks.db.seed(scenario.seed);

  const overrides = scenario.stateOverrides || {};

  try {
    // Import graph builder and MemorySaver
    const { StateGraph, START, END, MemorySaver } = require('@langchain/langgraph');
    const { FOIACaseStateAnnotation } = require('../langgraph/state/case-state');
    const { gateOrExecuteNode } = require('../langgraph/nodes/gate-or-execute');
    const { executeActionNode } = require('../langgraph/nodes/execute-action');
    const { commitStateNode } = require('../langgraph/nodes/commit-state');

    // Build graph
    const graph = new StateGraph(FOIACaseStateAnnotation);

    graph.addNode('load_context', loadContextNode);
    graph.addNode('classify_inbound', classifyInboundNode);
    graph.addNode('update_constraints', updateConstraintsNode);
    graph.addNode('decide_next_action', decideNextActionNode);
    graph.addNode('draft_response', draftResponseNode);
    graph.addNode('safety_check', safetyCheckNode);
    graph.addNode('gate_or_execute', gateOrExecuteNode);
    graph.addNode('execute_action', executeActionNode);
    graph.addNode('commit_state', commitStateNode);

    graph.addEdge(START, 'load_context');
    graph.addEdge('load_context', 'classify_inbound');
    graph.addEdge('classify_inbound', 'update_constraints');
    graph.addEdge('update_constraints', 'decide_next_action');

    // Route from decide_next_action
    graph.addConditionalEdges('decide_next_action', (state) => {
      if (state.isComplete) return 'end';
      if (state.nextNode === 'gate_or_execute') return 'gate_or_execute';
      if (state.nextNode === 'execute_action') return 'execute_action';
      if (state.proposalActionType === 'ESCALATE') return 'gate_or_execute';
      if (state.proposalActionType === 'NONE') return 'end';
      return 'draft_response';
    }, {
      draft_response: 'draft_response',
      gate_or_execute: 'gate_or_execute',
      execute_action: 'execute_action',
      end: END,
    });

    graph.addEdge('draft_response', 'safety_check');
    graph.addEdge('safety_check', 'gate_or_execute');

    graph.addConditionalEdges('gate_or_execute', (state) => {
      if (state.humanDecision) return 'decide_next_action';
      if (state.isComplete) return 'end';
      if (state.nextNode === 'execute_action') return 'execute_action';
      return 'execute_action';
    }, {
      execute_action: 'execute_action',
      decide_next_action: 'decide_next_action',
      end: END,
    });

    graph.addEdge('execute_action', 'commit_state');
    graph.addEdge('commit_state', END);

    // Compile with MemorySaver
    const checkpointer = new MemorySaver();
    const compiled = graph.compile({ checkpointer });

    // Build initial state
    const initialState = createInitialState(
      scenario.seed.case.id,
      overrides.triggerType || 'agency_reply',
      {
        messageId: overrides.latestInboundMessageId || null,
        runId: overrides.runId || null,
        autopilotMode: scenario.seed.case.autopilot_mode || 'SUPERVISED',
        llmStubs: scenario.llmStubs || null,
      }
    );

    const config = {
      configurable: { thread_id: `test:${scenario.seed.case.id}` }
    };

    const result = await compiled.invoke(initialState, config);

    // Check for interrupt
    if (result.__interrupt__) {
      console.log(`  ${MAGENTA}[INTERRUPTED]${RESET} Graph paused at gate_or_execute`);
    }

    const state = result;
    const failures = checkExpectations(state, scenario.expected);
    const passed = failures.length === 0;

    printResult(state, scenario, passed);
    printErrors(state);

    return { scenario, state, passed, failures };

  } catch (err) {
    console.log(`  ${RED}[GRAPH ERROR] ${err.message}${RESET}`);
    if (VERBOSE) console.log(err.stack);
    return { scenario, state: {}, passed: false, failures: [`Graph error: ${err.message}`] };
  }
}

// ============================================================================
// Interactive Mode
// ============================================================================

const readline = require('readline');

/**
 * Input adapter that works for both TTY (interactive) and piped stdin.
 * For piped input, we pre-buffer all lines up front so they're available
 * synchronously, avoiding readline's close-before-read race condition.
 */
async function createInput() {
  const isTTY = process.stdin.isTTY;

  if (isTTY) {
    // Interactive terminal — use readline normally
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    return {
      ask(question) {
        return new Promise((resolve) => {
          rl.question(question, (answer) => resolve(answer.trim()));
        });
      },
      close() { rl.close(); },
      onClose(fn) { rl.on('close', fn); },
    };
  }

  // Piped input — read all lines up front
  const lines = [];
  await new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin });
    rl.on('line', (line) => lines.push(line));
    rl.on('close', resolve);
  });
  let cursor = 0;
  return {
    ask(question) {
      process.stdout.write(question);
      const answer = cursor < lines.length ? lines[cursor++].trim() : '';
      process.stdout.write(answer + '\n');
      return Promise.resolve(answer);
    },
    close() {},
    onClose() {},
  };
}

async function pickOne(input, prompt, options) {
  console.log('');
  console.log(prompt);
  for (let i = 0; i < options.length; i++) {
    const suffix = options[i].default ? ' (default)' : '';
    console.log(`  ${i + 1}. ${options[i].label}${suffix}`);
  }
  const defaultIdx = options.findIndex((o) => o.default);
  const raw = await input.ask('> ');
  if (raw === '' && defaultIdx >= 0) return options[defaultIdx].value;
  const idx = parseInt(raw, 10) - 1;
  if (idx >= 0 && idx < options.length) return options[idx].value;
  return defaultIdx >= 0 ? options[defaultIdx].value : options[0].value;
}

async function askWithDefault(input, prompt, defaultVal) {
  const raw = await input.ask(`${prompt} [${defaultVal}]: `);
  return raw === '' ? defaultVal : raw;
}

async function askYesNo(input, prompt, defaultYes) {
  const hint = defaultYes ? '(Y/n)' : '(y/N)';
  const raw = await input.ask(`${prompt} ${hint}: `);
  if (raw === '') return defaultYes;
  return raw.toLowerCase().startsWith('y');
}

async function askNumber(input, prompt, defaultVal) {
  const raw = await input.ask(`${prompt} [${defaultVal}]: `);
  if (raw === '') return defaultVal;
  const num = parseFloat(raw);
  return isNaN(num) ? defaultVal : num;
}

/**
 * Build a complete scenario object from interactive user input.
 * Returns the same shape as the file-based scenarios, minus `expected`
 * (since we're exploring, not asserting).
 */
async function buildInteractiveScenario(input) {
  const caseId = 9001;
  let nextMsgId = 9001;
  let nextAnalysisId = 9501;

  // 1. Reply type
  const replyType = await pickOne(input, 'What type of agency reply?', [
    { label: 'Denial', value: 'denial' },
    { label: 'Fee quote', value: 'fee_quote' },
    { label: 'Clarification request', value: 'clarification' },
    { label: 'Records ready', value: 'records_ready' },
    { label: 'Portal redirect', value: 'portal_redirect' },
    { label: 'Hostile response', value: 'hostile' },
    { label: 'Acknowledgment', value: 'acknowledgment' },
    { label: 'Partial approval', value: 'partial_approval' },
    { label: 'No response (followup trigger)', value: 'no_response' },
  ]);

  // 2. Type-specific questions
  let denialSubtype = null;
  let feeAmount = null;
  let portalUrl = null;
  let classification, sentiment, keyPoints, requiresResponse, suggestedAction;
  let bodyText, messageSubject;
  let analysisIntent;
  let constraintsToAdd = [];
  let followup = null;
  let triggerType = 'agency_reply';

  switch (replyType) {
    case 'denial': {
      denialSubtype = await pickOne(input, 'Denial subtype?', [
        { label: 'Generic / unknown', value: null, default: true },
        { label: 'Ongoing investigation', value: 'ongoing_investigation' },
        { label: 'Privacy exemption', value: 'privacy_exemption' },
        { label: 'No records found', value: 'no_records_found' },
        { label: 'Wrong agency', value: 'wrong_agency' },
        { label: 'Overly broad', value: 'overly_broad' },
        { label: 'Excessive fees', value: 'excessive_fees' },
        { label: 'Retention expired', value: 'retention_expired' },
      ]);
      classification = 'DENIAL';
      sentiment = 'negative';
      analysisIntent = 'denial';
      // Build key_points based on subtype
      const subtypeKeyPoints = {
        ongoing_investigation: [
          'Records sealed per court order',
          'Ongoing investigation exemption applies',
          'Privacy exemption cited',
        ],
        privacy_exemption: [
          'Privacy exemption cited',
          'Personal information redacted under state law',
        ],
        no_records_found: ['No responsive records found after diligent search'],
        wrong_agency: ['Agency does not maintain requested records', 'Suggested alternate agency'],
        overly_broad: ['Request deemed overly broad', 'Agency asks to narrow scope'],
        excessive_fees: ['Estimated fees exceed reasonable threshold', 'Fee waiver denied'],
        retention_expired: ['Records destroyed per retention schedule', 'Retention period expired'],
      };
      keyPoints = subtypeKeyPoints[denialSubtype] || [
        'Request has been denied',
        'Records are not available at this time',
      ];
      if (denialSubtype === 'ongoing_investigation') {
        constraintsToAdd = ['SEALED_RECORDS', 'ONGOING_INVESTIGATION'];
      }
      requiresResponse = true;
      suggestedAction = null;
      bodyText = `Your request is denied. ${keyPoints[0]}.`;
      messageSubject = 'RE: FOIA Request - Denial';
      break;
    }
    case 'fee_quote': {
      feeAmount = await askNumber(input, 'Fee amount ($)', 50);
      classification = 'FEE_QUOTE';
      sentiment = 'neutral';
      analysisIntent = 'fee_request';
      keyPoints = [`Fee estimate provided: $${feeAmount.toFixed(2)}`, 'Records located and ready upon payment'];
      constraintsToAdd = ['FEE_REQUIRED'];
      requiresResponse = true;
      suggestedAction = null;
      bodyText = `The estimated cost for processing your request is $${feeAmount.toFixed(2)}. Please remit payment to proceed.`;
      messageSubject = 'RE: FOIA Request - Fee Estimate';
      break;
    }
    case 'clarification': {
      classification = 'CLARIFICATION_REQUEST';
      sentiment = 'neutral';
      analysisIntent = 'question';
      keyPoints = [
        'Agency requests specific date range',
        'Agency requests incident number',
        'Willing to process once details provided',
      ];
      constraintsToAdd = ['ID_REQUIRED'];
      requiresResponse = true;
      suggestedAction = null;
      bodyText = 'Could you please provide the specific date range and incident number for the records you are seeking?';
      messageSubject = 'RE: FOIA Request - Additional Information Needed';
      break;
    }
    case 'records_ready': {
      classification = 'RECORDS_READY';
      sentiment = 'positive';
      analysisIntent = 'records_ready';
      keyPoints = ['Records are available for download', 'Download link provided'];
      requiresResponse = false;
      suggestedAction = 'download';
      bodyText = 'The records responsive to your request are now available for download.';
      messageSubject = 'RE: FOIA Request - Records Available';
      break;
    }
    case 'portal_redirect': {
      portalUrl = await askWithDefault(input, 'Portal URL', 'https://foia.agency.gov');
      classification = 'PORTAL_REDIRECT';
      sentiment = 'neutral';
      analysisIntent = 'portal_redirect';
      keyPoints = ['Agency requires portal submission', `Portal URL: ${portalUrl}`, 'Email requests not accepted'];
      requiresResponse = false;
      suggestedAction = 'use_portal';
      bodyText = `All FOIA requests must be submitted through our online portal at ${portalUrl}.`;
      messageSubject = 'RE: FOIA Request - Portal Submission Required';
      break;
    }
    case 'hostile': {
      classification = 'HOSTILE';
      sentiment = 'hostile';
      analysisIntent = 'hostile';
      keyPoints = [
        'Agency characterizes request as frivolous',
        'Agency refuses to search records',
        'Agency demands no further contact',
      ];
      requiresResponse = true;
      suggestedAction = null;
      bodyText = 'Stop sending us these frivolous requests. We have no obligation to process this. Do not contact this office again.';
      messageSubject = 'RE: FOIA Request';
      break;
    }
    case 'acknowledgment': {
      classification = 'ACKNOWLEDGMENT';
      sentiment = 'neutral';
      analysisIntent = 'acknowledgment';
      keyPoints = ['Agency acknowledges receipt of request', 'Processing timeline provided'];
      requiresResponse = false;
      suggestedAction = 'wait';
      bodyText = 'We have received your FOIA request and it is being processed. Please allow 10 business days for a response.';
      messageSubject = 'RE: FOIA Request - Acknowledgment';
      break;
    }
    case 'partial_approval': {
      classification = 'PARTIAL_APPROVAL';
      sentiment = 'neutral';
      analysisIntent = 'partial_approval';
      keyPoints = [
        'Some records released',
        'Other records withheld',
        'Active case review cited for withholding',
      ];
      requiresResponse = true;
      suggestedAction = null;
      bodyText = 'We are releasing some records responsive to your request. However, certain records have been withheld.';
      messageSubject = 'RE: FOIA Request - Partial Release';
      break;
    }
    case 'no_response': {
      triggerType = 'followup_trigger';
      classification = null;
      sentiment = null;
      analysisIntent = null;
      keyPoints = null;
      requiresResponse = null;
      suggestedAction = null;
      bodyText = null;
      messageSubject = null;
      followup = { followup_count: 0 };
      break;
    }
  }

  // 3. Common questions
  const agencyName = await askWithDefault(input, 'Agency name', 'Springfield PD');
  const state = await askWithDefault(input, 'State', 'IL');
  const hasPortal = await askYesNo(input, 'Has portal?', false);
  const autopilotMode = await pickOne(input, 'Autopilot mode?', [
    { label: 'SUPERVISED', value: 'SUPERVISED', default: true },
    { label: 'AUTO', value: 'AUTO' },
  ]);

  // 4. Build scenario
  const messages = [];
  const analyses = [];

  if (triggerType !== 'followup_trigger') {
    messages.push({
      id: nextMsgId,
      case_id: caseId,
      direction: 'inbound',
      from_email: `records@agency.gov`,
      subject: messageSubject,
      body_text: bodyText,
      message_id: `<msg-${nextMsgId}@agency.gov>`,
    });

    analyses.push({
      id: nextAnalysisId,
      message_id: nextMsgId,
      case_id: caseId,
      intent: analysisIntent,
      confidence_score: 0.93,
      sentiment: sentiment,
      key_points: keyPoints,
      extracted_fee_amount: feeAmount,
      full_analysis_json: {
        denial_subtype: denialSubtype,
        constraints_to_add: constraintsToAdd,
        ...(portalUrl ? { portal_url: portalUrl } : {}),
      },
      requires_action: requiresResponse !== false,
    });
  }

  const classifyStub =
    triggerType === 'followup_trigger'
      ? null
      : {
          classification,
          confidence: 0.93,
          sentiment,
          key_points: keyPoints,
          ...(denialSubtype ? { denial_subtype: denialSubtype } : {}),
          ...(feeAmount != null ? { fee_amount: feeAmount } : {}),
          ...(requiresResponse === false ? { requires_response: false } : {}),
          ...(suggestedAction ? { suggested_action: suggestedAction } : {}),
          ...(portalUrl ? { portal_url: portalUrl } : {}),
        };

  return {
    name: `interactive-${replyType}`,
    description: `Interactive: ${classification || 'NO_RESPONSE'} from ${agencyName}`,

    seed: {
      case: {
        id: caseId,
        agency_name: agencyName,
        agency_email: 'records@agency.gov',
        status: 'awaiting_response',
        state,
        subject_name: 'Test Subject',
        case_name: `${agencyName} - Test Subject FOIA`,
        requested_records: ['Incident reports', 'Body camera footage'],
        constraints_jsonb: [],
        scope_items_jsonb: [
          { name: 'Incident reports', status: 'pending' },
          { name: 'Body camera footage', status: 'pending' },
        ],
        autopilot_mode: autopilotMode,
        portal_url: hasPortal ? 'https://portal.agency.gov' : null,
      },
      messages,
      analyses,
      followup,
    },

    llmStubs: {
      classify: classifyStub,
      draft: classifyStub
        ? {
            subject: `Re: ${messageSubject || 'FOIA Request'}`,
            body: 'Stubbed response body for interactive testing',
          }
        : {
            subject: `Follow-up: ${agencyName} - Test Subject FOIA`,
            body: 'Stubbed response body for interactive testing',
          },
    },

    stateOverrides: {
      triggerType,
      latestInboundMessageId: triggerType === 'followup_trigger' ? null : nextMsgId,
    },

    // No expected — interactive mode doesn't assert
    expected: {},
  };
}

async function runInteractive() {
  console.log('');
  console.log(`${BOLD}=== Interactive Agent Sandbox ===${RESET}`);
  console.log(`${DIM}Build custom scenarios and watch the agent route them in real time${RESET}`);

  const input = await createInput();

  // Ctrl+C / pipe close — set flag so the loop can exit gracefully
  let rlClosed = false;
  input.onClose(() => {
    rlClosed = true;
  });

  let runCount = 0;
  let running = true;

  while (running) {
    try {
      const scenario = await buildInteractiveScenario(input);

      console.log('');
      console.log(`${BOLD}Running pipeline...${RESET}`);

      // Reuse existing runner but skip pass/fail output
      // Reset and seed mock DB
      mocks.db.reset();
      mocks.db.seed(scenario.seed);

      const overrides = scenario.stateOverrides || {};
      let state = createInitialState(
        scenario.seed.case.id,
        overrides.triggerType || 'agency_reply',
        {
          messageId: overrides.latestInboundMessageId || null,
          runId: overrides.runId || null,
          autopilotMode: scenario.seed.case.autopilot_mode || 'SUPERVISED',
          llmStubs: scenario.llmStubs || null,
          scheduledKey: overrides.scheduledKey || null,
          caseAgencyId: overrides.caseAgencyId || null,
        }
      );

      if (overrides.classification) state.classification = overrides.classification;
      if (overrides.sentiment) state.sentiment = overrides.sentiment;

      state.constraints = state.constraints || [];
      state.scopeItems = state.scopeItems || [];
      state.proposalReasoning = state.proposalReasoning || [];
      state.riskFlags = state.riskFlags || [];
      state.warnings = state.warnings || [];

      const nodes = [
        { name: 'load_context', fn: loadContextNode },
        { name: 'classify_inbound', fn: classifyInboundNode },
        { name: 'update_constraints', fn: updateConstraintsNode },
        { name: 'decide_next_action', fn: decideNextActionNode },
      ];

      console.log('');
      for (const node of nodes) {
        const prevState = { ...state };
        try {
          const output = await node.fn(state);
          state = mergeState(state, output);
          printNodeResult(node.name, state, prevState);
        } catch (err) {
          console.log(`  ${RED}[${node.name}] ERROR: ${err.message}${RESET}`);
          state.errors = [...(state.errors || []), `${node.name}: ${err.message}`];
          break;
        }
        if (state.isComplete) break;
      }

      // Draft + safety if needed
      if (!state.isComplete && state.proposalActionType && state.nextNode === 'draft_response') {
        const prevDraft = { ...state };
        try {
          const draftOutput = await draftResponseNode(state);
          state = mergeState(state, draftOutput);
          printNodeResult('draft_response', state, prevDraft);
        } catch (err) {
          console.log(`  ${RED}[draft_response] ERROR: ${err.message}${RESET}`);
        }

        if (state.draftBodyText || state.draftSubject) {
          const prevSafety = { ...state };
          try {
            const safetyOutput = await safetyCheckNode(state);
            state = mergeState(state, safetyOutput);
            printNodeResult('safety_check', state, prevSafety);
          } catch (err) {
            console.log(`  ${RED}[safety_check] ERROR: ${err.message}${RESET}`);
          }
        }
      }

      // Print final result
      const action = state.proposalActionType || 'NONE';
      const human = state.requiresHuman ? 'requiresHuman=true' : 'requiresHuman=false';
      const auto = state.canAutoExecute ? 'canAutoExecute=true' : 'canAutoExecute=false';
      const complete = state.isComplete ? ', isComplete=true' : '';

      console.log('');
      console.log(`  ${BOLD}RESULT:${RESET} ${action} (${human}, ${auto}${complete})`);

      if (state.errors?.length) {
        console.log('');
        for (const err of state.errors) {
          console.log(`  ${RED}ERROR: ${err}${RESET}`);
        }
      }

      runCount++;
      console.log('');
      const again = await askYesNo(input, 'Run another?', true);
      if (!again) running = false;
    } catch (err) {
      // readline closed (Ctrl+C during prompt)
      if (err.code === 'ERR_USE_AFTER_CLOSE') break;
      console.error(`${RED}Error: ${err.message}${RESET}`);
    }
  }

  input.close();
  console.log(`\n${DIM}Ran ${runCount} interactive scenario${runCount !== 1 ? 's' : ''}.${RESET}`);
}

// ============================================================================
// Main
// ============================================================================

async function main() {
  // Interactive mode — entirely separate flow
  if (INTERACTIVE) {
    return runInteractive();
  }

  console.log('');
  console.log(`${BOLD}Offline Test Harness for LangGraph Agent${RESET}`);
  console.log(`${DIM}Running with mocked services — no external dependencies${RESET}`);

  const mode = GRAPH_MODE ? 'graph' : (NODE_ONLY ? `node-only (${NODE_ONLY})` : 'node-level');
  console.log(`${DIM}Mode: ${mode}${RESET}`);
  console.log('');

  // Filter scenarios
  let toRun = scenarios;
  if (SCENARIO_FILTER) {
    const filterNum = SCENARIO_FILTER.padStart(2, '0');
    toRun = scenarios.filter((_, i) =>
      String(i + 1).padStart(2, '0') === filterNum
    );
    if (toRun.length === 0) {
      console.log(`${RED}No scenario matching --scenario=${SCENARIO_FILTER}${RESET}`);
      process.exit(1);
    }
  }

  const results = [];

  for (let i = 0; i < toRun.length; i++) {
    const scenario = toRun[i];
    const globalIndex = scenarios.indexOf(scenario);

    let result;
    if (GRAPH_MODE) {
      result = await runScenarioGraphLevel(scenario, globalIndex);
    } else if (NODE_ONLY) {
      result = await runScenarioNodeOnly(scenario, globalIndex);
    } else {
      result = await runScenarioNodeLevel(scenario, globalIndex);
    }
    results.push(result);
  }

  // Summary
  console.log('');
  console.log(`${BOLD}${'='.repeat(60)}${RESET}`);
  console.log(`${BOLD}Summary${RESET}`);
  console.log(`${'='.repeat(60)}`);

  const passed = results.filter(r => r.passed).length;
  const failed = results.filter(r => !r.passed).length;
  const total = results.length;

  for (const r of results) {
    const idx = String(scenarios.indexOf(r.scenario) + 1).padStart(2, '0');
    const icon = r.passed ? `${GREEN}PASS${RESET}` : `${RED}FAIL${RESET}`;
    const action = r.state.proposalActionType || 'NONE';
    console.log(`  ${icon}  ${idx}: ${r.scenario.name} → ${action}`);
    if (!r.passed && r.failures.length > 0) {
      for (const f of r.failures) {
        console.log(`         ${RED}${f}${RESET}`);
      }
    }
  }

  console.log('');
  if (failed === 0) {
    console.log(`${GREEN}${BOLD}All ${total} scenarios passed!${RESET}`);
  } else {
    console.log(`${RED}${BOLD}${failed}/${total} scenarios failed${RESET}`);
  }
  console.log('');

  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
  console.error(`${RED}Fatal error:${RESET}`, err);
  process.exit(2);
});
