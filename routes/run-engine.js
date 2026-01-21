/**
 * Run Engine Routes
 *
 * Phase 3: Public APIs for triggering and resuming agent runs.
 *
 * Routes:
 * - POST /cases/:id/run-initial   - Trigger initial FOIA request generation
 * - POST /cases/:id/run-inbound   - Process inbound message
 * - POST /proposals/:id/decision  - Submit human decision to resume
 *
 * Each route creates an agent_run record for auditability and enqueues
 * the appropriate worker job.
 */

const express = require('express');
const router = express.Router();
const db = require('../services/database');
const { enqueueInitialRequestJob, enqueueInboundMessageJob, enqueueResumeRunJob, enqueueFollowupTriggerJob } = require('../queues/agent-queue');
const logger = require('../services/logger');

/**
 * POST /cases/:id/run-initial
 *
 * Trigger initial FOIA request generation for a case.
 * Creates agent_run record and enqueues worker job.
 *
 * Body (optional):
 * - autopilotMode: 'AUTO' | 'SUPERVISED' (default: 'SUPERVISED')
 * - llmStubs: Object with stubbed LLM responses for testing
 */
router.post('/cases/:id/run-initial', async (req, res) => {
  const caseId = parseInt(req.params.id);
  const { autopilotMode = 'SUPERVISED', llmStubs } = req.body || {};

  try {
    // Verify case exists
    const caseData = await db.getCaseById(caseId);
    if (!caseData) {
      return res.status(404).json({
        success: false,
        error: `Case ${caseId} not found`
      });
    }

    // Check for existing active run
    const existingRun = await db.getActiveRunForCase(caseId);
    if (existingRun) {
      return res.status(409).json({
        success: false,
        error: 'Case already has an active agent run',
        activeRun: {
          id: existingRun.id,
          status: existingRun.status,
          trigger_type: existingRun.trigger_type,
          started_at: existingRun.started_at
        }
      });
    }

    // Create run record
    const run = await db.createAgentRunFull({
      case_id: caseId,
      trigger_type: 'initial_request',
      status: 'queued',
      autopilot_mode: autopilotMode,
      langgraph_thread_id: `initial:${caseId}:${Date.now()}`
    });

    // Enqueue worker job
    const job = await enqueueInitialRequestJob(run.id, caseId, {
      autopilotMode,
      threadId: run.langgraph_thread_id,
      llmStubs
    });

    logger.info('Initial request job enqueued', {
      runId: run.id,
      caseId,
      jobId: job.id
    });

    res.status(202).json({
      success: true,
      message: 'Initial request generation queued',
      run: {
        id: run.id,
        status: run.status,
        thread_id: run.langgraph_thread_id
      },
      job_id: job.id
    });

  } catch (error) {
    logger.error('Error creating initial request run', { caseId, error: error.message });
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * POST /cases/:id/run-inbound
 *
 * Trigger processing of an inbound message for a case.
 * Creates agent_run record and enqueues worker job.
 *
 * Body:
 * - messageId: (required) ID of the inbound message to process
 * - autopilotMode: 'AUTO' | 'SUPERVISED' (default: 'SUPERVISED')
 * - llmStubs: Object with stubbed LLM responses for testing
 */
router.post('/cases/:id/run-inbound', async (req, res) => {
  const caseId = parseInt(req.params.id);
  const { messageId, autopilotMode = 'SUPERVISED', llmStubs } = req.body || {};

  try {
    // Validate messageId
    if (!messageId) {
      return res.status(400).json({
        success: false,
        error: 'messageId is required'
      });
    }

    // Verify case exists
    const caseData = await db.getCaseById(caseId);
    if (!caseData) {
      return res.status(404).json({
        success: false,
        error: `Case ${caseId} not found`
      });
    }

    // Verify message exists and belongs to case
    const message = await db.getMessageById(messageId);
    if (!message) {
      return res.status(404).json({
        success: false,
        error: `Message ${messageId} not found`
      });
    }

    // Check message already processed
    if (message.processed_at) {
      return res.status(409).json({
        success: false,
        error: 'Message already processed',
        processed_at: message.processed_at,
        processed_run_id: message.processed_run_id
      });
    }

    // Check for existing active run for this case
    const existingRun = await db.getActiveRunForCase(caseId);
    if (existingRun) {
      return res.status(409).json({
        success: false,
        error: 'Case already has an active agent run',
        activeRun: {
          id: existingRun.id,
          status: existingRun.status,
          trigger_type: existingRun.trigger_type,
          started_at: existingRun.started_at
        }
      });
    }

    // Create run record
    const run = await db.createAgentRunFull({
      case_id: caseId,
      trigger_type: 'inbound_message',
      message_id: messageId,
      status: 'queued',
      autopilot_mode: autopilotMode,
      langgraph_thread_id: `case:${caseId}:msg-${messageId}`
    });

    // Enqueue worker job
    const job = await enqueueInboundMessageJob(run.id, caseId, messageId, {
      autopilotMode,
      threadId: run.langgraph_thread_id,
      llmStubs
    });

    logger.info('Inbound message job enqueued', {
      runId: run.id,
      caseId,
      messageId,
      jobId: job.id
    });

    res.status(202).json({
      success: true,
      message: 'Inbound message processing queued',
      run: {
        id: run.id,
        status: run.status,
        message_id: messageId,
        thread_id: run.langgraph_thread_id
      },
      job_id: job.id
    });

  } catch (error) {
    logger.error('Error creating inbound message run', { caseId, error: error.message });
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * POST /proposals/:id/decision
 *
 * Submit a human decision for a pending proposal.
 * Updates proposal status and enqueues resume job.
 *
 * Body:
 * - action: 'APPROVE' | 'ADJUST' | 'DISMISS' | 'WITHDRAW' (required)
 * - instruction: Optional text instruction for ADJUST action
 * - reason: Optional reason for the decision
 */
router.post('/proposals/:id/decision', async (req, res) => {
  const proposalId = parseInt(req.params.id);
  const { action, instruction, reason } = req.body || {};

  try {
    // Validate action
    const validActions = ['APPROVE', 'ADJUST', 'DISMISS', 'WITHDRAW'];
    if (!action || !validActions.includes(action)) {
      return res.status(400).json({
        success: false,
        error: `action must be one of: ${validActions.join(', ')}`
      });
    }

    // Fetch proposal
    const proposal = await db.getProposalById(proposalId);
    if (!proposal) {
      return res.status(404).json({
        success: false,
        error: `Proposal ${proposalId} not found`
      });
    }

    // Check proposal is pending approval
    if (proposal.status !== 'PENDING_APPROVAL') {
      return res.status(409).json({
        success: false,
        error: `Proposal is not pending approval`,
        current_status: proposal.status
      });
    }

    const caseId = proposal.case_id;

    // Check for existing active run
    const existingRun = await db.getActiveRunForCase(caseId);
    if (existingRun) {
      // If the run is paused (waiting for this decision), complete it before resuming
      if (existingRun.status === 'paused') {
        logger.info('Completing paused run before processing decision', {
          runId: existingRun.id,
          proposalId
        });
        await db.updateAgentRun(existingRun.id, {
          status: 'completed',
          ended_at: new Date()
        });
      } else {
        // Run is actually active (queued/running), block the decision
        return res.status(409).json({
          success: false,
          error: 'Case already has an active agent run',
          activeRun: {
            id: existingRun.id,
            status: existingRun.status,
            trigger_type: existingRun.trigger_type
          }
        });
      }
    }

    // Build human decision object (full details for graph, action-only for DB until JSONB migration)
    const humanDecision = {
      action,
      proposalId,
      instruction: instruction || null,
      reason: reason || null,
      decidedAt: new Date().toISOString(),
      decidedBy: req.body.decidedBy || 'human'
    };

    // Update proposal with human decision
    // Note: human_decision column is VARCHAR(50), so we store just the action
    // The full humanDecision object is passed to the graph via the job data
    await db.updateProposal(proposalId, {
      human_decision: action, // Store just the action string for now
      status: action === 'DISMISS' || action === 'WITHDRAW' ? 'DISMISSED' : 'DECISION_RECEIVED'
    });

    // For DISMISS/WITHDRAW, no need to resume graph
    if (action === 'DISMISS' || action === 'WITHDRAW') {
      logger.info('Proposal dismissed/withdrawn', { proposalId, action });
      return res.json({
        success: true,
        message: `Proposal ${action.toLowerCase()}ed`,
        proposal_id: proposalId,
        action
      });
    }

    // Create resume run record
    const run = await db.createAgentRunFull({
      case_id: caseId,
      trigger_type: 'resume',
      status: 'queued',
      autopilot_mode: proposal.autopilot_mode || 'SUPERVISED',
      langgraph_thread_id: `resume:${caseId}:proposal-${proposalId}`
    });

    // Determine which graph to resume based on proposal action type
    const isInitialRequest = proposal.action_type === 'SEND_INITIAL_REQUEST';

    // Enqueue resume job
    const job = await enqueueResumeRunJob(run.id, caseId, humanDecision, {
      isInitialRequest,
      originalProposalId: proposalId
    });

    logger.info('Resume job enqueued', {
      runId: run.id,
      caseId,
      proposalId,
      action,
      jobId: job.id
    });

    res.status(202).json({
      success: true,
      message: 'Decision received, resume queued',
      run: {
        id: run.id,
        status: run.status
      },
      proposal_id: proposalId,
      action,
      job_id: job.id
    });

  } catch (error) {
    logger.error('Error processing proposal decision', { proposalId, error: error.message });
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * POST /cases/:id/run-followup
 *
 * Manually trigger a follow-up for a case.
 * Creates agent_run record and enqueues worker job.
 *
 * Body (optional):
 * - autopilotMode: 'AUTO' | 'SUPERVISED' (default: 'SUPERVISED')
 * - followupScheduleId: ID of the follow_up_schedule record (optional, will lookup if not provided)
 */
router.post('/cases/:id/run-followup', async (req, res) => {
  const caseId = parseInt(req.params.id);
  const { autopilotMode = 'SUPERVISED', followupScheduleId } = req.body || {};

  try {
    // Verify case exists
    const caseData = await db.getCaseById(caseId);
    if (!caseData) {
      return res.status(404).json({
        success: false,
        error: `Case ${caseId} not found`
      });
    }

    // Check case is in appropriate status
    if (!['sent', 'awaiting_response'].includes(caseData.status)) {
      return res.status(400).json({
        success: false,
        error: `Case status must be 'sent' or 'awaiting_response' for follow-up`,
        current_status: caseData.status
      });
    }

    // Check for existing active run
    const existingRun = await db.getActiveRunForCase(caseId);
    if (existingRun) {
      return res.status(409).json({
        success: false,
        error: 'Case already has an active agent run',
        activeRun: {
          id: existingRun.id,
          status: existingRun.status,
          trigger_type: existingRun.trigger_type,
          started_at: existingRun.started_at
        }
      });
    }

    // Get or validate follow-up schedule
    let followupSchedule;
    if (followupScheduleId) {
      followupSchedule = await db.getFollowUpScheduleById(followupScheduleId);
      if (!followupSchedule || followupSchedule.case_id !== caseId) {
        return res.status(404).json({
          success: false,
          error: `Follow-up schedule ${followupScheduleId} not found or does not belong to case`
        });
      }
    } else {
      // Lookup schedule by case_id
      followupSchedule = await db.getFollowUpScheduleByCaseId(caseId);
    }

    const followupCount = followupSchedule?.followup_count || 0;
    const today = new Date().toISOString().split('T')[0];
    const scheduledKey = `followup:${caseId}:${followupCount}:manual:${today}`;

    // Create run record
    const run = await db.createAgentRunFull({
      case_id: caseId,
      trigger_type: 'followup_trigger',
      scheduled_key: scheduledKey,
      status: 'queued',
      autopilot_mode: autopilotMode,
      langgraph_thread_id: `followup:${caseId}:${followupCount}:${Date.now()}`
    });

    // Update follow-up schedule if it exists
    if (followupSchedule) {
      await db.query(`
        UPDATE follow_up_schedule
        SET status = 'processing',
            scheduled_key = $2,
            last_run_id = $3,
            updated_at = NOW()
        WHERE id = $1
      `, [followupSchedule.id, scheduledKey, run.id]);
    }

    // Enqueue worker job
    const job = await enqueueFollowupTriggerJob(run.id, caseId, followupSchedule?.id || null, {
      autopilotMode,
      threadId: run.langgraph_thread_id,
      followupCount,
      manualTrigger: true
    });

    logger.info('Follow-up trigger job enqueued', {
      runId: run.id,
      caseId,
      jobId: job.id,
      followupCount,
      manualTrigger: true
    });

    res.status(202).json({
      success: true,
      message: 'Follow-up generation queued',
      run: {
        id: run.id,
        status: run.status,
        thread_id: run.langgraph_thread_id
      },
      followup: {
        count: followupCount,
        schedule_id: followupSchedule?.id || null
      },
      job_id: job.id
    });

  } catch (error) {
    logger.error('Error creating followup run', { caseId, error: error.message });
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * POST /followups/:id/trigger
 *
 * Manually trigger a specific follow-up schedule.
 * Creates agent_run record and enqueues worker job.
 *
 * Body (optional):
 * - autopilotMode: 'AUTO' | 'SUPERVISED' (default from schedule or 'SUPERVISED')
 */
router.post('/followups/:id/trigger', async (req, res) => {
  const followupId = parseInt(req.params.id);
  const { autopilotMode } = req.body || {};

  try {
    // Get follow-up schedule
    const followupSchedule = await db.getFollowUpScheduleById(followupId);
    if (!followupSchedule) {
      return res.status(404).json({
        success: false,
        error: `Follow-up schedule ${followupId} not found`
      });
    }

    const caseId = followupSchedule.case_id;

    // Verify case exists
    const caseData = await db.getCaseById(caseId);
    if (!caseData) {
      return res.status(404).json({
        success: false,
        error: `Case ${caseId} not found`
      });
    }

    // Check for existing active run
    const existingRun = await db.getActiveRunForCase(caseId);
    if (existingRun) {
      return res.status(409).json({
        success: false,
        error: 'Case already has an active agent run',
        activeRun: {
          id: existingRun.id,
          status: existingRun.status,
          trigger_type: existingRun.trigger_type,
          started_at: existingRun.started_at
        }
      });
    }

    const followupCount = followupSchedule.followup_count || 0;
    const mode = autopilotMode || followupSchedule.autopilot_mode || caseData.autopilot_mode || 'SUPERVISED';
    const today = new Date().toISOString().split('T')[0];
    const scheduledKey = `followup:${caseId}:${followupCount}:manual:${today}`;

    // Create run record
    const run = await db.createAgentRunFull({
      case_id: caseId,
      trigger_type: 'followup_trigger',
      scheduled_key: scheduledKey,
      status: 'queued',
      autopilot_mode: mode,
      langgraph_thread_id: `followup:${caseId}:${followupCount}:${Date.now()}`
    });

    // Update follow-up schedule
    await db.query(`
      UPDATE follow_up_schedule
      SET status = 'processing',
          scheduled_key = $2,
          last_run_id = $3,
          updated_at = NOW()
      WHERE id = $1
    `, [followupId, scheduledKey, run.id]);

    // Enqueue worker job
    const job = await enqueueFollowupTriggerJob(run.id, caseId, followupId, {
      autopilotMode: mode,
      threadId: run.langgraph_thread_id,
      followupCount,
      manualTrigger: true
    });

    logger.info('Follow-up trigger job enqueued', {
      runId: run.id,
      caseId,
      followupId,
      jobId: job.id,
      followupCount,
      manualTrigger: true
    });

    res.status(202).json({
      success: true,
      message: 'Follow-up generation queued',
      run: {
        id: run.id,
        status: run.status,
        thread_id: run.langgraph_thread_id
      },
      followup: {
        id: followupId,
        count: followupCount,
        autopilot_mode: mode
      },
      job_id: job.id
    });

  } catch (error) {
    logger.error('Error triggering followup', { followupId, error: error.message });
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /proposals
 *
 * List proposals, with optional filters.
 * Used by the Approval Queue UI.
 *
 * Query params:
 * - status: Filter by status (default: 'PENDING_APPROVAL')
 * - case_id: Filter by case ID
 * - limit: Max results (default: 50)
 */
router.get('/proposals', async (req, res) => {
  const status = req.query.status || 'PENDING_APPROVAL';
  const caseId = req.query.case_id ? parseInt(req.query.case_id) : null;
  const limit = parseInt(req.query.limit) || 50;

  try {
    let query = `
      SELECT
        p.id,
        p.case_id,
        p.proposal_key,
        p.action_type,
        p.draft_subject,
        p.draft_body_text,
        p.draft_body_html,
        p.reasoning,
        p.confidence,
        p.risk_flags,
        p.warnings,
        p.can_auto_execute,
        p.requires_human,
        p.pause_reason,
        p.status,
        p.human_decision,
        p.created_at,
        p.updated_at,
        c.case_name,
        c.subject_name,
        c.agency_name,
        c.state AS agency_state,
        c.status AS case_status,
        c.autopilot_mode,
        ra.intent AS classification,
        ra.sentiment,
        ra.extracted_fee_amount
      FROM proposals p
      JOIN cases c ON p.case_id = c.id
      LEFT JOIN response_analysis ra ON ra.case_id = c.id
        AND ra.id = (SELECT MAX(id) FROM response_analysis WHERE case_id = c.id)
      WHERE p.status = $1
    `;

    const params = [status];
    let paramIndex = 2;

    if (caseId) {
      query += ` AND p.case_id = $${paramIndex}`;
      params.push(caseId);
      paramIndex++;
    }

    query += ` ORDER BY p.created_at DESC LIMIT $${paramIndex}`;
    params.push(limit);

    const result = await db.query(query, params);

    res.json({
      success: true,
      count: result.rows.length,
      proposals: result.rows.map(row => ({
        id: row.id,
        case_id: row.case_id,
        proposal_key: row.proposal_key,
        action_type: row.action_type,
        draft_subject: row.draft_subject,
        draft_body_text: row.draft_body_text,
        draft_body_html: row.draft_body_html,
        reasoning: row.reasoning,
        confidence: row.confidence,
        risk_flags: row.risk_flags,
        warnings: row.warnings,
        can_auto_execute: row.can_auto_execute,
        requires_human: row.requires_human,
        pause_reason: row.pause_reason,
        status: row.status,
        human_decision: row.human_decision,
        created_at: row.created_at,
        updated_at: row.updated_at,
        case: {
          name: row.case_name,
          subject_name: row.subject_name,
          agency_name: row.agency_name,
          state: row.agency_state,
          status: row.case_status,
          autopilot_mode: row.autopilot_mode
        },
        analysis: {
          classification: row.classification,
          sentiment: row.sentiment,
          extracted_fee_amount: row.extracted_fee_amount
        }
      }))
    });

  } catch (error) {
    logger.error('Error fetching proposals', { error: error.message });
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /proposals/:id
 *
 * Get a single proposal with full details.
 */
router.get('/proposals/:id', async (req, res) => {
  const proposalId = parseInt(req.params.id);

  try {
    const proposal = await db.getProposalById(proposalId);
    if (!proposal) {
      return res.status(404).json({
        success: false,
        error: `Proposal ${proposalId} not found`
      });
    }

    // Get case details
    const caseData = await db.getCaseById(proposal.case_id);

    // Get latest response analysis
    const analysis = await db.getLatestResponseAnalysis(proposal.case_id);

    res.json({
      success: true,
      proposal: {
        ...proposal,
        case: caseData ? {
          name: caseData.case_name,
          subject_name: caseData.subject_name,
          agency_name: caseData.agency_name,
          state: caseData.state,
          status: caseData.status,
          autopilot_mode: caseData.autopilot_mode
        } : null,
        analysis: analysis ? {
          classification: analysis.classification,
          sentiment: analysis.sentiment,
          extracted_fee_amount: analysis.extracted_fee
        } : null
      }
    });

  } catch (error) {
    logger.error('Error fetching proposal', { proposalId, error: error.message });
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /runs
 *
 * List recent agent runs across all cases.
 * Used by the Runs dashboard page.
 *
 * Query params:
 * - status: Filter by status (optional)
 * - case_id: Filter by case ID (optional)
 * - limit: Max results (default: 50)
 */
router.get('/runs', async (req, res) => {
  const status = req.query.status || null;
  const caseId = req.query.case_id ? parseInt(req.query.case_id) : null;
  const limit = parseInt(req.query.limit) || 50;

  // Helper to map DB status to UI status
  const mapRunStatus = (dbStatus) => {
    const statusMap = {
      'created': 'running',
      'queued': 'running',
      'running': 'running',
      'completed': 'completed',
      'finished': 'completed',
      'failed': 'failed',
      'error': 'failed',
      'gated': 'gated',
      'paused': 'gated',
      'skipped': 'completed'
    };
    return statusMap[dbStatus] || 'running';
  };

  try {
    let query = `
      SELECT
        ar.id,
        ar.case_id,
        ar.trigger_type,
        ar.status,
        ar.langgraph_thread_id,
        ar.proposal_id,
        ar.autopilot_mode,
        ar.error AS error_message,
        ar.started_at,
        ar.ended_at AS completed_at,
        ar.metadata,
        c.case_name,
        c.subject_name,
        p.action_type AS final_action
      FROM agent_runs ar
      LEFT JOIN cases c ON ar.case_id = c.id
      LEFT JOIN proposals p ON ar.proposal_id = p.id
      WHERE 1=1
    `;

    const params = [];
    let paramIndex = 1;

    if (status) {
      query += ` AND ar.status = $${paramIndex}`;
      params.push(status);
      paramIndex++;
    }

    if (caseId) {
      query += ` AND ar.case_id = $${paramIndex}`;
      params.push(caseId);
      paramIndex++;
    }

    query += ` ORDER BY ar.started_at DESC LIMIT $${paramIndex}`;
    params.push(limit);

    const result = await db.query(query, params);

    // Map to expected format with string IDs for frontend compatibility
    const runs = result.rows.map(row => ({
      id: String(row.id),
      case_id: String(row.case_id),
      trigger_type: row.trigger_type || 'unknown',
      status: mapRunStatus(row.status),
      started_at: row.started_at,
      completed_at: row.completed_at,
      error_message: row.error_message,
      final_action: row.final_action,
      case_name: row.case_name || row.subject_name,
      gated_reason: row.status === 'gated' ? 'Requires human approval' : null,
      node_trace: row.metadata?.nodeTrace || null
    }));

    res.json({
      success: true,
      runs
    });

  } catch (error) {
    logger.error('Error fetching runs', { error: error.message });
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /runs/:id
 *
 * Get status and details of an agent run.
 */
router.get('/runs/:id', async (req, res) => {
  const runId = parseInt(req.params.id);

  try {
    const run = await db.getAgentRunById(runId);
    if (!run) {
      return res.status(404).json({
        success: false,
        error: `Run ${runId} not found`
      });
    }

    // Get associated proposals
    const proposals = await db.getProposalsByRunId(runId);

    // Get decision trace if available
    const decisionTrace = await db.getDecisionTraceByRunId(runId);

    res.json({
      success: true,
      run,
      proposals,
      decision_trace: decisionTrace
    });

  } catch (error) {
    logger.error('Error fetching run', { runId, error: error.message });
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /cases/:id/runs
 *
 * Get all agent runs for a case.
 */
router.get('/cases/:id/runs', async (req, res) => {
  const caseId = parseInt(req.params.id);
  const limit = parseInt(req.query.limit) || 20;

  try {
    const runs = await db.getAgentRunsByCaseId(caseId, limit);

    res.json({
      success: true,
      count: runs.length,
      runs
    });

  } catch (error) {
    logger.error('Error fetching case runs', { caseId, error: error.message });
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * POST /runs/:id/cancel
 *
 * Cancel a stuck or running agent run.
 * Marks the run as failed so new runs can be started.
 */
router.post('/runs/:id/cancel', async (req, res) => {
  const runId = parseInt(req.params.id);
  const { reason } = req.body || {};

  try {
    // Update the run status to failed
    await db.query(`
      UPDATE agent_runs
      SET status = 'failed',
          ended_at = NOW(),
          error = $2
      WHERE id = $1
    `, [runId, reason || 'Cancelled by user']);

    logger.info('Agent run cancelled', { runId, reason });

    res.json({
      success: true,
      message: `Run ${runId} cancelled`,
      run_id: runId
    });

  } catch (error) {
    logger.error('Error cancelling run', { runId, error: error.message });
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

module.exports = router;
