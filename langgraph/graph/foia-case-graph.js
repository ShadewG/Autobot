/**
 * FOIA Case Graph Definition
 *
 * Main LangGraph state machine for FOIA case handling.
 *
 * P0 FIXES APPLIED:
 * 1. Checkpointer at compile time, thread_id at invoke time
 * 2. Advisory locks for per-case concurrency
 * 3. __interrupt__ detection from result
 */

const { StateGraph, START, END } = require("@langchain/langgraph");
const { RedisSaver } = require("@langchain/langgraph-checkpoint-redis");
const { createClient } = require("redis");

const { FOIACaseStateAnnotation, createInitialState } = require("../state/case-state");
const { loadContextNode } = require("../nodes/load-context");
const { classifyInboundNode } = require("../nodes/classify-inbound");
const { updateConstraintsNode } = require("../nodes/update-constraints");
const { decideNextActionNode } = require("../nodes/decide-next-action");
const { draftResponseNode } = require("../nodes/draft-response");
const { safetyCheckNode } = require("../nodes/safety-check");
const { gateOrExecuteNode } = require("../nodes/gate-or-execute");
const { executeActionNode } = require("../nodes/execute-action");
const { commitStateNode } = require("../nodes/commit-state");

const logger = require("../../services/logger");
const db = require("../../services/database");

// Max iterations to prevent runaway
const MAX_ITERATIONS = parseInt(process.env.LANGGRAPH_MAX_ITERATIONS) || 5;

/**
 * Route based on decision node output
 */
function routeFromDecision(state) {
  const { isComplete, nextNode, proposalActionType } = state;

  // Explicit routing
  if (nextNode) {
    return nextNode;
  }

  // Complete state
  if (isComplete) {
    return "end";
  }

  // Route based on action type
  if (proposalActionType === 'ESCALATE') {
    return "gate_or_execute";
  }

  if (proposalActionType === 'NONE') {
    return "end";
  }

  // Default: draft a response
  return "draft_response";
}

/**
 * Route based on gate node output
 */
function routeFromGate(state) {
  const { nextNode, humanDecision, isComplete } = state;

  // After interrupt/resume
  if (humanDecision) {
    return "decide_next_action";
  }

  // Explicit routing
  if (nextNode) {
    return nextNode;
  }

  if (isComplete) {
    return "end";
  }

  return "execute_action";
}

/**
 * Create graph builder (not compiled)
 * Returns StateGraph that can be compiled with checkpointer
 */
function createFOIACaseGraphBuilder() {
  const graph = new StateGraph(FOIACaseStateAnnotation);

  // === Add Nodes ===
  graph.addNode("load_context", loadContextNode);
  graph.addNode("classify_inbound", classifyInboundNode);
  graph.addNode("update_constraints", updateConstraintsNode);
  graph.addNode("decide_next_action", decideNextActionNode);
  graph.addNode("draft_response", draftResponseNode);
  graph.addNode("safety_check", safetyCheckNode);
  graph.addNode("gate_or_execute", gateOrExecuteNode);
  graph.addNode("execute_action", executeActionNode);
  graph.addNode("commit_state", commitStateNode);

  // === Add Edges ===

  // Start → Load Context
  graph.addEdge(START, "load_context");

  // Load Context → Classify Inbound
  graph.addEdge("load_context", "classify_inbound");

  // Classify → Update Constraints
  graph.addEdge("classify_inbound", "update_constraints");

  // Update Constraints → Decide Next Action
  graph.addEdge("update_constraints", "decide_next_action");

  // Decide Next Action → Conditional routing
  graph.addConditionalEdges(
    "decide_next_action",
    routeFromDecision,
    {
      "draft_response": "draft_response",
      "execute_action": "execute_action",
      "gate_or_execute": "gate_or_execute",
      "end": END
    }
  );

  // Draft Response → Safety Check
  graph.addEdge("draft_response", "safety_check");

  // Safety Check → Gate or Execute
  graph.addEdge("safety_check", "gate_or_execute");

  // Gate or Execute → Conditional routing
  graph.addConditionalEdges(
    "gate_or_execute",
    routeFromGate,
    {
      "execute_action": "execute_action",
      "decide_next_action": "decide_next_action",
      "end": END
    }
  );

  // Execute Action → Commit State
  graph.addEdge("execute_action", "commit_state");

  // Commit State → End
  graph.addEdge("commit_state", END);

  return graph;
}

/**
 * Create checkpointer based on config
 * P0 FIX #1: Checkpointer is passed at compile time, NOT invoke time
 */
let _redisClient = null;

async function getRedisClient() {
  if (!_redisClient) {
    const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';
    _redisClient = createClient({ url: redisUrl });
    _redisClient.on('error', (err) => logger.error('Redis checkpointer error', { error: err.message }));
    await _redisClient.connect();
    logger.info('Redis checkpointer client connected');
  }
  return _redisClient;
}

async function createCheckpointer() {
  const checkpointerType = process.env.LANGGRAPH_CHECKPOINTER || 'redis';

  if (checkpointerType === 'redis') {
    const client = await getRedisClient();
    // RedisSaver takes client as FIRST argument, not in an object
    return new RedisSaver(client);
  }

  // Fallback to memory (not recommended for production)
  const { MemorySaver } = require("@langchain/langgraph");
  logger.warn('Using MemorySaver - not recommended for production');
  return new MemorySaver();
}

/**
 * Get compiled graph with checkpointer (singleton)
 * P0 FIX #1: Checkpointer is passed at COMPILE time
 */
let _compiledGraph = null;

async function getCompiledGraph() {
  if (!_compiledGraph) {
    const checkpointer = await createCheckpointer();
    const builder = createFOIACaseGraphBuilder();
    // CORRECT: Pass checkpointer at compile time
    _compiledGraph = builder.compile({ checkpointer });
    logger.info('LangGraph compiled with checkpointer');
  }
  return _compiledGraph;
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
 * Acquire advisory lock for case (P0 fix #4: Concurrency control)
 */
async function acquireCaseLock(caseId) {
  const lockKey = Math.abs(hashCode(`case:${caseId}`)) % 2147483647;
  try {
    await db.query('SELECT pg_advisory_lock($1)', [lockKey]);
    return lockKey;
  } catch (error) {
    logger.error('Failed to acquire case lock', { caseId, error: error.message });
    throw error;
  }
}

async function releaseCaseLock(lockKey) {
  try {
    await db.query('SELECT pg_advisory_unlock($1)', [lockKey]);
  } catch (error) {
    logger.error('Failed to release case lock', { lockKey, error: error.message });
  }
}

/**
 * Invoke the graph for a case
 * P0 FIX #1: Only pass thread_id at invoke time
 * P0 FIX #4: Acquire advisory lock before running
 * P0 FIX #5: Use result.__interrupt__ to detect interrupts
 */
async function invokeFOIACaseGraph(caseId, triggerType, options = {}) {
  const graph = await getCompiledGraph();
  const threadId = `case:${caseId}`;

  // P0 FIX #4: Acquire per-case lock
  const lockKey = await acquireCaseLock(caseId);

  try {
    // CORRECT: Only pass thread_id at invoke time
    const config = {
      configurable: { thread_id: threadId }
    };

    const initialState = createInitialState(caseId, triggerType, options);

    logger.info('Invoking FOIA case graph', { caseId, triggerType, threadId });

    const result = await graph.invoke(initialState, config);

    // P0 FIX #5: Use __interrupt__ from result (not getState)
    if (result.__interrupt__) {
      logger.info(`Graph interrupted for case ${caseId}`, {
        interruptValue: result.__interrupt__
      });

      return {
        status: 'interrupted',
        interruptData: result.__interrupt__,
        threadId,
        logs: result.logs || []
      };
    }

    logger.info('Graph completed for case', { caseId, isComplete: result.isComplete });

    return {
      status: 'completed',
      result,
      threadId
    };

  } catch (error) {
    logger.error('Graph invocation failed', { caseId, error: error.message, stack: error.stack });
    throw error;
  } finally {
    // Always release lock
    await releaseCaseLock(lockKey);
  }
}

/**
 * Resume graph with human decision
 * P0 FIX #1: Only pass thread_id at invoke time
 * P0 FIX #4: Acquire advisory lock before running
 */
async function resumeFOIACaseGraph(caseId, humanDecision) {
  const graph = await getCompiledGraph();
  const threadId = `case:${caseId}`;

  // P0 FIX #4: Acquire per-case lock
  const lockKey = await acquireCaseLock(caseId);

  try {
    const config = {
      configurable: { thread_id: threadId }
    };

    logger.info('Resuming FOIA case graph', { caseId, decision: humanDecision?.action });

    // Resume with the human decision
    const { Command } = require("@langchain/langgraph");
    const result = await graph.invoke(
      new Command({ resume: humanDecision }),
      config
    );

    // P0 FIX #5: Use __interrupt__ from result
    if (result.__interrupt__) {
      logger.info(`Graph re-interrupted for case ${caseId}`);
      return {
        status: 'interrupted',
        interruptData: result.__interrupt__,
        threadId
      };
    }

    logger.info('Graph resumed and completed for case', { caseId });

    return {
      status: 'completed',
      result,
      threadId
    };

  } catch (error) {
    logger.error('Graph resume failed', { caseId, error: error.message, stack: error.stack });
    throw error;
  } finally {
    await releaseCaseLock(lockKey);
  }
}

/**
 * Reset thread - delete all checkpoints for a case
 * Used for testing/iteration
 */
async function resetThread(caseId) {
  const client = await getRedisClient();
  const threadId = `case:${caseId}`;

  // Find and delete all keys for this thread
  const patterns = [
    `checkpoint:${threadId}:*`,
    `write_keys_zset:${threadId}:*`,
    `writes:${threadId}:*`
  ];

  let deletedCount = 0;
  for (const pattern of patterns) {
    // Use SCAN instead of KEYS for production safety
    let cursor = 0;
    do {
      const result = await client.scan(cursor, { MATCH: pattern, COUNT: 100 });
      cursor = result.cursor;
      if (result.keys.length > 0) {
        await client.del(result.keys);
        deletedCount += result.keys.length;
      }
    } while (cursor !== 0);
  }

  logger.info('Thread reset', { caseId, threadId, deletedCount });
  return { threadId, deletedCount };
}

/**
 * Get thread state/checkpoint info
 */
async function getThreadInfo(caseId) {
  const client = await getRedisClient();
  const threadId = `case:${caseId}`;

  // Find checkpoint keys
  const pattern = `checkpoint:${threadId}:*`;
  let checkpoints = [];

  let cursor = 0;
  do {
    const result = await client.scan(cursor, { MATCH: pattern, COUNT: 100 });
    cursor = result.cursor;
    checkpoints = checkpoints.concat(result.keys);
  } while (cursor !== 0);

  checkpoints.sort().reverse();

  let latestCheckpoint = null;
  if (checkpoints.length > 0) {
    try {
      latestCheckpoint = await client.json.get(checkpoints[0]);
    } catch (e) {
      // JSON module might not be available
      latestCheckpoint = await client.get(checkpoints[0]);
    }
  }

  return {
    threadId,
    checkpointCount: checkpoints.length,
    latestCheckpointKey: checkpoints[0] || null,
    latestCheckpoint
  };
}

module.exports = {
  createFOIACaseGraphBuilder,
  getCompiledGraph,
  invokeFOIACaseGraph,
  resumeFOIACaseGraph,
  createInitialState,
  resetThread,
  getThreadInfo,
  getRedisClient
};
