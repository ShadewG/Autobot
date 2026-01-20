# LangGraph Migration Plan - Detailed Implementation

## Overview

This plan migrates the current `FOIACaseAgent` (manual OpenAI function calling loop) to LangGraph with:
- Typed state management
- Durable checkpointing (Redis)
- Human-in-the-loop interrupts
- Deterministic + LLM routing
- Resume/approval endpoints

---

## CRITICAL: P0 Fixes (Must Implement)

Before implementing, these are non-negotiable requirements:

### 1. Checkpointer Wiring
- **Wrong**: Passing checkpointer at invoke time
- **Right**: Pass checkpointer at `graph.compile({ checkpointer })` time, only pass `thread_id` at invoke

### 2. Interrupt Idempotency
- **Never** wrap `interrupt()` in try/catch
- All side effects before `interrupt()` MUST be idempotent (safe to re-run)
- Use upsert patterns with deterministic keys for proposals

### 3. Execution Idempotency
- Store `execution_key` and `email_job_id` on proposals
- Check `if (proposal.status === 'EXECUTED')` before enqueueing
- Prevents duplicate emails on retries/resumes

### 4. Concurrency Control
- One agent run per case at a time
- Use Postgres advisory locks: `pg_advisory_lock(hash(caseId))`

### 5. Interrupt Detection
- Use `result.__interrupt__` from invoke result (not getState)

---

## Phase 1: Dependencies & Infrastructure Setup

### 1.1 Install Dependencies

**File:** `package.json`

```bash
npm install @langchain/langgraph @langchain/core @langchain/openai zod
```

Add to dependencies:
```json
{
  "@langchain/langgraph": "^0.2.x",
  "@langchain/langgraph-checkpoint": "^0.0.x",
  "@langchain/core": "^0.3.x",
  "@langchain/openai": "^0.3.x",
  "zod": "^3.23.x"
}
```

### 1.2 Create Directory Structure

```
mkdir -p langgraph/{graph,nodes,tools,state}
```

New files to create:
```
langgraph/
├── index.js                    # Main exports
├── graph/
│   └── foia-case-graph.js      # Graph definition
├── state/
│   └── case-state.js           # State annotation & schema
├── nodes/
│   ├── load-context.js         # Fetch case data
│   ├── classify-inbound.js     # AI analysis node
│   ├── update-constraints.js   # Update scope/constraints
│   ├── decide-next-action.js   # Router node
│   ├── draft-response.js       # Draft email (multiple types)
│   ├── safety-check.js         # Validate draft against constraints
│   ├── gate-or-execute.js      # Human interrupt OR execute
│   ├── execute-action.js       # Send email/schedule followup
│   ├── commit-state.js         # Finalize & recompute due_info
│   └── should-continue.js      # Loop control
└── tools/
    ├── case-tools.js           # fetch_case_context wrapped
    ├── email-tools.js          # send_email, schedule_followup
    ├── draft-tools.js          # draft_* tools
    └── escalation-tools.js     # escalate_to_human
```

### 1.3 Database Migration - Add Proposals Table

**File:** `migrations/015_proposals_table.sql`

```sql
-- Proposals table for NextActionProposal
-- CRITICAL: Uses proposal_key for idempotency (P0 fix #2)
CREATE TABLE IF NOT EXISTS proposals (
    id SERIAL PRIMARY KEY,
    case_id INTEGER REFERENCES cases(id) ON DELETE CASCADE,

    -- IDEMPOTENCY KEY (P0 fix): deterministic key for upsert
    -- Format: {case_id}:{trigger_message_id}:{action_type}:{attempt}
    proposal_key VARCHAR(255) UNIQUE NOT NULL,

    -- Proposal content
    action_type VARCHAR(50) NOT NULL,  -- SEND_FOLLOWUP, SEND_REBUTTAL, SEND_CLARIFICATION, APPROVE_FEE, ESCALATE, SUBMIT_PORTAL, etc.
    trigger_message_id INTEGER,  -- The inbound message that triggered this proposal (null for time-based)
    draft_subject TEXT,
    draft_body_text TEXT,
    draft_body_html TEXT,

    -- Reasoning
    reasoning JSONB,  -- Array of reasoning steps
    confidence DECIMAL(3,2),
    risk_flags TEXT[],
    warnings TEXT[],

    -- Execution control
    can_auto_execute BOOLEAN DEFAULT false,
    requires_human BOOLEAN DEFAULT true,

    -- Status lifecycle
    status VARCHAR(50) DEFAULT 'DRAFT',  -- DRAFT, PENDING_APPROVAL, APPROVED, EXECUTED, SUPERSEDED, REJECTED, DISMISSED

    -- EXECUTION IDEMPOTENCY (P0 fix #3)
    execution_key VARCHAR(255) UNIQUE,  -- Set when execution starts, prevents duplicate sends
    email_job_id VARCHAR(255),          -- BullMQ job ID if email was queued

    -- Human interaction
    approved_by VARCHAR(255),
    approved_at TIMESTAMP WITH TIME ZONE,
    adjustment_instruction TEXT,
    adjustment_count INTEGER DEFAULT 0,  -- Tracks re-draft attempts

    -- LangGraph tracking
    langgraph_thread_id VARCHAR(255),
    langgraph_checkpoint_id VARCHAR(255),

    -- Timestamps
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    executed_at TIMESTAMP WITH TIME ZONE
);

CREATE INDEX idx_proposals_case_id ON proposals(case_id);
CREATE INDEX idx_proposals_status ON proposals(status);
CREATE INDEX idx_proposals_thread_id ON proposals(langgraph_thread_id);
CREATE INDEX idx_proposals_key ON proposals(proposal_key);
CREATE INDEX idx_proposals_execution_key ON proposals(execution_key);

-- Add langgraph_thread_id to cases table
ALTER TABLE cases ADD COLUMN IF NOT EXISTS langgraph_thread_id VARCHAR(255);
CREATE INDEX IF NOT EXISTS idx_cases_langgraph_thread_id ON cases(langgraph_thread_id);

-- Add constraints and scope_items columns if not exists
ALTER TABLE cases ADD COLUMN IF NOT EXISTS constraints TEXT[] DEFAULT '{}';
ALTER TABLE cases ADD COLUMN IF NOT EXISTS scope_items JSONB DEFAULT '[]';
```

### 1.4 Environment Variables

**File:** `.env` (add)

```env
# LangGraph Configuration
USE_LANGGRAPH=false              # Feature flag for gradual rollout
LANGGRAPH_CHECKPOINTER=redis     # redis | postgres
LANGGRAPH_MAX_ITERATIONS=5       # Max graph iterations per run
```

---

## Phase 2: State Definition

### 2.1 State Schema

**File:** `langgraph/state/case-state.js`

```javascript
const { Annotation } = require("@langchain/langgraph");

/**
 * FOIACaseState - Minimal, explicit state for the case graph
 *
 * Design principles:
 * - Store IDs, not full objects (fetch when needed)
 * - Keep state small for checkpoint efficiency
 * - Track what's needed for decisions and resumption
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

  // === Trigger Context ===
  triggerType: Annotation({
    reducer: (_, v) => v,
    default: () => null  // 'agency_reply' | 'time_based_followup' | 'manual_review' | 'human_resume'
  }),
  latestInboundMessageId: Annotation({
    reducer: (_, v) => v,
    default: () => null
  }),

  // === Analysis Results (from classify_inbound) ===
  classification: Annotation({
    reducer: (_, v) => v,
    default: () => null  // FEE_QUOTE | DENIAL | ACKNOWLEDGMENT | RECORDS_READY | CLARIFICATION_REQUEST | NO_RESPONSE
  }),
  classificationConfidence: Annotation({
    reducer: (_, v) => v,
    default: () => 0
  }),
  sentiment: Annotation({
    reducer: (_, v) => v,
    default: () => 'neutral'  // positive | neutral | negative | hostile
  }),
  extractedFeeAmount: Annotation({
    reducer: (_, v) => v,
    default: () => null
  }),
  extractedDeadline: Annotation({
    reducer: (_, v) => v,
    default: () => null
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
    reducer: (_, v) => v,
    default: () => null
  }),
  proposalActionType: Annotation({
    reducer: (_, v) => v,
    default: () => null  // SEND_FOLLOWUP | SEND_REBUTTAL | SEND_CLARIFICATION | APPROVE_FEE | ESCALATE | NONE
  }),
  draftSubject: Annotation({
    reducer: (_, v) => v,
    default: () => null
  }),
  draftBodyText: Annotation({
    reducer: (_, v) => v,
    default: () => null
  }),
  draftBodyHtml: Annotation({
    reducer: (_, v) => v,
    default: () => null
  }),
  proposalReasoning: Annotation({
    reducer: (prev, v) => v ? [...(prev || []), ...v] : prev,
    default: () => []
  }),
  proposalConfidence: Annotation({
    reducer: (_, v) => v,
    default: () => 0
  }),
  riskFlags: Annotation({
    reducer: (_, v) => v,
    default: () => []
  }),
  canAutoExecute: Annotation({
    reducer: (_, v) => v,
    default: () => false
  }),

  // === Gate/Interrupt State ===
  requiresHuman: Annotation({
    reducer: (_, v) => v,
    default: () => false
  }),
  pauseReason: Annotation({
    reducer: (_, v) => v,
    default: () => null  // FEE_QUOTE | SCOPE | DENIAL | ID_REQUIRED | SENSITIVE | CLOSE_ACTION
  }),
  gateOptions: Annotation({
    reducer: (_, v) => v,
    default: () => ['APPROVE', 'ADJUST', 'DISMISS', 'WITHDRAW']
  }),

  // === Human Decision (populated on resume) ===
  humanDecision: Annotation({
    reducer: (_, v) => v,
    default: () => null  // { action: 'APPROVE' | 'ADJUST' | 'DISMISS' | 'WITHDRAW', instruction?: string }
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
    reducer: (_, v) => v,
    default: () => 'SUPERVISED'  // AUTO | SUPERVISED | MANUAL
  }),
  loopCount: Annotation({
    reducer: (prev, v) => v ?? (prev + 1),
    default: () => 0
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
  })
});

// Helper: Create initial state for a case
function createInitialState(caseId, triggerType, options = {}) {
  return {
    caseId,
    threadId: `case:${caseId}`,
    triggerType,
    latestInboundMessageId: options.messageId || null,
    autopilotMode: options.autopilotMode || 'SUPERVISED',
    loopCount: 0,
    isComplete: false,
    logs: [`Graph started: trigger=${triggerType}, caseId=${caseId}`],
    errors: []
  };
}

module.exports = {
  FOIACaseStateAnnotation,
  createInitialState
};
```

---

## Phase 3: Node Implementations

### 3.1 Load Context Node

**File:** `langgraph/nodes/load-context.js`

```javascript
const db = require('../../services/database');
const logger = require('../../utils/logger');

/**
 * Load all context needed for decision-making
 * Fetches: case data, messages, latest analysis, scheduled followups, existing proposal
 */
async function loadContextNode(state) {
  const { caseId, latestInboundMessageId } = state;

  try {
    // Fetch case details
    const caseData = await db.getCaseById(caseId);
    if (!caseData) {
      return {
        errors: [`Case ${caseId} not found`],
        isComplete: true
      };
    }

    // Fetch messages in thread
    const messages = await db.getMessagesByCaseId(caseId);

    // Fetch latest analysis if there's an inbound message
    let analysis = null;
    if (latestInboundMessageId) {
      analysis = await db.getResponseAnalysisByMessageId(latestInboundMessageId);
    }

    // Fetch scheduled followups
    const followups = await db.getFollowUpScheduleByCaseId(caseId);

    // Fetch existing pending proposal
    const existingProposal = await db.getLatestPendingProposal(caseId);

    // Extract constraints and scope from case data
    const constraints = caseData.constraints || [];
    const scopeItems = caseData.scope_items || caseData.requested_records?.map(r => ({
      item: r,
      status: 'PENDING'
    })) || [];

    return {
      // Store IDs/references, not full objects (fetch in nodes that need them)
      autopilotMode: caseData.autopilot_mode || 'SUPERVISED',
      constraints,
      scopeItems,
      proposalId: existingProposal?.id || null,
      logs: [
        `Loaded context: ${messages.length} messages, ` +
        `${constraints.length} constraints, ` +
        `${scopeItems.length} scope items, ` +
        `autopilot=${caseData.autopilot_mode || 'SUPERVISED'}`
      ]
    };
  } catch (error) {
    logger.error('load_context_node error', { caseId, error: error.message });
    return {
      errors: [`Failed to load context: ${error.message}`],
      isComplete: true
    };
  }
}

module.exports = { loadContextNode };
```

### 3.2 Classify Inbound Node

**File:** `langgraph/nodes/classify-inbound.js`

```javascript
const aiService = require('../../services/ai-service');
const db = require('../../services/database');
const logger = require('../../utils/logger');

/**
 * Analyze inbound message and classify intent
 * Maps to existing aiService.analyzeResponse()
 */
async function classifyInboundNode(state) {
  const { caseId, latestInboundMessageId, triggerType } = state;

  // Skip classification for time-based triggers (no new message)
  if (triggerType === 'time_based_followup') {
    return {
      classification: 'NO_RESPONSE',
      classificationConfidence: 1.0,
      logs: ['Skipped classification: time-based trigger (no new message)']
    };
  }

  // Skip if no inbound message
  if (!latestInboundMessageId) {
    return {
      classification: 'NO_RESPONSE',
      classificationConfidence: 1.0,
      logs: ['Skipped classification: no inbound message ID']
    };
  }

  try {
    // Fetch message and case data for analysis
    const message = await db.getMessageById(latestInboundMessageId);
    const caseData = await db.getCaseById(caseId);

    if (!message) {
      return {
        errors: [`Message ${latestInboundMessageId} not found`],
        classification: 'UNKNOWN',
        classificationConfidence: 0
      };
    }

    // Use existing AI analysis
    const analysis = await aiService.analyzeResponse(message, caseData);

    // Map intent to our classification enum
    const classificationMap = {
      'fee_request': 'FEE_QUOTE',
      'denial': 'DENIAL',
      'acknowledgment': 'ACKNOWLEDGMENT',
      'delivery': 'RECORDS_READY',
      'more_info_needed': 'CLARIFICATION_REQUEST',
      'question': 'CLARIFICATION_REQUEST'
    };

    const classification = classificationMap[analysis.intent] || 'UNKNOWN';

    // Save analysis to DB
    await db.saveResponseAnalysis({
      messageId: latestInboundMessageId,
      caseId,
      intent: analysis.intent,
      confidenceScore: analysis.confidence_score,
      sentiment: analysis.sentiment,
      keyPoints: analysis.key_points,
      extractedDeadline: analysis.extracted_deadline,
      extractedFeeAmount: analysis.extracted_fee_amount,
      requiresAction: analysis.requires_action,
      suggestedAction: analysis.suggested_action,
      fullAnalysisJson: analysis
    });

    return {
      classification,
      classificationConfidence: analysis.confidence_score || 0.8,
      sentiment: analysis.sentiment || 'neutral',
      extractedFeeAmount: analysis.extracted_fee_amount,
      extractedDeadline: analysis.extracted_deadline,
      logs: [
        `Classified as ${classification} (confidence: ${analysis.confidence_score}), ` +
        `sentiment: ${analysis.sentiment}, ` +
        `fee: ${analysis.extracted_fee_amount || 'none'}`
      ]
    };
  } catch (error) {
    logger.error('classify_inbound_node error', { caseId, error: error.message });
    return {
      errors: [`Classification failed: ${error.message}`],
      classification: 'UNKNOWN',
      classificationConfidence: 0
    };
  }
}

module.exports = { classifyInboundNode };
```

### 3.3 Update Constraints Node

**File:** `langgraph/nodes/update-constraints.js`

```javascript
const db = require('../../services/database');
const logger = require('../../utils/logger');

/**
 * Update constraints and scope based on agency response
 *
 * Critical for preventing contradictory proposals:
 * - If agency says "BWC exempt", add BWC_EXEMPT constraint
 * - If agency says "fee required", add FEE_REQUIRED constraint
 * - Update scope item statuses based on response
 */
async function updateConstraintsNode(state) {
  const { caseId, classification, extractedFeeAmount, constraints, scopeItems } = state;

  const newConstraints = [...constraints];
  const updatedScopeItems = [...scopeItems];
  const logs = [];

  try {
    // Fetch latest analysis for detailed constraint extraction
    const caseData = await db.getCaseById(caseId);
    const latestAnalysis = await db.getLatestResponseAnalysis(caseId);

    // Extract constraints from analysis key points
    if (latestAnalysis?.key_points) {
      for (const point of latestAnalysis.key_points) {
        const pointLower = point.toLowerCase();

        // BWC exemption detection
        if (pointLower.includes('body camera') || pointLower.includes('bwc')) {
          if (pointLower.includes('exempt') || pointLower.includes('not available') ||
              pointLower.includes('cannot provide') || pointLower.includes('withheld')) {
            if (!newConstraints.includes('BWC_EXEMPT')) {
              newConstraints.push('BWC_EXEMPT');
              logs.push('Added constraint: BWC_EXEMPT (agency indicated body camera footage unavailable)');

              // Update scope item status
              const bwcItem = updatedScopeItems.find(s =>
                s.item.toLowerCase().includes('body') || s.item.toLowerCase().includes('bwc')
              );
              if (bwcItem) {
                bwcItem.status = 'EXEMPT';
                bwcItem.reason = point;
              }
            }
          }
        }

        // Fee requirement detection
        if (pointLower.includes('fee') || pointLower.includes('cost') || pointLower.includes('payment')) {
          if (!newConstraints.includes('FEE_REQUIRED') && extractedFeeAmount > 0) {
            newConstraints.push('FEE_REQUIRED');
            logs.push(`Added constraint: FEE_REQUIRED (amount: $${extractedFeeAmount})`);
          }
        }

        // ID requirement detection
        if (pointLower.includes('identification') || pointLower.includes('verify identity') ||
            pointLower.includes('proof of') || pointLower.includes('notarized')) {
          if (!newConstraints.includes('ID_REQUIRED')) {
            newConstraints.push('ID_REQUIRED');
            logs.push('Added constraint: ID_REQUIRED (agency requires identity verification)');
          }
        }

        // Ongoing investigation detection
        if (pointLower.includes('ongoing investigation') || pointLower.includes('active case') ||
            pointLower.includes('pending litigation')) {
          if (!newConstraints.includes('INVESTIGATION_ACTIVE')) {
            newConstraints.push('INVESTIGATION_ACTIVE');
            logs.push('Added constraint: INVESTIGATION_ACTIVE');
          }
        }
      }
    }

    // Handle denial classifications
    if (classification === 'DENIAL') {
      if (!newConstraints.includes('DENIAL_RECEIVED')) {
        newConstraints.push('DENIAL_RECEIVED');
        logs.push('Added constraint: DENIAL_RECEIVED');
      }
    }

    // Persist updated constraints to DB
    if (newConstraints.length !== constraints.length) {
      await db.updateCase(caseId, {
        constraints: newConstraints,
        scope_items: updatedScopeItems
      });
    }

    return {
      constraints: newConstraints,
      scopeItems: updatedScopeItems,
      logs: logs.length > 0 ? logs : ['No constraint updates needed']
    };
  } catch (error) {
    logger.error('update_constraints_node error', { caseId, error: error.message });
    return {
      errors: [`Failed to update constraints: ${error.message}`]
    };
  }
}

module.exports = { updateConstraintsNode };
```

### 3.4 Decide Next Action Node (Router)

**File:** `langgraph/nodes/decide-next-action.js`

```javascript
const { Command } = require("@langchain/langgraph");
const db = require('../../services/database');
const logger = require('../../utils/logger');

// Fee threshold from env
const FEE_AUTO_APPROVE_MAX = parseFloat(process.env.FEE_AUTO_APPROVE_MAX) || 100;

/**
 * Decide what action to take next
 *
 * Uses DETERMINISTIC rules first, then LLM for complex cases
 * Returns Command with goto for routing
 */
async function decideNextActionNode(state) {
  const {
    caseId, classification, extractedFeeAmount, sentiment,
    constraints, triggerType, autopilotMode, loopCount,
    humanDecision
  } = state;

  const logs = [];
  const reasoning = [];

  try {
    // === Handle human resume first ===
    if (humanDecision) {
      logs.push(`Processing human decision: ${humanDecision.action}`);

      switch (humanDecision.action) {
        case 'APPROVE':
          reasoning.push('Human approved the proposal');
          return {
            proposalActionType: state.proposalActionType,  // Keep existing
            canAutoExecute: true,  // Now approved for execution
            requiresHuman: false,
            logs,
            proposalReasoning: reasoning,
            nextNode: 'execute_action'
          };

        case 'ADJUST':
          reasoning.push(`Human requested adjustment: ${humanDecision.instruction}`);
          return {
            proposalReasoning: reasoning,
            logs: [...logs, 'Re-drafting with adjustment instruction'],
            nextNode: 'draft_response'
          };

        case 'DISMISS':
          reasoning.push('Human dismissed proposal, will generate new one');
          return {
            proposalId: null,
            draftSubject: null,
            draftBodyText: null,
            draftBodyHtml: null,
            proposalReasoning: [],
            logs: [...logs, 'Proposal dismissed, generating new action'],
            // Continue to re-evaluate
          };

        case 'WITHDRAW':
          reasoning.push('Human chose to withdraw/close the request');
          await db.updateCaseStatus(caseId, 'cancelled', {
            substatus: 'withdrawn_by_user'
          });
          return {
            isComplete: true,
            logs: [...logs, 'Request withdrawn by user'],
            proposalReasoning: reasoning
          };
      }
    }

    // === Deterministic routing based on classification ===

    // 1. FEE QUOTE handling
    if (classification === 'FEE_QUOTE' && extractedFeeAmount) {
      reasoning.push(`Fee quote received: $${extractedFeeAmount}`);

      if (extractedFeeAmount <= FEE_AUTO_APPROVE_MAX && autopilotMode === 'AUTO') {
        reasoning.push(`Fee under threshold ($${FEE_AUTO_APPROVE_MAX}), auto-approving`);
        return {
          proposalActionType: 'APPROVE_FEE',
          canAutoExecute: true,
          requiresHuman: false,
          pauseReason: null,
          proposalReasoning: reasoning,
          logs: [...logs, `Auto-approving fee: $${extractedFeeAmount}`],
          nextNode: 'draft_response'
        };
      } else {
        reasoning.push(`Fee exceeds threshold or requires supervision, gating for human approval`);
        return {
          proposalActionType: 'APPROVE_FEE',
          canAutoExecute: false,
          requiresHuman: true,
          pauseReason: 'FEE_QUOTE',
          proposalReasoning: reasoning,
          logs: [...logs, `Gating fee approval: $${extractedFeeAmount}`],
          nextNode: 'draft_response'
        };
      }
    }

    // 2. DENIAL handling
    if (classification === 'DENIAL') {
      reasoning.push('Denial received from agency');

      // Check if denial is challengeable
      const caseData = await db.getCaseById(caseId);
      const denialStrength = await assessDenialStrength(caseData);
      reasoning.push(`Denial strength assessed as: ${denialStrength}`);

      if (denialStrength === 'weak' && autopilotMode === 'AUTO') {
        reasoning.push('Weak denial, preparing rebuttal');
        return {
          proposalActionType: 'SEND_REBUTTAL',
          canAutoExecute: true,
          requiresHuman: false,
          proposalReasoning: reasoning,
          logs: [...logs, 'Drafting rebuttal for weak denial'],
          nextNode: 'draft_response'
        };
      } else {
        reasoning.push('Strong/medium denial or supervised mode, gating for human review');
        return {
          proposalActionType: 'SEND_REBUTTAL',
          canAutoExecute: false,
          requiresHuman: true,
          pauseReason: 'DENIAL',
          proposalReasoning: reasoning,
          logs: [...logs, 'Gating denial response for human review'],
          nextNode: 'draft_response'
        };
      }
    }

    // 3. CLARIFICATION REQUEST handling
    if (classification === 'CLARIFICATION_REQUEST') {
      reasoning.push('Agency requested clarification/more info');

      const canAuto = autopilotMode === 'AUTO' && sentiment !== 'hostile';
      return {
        proposalActionType: 'SEND_CLARIFICATION',
        canAutoExecute: canAuto,
        requiresHuman: !canAuto,
        pauseReason: canAuto ? null : 'SCOPE',
        proposalReasoning: reasoning,
        logs: [...logs, `Preparing clarification response (auto=${canAuto})`],
        nextNode: 'draft_response'
      };
    }

    // 4. RECORDS_READY / ACKNOWLEDGMENT - positive outcomes
    if (classification === 'RECORDS_READY') {
      reasoning.push('Records are ready for pickup/download');
      await db.updateCaseStatus(caseId, 'completed', { substatus: 'records_received' });
      return {
        isComplete: true,
        proposalReasoning: reasoning,
        logs: [...logs, 'Case completed: records ready']
      };
    }

    if (classification === 'ACKNOWLEDGMENT') {
      reasoning.push('Acknowledgment received, no action needed');
      return {
        isComplete: true,
        proposalReasoning: reasoning,
        logs: [...logs, 'Acknowledgment received, waiting for next response']
      };
    }

    // 5. NO_RESPONSE - time-based follow-up
    if (classification === 'NO_RESPONSE' || triggerType === 'time_based_followup') {
      reasoning.push('No response from agency, preparing follow-up');

      const followupSchedule = await db.getFollowUpScheduleByCaseId(caseId);
      const followupCount = followupSchedule?.followup_count || 0;
      const maxFollowups = parseInt(process.env.MAX_FOLLOWUPS) || 2;

      if (followupCount >= maxFollowups) {
        reasoning.push(`Max follow-ups reached (${followupCount}/${maxFollowups}), escalating`);
        return {
          proposalActionType: 'ESCALATE',
          canAutoExecute: true,
          requiresHuman: true,
          pauseReason: 'CLOSE_ACTION',
          proposalReasoning: reasoning,
          logs: [...logs, 'Max follow-ups reached, escalating'],
          nextNode: 'escalate'
        };
      }

      const canAuto = autopilotMode === 'AUTO';
      return {
        proposalActionType: 'SEND_FOLLOWUP',
        canAutoExecute: canAuto,
        requiresHuman: !canAuto,
        proposalReasoning: reasoning,
        logs: [...logs, `Preparing follow-up #${followupCount + 1}`],
        nextNode: 'draft_response'
      };
    }

    // 6. UNKNOWN or hostile sentiment - always gate
    if (classification === 'UNKNOWN' || sentiment === 'hostile') {
      reasoning.push('Uncertain classification or hostile sentiment, escalating to human');
      return {
        proposalActionType: 'ESCALATE',
        canAutoExecute: false,
        requiresHuman: true,
        pauseReason: 'SENSITIVE',
        proposalReasoning: reasoning,
        logs: [...logs, 'Escalating uncertain/hostile case'],
        nextNode: 'escalate'
      };
    }

    // Default: No action needed
    reasoning.push('No action required at this time');
    return {
      proposalActionType: 'NONE',
      isComplete: true,
      proposalReasoning: reasoning,
      logs: [...logs, 'No action needed']
    };

  } catch (error) {
    logger.error('decide_next_action_node error', { caseId, error: error.message });
    return {
      errors: [`Decision failed: ${error.message}`],
      proposalActionType: 'ESCALATE',
      requiresHuman: true,
      pauseReason: 'SENSITIVE'
    };
  }
}

/**
 * Assess how strong a denial is (simplified version)
 */
async function assessDenialStrength(caseData) {
  // This would use AI analysis in production
  // Simplified: check if denial mentions specific exemptions
  const latestAnalysis = await db.getLatestResponseAnalysis(caseData.id);
  const keyPoints = latestAnalysis?.key_points || [];

  const strongIndicators = [
    'exemption', 'statute', 'law enforcement', 'ongoing investigation',
    'privacy', 'confidential', 'sealed'
  ];

  const strongCount = keyPoints.filter(p =>
    strongIndicators.some(ind => p.toLowerCase().includes(ind))
  ).length;

  if (strongCount >= 2) return 'strong';
  if (strongCount === 1) return 'medium';
  return 'weak';
}

module.exports = { decideNextActionNode };
```

### 3.5 Draft Response Node

**File:** `langgraph/nodes/draft-response.js`

```javascript
const aiService = require('../../services/ai-service');
const db = require('../../services/database');
const logger = require('../../utils/logger');

/**
 * Draft the appropriate response based on proposalActionType
 *
 * Handles: SEND_FOLLOWUP, SEND_REBUTTAL, SEND_CLARIFICATION, APPROVE_FEE
 */
async function draftResponseNode(state) {
  const {
    caseId, proposalActionType, humanDecision, constraints, scopeItems,
    extractedFeeAmount
  } = state;

  const logs = [];

  try {
    const caseData = await db.getCaseById(caseId);
    const messages = await db.getMessagesByCaseId(caseId);
    const latestInbound = messages.filter(m => m.direction === 'inbound').pop();
    const latestAnalysis = latestInbound ?
      await db.getResponseAnalysisByMessageId(latestInbound.id) : null;

    let draft = { subject: null, body_text: null, body_html: null };

    // Check for adjustment instruction
    const adjustmentInstruction = humanDecision?.action === 'ADJUST' ?
      humanDecision.instruction : null;

    switch (proposalActionType) {
      case 'SEND_FOLLOWUP': {
        const followupSchedule = await db.getFollowUpScheduleByCaseId(caseId);
        const attemptNumber = (followupSchedule?.followup_count || 0) + 1;

        logs.push(`Drafting follow-up #${attemptNumber}`);
        draft = await aiService.generateFollowUp(caseData, attemptNumber, {
          adjustmentInstruction
        });
        break;
      }

      case 'SEND_REBUTTAL': {
        logs.push('Drafting denial rebuttal with legal research');

        // Validate against constraints - don't request exempt items
        const exemptItems = constraints.filter(c => c.endsWith('_EXEMPT'));

        draft = await aiService.generateDenialRebuttal(
          latestInbound,
          latestAnalysis,
          caseData,
          {
            excludeItems: exemptItems,
            scopeItems,
            adjustmentInstruction
          }
        );
        break;
      }

      case 'SEND_CLARIFICATION': {
        logs.push('Drafting clarification response');
        draft = await aiService.generateClarificationResponse(
          latestInbound,
          latestAnalysis,
          caseData,
          {
            adjustmentInstruction
          }
        );
        break;
      }

      case 'APPROVE_FEE': {
        logs.push(`Drafting fee acceptance for $${extractedFeeAmount}`);
        draft = await aiService.generateFeeAcceptance(
          caseData,
          extractedFeeAmount,
          {
            adjustmentInstruction
          }
        );
        break;
      }

      default:
        logs.push(`Unknown action type: ${proposalActionType}`);
        return {
          errors: [`Unknown proposal action type: ${proposalActionType}`],
          logs
        };
    }

    return {
      draftSubject: draft.subject,
      draftBodyText: draft.body_text,
      draftBodyHtml: draft.body_html,
      logs: [...logs, `Draft created: "${draft.subject?.substring(0, 50)}..."`]
    };

  } catch (error) {
    logger.error('draft_response_node error', { caseId, error: error.message });
    return {
      errors: [`Draft failed: ${error.message}`],
      logs
    };
  }
}

module.exports = { draftResponseNode };
```

### 3.6 Safety Check Node

**File:** `langgraph/nodes/safety-check.js`

```javascript
const logger = require('../../utils/logger');

/**
 * Validate draft against constraints
 *
 * CRITICAL: Prevents sending contradictory requests
 * Example: Don't request BWC if agency already said it's exempt
 */
async function safetyCheckNode(state) {
  const {
    caseId, draftSubject, draftBodyText, constraints, scopeItems,
    proposalActionType
  } = state;

  const logs = [];
  const riskFlags = [];
  const warnings = [];

  if (!draftBodyText) {
    return {
      riskFlags: ['NO_DRAFT'],
      logs: ['Safety check skipped: no draft to validate']
    };
  }

  const draftLower = draftBodyText.toLowerCase();

  // === Constraint Violations ===

  // Check for BWC requests when exempt
  if (constraints.includes('BWC_EXEMPT')) {
    if (draftLower.includes('body camera') || draftLower.includes('bwc') ||
        draftLower.includes('body worn')) {
      // Only flag if we're requesting it, not acknowledging exemption
      if (!draftLower.includes('understand') && !draftLower.includes('acknowledge')) {
        riskFlags.push('REQUESTS_EXEMPT_ITEM');
        warnings.push('Draft requests body camera footage that agency has marked as exempt');
        logs.push('WARNING: Draft requests BWC despite BWC_EXEMPT constraint');
      }
    }
  }

  // Check for fee negotiation when already accepted
  if (constraints.includes('FEE_ACCEPTED')) {
    if (draftLower.includes('negotiate') || draftLower.includes('reduce') ||
        draftLower.includes('waive')) {
      riskFlags.push('CONTRADICTS_FEE_ACCEPTANCE');
      warnings.push('Draft attempts to negotiate fee after already accepting');
      logs.push('WARNING: Draft tries to negotiate already-accepted fee');
    }
  }

  // Check for requesting items marked as delivered
  const deliveredItems = scopeItems.filter(s => s.status === 'DELIVERED');
  for (const item of deliveredItems) {
    if (draftLower.includes(item.item.toLowerCase())) {
      // Check context - is it acknowledging receipt or re-requesting?
      if (!draftLower.includes('received') && !draftLower.includes('thank')) {
        warnings.push(`Draft may be re-requesting already-delivered item: ${item.item}`);
        logs.push(`NOTE: Draft mentions delivered item "${item.item}"`);
      }
    }
  }

  // === Tone/Content Checks ===

  // Check for aggressive language
  const aggressiveTerms = ['demand', 'lawsuit', 'attorney', 'legal action', 'violation'];
  const aggressiveFound = aggressiveTerms.filter(t => draftLower.includes(t));
  if (aggressiveFound.length > 0 && proposalActionType !== 'SEND_REBUTTAL') {
    warnings.push(`Draft contains potentially aggressive language: ${aggressiveFound.join(', ')}`);
    logs.push(`NOTE: Aggressive terms found: ${aggressiveFound.join(', ')}`);
  }

  // Check for PII in draft (basic check)
  const ssnPattern = /\d{3}-\d{2}-\d{4}/;
  if (ssnPattern.test(draftBodyText)) {
    riskFlags.push('CONTAINS_PII');
    warnings.push('Draft may contain SSN - review before sending');
    logs.push('WARNING: Possible SSN detected in draft');
  }

  // === Determine if safe to proceed ===
  const hasCriticalRisk = riskFlags.some(f =>
    ['REQUESTS_EXEMPT_ITEM', 'CONTRADICTS_FEE_ACCEPTANCE', 'CONTAINS_PII'].includes(f)
  );

  if (hasCriticalRisk) {
    logs.push('Safety check FAILED - critical risk flags');
    return {
      riskFlags,
      warnings,
      canAutoExecute: false,  // Force human review
      requiresHuman: true,
      pauseReason: 'SENSITIVE',
      logs
    };
  }

  logs.push(`Safety check passed (${warnings.length} warnings)`);
  return {
    riskFlags,
    warnings,
    logs
  };
}

module.exports = { safetyCheckNode };
```

### 3.7 Gate or Execute Node (with Interrupt)

**File:** `langgraph/nodes/gate-or-execute.js`

```javascript
const { interrupt } = require("@langchain/langgraph");
const db = require('../../services/database');
const logger = require('../../utils/logger');

/**
 * Generate deterministic proposal key for idempotency
 * P0 FIX #2: Allows safe re-runs without duplicate proposals
 */
function generateProposalKey(state) {
  const {
    caseId, latestInboundMessageId, proposalActionType,
    humanDecision
  } = state;

  // Include adjustment count to allow re-drafts after human adjustment
  const adjustmentCount = humanDecision?.action === 'ADJUST' ?
    (state.adjustmentCount || 0) + 1 : 0;

  // Format: {case}:{message}:{action}:{attempt}
  return `${caseId}:${latestInboundMessageId || 'scheduled'}:${proposalActionType}:${adjustmentCount}`;
}

/**
 * Gate for human approval OR execute automatically
 *
 * P0 FIX #2: CRITICAL RULES FOR INTERRUPTS
 * 1. NO try/catch around interrupt()
 * 2. All side effects before interrupt() MUST be idempotent
 * 3. Use upsert with proposal_key for proposal creation
 *
 * Uses LangGraph interrupt() for human-in-the-loop
 */
async function gateOrExecuteNode(state) {
  const {
    caseId, proposalActionType, canAutoExecute, requiresHuman,
    pauseReason, draftSubject, draftBodyText, draftBodyHtml,
    proposalReasoning, proposalConfidence, riskFlags, warnings,
    gateOptions
  } = state;

  const logs = [];

  // P0 FIX #2: Generate deterministic key for idempotent upsert
  const proposalKey = generateProposalKey(state);

  // P0 FIX #2: IDEMPOTENT proposal creation (upsert, not insert)
  // This is SAFE to re-run on resume because of ON CONFLICT
  const proposal = await db.upsertProposal({
    proposalKey,  // Unique key for idempotency
    caseId,
    triggerMessageId: state.latestInboundMessageId,
    actionType: proposalActionType,
    draftSubject,
    draftBodyText,
    draftBodyHtml,
    reasoning: proposalReasoning,
    confidence: proposalConfidence || 0.8,
    riskFlags,
    warnings,
    canAutoExecute,
    requiresHuman,
    status: canAutoExecute ? 'APPROVED' : 'PENDING_APPROVAL',
    langgraphThreadId: state.threadId,
    adjustmentCount: state.adjustmentCount || 0
  });

  logs.push(`Upserted proposal ${proposal.id} (key: ${proposalKey})`);

  // === AUTO EXECUTE PATH ===
  if (canAutoExecute && !requiresHuman) {
    logs.push('Auto-executing approved action');
    return {
      proposalId: proposal.id,
      proposalKey,
      logs,
      nextNode: 'execute_action'
    };
  }

  // === HUMAN GATE PATH ===
  logs.push(`Gating for human approval (reason: ${pauseReason})`);

  // P0 FIX #2: IDEMPOTENT status update (safe to re-run)
  // This uses an upsert pattern - running twice has same effect as once
  await db.updateCaseStatus(caseId, 'needs_human_review', {
    requires_human: true,
    pause_reason: pauseReason
  });

  // P0 FIX #2: CRITICAL - NO try/catch around interrupt()
  // The interrupt() call MUST NOT be wrapped in try/catch
  // When resumed, this entire node function reruns from the TOP
  // That's why all operations above MUST be idempotent

  const decision = interrupt({
    type: 'HUMAN_APPROVAL',
    requestId: caseId,
    proposalId: proposal.id,
    proposalKey,
    proposalActionType,
    pauseReason,
    options: gateOptions,
    summary: {
      subject: draftSubject,
      reasoning: proposalReasoning,
      riskFlags,
      warnings
    }
  });

  // This code runs AFTER resume - decision contains the human's choice
  // The node re-ran from the top, so proposal was re-upserted (idempotent)
  return {
    proposalId: proposal.id,
    proposalKey,
    humanDecision: decision,
    adjustmentCount: decision?.action === 'ADJUST' ?
      (state.adjustmentCount || 0) + 1 : state.adjustmentCount,
    logs: [...logs, `Human decision received: ${decision?.action}`],
    nextNode: 'decide_next_action'  // Re-route based on decision
  };

  // P0 FIX #2: NO catch block - errors should propagate up
  // The graph handles errors at a higher level
}

module.exports = { gateOrExecuteNode };
```

### 3.8 Execute Action Node

**File:** `langgraph/nodes/execute-action.js`

```javascript
const db = require('../../services/database');
const { getEmailQueue } = require('../../queues/email-queue');
const logger = require('../../utils/logger');
const crypto = require('crypto');

/**
 * Generate deterministic execution key
 * P0 FIX #3: Used to prevent duplicate executions
 */
function generateExecutionKey(proposalId, proposalKey) {
  return `exec:${proposalKey}:${Date.now()}`;
}

/**
 * Execute the approved action
 *
 * P0 FIX #3: IDEMPOTENT EXECUTION
 * - Check if already executed before doing anything
 * - Use execution_key to prevent duplicate sends
 * - Store email_job_id to track what was queued
 *
 * Handles: send_email, schedule_followup, update_status
 */
async function executeActionNode(state) {
  const {
    caseId, proposalId, proposalKey, proposalActionType,
    draftSubject, draftBodyText, draftBodyHtml
  } = state;

  const logs = [];
  let executionResult = null;

  // P0 FIX #3: IDEMPOTENCY CHECK - Already executed?
  const existingProposal = await db.getProposalById(proposalId);

  if (existingProposal?.status === 'EXECUTED') {
    logs.push(`SKIPPED: Proposal ${proposalId} already executed`);
    return {
      actionExecuted: true,  // Already done
      executionResult: {
        action: 'already_executed',
        emailJobId: existingProposal.email_job_id
      },
      logs
    };
  }

  if (existingProposal?.execution_key) {
    logs.push(`SKIPPED: Proposal ${proposalId} has execution_key (in progress or done)`);
    return {
      actionExecuted: true,
      executionResult: { action: 'execution_in_progress' },
      logs
    };
  }

  // P0 FIX #3: Claim execution with a key BEFORE doing anything
  // This prevents race conditions if node runs twice
  const executionKey = generateExecutionKey(proposalId, proposalKey);

  const claimed = await db.claimProposalExecution(proposalId, executionKey);
  if (!claimed) {
    logs.push(`SKIPPED: Could not claim execution for proposal ${proposalId}`);
    return {
      actionExecuted: false,
      executionResult: { action: 'claim_failed' },
      logs
    };
  }

  logs.push(`Claimed execution with key: ${executionKey}`);

  const caseData = await db.getCaseById(caseId);
  const emailQueue = getEmailQueue();

  // === Portal check - NEVER send email to portal cases ===
  if (caseData.portal_url && proposalActionType.startsWith('SEND_')) {
    logs.push('BLOCKED: Cannot send email to portal-based case');
    // Mark as executed but with error (don't retry)
    await db.updateProposal(proposalId, {
      status: 'EXECUTED',
      executedAt: new Date()
    });
    return {
      errors: ['Email blocked: case uses portal submission'],
      actionExecuted: false,
      logs
    };
  }

  switch (proposalActionType) {
    case 'SEND_FOLLOWUP':
    case 'SEND_REBUTTAL':
    case 'SEND_CLARIFICATION':
    case 'APPROVE_FEE': {
      // Get thread for proper email threading
      const thread = await db.getThreadByCaseId(caseId);
      const latestInbound = await db.getLatestInboundMessage(caseId);

      // Calculate human-like delay (2-10 hours)
      const delayMinutes = Math.floor(Math.random() * 480) + 120;

      // P0 FIX #3: Use execution_key as job ID for idempotency
      // BullMQ will dedupe if job with same ID exists
      const job = await emailQueue.add('send-email', {
        caseId,
        proposalId,
        executionKey,  // Include for tracing
        to: caseData.agency_email,
        subject: draftSubject,
        bodyText: draftBodyText,
        bodyHtml: draftBodyHtml,
        messageType: proposalActionType.toLowerCase().replace('send_', ''),
        originalMessageId: latestInbound?.message_id,
        threadId: thread?.id
      }, {
        delay: delayMinutes * 60 * 1000,
        jobId: executionKey  // P0 FIX: Dedupe by execution key
      });

      executionResult = {
        action: 'email_queued',
        jobId: job.id,
        executionKey,
        scheduledFor: new Date(Date.now() + delayMinutes * 60 * 1000).toISOString(),
        delayMinutes
      };

      logs.push(`Email queued (job ${job.id}), scheduled in ${delayMinutes} minutes`);

      // P0 FIX #3: Store job ID on proposal for tracking
      await db.updateProposal(proposalId, {
        status: 'EXECUTED',
        executedAt: new Date(),
        emailJobId: job.id
      });

      // Schedule next follow-up if this was a follow-up
      if (proposalActionType === 'SEND_FOLLOWUP') {
        const followupDays = parseInt(process.env.FOLLOWUP_DELAY_DAYS) || 7;
        const nextDate = new Date();
        nextDate.setDate(nextDate.getDate() + followupDays);

        await db.upsertFollowUpSchedule(caseId, {
          nextFollowupDate: nextDate,
          lastFollowupSentAt: new Date()
        });

        logs.push(`Next follow-up scheduled for ${nextDate.toISOString()}`);
      }

      // Update case status
      await db.updateCaseStatus(caseId, 'awaiting_response', {
        requires_human: false,
        pause_reason: null
      });

      break;
    }

    case 'ESCALATE': {
      // P0 FIX #3: Idempotent escalation (upsert by case + reason)
      const escalation = await db.upsertEscalation({
        caseId,
        executionKey,  // Unique per execution attempt
        reason: state.proposalReasoning?.join('; ') || 'Escalated by agent',
        urgency: 'medium',
        suggestedAction: 'Review case and decide next steps'
      });

      // Only notify if this is a new escalation
      if (escalation.wasInserted) {
        const discordService = require('../../services/discord-service');
        await discordService.sendCaseEscalation(caseData, escalation);
      }

      executionResult = {
        action: 'escalated',
        escalationId: escalation.id,
        wasNew: escalation.wasInserted
      };

      await db.updateProposal(proposalId, {
        status: 'EXECUTED',
        executedAt: new Date()
      });

      logs.push(`Case escalated (escalation ${escalation.id}, new=${escalation.wasInserted})`);
      break;
    }

    case 'NONE': {
      executionResult = { action: 'none' };
      await db.updateProposal(proposalId, {
        status: 'EXECUTED',
        executedAt: new Date()
      });
      logs.push('No action executed');
      break;
    }

    default:
      logs.push(`Unknown action type: ${proposalActionType}`);
      return {
        errors: [`Unknown action type: ${proposalActionType}`],
        actionExecuted: false,
        logs
      };
  }

  // Log activity (idempotent - activity log allows duplicates, that's fine)
  await db.logActivity('agent_action_executed', `Executed ${proposalActionType}`, {
    caseId,
    proposalId,
    executionKey,
    result: executionResult
  });

  return {
    actionExecuted: true,
    executionResult,
    logs
  };
}

module.exports = { executeActionNode };
```

### 3.9 Commit State Node

**File:** `langgraph/nodes/commit-state.js`

```javascript
const db = require('../../services/database');
const logger = require('../../utils/logger');

/**
 * Finalize state after action execution
 *
 * - Recompute due_info
 * - Update next_due_at
 * - Clear gates if resolved
 * - Log decision for learning
 */
async function commitStateNode(state) {
  const {
    caseId, proposalActionType, proposalReasoning, proposalConfidence,
    actionExecuted, executionResult
  } = state;

  const logs = [];

  try {
    const caseData = await db.getCaseById(caseId);

    // === Recompute due_info ===
    const dueInfo = await computeDueInfo(caseData);

    await db.updateCase(caseId, {
      next_due_at: dueInfo.next_due_at,
      updated_at: new Date()
    });

    logs.push(`Updated next_due_at: ${dueInfo.next_due_at || 'none'}`);

    // === Log decision for adaptive learning ===
    await db.createAgentDecision({
      caseId,
      reasoning: proposalReasoning?.join('\n') || 'No reasoning recorded',
      actionTaken: proposalActionType,
      confidence: proposalConfidence || 0.8,
      triggerType: state.triggerType,
      outcome: actionExecuted ? 'executed' : 'gated'
    });

    logs.push('Decision logged for learning');

    // === Log timeline event ===
    await db.logActivity('agent_decision',
      `Agent decided: ${proposalActionType}`, {
        caseId,
        reasoning: proposalReasoning,
        executed: actionExecuted,
        result: executionResult
      }
    );

    return {
      isComplete: true,
      logs
    };

  } catch (error) {
    logger.error('commit_state_node error', { caseId, error: error.message });
    return {
      errors: [`Commit failed: ${error.message}`],
      isComplete: true,  // Still mark complete to exit
      logs
    };
  }
}

/**
 * Compute next due date based on case state
 */
async function computeDueInfo(caseData) {
  const { id, status, send_date, state: caseState } = caseData;

  // Get statutory deadline (varies by state)
  const statutoryDays = getStatutoryDays(caseState);

  // Check for scheduled follow-up
  const followup = await db.getFollowUpScheduleByCaseId(id);

  let next_due_at = null;
  let due_type = null;

  if (followup?.next_followup_date) {
    next_due_at = followup.next_followup_date;
    due_type = 'FOLLOWUP';
  } else if (send_date && statutoryDays) {
    // Calculate statutory deadline
    const deadline = new Date(send_date);
    deadline.setDate(deadline.getDate() + statutoryDays);
    next_due_at = deadline;
    due_type = 'STATUTORY';
  }

  return {
    next_due_at,
    due_type,
    statutory_days: statutoryDays
  };
}

/**
 * Get statutory response days by state
 */
function getStatutoryDays(state) {
  const stateDays = {
    'CA': 10,
    'TX': 10,
    'NY': 5,
    'FL': 14,
    // Add more states...
    'DEFAULT': 10
  };
  return stateDays[state] || stateDays['DEFAULT'];
}

module.exports = { commitStateNode };
```

---

## Phase 4: Graph Definition

### 4.1 Main Graph

**File:** `langgraph/graph/foia-case-graph.js`

```javascript
const { StateGraph, START, END } = require("@langchain/langgraph");
const { RedisSaver } = require("@langchain/langgraph-checkpoint-redis");
const Redis = require("ioredis");

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

const logger = require("../../utils/logger");

// Max iterations to prevent runaway
const MAX_ITERATIONS = parseInt(process.env.LANGGRAPH_MAX_ITERATIONS) || 5;

/**
 * Create the FOIA Case Graph
 */
function createFOIACaseGraph() {
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
      "escalate": "gate_or_execute",
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
      "decide_next_action": "decide_next_action",  // After human resume
      "end": END
    }
  );

  // Execute Action → Commit State
  graph.addEdge("execute_action", "commit_state");

  // Commit State → End
  graph.addEdge("commit_state", END);

  return graph.compile();
}

/**
 * Route based on decision node output
 */
function routeFromDecision(state) {
  const { isComplete, nextNode, proposalActionType, loopCount } = state;

  // Check loop limit
  if (loopCount >= MAX_ITERATIONS) {
    logger.warn(`Max iterations (${MAX_ITERATIONS}) reached for case ${state.caseId}`);
    return "end";
  }

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
    return "escalate";
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
 * Create checkpointer based on config
 * CRITICAL (P0 fix #1): Checkpointer is passed at compile time, NOT invoke time
 */
async function createCheckpointer() {
  const checkpointerType = process.env.LANGGRAPH_CHECKPOINTER || 'redis';

  if (checkpointerType === 'redis') {
    const redis = new Redis(process.env.REDIS_URL);
    return new RedisSaver({ client: redis });
  }

  // Fallback to memory (not recommended for production)
  const { MemorySaver } = require("@langchain/langgraph");
  return new MemorySaver();
}

/**
 * Get compiled graph with checkpointer
 * P0 FIX #1: Checkpointer is passed at COMPILE time via graph.compile({ checkpointer })
 */
let _compiledGraph = null;

async function getCompiledGraph() {
  if (!_compiledGraph) {
    const checkpointer = await createCheckpointer();
    const builder = createFOIACaseGraphBuilder();
    // CORRECT: Pass checkpointer at compile time
    _compiledGraph = builder.compile({ checkpointer });
  }
  return _compiledGraph;
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

  // === Add Edges (same as before) ===
  graph.addEdge(START, "load_context");
  graph.addEdge("load_context", "classify_inbound");
  graph.addEdge("classify_inbound", "update_constraints");
  graph.addEdge("update_constraints", "decide_next_action");

  graph.addConditionalEdges(
    "decide_next_action",
    routeFromDecision,
    {
      "draft_response": "draft_response",
      "execute_action": "execute_action",
      "escalate": "gate_or_execute",
      "end": END
    }
  );

  graph.addEdge("draft_response", "safety_check");
  graph.addEdge("safety_check", "gate_or_execute");

  graph.addConditionalEdges(
    "gate_or_execute",
    routeFromGate,
    {
      "execute_action": "execute_action",
      "decide_next_action": "decide_next_action",
      "end": END
    }
  );

  graph.addEdge("execute_action", "commit_state");
  graph.addEdge("commit_state", END);

  return graph;  // Return builder, not compiled
}

/**
 * Acquire advisory lock for case (P0 fix #4: Concurrency control)
 */
async function acquireCaseLock(caseId) {
  const db = require('../../services/database');
  const lockKey = Math.abs(hashCode(`case:${caseId}`)) % 2147483647;
  await db.query('SELECT pg_advisory_lock($1)', [lockKey]);
  return lockKey;
}

async function releaseCaseLock(lockKey) {
  const db = require('../../services/database');
  await db.query('SELECT pg_advisory_unlock($1)', [lockKey]);
}

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
 * Invoke the graph for a case
 * P0 FIX #1: Only pass thread_id at invoke time (checkpointer already in compiled graph)
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
    const result = await graph.invoke(initialState, config);

    // P0 FIX #5: Use __interrupt__ from result (not getState)
    if (result.__interrupt__) {
      logger.info(`Graph interrupted for case ${caseId}`, {
        interruptValue: result.__interrupt__
      });

      return {
        status: 'interrupted',
        interruptData: result.__interrupt__,
        threadId
      };
    }

    return {
      status: 'completed',
      result,
      threadId
    };

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

    // Resume with the human decision
    const { Command } = require("@langchain/langgraph");
    const result = await graph.invoke(
      new Command({ resume: humanDecision }),
      config
    );

    // P0 FIX #5: Use __interrupt__ from result
    if (result.__interrupt__) {
      return {
        status: 'interrupted',
        interruptData: result.__interrupt__,
        threadId
      };
    }

    return {
      status: 'completed',
      result,
      threadId
    };

  } finally {
    await releaseCaseLock(lockKey);
  }
}

module.exports = {
  createFOIACaseGraphBuilder,  // Returns builder, compile with checkpointer
  getCompiledGraph,            // Returns compiled graph (singleton)
  invokeFOIACaseGraph,         // Run graph for a case
  resumeFOIACaseGraph,         // Resume after human decision
  createInitialState           // Create initial state for a case
};
```

---

## Phase 5: Queue Integration

### 5.1 New Agent Queue Jobs

**File:** `queues/email-queue.js` (modify - add new job types)

Add these job handlers to the existing file:

```javascript
// === ADD TO EXISTING email-queue.js ===

const { invokeFOIACaseGraph, resumeFOIACaseGraph } = require('../langgraph');
const USE_LANGGRAPH = process.env.USE_LANGGRAPH === 'true';

// Add new queue for agent jobs
const agentQueue = new Queue('agent', { connection });

// Agent Worker
const agentWorker = new Worker('agent', async (job) => {
  const { type, caseId, triggerType, humanDecision, options } = job.data;

  logger.info(`Agent job started: ${type}`, { caseId, triggerType });

  try {
    switch (type) {
      case 'run_on_inbound': {
        if (USE_LANGGRAPH) {
          return await invokeFOIACaseGraph(caseId, 'agency_reply', options);
        } else {
          // Fallback to old agent
          return await foiaCaseAgent.handleCase(caseId, { type: 'agency_reply' });
        }
      }

      case 'run_on_schedule': {
        if (USE_LANGGRAPH) {
          return await invokeFOIACaseGraph(caseId, 'time_based_followup', options);
        } else {
          return await foiaCaseAgent.handleCase(caseId, { type: 'time_based_followup' });
        }
      }

      case 'resume_from_human': {
        if (USE_LANGGRAPH) {
          return await resumeFOIACaseGraph(caseId, humanDecision);
        } else {
          // Old agent doesn't support resume - just re-run
          return await foiaCaseAgent.handleCase(caseId, { type: 'manual_review' });
        }
      }

      default:
        throw new Error(`Unknown agent job type: ${type}`);
    }
  } catch (error) {
    logger.error('Agent job failed', { type, caseId, error: error.message });
    throw error;
  }
}, { connection });

// Export agent queue
function getAgentQueue() {
  return agentQueue;
}

module.exports = {
  // ... existing exports ...
  agentQueue,
  agentWorker,
  getAgentQueue
};
```

### 5.2 Modify Analysis Worker

**File:** `queues/email-queue.js` (modify analysisWorker)

```javascript
// In analysisWorker, replace the foiaCaseAgent.handleCase call:

// BEFORE:
// if (isComplexCase) {
//   await foiaCaseAgent.handleCase(caseId, { type: 'agency_reply', messageId });
// }

// AFTER:
if (isComplexCase) {
  // Queue agent job instead of running inline
  await agentQueue.add('run_on_inbound', {
    type: 'run_on_inbound',
    caseId,
    triggerType: 'agency_reply',
    options: { messageId }
  });
  logger.info(`Queued agent job for complex case ${caseId}`);
}
```

---

## Phase 6: API Endpoints

### 6.1 Resume/Approval Endpoints

**File:** `routes/requests.js` (add new endpoints)

```javascript
const { getAgentQueue } = require('../queues/email-queue');

// POST /api/requests/:caseId/proposals/:proposalId/approve
router.post('/:caseId/proposals/:proposalId/approve', async (req, res) => {
  try {
    const { caseId, proposalId } = req.params;
    const agentQueue = getAgentQueue();

    // Queue resume job
    const job = await agentQueue.add('resume_from_human', {
      type: 'resume_from_human',
      caseId: parseInt(caseId),
      humanDecision: {
        action: 'APPROVE',
        proposalId: parseInt(proposalId)
      }
    });

    res.json({
      success: true,
      message: 'Approval queued',
      jobId: job.id
    });
  } catch (error) {
    logger.error('Approve endpoint error', { error: error.message });
    res.status(500).json({ error: error.message });
  }
});

// POST /api/requests/:caseId/proposals/:proposalId/adjust
router.post('/:caseId/proposals/:proposalId/adjust', async (req, res) => {
  try {
    const { caseId, proposalId } = req.params;
    const { instruction } = req.body;

    if (!instruction) {
      return res.status(400).json({ error: 'Adjustment instruction required' });
    }

    const agentQueue = getAgentQueue();

    const job = await agentQueue.add('resume_from_human', {
      type: 'resume_from_human',
      caseId: parseInt(caseId),
      humanDecision: {
        action: 'ADJUST',
        proposalId: parseInt(proposalId),
        instruction
      }
    });

    res.json({
      success: true,
      message: 'Adjustment queued',
      jobId: job.id
    });
  } catch (error) {
    logger.error('Adjust endpoint error', { error: error.message });
    res.status(500).json({ error: error.message });
  }
});

// POST /api/requests/:caseId/proposals/:proposalId/dismiss
router.post('/:caseId/proposals/:proposalId/dismiss', async (req, res) => {
  try {
    const { caseId, proposalId } = req.params;
    const agentQueue = getAgentQueue();

    const job = await agentQueue.add('resume_from_human', {
      type: 'resume_from_human',
      caseId: parseInt(caseId),
      humanDecision: {
        action: 'DISMISS',
        proposalId: parseInt(proposalId)
      }
    });

    res.json({
      success: true,
      message: 'Dismissal queued',
      jobId: job.id
    });
  } catch (error) {
    logger.error('Dismiss endpoint error', { error: error.message });
    res.status(500).json({ error: error.message });
  }
});

// POST /api/requests/:caseId/proposals/:proposalId/withdraw
router.post('/:caseId/proposals/:proposalId/withdraw', async (req, res) => {
  try {
    const { caseId, proposalId } = req.params;
    const agentQueue = getAgentQueue();

    const job = await agentQueue.add('resume_from_human', {
      type: 'resume_from_human',
      caseId: parseInt(caseId),
      humanDecision: {
        action: 'WITHDRAW',
        proposalId: parseInt(proposalId)
      }
    });

    res.json({
      success: true,
      message: 'Withdrawal queued',
      jobId: job.id
    });
  } catch (error) {
    logger.error('Withdraw endpoint error', { error: error.message });
    res.status(500).json({ error: error.message });
  }
});

// GET /api/requests/:caseId/agent-state
router.get('/:caseId/agent-state', async (req, res) => {
  try {
    const { caseId } = req.params;
    const { getCompiledGraph } = require('../langgraph');

    const { graph, checkpointer } = await getCompiledGraph();
    const threadId = `case:${caseId}`;

    const config = {
      configurable: { thread_id: threadId },
      checkpointer
    };

    const snapshot = await graph.getState(config);

    res.json({
      threadId,
      state: snapshot.values,
      next: snapshot.next,
      isInterrupted: snapshot.next?.length > 0,
      interruptData: snapshot.tasks?.[0]?.interrupts?.[0]
    });
  } catch (error) {
    logger.error('Agent state endpoint error', { error: error.message });
    res.status(500).json({ error: error.message });
  }
});
```

---

## Phase 7: Database Functions

### 7.1 Add Database Methods

**File:** `services/database.js` (add methods)

```javascript
// === ADD THESE METHODS TO database.js ===

// =====================================================
// P0 FIX #2 & #3: IDEMPOTENT PROPOSAL METHODS
// =====================================================

/**
 * UPSERT proposal using proposal_key for idempotency
 * P0 FIX #2: Safe to call multiple times - uses ON CONFLICT
 */
async function upsertProposal(data) {
  const result = await pool.query(`
    INSERT INTO proposals (
      proposal_key, case_id, trigger_message_id, action_type,
      draft_subject, draft_body_text, draft_body_html,
      reasoning, confidence, risk_flags, warnings,
      can_auto_execute, requires_human, status,
      langgraph_thread_id, adjustment_count
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
    ON CONFLICT (proposal_key) DO UPDATE SET
      draft_subject = EXCLUDED.draft_subject,
      draft_body_text = EXCLUDED.draft_body_text,
      draft_body_html = EXCLUDED.draft_body_html,
      reasoning = EXCLUDED.reasoning,
      confidence = EXCLUDED.confidence,
      risk_flags = EXCLUDED.risk_flags,
      warnings = EXCLUDED.warnings,
      can_auto_execute = EXCLUDED.can_auto_execute,
      requires_human = EXCLUDED.requires_human,
      status = CASE
        WHEN proposals.status = 'EXECUTED' THEN proposals.status
        ELSE EXCLUDED.status
      END,
      adjustment_count = EXCLUDED.adjustment_count,
      updated_at = NOW()
    RETURNING *
  `, [
    data.proposalKey, data.caseId, data.triggerMessageId, data.actionType,
    data.draftSubject, data.draftBodyText, data.draftBodyHtml,
    JSON.stringify(data.reasoning), data.confidence,
    data.riskFlags, data.warnings,
    data.canAutoExecute, data.requiresHuman,
    data.status || 'DRAFT', data.langgraphThreadId, data.adjustmentCount || 0
  ]);
  return result.rows[0];
}

/**
 * Claim execution lock on proposal
 * P0 FIX #3: Atomic claim - only succeeds if execution_key is null
 * Returns true if claimed, false if already claimed
 */
async function claimProposalExecution(proposalId, executionKey) {
  const result = await pool.query(`
    UPDATE proposals
    SET execution_key = $2, updated_at = NOW()
    WHERE id = $1 AND execution_key IS NULL AND status != 'EXECUTED'
    RETURNING id
  `, [proposalId, executionKey]);

  return result.rowCount > 0;
}

/**
 * Update proposal (non-idempotent, use for status changes)
 */
async function updateProposal(proposalId, data) {
  const fields = [];
  const values = [];
  let paramIndex = 1;

  for (const [key, value] of Object.entries(data)) {
    const snakeKey = key.replace(/[A-Z]/g, m => '_' + m.toLowerCase());
    fields.push(`${snakeKey} = $${paramIndex}`);
    values.push(key === 'reasoning' ? JSON.stringify(value) : value);
    paramIndex++;
  }

  values.push(proposalId);

  const result = await pool.query(`
    UPDATE proposals
    SET ${fields.join(', ')}, updated_at = NOW()
    WHERE id = $${paramIndex}
    RETURNING *
  `, values);

  return result.rows[0];
}

async function getLatestPendingProposal(caseId) {
  const result = await pool.query(`
    SELECT * FROM proposals
    WHERE case_id = $1 AND status IN ('DRAFT', 'PENDING_APPROVAL')
    ORDER BY created_at DESC
    LIMIT 1
  `, [caseId]);
  return result.rows[0];
}

async function getProposalById(proposalId) {
  const result = await pool.query(`
    SELECT * FROM proposals WHERE id = $1
  `, [proposalId]);
  return result.rows[0];
}

// Response Analysis
async function saveResponseAnalysis(data) {
  const result = await pool.query(`
    INSERT INTO response_analysis (
      message_id, case_id, intent, confidence_score, sentiment,
      key_points, extracted_deadline, extracted_fee_amount,
      requires_action, suggested_action, full_analysis_json
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
    ON CONFLICT (message_id) DO UPDATE SET
      intent = EXCLUDED.intent,
      confidence_score = EXCLUDED.confidence_score,
      sentiment = EXCLUDED.sentiment,
      key_points = EXCLUDED.key_points,
      extracted_deadline = EXCLUDED.extracted_deadline,
      extracted_fee_amount = EXCLUDED.extracted_fee_amount,
      requires_action = EXCLUDED.requires_action,
      suggested_action = EXCLUDED.suggested_action,
      full_analysis_json = EXCLUDED.full_analysis_json
    RETURNING *
  `, [
    data.messageId, data.caseId, data.intent, data.confidenceScore,
    data.sentiment, data.keyPoints, data.extractedDeadline,
    data.extractedFeeAmount, data.requiresAction, data.suggestedAction,
    JSON.stringify(data.fullAnalysisJson)
  ]);
  return result.rows[0];
}

async function getLatestResponseAnalysis(caseId) {
  const result = await pool.query(`
    SELECT ra.* FROM response_analysis ra
    JOIN messages m ON ra.message_id = m.id
    WHERE ra.case_id = $1 AND m.direction = 'inbound'
    ORDER BY m.received_at DESC
    LIMIT 1
  `, [caseId]);
  return result.rows[0];
}

async function getResponseAnalysisByMessageId(messageId) {
  const result = await pool.query(`
    SELECT * FROM response_analysis WHERE message_id = $1
  `, [messageId]);
  return result.rows[0];
}

// Messages
async function getMessageById(messageId) {
  const result = await pool.query(`
    SELECT * FROM messages WHERE id = $1
  `, [messageId]);
  return result.rows[0];
}

async function getLatestInboundMessage(caseId) {
  const result = await pool.query(`
    SELECT * FROM messages
    WHERE case_id = $1 AND direction = 'inbound'
    ORDER BY received_at DESC
    LIMIT 1
  `, [caseId]);
  return result.rows[0];
}

// Agent Decisions
async function createAgentDecision(data) {
  const result = await pool.query(`
    INSERT INTO agent_decisions (
      case_id, reasoning, action_taken, confidence, trigger_type, outcome
    ) VALUES ($1, $2, $3, $4, $5, $6)
    RETURNING *
  `, [
    data.caseId, data.reasoning, data.actionTaken,
    data.confidence, data.triggerType, data.outcome
  ]);
  return result.rows[0];
}

// Escalations - P0 FIX #3: Idempotent version
async function upsertEscalation(data) {
  // Use execution_key if provided for exact deduplication
  // Otherwise dedupe by case_id + reason (within 1 hour)
  const result = await pool.query(`
    INSERT INTO escalations (case_id, reason, urgency, suggested_action, status)
    SELECT $1, $2, $3, $4, 'pending'
    WHERE NOT EXISTS (
      SELECT 1 FROM escalations
      WHERE case_id = $1
        AND reason = $2
        AND created_at > NOW() - INTERVAL '1 hour'
    )
    RETURNING *, true as was_inserted
  `, [data.caseId, data.reason, data.urgency, data.suggestedAction]);

  if (result.rows.length > 0) {
    return { ...result.rows[0], wasInserted: true };
  }

  // Return existing escalation
  const existing = await pool.query(`
    SELECT * FROM escalations
    WHERE case_id = $1 AND reason = $2
    ORDER BY created_at DESC LIMIT 1
  `, [data.caseId, data.reason]);

  return { ...existing.rows[0], wasInserted: false };
}

// Legacy create method (deprecated, use upsertEscalation)
async function createEscalation(data) {
  return upsertEscalation(data);
}

// Follow-up Schedule
async function upsertFollowUpSchedule(caseId, data) {
  const result = await pool.query(`
    INSERT INTO follow_up_schedule (case_id, next_followup_date, followup_count, last_followup_sent_at, auto_send, status)
    VALUES ($1, $2, 1, $3, true, 'scheduled')
    ON CONFLICT (case_id) DO UPDATE SET
      next_followup_date = COALESCE($2, follow_up_schedule.next_followup_date),
      followup_count = follow_up_schedule.followup_count + 1,
      last_followup_sent_at = COALESCE($3, follow_up_schedule.last_followup_sent_at),
      status = 'scheduled'
    RETURNING *
  `, [caseId, data.nextFollowupDate, data.lastFollowupSentAt]);
  return result.rows[0];
}

// Update case with constraints
async function updateCase(caseId, data) {
  const fields = [];
  const values = [];
  let paramIndex = 1;

  for (const [key, value] of Object.entries(data)) {
    const snakeKey = key.replace(/[A-Z]/g, m => '_' + m.toLowerCase());
    fields.push(`${snakeKey} = $${paramIndex}`);
    values.push(Array.isArray(value) || typeof value === 'object' ? JSON.stringify(value) : value);
    paramIndex++;
  }

  values.push(caseId);

  const result = await pool.query(`
    UPDATE cases
    SET ${fields.join(', ')}, updated_at = NOW()
    WHERE id = $${paramIndex}
    RETURNING *
  `, values);

  return result.rows[0];
}

module.exports = {
  // ... existing exports ...

  // P0 IDEMPOTENT METHODS
  upsertProposal,           // P0 fix #2
  claimProposalExecution,   // P0 fix #3
  updateProposal,
  getLatestPendingProposal,
  getProposalById,

  // Response Analysis
  saveResponseAnalysis,
  getLatestResponseAnalysis,
  getResponseAnalysisByMessageId,

  // Messages
  getMessageById,
  getLatestInboundMessage,

  // Agent Decisions
  createAgentDecision,

  // Escalations (idempotent)
  upsertEscalation,         // P0 fix #3
  createEscalation,         // Deprecated, wraps upsert

  // Follow-ups
  upsertFollowUpSchedule,

  // Cases
  updateCase
};
```

---

## Phase 8: AI Service Extensions

### 8.1 Add Missing AI Methods

**File:** `services/ai-service.js` (add methods)

```javascript
// === ADD THESE METHODS TO ai-service.js ===

/**
 * Generate clarification response
 */
async function generateClarificationResponse(message, analysis, caseData, options = {}) {
  const prompt = `
You are responding to a public records request clarification from an agency.

AGENCY MESSAGE:
${message.body_text}

ORIGINAL REQUEST:
- Subject: ${caseData.subject_name}
- Records Requested: ${caseData.requested_records?.join(', ')}
- Incident Date: ${caseData.incident_date}
- Location: ${caseData.incident_location}

${options.adjustmentInstruction ? `USER ADJUSTMENT: ${options.adjustmentInstruction}` : ''}

Generate a professional, helpful response that:
1. Addresses their specific questions
2. Provides any clarification needed
3. Offers to narrow scope if helpful
4. Maintains a cooperative tone

Return JSON:
{
  "subject": "RE: ...",
  "body_text": "...",
  "body_html": "..."
}
`;

  const response = await callOpenAI(prompt, { responseFormat: 'json' });
  return JSON.parse(response);
}

/**
 * Generate fee acceptance response
 */
async function generateFeeAcceptance(caseData, feeAmount, options = {}) {
  const prompt = `
Generate a professional response accepting a fee quote for a public records request.

CASE:
- Subject: ${caseData.subject_name}
- Agency: ${caseData.agency_name}
- Fee Amount: $${feeAmount}

${options.adjustmentInstruction ? `USER ADJUSTMENT: ${options.adjustmentInstruction}` : ''}

The response should:
1. Confirm acceptance of the fee
2. Ask about payment method (check, money order, etc.)
3. Request invoice/mailing address if needed
4. Be brief and professional

Return JSON:
{
  "subject": "RE: Fee Acceptance - ...",
  "body_text": "...",
  "body_html": "..."
}
`;

  const response = await callOpenAI(prompt, { responseFormat: 'json' });
  return JSON.parse(response);
}

module.exports = {
  // ... existing exports ...
  generateClarificationResponse,
  generateFeeAcceptance
};
```

---

## Phase 9: Migration Checklist

### 9.1 Files to Create

| File | Purpose | Priority |
|------|---------|----------|
| `langgraph/index.js` | Main exports | P0 |
| `langgraph/state/case-state.js` | State annotation | P0 |
| `langgraph/graph/foia-case-graph.js` | Graph definition | P0 |
| `langgraph/nodes/load-context.js` | Load case data | P0 |
| `langgraph/nodes/classify-inbound.js` | AI analysis | P0 |
| `langgraph/nodes/update-constraints.js` | Constraint tracking | P0 |
| `langgraph/nodes/decide-next-action.js` | Router node | P0 |
| `langgraph/nodes/draft-response.js` | Draft emails | P0 |
| `langgraph/nodes/safety-check.js` | Validate drafts | P0 |
| `langgraph/nodes/gate-or-execute.js` | Human interrupt | P0 |
| `langgraph/nodes/execute-action.js` | Send emails | P0 |
| `langgraph/nodes/commit-state.js` | Finalize state | P0 |
| `migrations/015_proposals_table.sql` | Proposals table | P0 |

### 9.2 Files to Modify

| File | Changes | Priority |
|------|---------|----------|
| `package.json` | Add LangGraph deps | P0 |
| `queues/email-queue.js` | Add agent queue/worker | P0 |
| `routes/requests.js` | Add resume endpoints | P1 |
| `services/database.js` | Add proposal methods | P1 |
| `services/ai-service.js` | Add missing methods | P1 |
| `.env` | Add feature flag | P0 |

### 9.3 Testing Plan

1. **Unit Tests**
   - Each node in isolation
   - State transitions
   - Routing logic

2. **Integration Tests**
   - Full graph flow (no interrupt)
   - Interrupt + resume flow
   - Error handling

3. **Shadow Mode**
   - Run both old + new agent
   - Compare decisions
   - Log discrepancies

4. **Gradual Rollout**
   - Enable for fee quotes first
   - Then follow-ups
   - Then denials
   - Full rollout

---

## Phase 10: P1 Improvements (High Leverage)

### 10.1 Structured Constraint Extraction (P1 Fix #6)

**Problem**: `update-constraints.js` uses brittle string matching on `key_points`.

**Solution**: Have AI return structured constraint data directly.

**File:** `services/ai-service.js` (modify analyzeResponse)

```javascript
/**
 * Analyze response with STRUCTURED constraint extraction
 * P1 FIX #6: AI returns structured data, not just key_points
 */
async function analyzeResponse(message, caseData) {
  const prompt = `
Analyze this agency response to a public records request.

AGENCY MESSAGE:
${message.body_text}

ORIGINAL REQUEST:
- Subject: ${caseData.subject_name}
- Records Requested: ${caseData.requested_records?.join(', ')}

Return a JSON object with these exact fields:

{
  "intent": "acknowledgment" | "question" | "delivery" | "denial" | "fee_request" | "more_info_needed",
  "confidence_score": 0.0-1.0,
  "sentiment": "positive" | "neutral" | "negative" | "hostile",

  "fee_amount": number | null,
  "deadline_date": "YYYY-MM-DD" | null,

  "constraints_to_add": [
    // Array of constraint codes to add. Use ONLY these codes:
    // "BWC_EXEMPT" - Body camera/BWC explicitly unavailable
    // "FEE_REQUIRED" - Payment required before release
    // "ID_REQUIRED" - Identity verification required
    // "INVESTIGATION_ACTIVE" - Ongoing investigation cited
    // "PRIVACY_EXEMPTION" - Privacy/HIPAA cited
    // "RETENTION_EXPIRED" - Records no longer retained
    // "WRONG_AGENCY" - Referred to different agency
  ],

  "scope_updates": [
    // Array of scope item status changes
    {
      "item": "string - the record type",
      "status": "PENDING" | "EXEMPT" | "DENIED" | "DELIVERED" | "PARTIAL",
      "reason": "string - why this status"
    }
  ],

  "key_points": ["array of important points"],
  "requires_action": true | false,
  "suggested_action": "string"
}
`;

  const response = await callOpenAI(prompt, { responseFormat: 'json' });
  return JSON.parse(response);
}
```

**File:** `langgraph/nodes/update-constraints.js` (simplified)

```javascript
/**
 * Update constraints using STRUCTURED data from analysis
 * P1 FIX #6: No more string matching - uses AI-extracted constraints
 */
async function updateConstraintsNode(state) {
  const { caseId, latestInboundMessageId } = state;

  // Fetch the analysis (which now has structured constraints)
  const analysis = await db.getResponseAnalysisByMessageId(latestInboundMessageId);

  if (!analysis?.full_analysis_json) {
    return { logs: ['No analysis found, skipping constraint update'] };
  }

  const parsed = typeof analysis.full_analysis_json === 'string'
    ? JSON.parse(analysis.full_analysis_json)
    : analysis.full_analysis_json;

  // Get current constraints
  const caseData = await db.getCaseById(caseId);
  const currentConstraints = caseData.constraints || [];
  const currentScopeItems = caseData.scope_items || [];

  // Merge new constraints (dedupe)
  const newConstraints = [
    ...new Set([...currentConstraints, ...(parsed.constraints_to_add || [])])
  ];

  // Merge scope updates
  const updatedScopeItems = mergeScpoeUpdates(currentScopeItems, parsed.scope_updates || []);

  // Persist if changed
  if (JSON.stringify(newConstraints) !== JSON.stringify(currentConstraints) ||
      JSON.stringify(updatedScopeItems) !== JSON.stringify(currentScopeItems)) {
    await db.updateCase(caseId, {
      constraints: newConstraints,
      scope_items: updatedScopeItems
    });
  }

  return {
    constraints: newConstraints,
    scopeItems: updatedScopeItems,
    extractedFeeAmount: parsed.fee_amount,
    extractedDeadline: parsed.deadline_date,
    logs: [
      `Constraints: ${parsed.constraints_to_add?.join(', ') || 'none added'}`,
      `Scope updates: ${parsed.scope_updates?.length || 0} items`
    ]
  };
}

function mergeScopeUpdates(existing, updates) {
  const byItem = new Map(existing.map(s => [s.item.toLowerCase(), s]));

  for (const update of updates) {
    const key = update.item.toLowerCase();
    if (byItem.has(key)) {
      // Update existing
      byItem.set(key, { ...byItem.get(key), ...update });
    } else {
      // Add new
      byItem.set(key, update);
    }
  }

  return Array.from(byItem.values());
}
```

### 10.2 Separate Agent Queue (P1 Fix #9)

**Problem**: Agent queue mixed into `email-queue.js` creates coupling.

**Solution**: Create separate files.

**File:** `queues/agent-queue.js` (new file)

```javascript
const { Queue, Worker } = require('bullmq');
const Redis = require('ioredis');
const logger = require('../utils/logger');

const connection = new Redis(process.env.REDIS_URL);

// Agent orchestration queue
const agentQueue = new Queue('agent', {
  connection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 5000 },
    removeOnComplete: 100,
    removeOnFail: 500
  }
});

module.exports = { agentQueue, connection };
```

**File:** `workers/agent-worker.js` (new file)

```javascript
const { Worker } = require('bullmq');
const { connection } = require('../queues/agent-queue');
const { invokeFOIACaseGraph, resumeFOIACaseGraph } = require('../langgraph');
const foiaCaseAgent = require('../services/foia-case-agent');
const logger = require('../utils/logger');

const USE_LANGGRAPH = process.env.USE_LANGGRAPH === 'true';

const agentWorker = new Worker('agent', async (job) => {
  const { type, caseId, triggerType, humanDecision, options } = job.data;

  logger.info(`Agent job started: ${type}`, { caseId, jobId: job.id });

  switch (type) {
    case 'run_on_inbound': {
      if (USE_LANGGRAPH) {
        return await invokeFOIACaseGraph(caseId, 'agency_reply', options);
      }
      return await foiaCaseAgent.handleCase(caseId, { type: 'agency_reply' });
    }

    case 'run_on_schedule': {
      if (USE_LANGGRAPH) {
        return await invokeFOIACaseGraph(caseId, 'time_based_followup', options);
      }
      return await foiaCaseAgent.handleCase(caseId, { type: 'time_based_followup' });
    }

    case 'resume_from_human': {
      if (USE_LANGGRAPH) {
        return await resumeFOIACaseGraph(caseId, humanDecision);
      }
      return await foiaCaseAgent.handleCase(caseId, { type: 'manual_review' });
    }

    default:
      throw new Error(`Unknown agent job type: ${type}`);
  }
}, {
  connection,
  concurrency: 5,  // Process up to 5 cases in parallel
  limiter: {
    max: 10,
    duration: 60000  // Max 10 jobs per minute
  }
});

agentWorker.on('completed', (job, result) => {
  logger.info(`Agent job completed: ${job.id}`, { result: result?.status });
});

agentWorker.on('failed', (job, error) => {
  logger.error(`Agent job failed: ${job.id}`, { error: error.message });
});

module.exports = { agentWorker };
```

### 10.3 Remove loopCount (P1 Fix #8)

**Problem**: `loopCount` doesn't actually increment in a meaningful way in the current linear graph.

**Solution**: Remove it for now, or add a real loop edge.

**If removing**: Simply delete `loopCount` from state and routing logic.

**If keeping with real loop**: Add edge from `safety_check` back to `draft_response` when violations detected:

```javascript
// In graph definition
graph.addConditionalEdges(
  "safety_check",
  (state) => {
    // If critical risk, loop back for re-draft (with limit)
    if (state.riskFlags?.includes('REQUESTS_EXEMPT_ITEM') && state.loopCount < 3) {
      return "draft_response";  // Loop back
    }
    return "gate_or_execute";
  },
  {
    "draft_response": "draft_response",
    "gate_or_execute": "gate_or_execute"
  }
);
```

---

## Phase 11: Recommended Migration Order

Based on all P0 fixes, here's the safest order:

### Week 1: Foundation
1. Install dependencies (`@langchain/langgraph`, etc.)
2. Run migration `015_proposals_table.sql`
3. Add env vars (`USE_LANGGRAPH=false`)
4. Create `langgraph/` directory structure

### Week 2: Core Graph
5. Implement state schema (`case-state.js`)
6. Implement nodes: `load-context`, `classify-inbound`, `decide-next-action`
7. Implement nodes: `draft-response`, `gate-or-execute` (with idempotency)
8. Implement `execute-action` (with idempotency)
9. Implement `commit-state`
10. Wire up graph with correct checkpointer pattern

### Week 3: Integration
11. Create separate `agent-queue.js` and `agent-worker.js`
12. Add database methods (`upsertProposal`, `claimProposalExecution`)
13. Add API endpoints for approve/adjust/dismiss
14. Add advisory lock functions

### Week 4: Testing
15. Unit tests for each node
16. Integration test: full flow without interrupt
17. Integration test: interrupt + resume
18. Shadow mode: run both agents, compare

### Week 5: Rollout
19. Enable for fee quotes only (`USE_LANGGRAPH=true` + case filter)
20. Monitor for duplicates, lock issues
21. Expand to follow-ups
22. Full rollout

---

## Summary

This plan provides:
- **P0 fixes** for checkpointer, idempotency, interrupts, concurrency
- **P1 improvements** for structured AI output, separate queues
- **25+ files** with detailed implementations
- **Clear phases** for incremental migration
- **Feature flag** for safe rollout
- **Shadow mode** for comparison testing
- **All node implementations** for the LangGraph state machine
- **API endpoints** for human-in-the-loop

**Critical reminders:**
1. Checkpointer at compile time, thread_id at invoke time
2. No try/catch around interrupt()
3. All pre-interrupt operations must be idempotent
4. Use execution_key + BullMQ jobId for email deduplication
5. Advisory locks for per-case concurrency

Total estimated files: 17 new, 8 modified
