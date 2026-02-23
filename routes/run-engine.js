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
  const { autopilotMode = 'SUPERVISED', llmStubs, route_mode } = req.body || {};

  try {
    // Verify case exists
    const caseData = await db.getCaseById(caseId);
    if (!caseData) {
      return res.status(404).json({
        success: false,
        error: `Case ${caseId} not found`
      });
    }

    const hasPortal = !!caseData.portal_url;
    const hasEmail = !!caseData.agency_email;
    const normalizedRouteMode = typeof route_mode === 'string' ? route_mode.toLowerCase() : null;

    if (normalizedRouteMode && !['email', 'portal'].includes(normalizedRouteMode)) {
      return res.status(400).json({
        success: false,
        error: 'route_mode must be one of: email, portal'
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
      langgraph_thread_id: `initial:${caseId}:${Date.now()}`,
      metadata: {
        route_mode: normalizedRouteMode || null
      }
    });

    // Enqueue worker job (clean up orphaned run on failure)
    let job;
    try {
      job = await enqueueInitialRequestJob(run.id, caseId, {
        autopilotMode,
        threadId: run.langgraph_thread_id,
        llmStubs
      });
    } catch (enqueueError) {
      await db.updateAgentRun(run.id, { status: 'failed', ended_at: new Date(), error: `Enqueue failed: ${enqueueError.message}` });
      throw enqueueError;
    }

    logger.info('Initial request job enqueued', {
      runId: run.id,
      caseId,
      jobId: job.id
    });

    res.status(202).json({
      success: true,
      message: 'Initial request generation queued',
      route_mode: normalizedRouteMode || null,
      run: {
        id: run.id,
        status: run.status,
        thread_id: run.langgraph_thread_id
      },
      job_id: job.id
    });

  } catch (error) {
    // Fix J: Handle unique constraint violation (concurrent run creation)
    if (error.code === '23505' && String(error.constraint || '').includes('one_active_per_case')) {
      return res.status(409).json({ success: false, error: 'Case already has an active agent run (constraint)' });
    }
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

    // Enqueue worker job (clean up orphaned run on failure)
    let job;
    try {
      job = await enqueueInboundMessageJob(run.id, caseId, messageId, {
        autopilotMode,
        threadId: run.langgraph_thread_id,
        llmStubs
      });
    } catch (enqueueError) {
      await db.updateAgentRun(run.id, { status: 'failed', ended_at: new Date(), error: `Enqueue failed: ${enqueueError.message}` });
      throw enqueueError;
    }

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
    if (error.code === '23505' && String(error.constraint || '').includes('one_active_per_case')) {
      return res.status(409).json({ success: false, error: 'Case already has an active agent run (constraint)' });
    }
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

    // Build human decision object (full details for graph and DB)
    const humanDecision = {
      action,
      proposalId,
      instruction: instruction || null,
      reason: reason || null,
      decidedAt: new Date().toISOString(),
      decidedBy: req.body.decidedBy || 'human'
    };

    // For DISMISS/WITHDRAW, update proposal and return — no need to resume graph
    if (action === 'DISMISS' || action === 'WITHDRAW') {
      await db.updateProposal(proposalId, {
        human_decision: humanDecision,
        status: 'DISMISSED'
      });
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

    // Enqueue resume job (clean up orphaned run on failure)
    let job;
    try {
      job = await enqueueResumeRunJob(run.id, caseId, humanDecision, {
        isInitialRequest,
        originalProposalId: proposalId
      });
    } catch (enqueueError) {
      await db.updateAgentRun(run.id, { status: 'failed', ended_at: new Date(), error: `Enqueue failed: ${enqueueError.message}` });
      throw enqueueError;
    }

    // Fix G: Only mark DECISION_RECEIVED AFTER enqueue succeeds (prevents split-brain)
    await db.updateProposal(proposalId, {
      human_decision: humanDecision,
      status: 'DECISION_RECEIVED'
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
    if (error.code === '23505' && String(error.constraint || '').includes('one_active_per_case')) {
      return res.status(409).json({ success: false, error: 'Case already has an active agent run (constraint)' });
    }
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

    // Enqueue worker job (clean up orphaned run on failure)
    let job;
    try {
      job = await enqueueFollowupTriggerJob(run.id, caseId, followupSchedule?.id || null, {
        autopilotMode,
        threadId: run.langgraph_thread_id,
        followupCount,
        manualTrigger: true
      });
    } catch (enqueueError) {
      await db.updateAgentRun(run.id, { status: 'failed', ended_at: new Date(), error: `Enqueue failed: ${enqueueError.message}` });
      throw enqueueError;
    }

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
    if (error.code === '23505' && String(error.constraint || '').includes('one_active_per_case')) {
      return res.status(409).json({ success: false, error: 'Case already has an active agent run (constraint)' });
    }
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

    // Enqueue worker job (clean up orphaned run on failure)
    let job;
    try {
      job = await enqueueFollowupTriggerJob(run.id, caseId, followupId, {
        autopilotMode: mode,
        threadId: run.langgraph_thread_id,
        followupCount,
        manualTrigger: true
      });
    } catch (enqueueError) {
      await db.updateAgentRun(run.id, { status: 'failed', ended_at: new Date(), error: `Enqueue failed: ${enqueueError.message}` });
      throw enqueueError;
    }

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
    if (error.code === '23505' && String(error.constraint || '').includes('one_active_per_case')) {
      return res.status(409).json({ success: false, error: 'Case already has an active agent run (constraint)' });
    }
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
        ar.message_id,
        ar.autopilot_mode,
        ar.error AS error_message,
        ar.started_at,
        ar.ended_at AS completed_at,
        ar.metadata,
        c.case_name,
        c.subject_name,
        c.pause_reason,
        p.action_type AS final_action,
        p.confidence,
        p.risk_flags,
        p.draft_subject,
        p.draft_body_text,
        p.reasoning,
        p.warnings,
        p.status AS proposal_status,
        m.from_email AS trigger_from_email,
        m.subject AS trigger_subject,
        m.body_text AS trigger_body_text,
        m.created_at AS trigger_received_at,
        ra.intent AS trigger_classification,
        ra.sentiment AS trigger_sentiment,
        EXTRACT(EPOCH FROM (NOW() - ar.started_at)) AS duration_seconds
      FROM agent_runs ar
      LEFT JOIN cases c ON ar.case_id = c.id
      LEFT JOIN proposals p ON ar.proposal_id = p.id
      LEFT JOIN messages m ON ar.message_id = m.id
      LEFT JOIN response_analysis ra ON ra.message_id = m.id
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
    const runs = result.rows.map(row => {
      const durationSeconds = row.duration_seconds ? Math.round(parseFloat(row.duration_seconds)) : null;
      const isStuck = row.status === 'running' && durationSeconds && durationSeconds > 120;

      return {
        id: String(row.id),
        case_id: String(row.case_id),
        trigger_type: row.trigger_type || 'unknown',
        status: mapRunStatus(row.status),
        started_at: row.started_at,
        completed_at: row.completed_at,
        duration_seconds: durationSeconds,
        is_stuck: isStuck,
        error_message: row.error_message,
        final_action: row.final_action,
        case_name: row.case_name || row.subject_name,
        pause_reason: row.pause_reason,
        gated_reason: row.status === 'gated' ? 'Requires human approval' : null,
        node_trace: row.metadata?.nodeTrace || null,
        // Proposal data for gated runs
        proposal_id: row.proposal_id ? String(row.proposal_id) : null,
        proposal: row.proposal_id ? {
          action_type: row.final_action,
          confidence: row.confidence,
          risk_flags: row.risk_flags,
          draft_subject: row.draft_subject,
          draft_preview: row.draft_body_text ? row.draft_body_text.slice(0, 200) : null,
          reasoning: row.reasoning,
          warnings: row.warnings,
          status: row.proposal_status
        } : null,
        // Triggering inbound message data
        trigger_message: row.message_id ? {
          id: String(row.message_id),
          from_email: row.trigger_from_email,
          subject: row.trigger_subject,
          body_text: row.trigger_body_text,
          received_at: row.trigger_received_at,
          classification: row.trigger_classification,
          sentiment: row.trigger_sentiment
        } : null
      };
    });

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

    // Get associated proposals - try by run_id first, then fallback to case_id
    let proposals = await db.getProposalsByRunId(runId);

    // Fallback: if no proposals found by run_id, try to find recent proposals for this case
    // This handles legacy runs where run_id wasn't set on proposals
    if (proposals.length === 0 && run.case_id) {
      const caseProposals = await db.query(`
        SELECT * FROM proposals
        WHERE case_id = $1
          AND created_at >= $2
          AND created_at <= COALESCE($3, NOW() + interval '1 hour')
        ORDER BY created_at DESC
        LIMIT 5
      `, [run.case_id, run.started_at, run.ended_at]);
      proposals = caseProposals.rows;
    }

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

/**
 * POST /runs/:id/retry
 *
 * Retry a failed or gated run.
 * Creates a new run with the same trigger type and case.
 */
router.post('/runs/:id/retry', async (req, res) => {
  const runId = parseInt(req.params.id);

  try {
    // Get the original run
    const originalRun = await db.getAgentRunById(runId);
    if (!originalRun) {
      return res.status(404).json({
        success: false,
        error: `Run ${runId} not found`
      });
    }

    // Check if case already has an active run
    const existingRun = await db.getActiveRunForCase(originalRun.case_id);
    if (existingRun) {
      return res.status(409).json({
        success: false,
        error: 'Case already has an active agent run',
        active_run_id: existingRun.id
      });
    }

    // Create a new run based on the original
    const newRun = await db.createAgentRunFull({
      case_id: originalRun.case_id,
      trigger_type: `RETRY_${originalRun.trigger_type}`,
      status: 'queued',
      autopilot_mode: originalRun.autopilot_mode || 'SUPERVISED',
      langgraph_thread_id: `retry:${originalRun.case_id}:run-${runId}:${Date.now()}`
    });

    // Enqueue the appropriate job based on original trigger type
    let job;
    const triggerType = originalRun.trigger_type?.toLowerCase() || 'manual';

    if (triggerType.includes('initial')) {
      job = await enqueueInitialRequestJob(newRun.id, originalRun.case_id, {
        autopilotMode: newRun.autopilot_mode,
        threadId: newRun.langgraph_thread_id
      });
    } else if (triggerType.includes('inbound')) {
      // Need the original message ID
      const messageId = originalRun.message_id;
      if (messageId) {
        job = await enqueueInboundMessageJob(newRun.id, originalRun.case_id, messageId, {
          autopilotMode: newRun.autopilot_mode,
          threadId: newRun.langgraph_thread_id
        });
      } else {
        // Fall back to manual trigger
        job = await enqueueAgentJob(originalRun.case_id, 'RETRY_MANUAL', {});
      }
    } else if (triggerType.includes('followup')) {
      job = await enqueueFollowupTriggerJob(newRun.id, originalRun.case_id, null, {
        autopilotMode: newRun.autopilot_mode,
        threadId: newRun.langgraph_thread_id,
        manualTrigger: true
      });
    } else {
      // Generic manual trigger
      job = await enqueueAgentJob(originalRun.case_id, 'RETRY_MANUAL', {});
    }

    logger.info('Agent run retry created', {
      originalRunId: runId,
      newRunId: newRun.id,
      triggerType: newRun.trigger_type
    });

    res.status(202).json({
      success: true,
      message: 'Retry run created',
      original_run_id: runId,
      new_run: {
        id: newRun.id,
        status: newRun.status,
        trigger_type: newRun.trigger_type
      },
      job_id: job?.id
    });

  } catch (error) {
    logger.error('Error retrying run', { runId, error: error.message });
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * POST /cases/:id/ingest-email
 *
 * ATOMIC endpoint: Manually ingest an inbound email AND trigger agent processing.
 * Used for manual data entry via paste or forwarding.
 *
 * Features:
 * - Idempotent: Duplicate emails (same from+subject+body within 24h window) return 409
 * - Atomic: Creates message AND triggers run in one call
 * - Returns run_id for tracking
 *
 * Body:
 * - from_email: string (required) - Sender email address
 * - subject: string - Email subject
 * - body_text: string (required) - Email body
 * - message_id_header: string (optional) - Email Message-ID header for deduplication
 * - received_at: string - ISO timestamp (defaults to now)
 * - source: string - Source of the email (defaults to 'manual_paste')
 * - autopilot_mode: 'AUTO' | 'SUPERVISED' (defaults to 'SUPERVISED')
 * - trigger_run: boolean (defaults to true) - Set false to only create message without processing
 */
router.post('/cases/:id/ingest-email', async (req, res) => {
  const caseId = parseInt(req.params.id);
  const {
    from_email,
    subject,
    body_text,
    message_id_header,
    received_at,
    source = 'manual_paste',
    autopilot_mode = 'SUPERVISED',
    trigger_run = true
  } = req.body || {};

  try {
    // === VALIDATION (422 for parsing failures) ===
    const validationErrors = [];

    if (!from_email) {
      validationErrors.push({ field: 'from_email', error: 'required' });
    } else if (!from_email.includes('@')) {
      validationErrors.push({ field: 'from_email', error: 'invalid email format' });
    }

    if (!body_text) {
      validationErrors.push({ field: 'body_text', error: 'required' });
    } else if (body_text.length < 10) {
      validationErrors.push({ field: 'body_text', error: 'too short (min 10 chars)' });
    }

    if (validationErrors.length > 0) {
      return res.status(422).json({
        success: false,
        error: 'Validation failed',
        details: validationErrors
      });
    }

    // Verify case exists
    const caseData = await db.getCaseById(caseId);
    if (!caseData) {
      return res.status(404).json({
        success: false,
        error: 'Case not found'
      });
    }

    // === DEDUPLICATION ===
    // Generate dedupe key from: message_id_header OR hash(from + subject + normalized_body)
    const crypto = require('crypto');
    const normalizedBody = body_text.trim().toLowerCase().replace(/\s+/g, ' ').slice(0, 500);
    const dedupeKey = message_id_header ||
      crypto.createHash('sha256')
        .update(`${from_email}|${subject || ''}|${normalizedBody}`)
        .digest('hex')
        .slice(0, 32);

    // Check for duplicate within 24h window
    const duplicateCheck = await db.query(`
      SELECT id, created_at FROM messages
      WHERE thread_id IN (SELECT id FROM email_threads WHERE case_id = $1)
        AND direction = 'inbound'
        AND (
          metadata->>'dedupe_key' = $2
          OR metadata->>'message_id_header' = $3
        )
        AND created_at > NOW() - INTERVAL '24 hours'
      LIMIT 1
    `, [caseId, dedupeKey, message_id_header || 'none']);

    if (duplicateCheck.rows.length > 0) {
      const existing = duplicateCheck.rows[0];
      logger.info('Duplicate email detected', { caseId, existingMessageId: existing.id, dedupeKey });
      return res.status(409).json({
        success: false,
        error: 'Duplicate email already ingested',
        existing_message_id: existing.id,
        created_at: existing.created_at,
        dedupe_key: dedupeKey
      });
    }

    // === CHECK FOR ACTIVE RUN ===
    if (trigger_run) {
      const existingRun = await db.getActiveRunForCase(caseId);
      if (existingRun) {
        return res.status(409).json({
          success: false,
          error: 'Case has an active agent run. Wait for it to complete or cancel it first.',
          active_run: {
            id: existingRun.id,
            status: existingRun.status,
            started_at: existingRun.started_at
          }
        });
      }
    }

    // === CREATE THREAD IF NEEDED ===
    let thread = await db.getThreadByCaseId(caseId);
    if (!thread) {
      const threadResult = await db.query(`
        INSERT INTO email_threads (case_id, subject, created_at, updated_at)
        VALUES ($1, $2, NOW(), NOW())
        RETURNING *
      `, [caseId, subject || `Manual ingestion for case ${caseId}`]);
      thread = threadResult.rows[0];
    }

    // === CREATE MESSAGE ===
    const messageResult = await db.query(`
      INSERT INTO messages (
        thread_id,
        direction,
        from_email,
        to_email,
        subject,
        body_text,
        received_at,
        created_at,
        provider_message_id,
        metadata
      )
      VALUES ($1, 'inbound', $2, $3, $4, $5, $6, NOW(), $7, $8)
      RETURNING *
    `, [
      thread.id,
      from_email,
      caseData.our_email || process.env.FOIA_FROM_EMAIL || 'noreply@example.com',
      subject || '(No subject)',
      body_text,
      received_at ? new Date(received_at) : new Date(),
      `ingest-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      JSON.stringify({
        source,
        manual_paste: true,
        dedupe_key: dedupeKey,
        message_id_header: message_id_header || null
      })
    ]);

    const message = messageResult.rows[0];

    // Update case last_response_date
    await db.updateCase(caseId, {
      last_response_date: message.received_at,
      status: 'responded'
    });

    // Log activity
    await db.logActivity('email_ingested', `Manually ingested inbound email from ${from_email}`, {
      case_id: caseId,
      message_id: message.id,
      source: source,
      from_email: from_email
    });

    // === TRIGGER RUN (atomic) ===
    let run = null;
    let job = null;

    if (trigger_run) {
      // Create agent run record
      run = await db.createAgentRunFull({
        case_id: caseId,
        trigger_type: 'inbound_message',
        message_id: message.id,
        status: 'queued',
        autopilot_mode: autopilot_mode,
        langgraph_thread_id: `case:${caseId}:msg-${message.id}`
      });

      // Enqueue worker job (clean up orphaned run on failure)
      try {
        job = await enqueueInboundMessageJob(run.id, caseId, message.id, {
          autopilotMode: autopilot_mode,
          threadId: run.langgraph_thread_id
        });
      } catch (enqueueError) {
        await db.updateAgentRun(run.id, { status: 'failed', ended_at: new Date(), error: `Enqueue failed: ${enqueueError.message}` });
        throw enqueueError;
      }

      logger.info('Email ingested and run triggered', {
        caseId,
        messageId: message.id,
        runId: run.id,
        jobId: job.id
      });
    } else {
      logger.info('Email ingested (no run triggered)', {
        caseId,
        messageId: message.id
      });
    }

    // Return 201 for new resource, with run info
    res.status(201).json({
      success: true,
      message: trigger_run ? 'Email ingested and processing started' : 'Email ingested successfully',
      inbound_message_id: message.id,
      thread_id: thread.id,
      dedupe_key: dedupeKey,
      run: run ? {
        id: run.id,
        status: run.status,
        thread_id: run.langgraph_thread_id
      } : null,
      job_id: job?.id || null
    });

  } catch (error) {
    logger.error('Error ingesting email', { caseId, error: error.message, stack: error.stack });
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * POST /cases/:id/inbound-and-run
 *
 * ATOMIC endpoint that creates an inbound message AND triggers agent processing in one call.
 * This is the recommended endpoint for testing as it avoids race conditions.
 *
 * Body:
 * - body_text: (required) The email body text
 * - subject: (optional) Email subject
 * - from_email: (optional) Sender email, defaults to agency email
 * - classification: (optional) Pre-analyzed classification for testing
 * - extracted_fee: (optional) Pre-extracted fee amount
 * - autopilotMode: 'AUTO' | 'SUPERVISED' (default: 'SUPERVISED')
 * - llmStubs: Object with stubbed LLM responses for testing
 * - force_new_run: (optional) If true, cancels any active run first
 */
router.post('/cases/:id/inbound-and-run', async (req, res) => {
  const caseId = parseInt(req.params.id);
  const {
    body_text,
    subject,
    from_email,
    classification,
    extracted_fee,
    autopilotMode = 'SUPERVISED',
    llmStubs,
    force_new_run = false
  } = req.body || {};

  try {
    // Validate body_text
    if (!body_text) {
      return res.status(400).json({
        success: false,
        error: 'body_text is required',
        expected_format: {
          body_text: 'string (required)',
          subject: 'string (optional)',
          from_email: 'string (optional)',
          classification: 'string (optional) - FEE_QUOTE, DENIAL, etc.',
          extracted_fee: 'number (optional)',
          autopilotMode: 'AUTO | SUPERVISED (default: SUPERVISED)',
          llmStubs: 'object (optional)',
          force_new_run: 'boolean (optional) - cancel active run first'
        }
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

    // Check for existing active run
    const existingRun = await db.getActiveRunForCase(caseId);
    if (existingRun) {
      if (force_new_run) {
        // Cancel the existing run
        await db.query(`
          UPDATE agent_runs
          SET status = 'failed',
              ended_at = NOW(),
              error = 'Cancelled by inbound-and-run force_new_run'
          WHERE id = $1
        `, [existingRun.id]);
        logger.info('Cancelled existing run for force_new_run', { runId: existingRun.id, caseId });
      } else {
        return res.status(409).json({
          success: false,
          error: 'Case already has an active agent run',
          hint: 'Set force_new_run: true to cancel the active run, or wait for it to complete',
          activeRun: {
            id: existingRun.id,
            status: existingRun.status,
            trigger_type: existingRun.trigger_type,
            started_at: existingRun.started_at
          }
        });
      }
    }

    // Get or create thread for the case
    let thread = await db.getThreadByCaseId(caseId);
    if (!thread) {
      const threadResult = await db.query(`
        INSERT INTO email_threads (case_id, subject, created_at, updated_at)
        VALUES ($1, $2, NOW(), NOW())
        RETURNING *
      `, [caseId, subject || `Inbound for case ${caseId}`]);
      thread = threadResult.rows[0];
    }

    // Create the inbound message
    const messageResult = await db.query(`
      INSERT INTO messages (
        thread_id,
        direction,
        from_email,
        to_email,
        subject,
        body_text,
        body_html,
        received_at,
        created_at,
        provider_message_id,
        metadata
      )
      VALUES ($1, 'inbound', $2, $3, $4, $5, $6, NOW(), NOW(), $7, $8)
      RETURNING *
    `, [
      thread.id,
      from_email || caseData.agency_email || 'agency@test.example.com',
      process.env.FOIA_FROM_EMAIL || 'foia@autobot.example.com',
      subject || `RE: ${caseData.case_name || 'FOIA Request'}`,
      body_text,
      `<p>${body_text.replace(/\n/g, '</p><p>')}</p>`,
      `inbound-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      JSON.stringify({ source: 'inbound-and-run', classification, extracted_fee })
    ]);

    const message = messageResult.rows[0];

    // Create response analysis record if classification provided
    if (classification || extracted_fee) {
      await db.query(`
        INSERT INTO response_analysis (case_id, message_id, intent, sentiment, extracted_fee_amount)
        VALUES ($1, $2, $3, $4, $5)
      `, [caseId, message.id, classification || 'UNKNOWN', 'neutral', extracted_fee || null]);
    }

    // Create agent run record
    const run = await db.createAgentRunFull({
      case_id: caseId,
      trigger_type: 'inbound_message',
      message_id: message.id,
      status: 'queued',
      autopilot_mode: autopilotMode,
      langgraph_thread_id: `case:${caseId}:msg-${message.id}`
    });

    // Enqueue worker job (clean up orphaned run on failure)
    let job;
    try {
      job = await enqueueInboundMessageJob(run.id, caseId, message.id, {
        autopilotMode,
        threadId: run.langgraph_thread_id,
        llmStubs
      });
    } catch (enqueueError) {
      await db.updateAgentRun(run.id, { status: 'failed', ended_at: new Date(), error: `Enqueue failed: ${enqueueError.message}` });
      throw enqueueError;
    }

    logger.info('Inbound-and-run completed', {
      caseId,
      messageId: message.id,
      runId: run.id,
      jobId: job.id
    });

    res.status(202).json({
      success: true,
      message: 'Message created and processing queued',
      data: {
        message_id: message.id,
        thread_id: thread.id,
        run_id: run.id,
        job_id: job.id,
        classification: classification || null,
        extracted_fee: extracted_fee || null
      },
      run: {
        id: run.id,
        status: run.status,
        thread_id: run.langgraph_thread_id
      }
    });

  } catch (error) {
    logger.error('Error in inbound-and-run', { caseId, error: error.message, stack: error.stack });
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

module.exports = router;
