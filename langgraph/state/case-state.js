/**
 * LangGraph State Schema for FOIA Case Agent
 *
 * Design principles:
 * - Store IDs, not full objects (fetch when needed)
 * - Keep state small for checkpoint efficiency
 * - Track what's needed for decisions and resumption
 *
 * Shared by both graphs:
 * - Initial Request Graph: new FOIA request generation
 * - Inbound Response Graph: handling agency replies
 */

const { Annotation } = require("@langchain/langgraph");

/**
 * FOIACaseState - Minimal, explicit state for both case graphs
 */
const FOIACaseStateAnnotation = Annotation.Root({
  // === Identity ===
  caseId: Annotation({
    reducer: (_, v) => v,
    default: () => null
  }),
  threadId: Annotation({
    reducer: (_, v) => v,
    default: () => null  // LangGraph thread_id: `case:${caseId}`
  }),
  runId: Annotation({
    reducer: (_, v) => v,
    default: () => null  // agent_runs.id for auditability
  }),

  // === Trigger Context ===
  triggerType: Annotation({
    reducer: (_, v) => v,
    default: () => null  // 'initial_request' | 'agency_reply' | 'followup_trigger' | 'resume'
  }),
  latestInboundMessageId: Annotation({
    reducer: (_, v) => v,
    default: () => null
  }),
  scheduledKey: Annotation({
    reducer: (_, v) => v,
    default: () => null  // For followup triggers
  }),

  // === Analysis Results (from classify_inbound) ===
  classification: Annotation({
    reducer: (prev, v) => v !== undefined ? v : prev,  // Preserve if not explicitly set
    default: () => null  // FEE_QUOTE | DENIAL | ACKNOWLEDGMENT | RECORDS_READY | CLARIFICATION_REQUEST | NO_RESPONSE
  }),
  classificationConfidence: Annotation({
    reducer: (prev, v) => v !== undefined ? v : prev,  // Preserve if not explicitly set
    default: () => 0
  }),
  sentiment: Annotation({
    reducer: (prev, v) => v !== undefined ? v : prev,  // Preserve if not explicitly set
    default: () => 'neutral'  // positive | neutral | negative | hostile
  }),
  extractedFeeAmount: Annotation({
    reducer: (prev, v) => v !== undefined ? v : prev,  // Preserve if not explicitly set
    default: () => null
  }),
  extractedDeadline: Annotation({
    reducer: (prev, v) => v !== undefined ? v : prev,  // Preserve if not explicitly set
    default: () => null
  }),

  // === NEW: Prompt Tuning Fields (requires_response logic) ===
  requiresResponse: Annotation({
    reducer: (prev, v) => v !== undefined ? v : prev,
    default: () => true  // Default true for safety - only skip response when explicitly false
  }),
  portalUrl: Annotation({
    reducer: (prev, v) => v !== undefined ? v : prev,
    default: () => null  // Extracted portal URL if agency redirects to portal
  }),
  suggestedAction: Annotation({
    reducer: (prev, v) => v !== undefined ? v : prev,
    default: () => null  // AI-suggested action: use_portal, download, wait, respond, etc.
  }),
  reasonNoResponse: Annotation({
    reducer: (prev, v) => v !== undefined ? v : prev,
    default: () => null  // Explanation for why no response needed (for audit trail)
  }),

  // === Constraints & Scope (persisted facts about this case) ===
  constraints: Annotation({
    reducer: (prev, v) => v ?? prev,
    default: () => []  // ['BWC_EXEMPT', 'FEE_REQUIRED', 'ID_REQUIRED', etc.]
  }),
  scopeItems: Annotation({
    reducer: (prev, v) => v ?? prev,
    default: () => []  // Requested records with status
  }),

  // === Current Proposal ===
  proposalId: Annotation({
    reducer: (prev, v) => v !== undefined ? v : prev,  // Preserve if not explicitly set
    default: () => null
  }),
  proposalKey: Annotation({
    reducer: (prev, v) => v !== undefined ? v : prev,  // Preserve if not explicitly set
    default: () => null
  }),
  proposalActionType: Annotation({
    reducer: (prev, v) => v !== undefined ? v : prev,  // Preserve if not explicitly set
    default: () => null  // SEND_FOLLOWUP | SEND_REBUTTAL | SEND_CLARIFICATION | APPROVE_FEE | ESCALATE | NONE
  }),
  draftSubject: Annotation({
    reducer: (prev, v) => v !== undefined ? v : prev,  // Preserve if not explicitly set
    default: () => null
  }),
  draftBodyText: Annotation({
    reducer: (prev, v) => v !== undefined ? v : prev,  // Preserve if not explicitly set
    default: () => null
  }),
  draftBodyHtml: Annotation({
    reducer: (prev, v) => v !== undefined ? v : prev,  // Preserve if not explicitly set
    default: () => null
  }),
  proposalReasoning: Annotation({
    reducer: (prev, v) => v ? [...(prev || []), ...v] : prev,
    default: () => []
  }),
  proposalConfidence: Annotation({
    reducer: (prev, v) => v !== undefined ? v : prev,  // Preserve if not explicitly set
    default: () => 0
  }),
  riskFlags: Annotation({
    reducer: (prev, v) => v !== undefined ? v : prev,  // Preserve if not explicitly set
    default: () => []
  }),
  warnings: Annotation({
    reducer: (prev, v) => v !== undefined ? v : prev,  // Preserve if not explicitly set
    default: () => []
  }),
  canAutoExecute: Annotation({
    reducer: (prev, v) => v !== undefined ? v : prev,  // Preserve if not explicitly set
    default: () => false
  }),

  // === Gate/Interrupt State ===
  requiresHuman: Annotation({
    reducer: (prev, v) => v !== undefined ? v : prev,  // Preserve if not explicitly set
    default: () => false
  }),
  pauseReason: Annotation({
    reducer: (prev, v) => v !== undefined ? v : prev,  // Preserve if not explicitly set
    default: () => null  // FEE_QUOTE | SCOPE | DENIAL | ID_REQUIRED | SENSITIVE | CLOSE_ACTION
  }),
  gateOptions: Annotation({
    reducer: (prev, v) => v !== undefined ? v : prev,  // Preserve if not explicitly set
    default: () => ['APPROVE', 'ADJUST', 'DISMISS', 'WITHDRAW']
  }),

  // === Human Decision (populated on resume) ===
  humanDecision: Annotation({
    reducer: (_, v) => v,
    default: () => null  // { action: 'APPROVE' | 'ADJUST' | 'DISMISS' | 'WITHDRAW', instruction?: string }
  }),
  adjustmentInstruction: Annotation({
    reducer: (_, v) => v,
    default: () => null  // The human's instruction for ADJUST actions
  }),
  adjustmentCount: Annotation({
    reducer: (_, v) => v,
    default: () => 0
  }),

  // === Execution State ===
  actionExecuted: Annotation({
    reducer: (_, v) => v,
    default: () => false
  }),
  executionResult: Annotation({
    reducer: (_, v) => v,
    default: () => null
  }),

  // === Control Flow ===
  autopilotMode: Annotation({
    reducer: (prev, v) => v !== undefined ? v : prev,  // Preserve if not explicitly set
    default: () => 'SUPERVISED'  // AUTO | SUPERVISED | MANUAL
  }),
  isComplete: Annotation({
    reducer: (_, v) => v,
    default: () => false
  }),
  nextNode: Annotation({
    reducer: (_, v) => v,
    default: () => null  // For explicit routing
  }),

  // === Logs & Errors ===
  logs: Annotation({
    reducer: (prev, v) => v ? [...prev, ...v] : prev,
    default: () => []
  }),
  errors: Annotation({
    reducer: (prev, v) => v ? [...prev, ...v] : prev,
    default: () => []
  }),

  // === Testing/Deterministic Mode ===
  llmStubs: Annotation({
    reducer: (prev, v) => v !== undefined ? v : prev,
    default: () => null  // { classify: {...}, draft: {...} } - stubbed LLM responses for E2E testing
  })
});

/**
 * Create initial state for a case
 *
 * @param {number} caseId - The case ID
 * @param {string} triggerType - 'initial_request' | 'agency_reply' | 'followup_trigger' | 'resume'
 * @param {Object} options - Additional options
 * @param {number} options.runId - agent_runs.id for auditability
 * @param {number} options.messageId - Message ID for inbound triggers
 * @param {string} options.scheduledKey - Key for followup triggers
 * @param {string} options.autopilotMode - AUTO | SUPERVISED
 * @param {string} options.threadId - Custom thread ID (default: case:${caseId})
 * @param {Object} options.llmStubs - Stubbed LLM responses for testing
 */
function createInitialState(caseId, triggerType, options = {}) {
  return {
    caseId,
    threadId: options.threadId || `case:${caseId}`,
    runId: options.runId || null,
    triggerType,
    latestInboundMessageId: options.messageId || null,
    scheduledKey: options.scheduledKey || null,
    autopilotMode: options.autopilotMode || 'SUPERVISED',
    adjustmentCount: 0,
    isComplete: false,
    logs: [`Graph started: trigger=${triggerType}, caseId=${caseId}, run=${options.runId || 'none'}`],
    errors: [],
    llmStubs: options.llmStubs || null  // For deterministic E2E testing
  };
}

module.exports = {
  FOIACaseStateAnnotation,
  createInitialState
};
