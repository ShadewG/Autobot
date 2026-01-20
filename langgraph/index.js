/**
 * LangGraph Module Exports
 *
 * Main entry point for the LangGraph-based FOIA case agent.
 *
 * Two graphs sharing the same state:
 * 1. Initial Request Graph - Generate and send new FOIA requests
 * 2. Inbound Response Graph - Handle agency replies
 */

// Inbound Response Graph (existing foia-case-graph)
const {
  createFOIACaseGraphBuilder,
  getCompiledGraph,
  invokeFOIACaseGraph,
  resumeFOIACaseGraph,
  resetThread,
  getThreadInfo,
  getRedisClient
} = require('./graph/foia-case-graph');

// Initial Request Graph (new)
const {
  createInitialRequestGraphBuilder,
  getCompiledInitialRequestGraph,
  invokeInitialRequestGraph,
  resumeInitialRequestGraph
} = require('./graph/initial-request-graph');

// Shared state
const { FOIACaseStateAnnotation, createInitialState } = require('./state/case-state');

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

// Initial Request Graph nodes
const { draftInitialRequestNode } = require('./nodes/draft-initial-request');
const { scheduleFollowupsNode } = require('./nodes/schedule-followups');

// DRY_RUN mode - prevents actual email sending in testing
const DRY_RUN = process.env.LANGGRAPH_DRY_RUN === 'true' ||
                process.env.NODE_ENV === 'development' ||
                process.env.LANGGRAPH_DRY_RUN !== 'false'; // Default ON unless explicitly disabled

module.exports = {
  // === INBOUND RESPONSE GRAPH (agency reply handling) ===
  createFOIACaseGraphBuilder,  // Alias: createInboundResponseGraphBuilder
  getCompiledGraph,            // Returns compiled inbound response graph
  invokeFOIACaseGraph,         // Invoke inbound response graph
  resumeFOIACaseGraph,         // Resume after human decision

  // === INITIAL REQUEST GRAPH (new FOIA request generation) ===
  createInitialRequestGraphBuilder,
  getCompiledInitialRequestGraph,
  invokeInitialRequestGraph,   // Invoke initial request graph
  resumeInitialRequestGraph,   // Resume after human decision

  // === SHARED ===
  createInitialState,          // Create initial state for either graph

  // Thread management
  resetThread,
  getThreadInfo,
  getRedisClient,

  // Configuration
  DRY_RUN,

  // State schema (shared by both graphs)
  FOIACaseStateAnnotation,

  // Individual nodes (for testing)
  nodes: {
    // Shared nodes
    loadContextNode,
    safetyCheckNode,
    gateOrExecuteNode,
    executeActionNode,
    commitStateNode,

    // Inbound Response Graph nodes
    classifyInboundNode,
    updateConstraintsNode,
    decideNextActionNode,
    draftResponseNode,

    // Initial Request Graph nodes
    draftInitialRequestNode,
    scheduleFollowupsNode
  }
};
