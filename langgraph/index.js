/**
 * LangGraph Module Exports
 *
 * Main entry point for the LangGraph-based FOIA case agent.
 */

const {
  createFOIACaseGraphBuilder,
  getCompiledGraph,
  invokeFOIACaseGraph,
  resumeFOIACaseGraph,
  createInitialState,
  resetThread,
  getThreadInfo,
  getRedisClient
} = require('./graph/foia-case-graph');

const { FOIACaseStateAnnotation } = require('./state/case-state');

// Node exports (for testing)
const { loadContextNode } = require('./nodes/load-context');
const { classifyInboundNode } = require('./nodes/classify-inbound');
const { updateConstraintsNode } = require('./nodes/update-constraints');
const { decideNextActionNode } = require('./nodes/decide-next-action');
const { draftResponseNode } = require('./nodes/draft-response');
const { safetyCheckNode } = require('./nodes/safety-check');
const { gateOrExecuteNode } = require('./nodes/gate-or-execute');
const { executeActionNode } = require('./nodes/execute-action');
const { commitStateNode } = require('./nodes/commit-state');

// DRY_RUN mode - prevents actual email sending in testing
const DRY_RUN = process.env.LANGGRAPH_DRY_RUN === 'true' ||
                process.env.NODE_ENV === 'development' ||
                process.env.LANGGRAPH_DRY_RUN !== 'false'; // Default ON unless explicitly disabled

module.exports = {
  // Main graph functions
  createFOIACaseGraphBuilder,
  getCompiledGraph,
  invokeFOIACaseGraph,
  resumeFOIACaseGraph,
  createInitialState,

  // Thread management
  resetThread,
  getThreadInfo,
  getRedisClient,

  // Configuration
  DRY_RUN,

  // State schema
  FOIACaseStateAnnotation,

  // Individual nodes (for testing)
  nodes: {
    loadContextNode,
    classifyInboundNode,
    updateConstraintsNode,
    decideNextActionNode,
    draftResponseNode,
    safetyCheckNode,
    gateOrExecuteNode,
    executeActionNode,
    commitStateNode
  }
};
