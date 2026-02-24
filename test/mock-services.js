/**
 * Mock Services for Offline Test Harness
 *
 * Provides in-memory mock implementations of all services used by the
 * LangGraph FOIA case pipeline. Uses require.cache injection so that
 * graph nodes resolve to these mocks instead of the real services.
 *
 * Usage:
 *   const { injectMocks, createMockDb, createMockLogger } = require('./mock-services');
 *   const mocks = injectMocks();        // call BEFORE requiring any graph code
 *   mocks.db.seed({ case: {...}, ... });
 *   // now require and run graph nodes
 */

const path = require('path');

// ---------------------------------------------------------------------------
// Auto-incrementing ID generator
// ---------------------------------------------------------------------------

let _nextId = 10000;

function nextId() {
  return _nextId++;
}

function resetIdCounter() {
  _nextId = 10000;
}

// ---------------------------------------------------------------------------
// Mock Database
// ---------------------------------------------------------------------------

function createMockDb() {
  // In-memory stores
  const cases = new Map();
  const messages = new Map();
  const analyses = new Map();       // keyed by message_id
  const proposals = new Map();
  const runs = new Map();
  const activities = [];
  const feeEvents = [];
  const followups = new Map();      // keyed by case_id
  const threads = new Map();        // keyed by case_id
  const decisionTraces = new Map();
  const escalations = new Map();
  const agentDecisions = [];
  const attachments = new Map();
  const agencies = new Map();
  const caseAgencies = new Map();
  const processedMessages = new Map();

  // -----------------------------------------------------------------------
  // Seed & Reset
  // -----------------------------------------------------------------------

  function seed(data) {
    if (data.case) {
      const c = { ...data.case };
      if (!c.id) c.id = nextId();
      cases.set(c.id, c);
    }

    if (data.messages) {
      for (const msg of data.messages) {
        const m = { ...msg };
        if (!m.id) m.id = nextId();
        messages.set(m.id, m);
      }
    }

    if (data.analyses) {
      for (const a of data.analyses) {
        const analysis = { ...a };
        if (!analysis.id) analysis.id = nextId();
        analyses.set(analysis.message_id, analysis);
      }
    }

    if (data.proposals) {
      for (const p of data.proposals) {
        const prop = { ...p };
        if (!prop.id) prop.id = nextId();
        proposals.set(prop.id, prop);
      }
    }

    if (data.runs) {
      for (const r of data.runs) {
        const run = { ...r };
        if (!run.id) run.id = nextId();
        runs.set(run.id, run);
      }
    }

    if (data.followup) {
      const f = { ...data.followup };
      if (!f.id) f.id = nextId();
      const caseId = f.case_id;
      followups.set(caseId, f);
    }

    if (data.thread) {
      const t = { ...data.thread };
      if (!t.id) t.id = nextId();
      threads.set(t.case_id, t);
    }

    if (data.attachments) {
      for (const att of data.attachments) {
        const a = { ...att };
        if (!a.id) a.id = nextId();
        attachments.set(a.id, a);
      }
    }
  }

  function reset() {
    cases.clear();
    messages.clear();
    analyses.clear();
    proposals.clear();
    runs.clear();
    activities.length = 0;
    feeEvents.length = 0;
    followups.clear();
    threads.clear();
    decisionTraces.clear();
    escalations.clear();
    agentDecisions.length = 0;
    attachments.clear();
    agencies.clear();
    caseAgencies.clear();
    processedMessages.clear();
    resetIdCounter();
  }

  // -----------------------------------------------------------------------
  // Cases
  // -----------------------------------------------------------------------

  async function getCaseById(id) {
    return cases.get(id) || null;
  }

  async function updateCaseStatus(caseId, status, additionalFields = {}) {
    const c = cases.get(caseId);
    if (!c) return null;
    c.status = status;
    Object.assign(c, additionalFields);
    c.updated_at = new Date().toISOString();
    return c;
  }

  async function updateCase(caseId, updates = {}) {
    const c = cases.get(caseId);
    if (!c) return null;
    Object.assign(c, updates);
    c.updated_at = new Date().toISOString();
    return c;
  }

  async function updateCasePortalStatus(caseId, portalData = {}) {
    const c = cases.get(caseId);
    if (!c) return null;
    const fields = [
      'portal_url', 'portal_provider', 'last_portal_status',
      'last_portal_status_at', 'last_portal_engine', 'last_portal_run_id',
      'last_portal_details', 'last_portal_task_url',
      'last_portal_recording_url', 'last_portal_account_email',
      'portal_request_number'
    ];
    for (const field of fields) {
      if (portalData[field] !== undefined) {
        c[field] = portalData[field];
      }
    }
    c.updated_at = new Date().toISOString();
    return c;
  }

  // -----------------------------------------------------------------------
  // Messages
  // -----------------------------------------------------------------------

  async function getMessageById(id) {
    return messages.get(id) || null;
  }

  async function getMessagesByCaseId(caseId, limit = 50) {
    const result = [];
    for (const msg of messages.values()) {
      if (msg.case_id === caseId) {
        result.push(msg);
      }
    }
    // DESC order by received_at / sent_at / created_at
    result.sort((a, b) => {
      const dateA = a.received_at || a.sent_at || a.created_at || '';
      const dateB = b.received_at || b.sent_at || b.created_at || '';
      return dateB.localeCompare(dateA);
    });
    return result.slice(0, limit);
  }

  async function getLatestInboundMessage(caseId) {
    const msgs = [];
    for (const msg of messages.values()) {
      if (msg.case_id === caseId && msg.direction === 'inbound') {
        msgs.push(msg);
      }
    }
    msgs.sort((a, b) => {
      const dateA = a.received_at || a.created_at || '';
      const dateB = b.received_at || b.created_at || '';
      return dateB.localeCompare(dateA);
    });
    return msgs[0] || null;
  }

  async function markMessageProcessed(messageId, runId, error = null) {
    const msg = messages.get(messageId);
    if (!msg) return null;
    msg.processed_at = new Date().toISOString();
    msg.processed_run_id = runId;
    msg.last_error = error;
    processedMessages.set(messageId, { runId, error });
    return msg;
  }

  // -----------------------------------------------------------------------
  // Response Analysis
  // -----------------------------------------------------------------------

  async function getLatestResponseAnalysis(caseId) {
    // Find all analyses for messages belonging to this case
    const caseAnalyses = [];
    for (const [msgId, analysis] of analyses.entries()) {
      const msg = messages.get(msgId);
      if (msg && msg.case_id === caseId) {
        caseAnalyses.push(analysis);
      }
      // Also check if the analysis itself has a case_id
      if (analysis.case_id === caseId) {
        caseAnalyses.push(analysis);
      }
    }
    // Deduplicate by id
    const seen = new Set();
    const unique = caseAnalyses.filter(a => {
      if (seen.has(a.id)) return false;
      seen.add(a.id);
      return true;
    });
    // Sort by created_at DESC
    unique.sort((a, b) => {
      const dateA = a.created_at || '';
      const dateB = b.created_at || '';
      return dateB.localeCompare(dateA);
    });
    return unique[0] || null;
  }

  async function getResponseAnalysisByMessageId(messageId) {
    return analyses.get(messageId) || null;
  }

  async function saveResponseAnalysis(analysisData) {
    const analysis = {
      id: nextId(),
      message_id: analysisData.messageId,
      case_id: analysisData.caseId,
      intent: analysisData.intent,
      confidence_score: analysisData.confidenceScore,
      sentiment: analysisData.sentiment,
      key_points: analysisData.keyPoints,
      extracted_deadline: analysisData.extractedDeadline,
      extracted_fee_amount: analysisData.extractedFeeAmount,
      requires_action: analysisData.requiresAction,
      suggested_action: analysisData.suggestedAction,
      full_analysis_json: analysisData.fullAnalysisJson,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };
    analyses.set(analysis.message_id, analysis);
    return analysis;
  }

  // -----------------------------------------------------------------------
  // Proposals
  // -----------------------------------------------------------------------

  async function upsertProposal(proposalData) {
    const proposal = {
      id: nextId(),
      proposal_key: proposalData.proposalKey || null,
      case_id: proposalData.caseId,
      run_id: proposalData.runId || null,
      trigger_message_id: proposalData.triggerMessageId || null,
      action_type: proposalData.actionType || 'UNKNOWN',
      draft_subject: proposalData.draftSubject || null,
      draft_body_text: proposalData.draftBodyText || null,
      draft_body_html: proposalData.draftBodyHtml || null,
      reasoning: proposalData.reasoning || null,
      confidence: proposalData.confidence || null,
      risk_flags: proposalData.riskFlags || null,
      warnings: proposalData.warnings || null,
      can_auto_execute: proposalData.canAutoExecute !== undefined ? proposalData.canAutoExecute : false,
      requires_human: proposalData.requiresHuman !== undefined ? proposalData.requiresHuman : true,
      status: proposalData.status || 'PENDING_APPROVAL',
      langgraph_thread_id: proposalData.langgraphThreadId || null,
      adjustment_count: proposalData.adjustmentCount || 0,
      lessons_applied: proposalData.lessonsApplied || null,
      execution_key: null,
      executed_at: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };
    proposals.set(proposal.id, proposal);
    return proposal;
  }

  async function getProposalById(proposalId) {
    return proposals.get(proposalId) || null;
  }

  async function getLatestPendingProposal(caseId) {
    const pending = [];
    for (const p of proposals.values()) {
      if (p.case_id === caseId && (p.status === 'PENDING_APPROVAL' || p.status === 'DRAFT')) {
        pending.push(p);
      }
    }
    pending.sort((a, b) => {
      const dateA = a.created_at || '';
      const dateB = b.created_at || '';
      return dateB.localeCompare(dateA);
    });
    return pending[0] || null;
  }

  async function getAllProposalsByCaseId(caseId) {
    const result = [];
    for (const p of proposals.values()) {
      if (p.case_id === caseId) {
        result.push({
          id: p.id,
          action_type: p.action_type,
          status: p.status,
          created_at: p.created_at
        });
      }
    }
    result.sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));
    return result;
  }

  async function updateProposal(proposalId, updates) {
    const p = proposals.get(proposalId);
    if (!p) return null;
    // Apply camelCase to snake_case mapping
    const fieldMap = {
      executedAt: 'executed_at',
      emailJobId: 'email_job_id',
      executionKey: 'execution_key',
      humanDecision: 'human_decision',
      humanDecidedAt: 'human_decided_at',
      humanDecidedBy: 'human_decided_by',
      adjustmentCount: 'adjustment_count'
    };
    for (const [key, value] of Object.entries(updates)) {
      const dbKey = fieldMap[key] || key;
      p[dbKey] = value;
    }
    p.updated_at = new Date().toISOString();
    return p;
  }

  async function claimProposalExecution(proposalId, executionKey) {
    const p = proposals.get(proposalId);
    if (!p) return false;
    if (p.execution_key || p.status === 'EXECUTED') return false;
    p.execution_key = executionKey;
    return true;
  }

  async function dismissPendingProposals(caseId, reason = 'Case status advanced', actionTypes = null) {
    const dismissed = [];
    for (const p of proposals.values()) {
      if (p.case_id !== caseId) continue;
      if (p.status !== 'PENDING_APPROVAL' && p.status !== 'DRAFT') continue;
      if (actionTypes && actionTypes.length > 0 && !actionTypes.includes(p.action_type)) continue;
      p.status = 'DISMISSED';
      p.updated_at = new Date().toISOString();
      dismissed.push({ id: p.id, action_type: p.action_type });
    }
    return dismissed;
  }

  async function blockProposal(proposalId, reason) {
    const p = proposals.get(proposalId);
    if (!p) return null;
    p.status = 'blocked';
    p.blocked_reason = reason;
    return p;
  }

  async function isProposalExecuted(proposalId) {
    const p = proposals.get(proposalId);
    if (!p) return null;
    return {
      executed: !!p.executed_at,
      emailJobId: p.email_job_id || null,
      executionKey: p.execution_key || null
    };
  }

  async function getProposalsByRunId(runId) {
    const result = [];
    for (const p of proposals.values()) {
      if (p.run_id === runId) {
        result.push(p);
      }
    }
    result.sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));
    return result;
  }

  // -----------------------------------------------------------------------
  // Agent Runs
  // -----------------------------------------------------------------------

  async function createAgentRun(caseId, triggerType, metadata = {}) {
    const run = {
      id: nextId(),
      case_id: caseId,
      trigger_type: triggerType,
      metadata: typeof metadata === 'string' ? JSON.parse(metadata) : metadata,
      status: 'running',
      started_at: new Date().toISOString(),
      ended_at: null,
      proposal_id: null,
      error: null,
      lock_acquired: true
    };
    runs.set(run.id, run);
    return run;
  }

  async function getAgentRunById(runId) {
    return runs.get(runId) || null;
  }

  async function updateAgentRun(runId, updates) {
    const r = runs.get(runId);
    if (!r) return null;
    Object.assign(r, updates);
    return r;
  }

  async function completeAgentRun(runId, proposalId = null, error = null) {
    const r = runs.get(runId);
    if (!r) return null;
    r.status = error ? 'failed' : 'completed';
    r.ended_at = new Date().toISOString();
    if (proposalId) r.proposal_id = proposalId;
    if (error) r.error = error;
    return r;
  }

  async function hasActiveAgentRun(caseId) {
    for (const r of runs.values()) {
      if (r.case_id === caseId && r.status === 'running') {
        return true;
      }
    }
    return false;
  }

  async function updateAgentRunNodeProgress(runId, nodeName, iteration = null) {
    const r = runs.get(runId);
    if (!r) return null;
    if (!r.metadata) r.metadata = {};
    r.metadata.current_node = nodeName;
    r.metadata.node_started_at = new Date().toISOString();
    r.metadata.iteration_count = iteration;
    return r;
  }

  async function getActiveRunForCase(caseId) {
    const active = [];
    for (const r of runs.values()) {
      if (r.case_id === caseId && ['created', 'queued', 'running', 'paused'].includes(r.status)) {
        active.push(r);
      }
    }
    active.sort((a, b) => (b.started_at || '').localeCompare(a.started_at || ''));
    return active[0] || null;
  }

  async function skipAgentRun(runId, reason = 'Case locked by another agent run') {
    const r = runs.get(runId);
    if (!r) return null;
    r.status = 'skipped_locked';
    r.ended_at = new Date().toISOString();
    r.error = reason;
    return r;
  }

  // -----------------------------------------------------------------------
  // Other DB methods
  // -----------------------------------------------------------------------

  async function logActivity(eventType, description, metadata = {}) {
    const entry = {
      id: nextId(),
      event_type: eventType,
      case_id: metadata.case_id || null,
      message_id: metadata.message_id || null,
      description,
      metadata,
      user_id: metadata.user_id || null,
      created_at: new Date().toISOString()
    };
    activities.push(entry);
    return entry;
  }

  async function logFeeEvent(caseId, eventType, amount = null, notes = null, sourceMessageId = null) {
    const entry = {
      id: nextId(),
      case_id: caseId,
      event_type: eventType,
      amount,
      notes,
      source_message_id: sourceMessageId,
      created_at: new Date().toISOString()
    };
    feeEvents.push(entry);
    return entry;
  }

  async function getFollowUpScheduleByCaseId(caseId) {
    return followups.get(caseId) || null;
  }

  async function upsertFollowUpSchedule(caseId, scheduleData) {
    const existing = followups.get(caseId);
    const schedule = {
      id: existing ? existing.id : nextId(),
      case_id: caseId,
      thread_id: scheduleData.threadId || (existing ? existing.thread_id : null),
      next_followup_date: scheduleData.nextFollowupDate || (existing ? existing.next_followup_date : null),
      followup_count: scheduleData.followupCount || ((existing ? existing.followup_count : 0) + 1),
      auto_send: scheduleData.autoSend !== false,
      status: scheduleData.status || 'scheduled',
      last_followup_sent_at: scheduleData.lastFollowupSentAt || (existing ? existing.last_followup_sent_at : null),
      created_at: existing ? existing.created_at : new Date().toISOString(),
      updated_at: new Date().toISOString()
    };
    followups.set(caseId, schedule);
    return schedule;
  }

  async function getThreadByCaseId(caseId) {
    return threads.get(caseId) || null;
  }

  async function createDecisionTrace(data) {
    const trace = {
      id: nextId(),
      run_id: data.run_id,
      case_id: data.case_id,
      message_id: data.message_id || null,
      classification: data.classification || null,
      router_output: data.router_output || null,
      node_trace: data.node_trace || null,
      gate_decision: data.gate_decision || null,
      started_at: data.started_at || new Date().toISOString(),
      completed_at: null,
      duration_ms: null,
      created_at: new Date().toISOString()
    };
    decisionTraces.set(trace.id, trace);
    return trace;
  }

  async function completeDecisionTrace(traceId, updates) {
    const trace = decisionTraces.get(traceId);
    if (!trace) return null;
    if (updates.classification) trace.classification = updates.classification;
    if (updates.router_output) trace.router_output = updates.router_output;
    if (updates.node_trace) trace.node_trace = updates.node_trace;
    if (updates.gate_decision) trace.gate_decision = updates.gate_decision;
    trace.completed_at = new Date().toISOString();
    const start = new Date(trace.started_at).getTime();
    trace.duration_ms = Date.now() - start;
    return trace;
  }

  async function upsertEscalation(escalationData) {
    const escalation = {
      id: nextId(),
      case_id: escalationData.caseId,
      execution_key: escalationData.executionKey || null,
      reason: escalationData.reason,
      urgency: escalationData.urgency || 'medium',
      suggested_action: escalationData.suggestedAction || null,
      status: escalationData.status || 'OPEN',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      was_inserted: true
    };
    escalations.set(escalation.id, escalation);
    return { ...escalation, wasInserted: true };
  }

  async function createAgentDecision(decisionData) {
    const decision = {
      id: nextId(),
      case_id: decisionData.caseId,
      reasoning: decisionData.reasoning,
      action_taken: decisionData.actionTaken,
      confidence: decisionData.confidence || 0.8,
      trigger_type: decisionData.triggerType,
      outcome: decisionData.outcome || 'pending',
      created_at: new Date().toISOString()
    };
    agentDecisions.push(decision);
    return decision;
  }

  async function getAttachmentsByCaseId(caseId) {
    const result = [];
    for (const att of attachments.values()) {
      if (att.case_id === caseId) {
        result.push(att);
      }
    }
    result.sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));
    return result;
  }

  async function getAttachmentById(id) {
    return attachments.get(id) || null;
  }

  async function findAgencyByName(agencyName, state = null) {
    if (!agencyName) return null;
    for (const agency of agencies.values()) {
      if (agency.name === agencyName) {
        if (!state || agency.state === state) return agency;
      }
    }
    return null;
  }

  async function addCaseAgency(caseId, agencyData) {
    const caseAgency = {
      id: nextId(),
      case_id: caseId,
      agency_id: agencyData.agency_id || null,
      agency_name: agencyData.agency_name,
      agency_email: agencyData.agency_email || null,
      portal_url: agencyData.portal_url || null,
      portal_provider: agencyData.portal_provider || null,
      is_primary: agencyData.is_primary || false,
      is_active: true,
      added_source: agencyData.added_source || 'manual',
      status: agencyData.status || 'pending',
      notes: agencyData.notes || null,
      created_at: new Date().toISOString()
    };
    caseAgencies.set(caseAgency.id, caseAgency);
    return caseAgency;
  }

  async function getCaseAgencyById(caseAgencyId) {
    return caseAgencies.get(caseAgencyId) || null;
  }

  async function getDecisionTraceByRunId(runId) {
    let latest = null;
    for (const trace of decisionTraces.values()) {
      if (trace.run_id === runId) {
        if (!latest || (trace.created_at || '') > (latest.created_at || '')) {
          latest = trace;
        }
      }
    }
    return latest;
  }

  async function getDecisionTracesByCaseId(caseId, limit = 10) {
    const result = [];
    for (const trace of decisionTraces.values()) {
      if (trace.case_id === caseId) {
        result.push(trace);
      }
    }
    result.sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));
    return result.slice(0, limit);
  }

  // -----------------------------------------------------------------------
  // Raw query() — pattern-matches SQL text
  // -----------------------------------------------------------------------

  async function query(text, params = []) {
    const sql = (text || '').trim().toLowerCase();

    // Advisory lock/unlock
    if (sql.includes('pg_advisory_lock') || sql.includes('pg_try_advisory_lock') ||
        sql.includes('pg_advisory_unlock')) {
      return { rows: [{}], rowCount: 1 };
    }

    // response_analysis JOIN messages — used by decide-next-action
    if (sql.includes('response_analysis') && sql.includes('join') && sql.includes('messages')) {
      const caseId = params[0];
      const caseAnalyses = [];
      for (const [msgId, analysis] of analyses.entries()) {
        const msg = messages.get(msgId);
        if (msg && msg.case_id === caseId) {
          caseAnalyses.push({ ...analysis, message_id: msgId });
        }
        if (analysis.case_id === caseId && !caseAnalyses.find(a => a.id === analysis.id)) {
          caseAnalyses.push(analysis);
        }
      }
      caseAnalyses.sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));
      return { rows: caseAnalyses, rowCount: caseAnalyses.length };
    }

    // state_deadlines lookup — used by schedule-followups
    if (sql.includes('state_deadlines') || sql.includes('response_days')) {
      return { rows: [{ response_days: 10 }], rowCount: 1 };
    }

    // Proposal recovery query in gate node — SELECT from proposals WHERE case_id AND run_id
    if (sql.includes('proposals') && sql.includes('case_id') && sql.includes('run_id')) {
      const caseId = params[0];
      const runId = params[1];
      const matching = [];
      for (const p of proposals.values()) {
        if (p.case_id === caseId && p.run_id === runId) {
          matching.push(p);
        }
      }
      return { rows: matching, rowCount: matching.length };
    }

    // Generic proposals by case_id (dedup guard in upsertProposal, etc.)
    if (sql.includes('proposals') && sql.includes('case_id')) {
      const caseId = params[0];
      const matching = [];
      for (const p of proposals.values()) {
        if (p.case_id === caseId) {
          matching.push(p);
        }
      }
      return { rows: matching, rowCount: matching.length };
    }

    // Fallback — unknown queries
    console.warn('[MockDb] Unhandled query:', text.substring(0, 120), '| params:', params);
    return { rows: [], rowCount: 0 };
  }

  return {
    // Seed & reset
    seed,
    reset,

    // Cases
    getCaseById,
    updateCaseStatus,
    updateCase,
    updateCasePortalStatus,

    // Messages
    getMessageById,
    getMessagesByCaseId,
    getLatestInboundMessage,
    markMessageProcessed,

    // Analysis
    getLatestResponseAnalysis,
    getResponseAnalysisByMessageId,
    saveResponseAnalysis,

    // Proposals
    upsertProposal,
    getProposalById,
    getLatestPendingProposal,
    getAllProposalsByCaseId,
    updateProposal,
    claimProposalExecution,
    dismissPendingProposals,
    blockProposal,
    isProposalExecuted,
    getProposalsByRunId,

    // Runs
    createAgentRun,
    getAgentRunById,
    updateAgentRun,
    completeAgentRun,
    hasActiveAgentRun,
    updateAgentRunNodeProgress,
    getActiveRunForCase,
    skipAgentRun,

    // Other
    logActivity,
    logFeeEvent,
    getFollowUpScheduleByCaseId,
    upsertFollowUpSchedule,
    getThreadByCaseId,
    createDecisionTrace,
    completeDecisionTrace,
    upsertEscalation,
    createAgentDecision,
    getAttachmentsByCaseId,
    getAttachmentById,
    findAgencyByName,
    addCaseAgency,
    getCaseAgencyById,
    getDecisionTraceByRunId,
    getDecisionTracesByCaseId,

    // Raw SQL
    query,

    // Direct access to stores (for assertions in tests)
    _stores: {
      cases,
      messages,
      analyses,
      proposals,
      runs,
      activities,
      feeEvents,
      followups,
      threads,
      decisionTraces,
      escalations,
      agentDecisions,
      attachments,
      agencies,
      caseAgencies
    }
  };
}

// ---------------------------------------------------------------------------
// Mock AI Service
// ---------------------------------------------------------------------------

function createMockAiService() {
  return {
    async analyzeResponse(caseData, messageText, options = {}) {
      return {
        intent: 'acknowledgement',
        confidence_score: 0.85,
        sentiment: 'neutral',
        key_points: ['Request received', 'Will be processed'],
        extracted_deadline: null,
        extracted_fee_amount: null,
        requires_action: true,
        suggested_action: 'SEND_FOLLOWUP',
        full_analysis_json: { mock: true }
      };
    },

    async generateFollowUp(caseData, threadHistory = []) {
      return {
        subject: `Follow-up: FOIA Request - ${caseData.case_name || 'Case'}`,
        body: 'This is a mock follow-up email body. Please provide an update on our records request.',
        metadata: { mock: true }
      };
    },

    async generateDenialRebuttal(caseData, analysisData = {}) {
      return {
        subject: `Re: FOIA Request - Appeal of Denial`,
        body: 'This is a mock denial rebuttal. We respectfully challenge the cited exemption.',
        metadata: { mock: true }
      };
    },

    async generateClarificationResponse(caseData, clarificationRequest = '') {
      return {
        subject: `Re: Clarification - FOIA Request`,
        body: 'This is a mock clarification response providing the requested additional details.',
        metadata: { mock: true }
      };
    },

    async generateAutoReply(caseData, message, analysis = {}) {
      return {
        subject: `Re: ${message.subject || 'FOIA Request'}`,
        body: 'This is a mock auto-reply generated for the inbound message.',
        response_type: 'general',
        confidence: 0.8,
        metadata: { mock: true }
      };
    },

    async generateFeeResponse(caseData, feeAmount, options = {}) {
      return {
        subject: `Re: Fee Estimate - FOIA Request`,
        body: `This is a mock fee response. We agree to pay the estimated fee of $${feeAmount}.`,
        decision: 'accept',
        metadata: { mock: true }
      };
    },

    async generatePartialApprovalResponse(caseData, analysis = {}) {
      return {
        subject: `Re: Partial Approval - FOIA Request`,
        body: 'This is a mock partial approval response. We request the remaining withheld records.',
        metadata: { mock: true }
      };
    },

    async generateAgencyResearchBrief(caseData) {
      return {
        agency_name: caseData.agency_name || 'Unknown Agency',
        foia_email: caseData.agency_email || null,
        portal_url: caseData.portal_url || null,
        notes: 'Mock research brief — no real data queried.',
        metadata: { mock: true }
      };
    },

    async generateReformulatedRequest(caseData, feedback = '') {
      return {
        subject: `Revised FOIA Request - ${caseData.case_name || 'Case'}`,
        body: 'This is a mock reformulated request with narrowed scope.',
        metadata: { mock: true }
      };
    },

    async generateFOIARequest(caseData) {
      return {
        subject: `FOIA Request - ${caseData.case_name || 'Records Request'}`,
        body: 'This is a mock FOIA request generated for testing purposes.',
        metadata: { mock: true }
      };
    }
  };
}

// ---------------------------------------------------------------------------
// Mock Executor Adapter
// ---------------------------------------------------------------------------

function createMockExecutorAdapter() {
  const sentEmails = [];
  const portalTasks = [];
  const executionRecords = [];

  return {
    EXECUTION_MODE: 'DRY',

    isDryRun() {
      return true;
    },

    isLiveMode() {
      return false;
    },

    generateExecutionKey(caseId, actionType, proposalId) {
      const timestamp = Date.now();
      return `mock-exec:${caseId}:${actionType}:${proposalId || 'none'}:${timestamp}`;
    },

    async createExecutionRecord(data) {
      const record = {
        id: nextId(),
        case_id: data.caseId,
        proposal_id: data.proposalId || null,
        run_id: data.runId || null,
        execution_key: data.executionKey,
        action_type: data.actionType,
        status: data.status || 'QUEUED',
        provider: data.provider || null,
        provider_payload: data.providerPayload || null,
        error_message: data.errorMessage || null,
        created_at: new Date().toISOString()
      };
      executionRecords.push(record);
      return record;
    },

    async updateExecutionRecord(executionKey, updates) {
      const record = executionRecords.find(r => r.execution_key === executionKey);
      if (record) {
        Object.assign(record, updates);
      }
      return record || null;
    },

    emailExecutor: {
      async sendEmail(params) {
        const result = {
          success: true,
          dryRun: true,
          jobId: `mock-job-${nextId()}`,
          executionKey: `mock-exec:${params.caseId}:${params.actionType}:${Date.now()}`,
          status: 'SKIPPED'
        };
        sentEmails.push({ params, result });
        return result;
      },

      async markSent(executionKey, providerMessageId, providerResponse) {
        return { execution_key: executionKey, status: 'SENT' };
      },

      async markFailed(executionKey, errorMessage) {
        return { execution_key: executionKey, status: 'FAILED', error_message: errorMessage };
      }
    },

    portalExecutor: {
      requiresPortal(caseData) {
        return !!(
          caseData.portal_url ||
          caseData.delivery_method === 'portal' ||
          caseData.submission_method === 'portal'
        );
      },

      async createPortalTask(params) {
        const task = {
          id: nextId(),
          case_id: params.caseId,
          action_type: params.actionType,
          status: 'PENDING_HUMAN',
          portal_url: params.caseData ? params.caseData.portal_url : null,
          created_at: new Date().toISOString()
        };
        portalTasks.push(task);
        return {
          success: true,
          gated: true,
          taskId: task.id,
          status: 'PENDING_HUMAN',
          portalUrl: task.portal_url,
          message: 'Portal submission requires manual execution'
        };
      }
    },

    // Top-level createPortalTask (imported directly by decide-next-action)
    async createPortalTask(data) {
      const task = {
        id: nextId(),
        case_id: data.caseId,
        execution_id: data.executionId || null,
        proposal_id: data.proposalId || null,
        portal_url: data.portalUrl || null,
        action_type: data.actionType,
        subject: data.subject || null,
        body_text: data.bodyText || null,
        body_html: data.bodyHtml || null,
        status: data.status || 'PENDING',
        instructions: data.instructions || null,
        created_at: new Date().toISOString()
      };
      portalTasks.push(task);
      return task;
    },

    async updatePortalTask(taskId, updates) {
      const task = portalTasks.find(t => t.id === taskId);
      if (task) {
        Object.assign(task, updates);
      }
      return task || null;
    },

    async getPendingPortalTasks(limit = 50) {
      return portalTasks
        .filter(t => t.status === 'PENDING')
        .slice(0, limit);
    },

    async getPortalTaskById(taskId) {
      return portalTasks.find(t => t.id === taskId) || null;
    },

    // Expose internal stores for test assertions
    _stores: {
      sentEmails,
      portalTasks,
      executionRecords
    }
  };
}

// ---------------------------------------------------------------------------
// Mock Logger
// ---------------------------------------------------------------------------

function createMockLogger() {
  const logs = {
    info: [],
    warn: [],
    error: [],
    debug: [],
    http: []
  };

  function makeLogFn(level) {
    return function (message, meta) {
      logs[level].push({ message, meta, timestamp: new Date().toISOString() });
    };
  }

  function makeChildLogger(parentContext) {
    const child = {
      info: makeLogFn('info'),
      warn: makeLogFn('warn'),
      error: makeLogFn('error'),
      debug: makeLogFn('debug'),
      http: makeLogFn('http'),
      child(ctx) {
        return makeChildLogger({ ...parentContext, ...ctx });
      }
    };
    return child;
  }

  const logger = {
    info: makeLogFn('info'),
    warn: makeLogFn('warn'),
    error: makeLogFn('error'),
    debug: makeLogFn('debug'),
    http: makeLogFn('http'),

    // Child logger creators matching the real logger API
    forCase(caseId) {
      return makeChildLogger({ caseId });
    },
    forAgent(caseId, triggerType, runId = null) {
      return makeChildLogger({ caseId, triggerType, agentRunId: runId });
    },
    forWorker(queueName, jobId = null) {
      return makeChildLogger({ queueName, jobId });
    },
    forProposal(caseId, proposalId) {
      return makeChildLogger({ caseId, proposalId });
    },

    // Timing utilities
    timing(operation, durationMs, context = {}) {
      logs.info.push({ message: `${operation} completed`, meta: { ...context, durationMs } });
    },
    startTimer(operation, context = {}) {
      const start = Date.now();
      return function (additionalContext = {}) {
        return Date.now() - start;
      };
    },

    // Structured event loggers
    agentRunEvent(event, runData) {
      logs.info.push({ message: `Agent run ${event}`, meta: runData });
    },
    proposalEvent(event, proposalData) {
      logs.info.push({ message: `Proposal ${event}`, meta: proposalData });
    },
    policyViolation(ruleName, context) {
      logs.warn.push({ message: `Policy violation: ${ruleName}`, meta: context });
    },

    // The real logger also exposes a `logger` property pointing to the winston instance
    logger: null,

    // Direct access to captured logs for assertions
    _logs: logs,

    // Clear all captured logs
    _reset() {
      for (const level of Object.keys(logs)) {
        logs[level].length = 0;
      }
    }
  };

  // Self-reference so logger.logger.child() works if anything uses it
  logger.logger = logger;

  return logger;
}

// ---------------------------------------------------------------------------
// Mock Decision Memory Service
// ---------------------------------------------------------------------------

function createMockDecisionMemory() {
  return {
    async getRelevantLessons(caseData, options = {}) {
      return [];
    },

    formatLessonsForPrompt(lessons) {
      return '';
    }
  };
}

// ---------------------------------------------------------------------------
// Mock Discord Service
// ---------------------------------------------------------------------------

function createMockDiscord() {
  const sent = [];

  return {
    async sendCaseEscalation(caseData, escalation) {
      sent.push({ caseData, escalation, timestamp: new Date().toISOString() });
    },

    async notify(options) {
      sent.push({ options, timestamp: new Date().toISOString() });
    },

    async notifyRequestSent(caseData, method) {
      sent.push({ event: 'request_sent', caseData, method });
    },

    enabled: false,
    ready: false,

    _sent: sent
  };
}

// ---------------------------------------------------------------------------
// Mock SendGrid Service
// ---------------------------------------------------------------------------

function createMockSendgrid() {
  const sent = [];

  return {
    async sendEmail(params) {
      const messageId = `mock-msg-${nextId()}`;
      sent.push({ ...params, messageId });
      return { messageId };
    },

    async sendFOIARequest(caseId, requestText, subject, toEmail) {
      const messageId = `mock-msg-${nextId()}`;
      sent.push({ caseId, requestText, subject, toEmail, messageId });
      return { messageId };
    },

    async getFromEmail(caseId) {
      return 'mock@foib-request.com';
    },

    _sent: sent
  };
}

// ---------------------------------------------------------------------------
// Mock PD Contact Service
// ---------------------------------------------------------------------------

function createMockPdContact() {
  return {
    async preCheck(departmentName, location) {
      return {
        portalUrl: null,
        email: null,
        contactName: null,
        contactPhone: null,
        source: 'mock'
      };
    },

    async firecrawlSearch(departmentName, state) {
      return {
        portalUrl: null,
        email: null,
        source: 'firecrawl-mock'
      };
    },

    async saveToNotion(departmentName, contactData) {
      return { id: `mock-notion-${nextId()}` };
    },

    async lookupContact(departmentName, state) {
      return {
        portalUrl: null,
        email: null,
        contactName: null,
        contactPhone: null,
        foiaOfficer: null,
        source: 'mock-lookup'
      };
    }
  };
}

// ---------------------------------------------------------------------------
// Mock Email Queue
// ---------------------------------------------------------------------------

function createMockEmailQueue() {
  return {
    portalQueue: null,
    emailQueue: null
  };
}

// ---------------------------------------------------------------------------
// require.cache Injection
// ---------------------------------------------------------------------------

/**
 * Inject mock modules into require.cache BEFORE any graph code loads.
 *
 * Returns an object containing all mock instances so tests can access
 * them for seeding data and making assertions.
 */
function injectMocks(options = {}) {
  const db = options.db || createMockDb();
  const aiService = options.aiService || createMockAiService();
  const executor = options.executor || createMockExecutorAdapter();
  const logger = options.logger || createMockLogger();
  const decisionMemory = options.decisionMemory || createMockDecisionMemory();
  const discord = options.discord || createMockDiscord();
  const sendgrid = options.sendgrid || createMockSendgrid();
  const pdContact = options.pdContact || createMockPdContact();
  const emailQueue = options.emailQueue || createMockEmailQueue();

  const projectRoot = path.resolve(__dirname, '..');

  // Map of relative paths (from project root) to mock objects
  const mocks = {
    'services/database.js': db,
    'services/ai-service.js': aiService,
    'services/executor-adapter.js': executor,
    'services/logger.js': logger,
    'services/decision-memory-service.js': decisionMemory,
    'services/discord-service.js': discord,
    'services/sendgrid-service.js': sendgrid,
    'services/pd-contact-service.js': pdContact,
    'queues/email-queue.js': emailQueue
  };

  for (const [relativePath, mockExport] of Object.entries(mocks)) {
    const fullPath = path.join(projectRoot, relativePath);
    const resolvedPath = resolveModulePath(fullPath);

    // Create a fake Module entry in require.cache
    require.cache[resolvedPath] = {
      id: resolvedPath,
      filename: resolvedPath,
      loaded: true,
      exports: mockExport,
      paths: [],
      children: [],
      parent: null
    };
  }

  return {
    db,
    aiService,
    executor,
    logger,
    decisionMemory,
    discord,
    sendgrid,
    pdContact,
    emailQueue
  };
}

/**
 * Resolve a module path to the absolute path that Node would use
 * as a cache key. Tries require.resolve first, falling back to the
 * raw path (the file may not exist yet in a test environment).
 */
function resolveModulePath(fullPath) {
  try {
    return require.resolve(fullPath);
  } catch {
    // File may not exist yet; use the raw path with .js extension
    if (!fullPath.endsWith('.js')) {
      return fullPath + '.js';
    }
    return fullPath;
  }
}

/**
 * Remove all injected mocks from require.cache.
 * Call this in test teardown to avoid cross-test pollution.
 */
function clearMocks() {
  const projectRoot = path.resolve(__dirname, '..');
  const mockPaths = [
    'services/database.js',
    'services/ai-service.js',
    'services/executor-adapter.js',
    'services/logger.js',
    'services/decision-memory-service.js',
    'services/discord-service.js',
    'services/sendgrid-service.js',
    'services/pd-contact-service.js',
    'queues/email-queue.js'
  ];

  for (const relativePath of mockPaths) {
    const fullPath = path.join(projectRoot, relativePath);
    const resolvedPath = resolveModulePath(fullPath);
    delete require.cache[resolvedPath];
  }
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  // Primary API
  injectMocks,
  clearMocks,

  // Individual mock factories (for custom configuration)
  createMockDb,
  createMockAiService,
  createMockExecutorAdapter,
  createMockLogger,
  createMockDecisionMemory,
  createMockDiscord,
  createMockSendgrid,
  createMockPdContact,
  createMockEmailQueue,

  // Utilities
  nextId,
  resetIdCounter
};
