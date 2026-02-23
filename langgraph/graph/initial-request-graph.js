/**
 * Initial Request Graph Definition
 *
 * LangGraph state machine for generating and sending initial FOIA requests.
 *
 * Flow:
 * load_context → draft_initial_request → safety_check → gate_or_execute →
 * execute_action → schedule_followups → commit_state
 *
 * Shares state schema with Inbound Response Graph (FOIACaseStateAnnotation).
 */

const { StateGraph, START, END } = require("@langchain/langgraph");

const { FOIACaseStateAnnotation, createInitialState } = require("../state/case-state");
const { loadContextNode } = require("../nodes/load-context");
const { draftInitialRequestNode } = require("../nodes/draft-initial-request");
const { safetyCheckNode } = require("../nodes/safety-check");
const { gateOrExecuteNode } = require("../nodes/gate-or-execute");
const { executeActionNode } = require("../nodes/execute-action");
const { scheduleFollowupsNode } = require("../nodes/schedule-followups");
const { commitStateNode } = require("../nodes/commit-state");

const logger = require("../../services/logger");

/**
 * Route after draft node
 * - If draft failed with errors, go to end
 * - Otherwise, continue to safety check
 */
function routeAfterDraft(state) {
  const { errors, isComplete } = state;

  if (isComplete) {
    return "end";
  }

  if (errors && errors.length > 0) {
    return "commit_state";  // Commit error state
  }

  return "safety_check";
}

/**
 * Route after gate node
 * - If human decision received (resume), check action
 * - If auto-execute allowed, continue to execute
 * - If requires human, interrupt
 */
/**
 * IMPORTANT: Only accept nextNode values that are valid destinations from this
 * routing point. Stale nextNode values from prior nodes could cause errors.
 */
const VALID_INIT_GATE_DESTINATIONS = new Set(["execute_action", "draft_initial_request", "commit_state", "end"]);

function routeFromGate(state) {
  const { nextNode, humanDecision, isComplete, canAutoExecute } = state;

  // Explicit routing from human decision
  if (humanDecision) {
    if (humanDecision.action === 'APPROVE') {
      return "execute_action";
    }
    if (humanDecision.action === 'DISMISS' || humanDecision.action === 'WITHDRAW') {
      return "commit_state";
    }
    // ADJUST would re-draft, but for initial request we go back to draft
    if (humanDecision.action === 'ADJUST') {
      return "draft_initial_request";
    }
  }

  // Terminal state takes priority — prevents stale nextNode from overriding
  if (isComplete) {
    return "end";
  }

  // Explicit routing — only accept valid destinations from this node
  if (nextNode && VALID_INIT_GATE_DESTINATIONS.has(nextNode)) {
    return nextNode;
  }
  if (nextNode && !VALID_INIT_GATE_DESTINATIONS.has(nextNode)) {
    logger.warn('routeFromGate: ignoring invalid nextNode', { nextNode, caseId: state.caseId });
  }

  // If can auto-execute, proceed
  if (canAutoExecute) {
    return "execute_action";
  }

  // Otherwise, we've hit a gate (interrupt handled by gateOrExecuteNode)
  return "end";
}

/**
 * Route after execute
 * - If execution successful, schedule follow-ups
 * - If execution failed, commit state
 */
function routeAfterExecute(state) {
  const { actionExecuted, errors } = state;

  if (actionExecuted) {
    return "schedule_followups";
  }

  // Execution skipped or failed
  return "commit_state";
}

/**
 * Create Initial Request Graph Builder
 *
 * Returns StateGraph that can be compiled with checkpointer.
 * Uses same state schema as Inbound Response Graph.
 */
function createInitialRequestGraphBuilder() {
  const graph = new StateGraph(FOIACaseStateAnnotation);

  // === Add Nodes ===
  graph.addNode("load_context", loadContextNode);
  graph.addNode("draft_initial_request", draftInitialRequestNode);
  graph.addNode("safety_check", safetyCheckNode);
  graph.addNode("gate_or_execute", gateOrExecuteNode);
  graph.addNode("execute_action", executeActionNode);
  graph.addNode("schedule_followups", scheduleFollowupsNode);
  graph.addNode("commit_state", commitStateNode);

  // === Add Edges ===

  // Start → Load Context
  graph.addEdge(START, "load_context");

  // Load Context → Draft Initial Request
  graph.addEdge("load_context", "draft_initial_request");

  // Draft Initial Request → Conditional routing
  graph.addConditionalEdges(
    "draft_initial_request",
    routeAfterDraft,
    {
      "safety_check": "safety_check",
      "commit_state": "commit_state",
      "end": END
    }
  );

  // Safety Check → Gate or Execute
  graph.addEdge("safety_check", "gate_or_execute");

  // Gate or Execute → Conditional routing
  graph.addConditionalEdges(
    "gate_or_execute",
    routeFromGate,
    {
      "execute_action": "execute_action",
      "draft_initial_request": "draft_initial_request",  // For ADJUST
      "commit_state": "commit_state",
      "end": END
    }
  );

  // Execute Action → Conditional routing
  graph.addConditionalEdges(
    "execute_action",
    routeAfterExecute,
    {
      "schedule_followups": "schedule_followups",
      "commit_state": "commit_state"
    }
  );

  // Schedule Follow-ups → Commit State
  graph.addEdge("schedule_followups", "commit_state");

  // Commit State → End
  graph.addEdge("commit_state", END);

  return graph;
}

// Import shared utilities from foia-case-graph
const {
  acquireCaseLock,
  releaseCaseLock
} = require('./foia-case-graph');

const { PostgresSaver } = require("@langchain/langgraph-checkpoint-postgres");
const db = require("../../services/database");

/**
 * Create checkpointer using PostgresSaver for persistent checkpoints
 */
let _postgresCheckpointer = null;
let _checkpointerSetupComplete = false;

async function createCheckpointer() {
  if (_postgresCheckpointer) {
    return _postgresCheckpointer;
  }

  const databaseUrl = process.env.DATABASE_URL;

  if (!databaseUrl) {
    logger.warn('DATABASE_URL not set, falling back to MemorySaver');
    const { MemorySaver } = require("@langchain/langgraph");
    return new MemorySaver();
  }

  try {
    _postgresCheckpointer = PostgresSaver.fromConnString(databaseUrl, {
      schema: 'langgraph'
    });

    if (!_checkpointerSetupComplete) {
      logger.info('Setting up PostgresSaver for initial request graph...');
      await _postgresCheckpointer.setup();
      _checkpointerSetupComplete = true;
    }

    logger.info('Using PostgresSaver for initial request graph checkpoints');
    return _postgresCheckpointer;
  } catch (error) {
    logger.error('PostgresSaver creation failed', { error: error.message });
    const { MemorySaver } = require("@langchain/langgraph");
    return new MemorySaver();
  }
}

/**
 * Get compiled initial request graph (singleton)
 */
let _compiledInitialRequestGraph = null;

async function getCompiledInitialRequestGraph() {
  if (!_compiledInitialRequestGraph) {
    const checkpointer = await createCheckpointer();
    const builder = createInitialRequestGraphBuilder();
    _compiledInitialRequestGraph = builder.compile({ checkpointer });
    logger.info('Initial Request Graph compiled with checkpointer');
  }
  return _compiledInitialRequestGraph;
}

/**
 * Hash function for advisory lock
 */
function hashCode(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return hash;
}

/**
 * Acquire advisory lock for case
 */
async function acquireInitialRequestLock(caseId) {
  const lockKey = Math.abs(hashCode(`initial:${caseId}`)) % 2147483647;
  try {
    await db.query('SELECT pg_advisory_lock($1)', [lockKey]);
    return lockKey;
  } catch (error) {
    logger.error('Failed to acquire initial request lock', { caseId, error: error.message });
    throw error;
  }
}

async function releaseInitialRequestLock(lockKey) {
  try {
    await db.query('SELECT pg_advisory_unlock($1)', [lockKey]);
  } catch (error) {
    logger.error('Failed to release initial request lock', { lockKey, error: error.message });
  }
}

/**
 * Invoke the Initial Request Graph
 *
 * @param {number} caseId - Case ID to generate request for
 * @param {Object} options - Options
 * @param {number} options.runId - agent_runs.id for auditability
 * @param {string} options.autopilotMode - AUTO | SUPERVISED
 * @param {string} options.threadId - Custom thread ID
 * @param {Object} options.llmStubs - Stubbed responses for testing
 */
async function invokeInitialRequestGraph(caseId, options = {}) {
  const graph = await getCompiledInitialRequestGraph();
  const threadId = options.threadId || `initial:${caseId}`;

  // Acquire lock
  const lockKey = await acquireInitialRequestLock(caseId);

  try {
    const config = {
      configurable: { thread_id: threadId }
    };

    const initialState = createInitialState(caseId, 'initial_request', {
      runId: options.runId,
      autopilotMode: options.autopilotMode || 'SUPERVISED',
      threadId,
      llmStubs: options.llmStubs
    });

    logger.info('Invoking Initial Request Graph', { caseId, threadId });

    const result = await graph.invoke(initialState, config);

    // Check for interrupt
    if (result.__interrupt__) {
      logger.info(`Initial Request Graph interrupted for case ${caseId}`, {
        interruptValue: result.__interrupt__
      });

      return {
        status: 'interrupted',
        interruptData: result.__interrupt__,
        threadId,
        logs: result.logs || []
      };
    }

    logger.info('Initial Request Graph completed', { caseId, isComplete: result.isComplete });

    return {
      status: 'completed',
      result,
      threadId
    };

  } catch (error) {
    logger.error('Initial Request Graph invocation failed', { caseId, error: error.message });
    throw error;
  } finally {
    await releaseInitialRequestLock(lockKey);
  }
}

/**
 * Resume Initial Request Graph with human decision
 */
async function resumeInitialRequestGraph(caseId, humanDecision, options = {}) {
  const graph = await getCompiledInitialRequestGraph();
  const threadId = options.threadId || `initial:${caseId}`;

  const lockKey = await acquireInitialRequestLock(caseId);

  try {
    const config = {
      configurable: { thread_id: threadId }
    };

    logger.info('Resuming Initial Request Graph', { caseId, decision: humanDecision?.action });

    const { Command } = require("@langchain/langgraph");
    const result = await graph.invoke(
      new Command({
        resume: humanDecision,
        update: { caseId }
      }),
      config
    );

    if (result.__interrupt__) {
      logger.info(`Initial Request Graph re-interrupted for case ${caseId}`);
      return {
        status: 'interrupted',
        interruptData: result.__interrupt__,
        threadId
      };
    }

    logger.info('Initial Request Graph resumed and completed', { caseId });

    return {
      status: 'completed',
      result,
      threadId
    };

  } catch (error) {
    logger.error('Initial Request Graph resume failed', { caseId, error: error.message });
    throw error;
  } finally {
    await releaseInitialRequestLock(lockKey);
  }
}

module.exports = {
  createInitialRequestGraphBuilder,
  getCompiledInitialRequestGraph,
  invokeInitialRequestGraph,
  resumeInitialRequestGraph,
  createInitialState
};
