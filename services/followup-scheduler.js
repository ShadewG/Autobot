/**
 * Follow-up Scheduler Service
 *
 * Phase 6: Production follow-up scheduling integrated with Run Engine.
 *
 * Instead of sending emails directly, this service:
 * 1. Picks due follow-ups from follow_up_schedule table
 * 2. Creates agent_run records with trigger_type='followup_trigger'
 * 3. Enqueues run_followup_trigger jobs
 * 4. Lets LangGraph handle the SEND_FOLLOWUP proposal flow
 *
 * Runs on a cron schedule (configurable, default: every 15 minutes).
 */

const { CronJob } = require('cron');
const db = require('./database');
const logger = require('./logger');
const { enqueueFollowupTriggerJob } = require('../queues/agent-queue');

// Configuration
const FOLLOWUP_CHECK_CRON = process.env.FOLLOWUP_CHECK_CRON || '*/15 * * * *'; // Every 15 minutes
const MAX_FOLLOWUPS = parseInt(process.env.MAX_FOLLOWUPS) || 3;
const MAX_CONCURRENT_FOLLOWUPS = parseInt(process.env.MAX_CONCURRENT_FOLLOWUPS) || 5;

class FollowupScheduler {
  constructor() {
    this.cronJob = null;
    this.isProcessing = false;
  }

  /**
   * Start the follow-up scheduler
   */
  start() {
    this.cronJob = new CronJob(FOLLOWUP_CHECK_CRON, async () => {
      await this.processFollowups();
    }, null, true, 'America/New_York');

    logger.info('Follow-up scheduler started', {
      cron: FOLLOWUP_CHECK_CRON,
      maxFollowups: MAX_FOLLOWUPS,
      maxConcurrent: MAX_CONCURRENT_FOLLOWUPS
    });
  }

  /**
   * Stop the scheduler
   */
  stop() {
    if (this.cronJob) {
      this.cronJob.stop();
      logger.info('Follow-up scheduler stopped');
    }
  }

  /**
   * Process due follow-ups
   *
   * Main scheduling loop:
   * 1. Query for due follow-ups
   * 2. For each due followup, create run and enqueue job
   * 3. Update schedule status to 'processing'
   */
  async processFollowups() {
    if (this.isProcessing) {
      logger.warn('Followup processing already in progress, skipping');
      return;
    }

    this.isProcessing = true;

    try {
      // Get due follow-ups
      const dueFollowups = await this.getDueFollowups();

      if (dueFollowups.length === 0) {
        return;
      }

      logger.info(`Found ${dueFollowups.length} due follow-ups`);

      // Process up to MAX_CONCURRENT_FOLLOWUPS at a time
      const toProcess = dueFollowups.slice(0, MAX_CONCURRENT_FOLLOWUPS);

      for (const followup of toProcess) {
        try {
          await this.triggerFollowup(followup);
        } catch (error) {
          logger.error('Error triggering followup', {
            followupId: followup.id,
            caseId: followup.case_id,
            error: error.message
          });

          // Update error count
          await this.markFollowupError(followup.id, error.message);
        }
      }

      logger.info(`Processed ${toProcess.length} follow-ups`);

    } catch (error) {
      logger.error('Error in followup processing loop', { error: error.message });
    } finally {
      this.isProcessing = false;
    }
  }

  /**
   * Get due follow-ups that are ready to be processed
   */
  async getDueFollowups() {
    const result = await db.query(`
      SELECT
        fs.*,
        c.case_name,
        c.agency_name,
        c.agency_email,
        c.autopilot_mode as case_autopilot_mode
      FROM follow_up_schedule fs
      JOIN cases c ON fs.case_id = c.id
      WHERE fs.next_followup_date <= NOW()
        AND fs.status = 'scheduled'
        AND fs.auto_send = true
        AND fs.followup_count < $1
        AND c.status IN ('sent', 'awaiting_response')
        AND NOT EXISTS (
          -- Don't process if there's already an active run for this case
          SELECT 1 FROM agent_runs ar
          WHERE ar.case_id = fs.case_id
            AND ar.status IN ('created', 'queued', 'running', 'paused')
        )
      ORDER BY fs.next_followup_date ASC
      LIMIT $2
    `, [MAX_FOLLOWUPS, MAX_CONCURRENT_FOLLOWUPS * 2]);

    return result.rows;
  }

  /**
   * Trigger a follow-up via the Run Engine
   */
  async triggerFollowup(followup) {
    const { id: followupId, case_id: caseId, followup_count: followupCount } = followup;

    // Generate scheduled_key for idempotency
    const today = new Date().toISOString().split('T')[0];
    const scheduledKey = `followup:${caseId}:${followupCount}:${today}`;

    // Check if already processed today (idempotency)
    if (followup.scheduled_key === scheduledKey) {
      logger.info('Followup already has scheduled_key for today, skipping', {
        followupId,
        caseId,
        scheduledKey
      });
      return;
    }

    // Determine autopilot mode
    const autopilotMode = followup.autopilot_mode || followup.case_autopilot_mode || 'SUPERVISED';

    // Create run record
    const run = await db.createAgentRunFull({
      case_id: caseId,
      trigger_type: 'followup_trigger',
      scheduled_key: scheduledKey,
      status: 'queued',
      autopilot_mode: autopilotMode,
      langgraph_thread_id: `followup:${caseId}:${followupCount}:${Date.now()}`
    });

    // Update followup schedule
    await db.query(`
      UPDATE follow_up_schedule
      SET status = 'processing',
          scheduled_key = $2,
          last_run_id = $3,
          updated_at = NOW()
      WHERE id = $1
    `, [followupId, scheduledKey, run.id]);

    // Enqueue the job
    const job = await enqueueFollowupTriggerJob(run.id, caseId, followupId, {
      autopilotMode,
      threadId: run.langgraph_thread_id,
      followupCount
    });

    logger.info('Followup trigger enqueued', {
      followupId,
      caseId,
      runId: run.id,
      jobId: job.id,
      followupCount,
      autopilotMode
    });

    return { run, job };
  }

  /**
   * Mark a follow-up schedule as having an error
   */
  async markFollowupError(followupId, errorMessage) {
    await db.query(`
      UPDATE follow_up_schedule
      SET last_error = $2,
          error_count = COALESCE(error_count, 0) + 1,
          status = CASE
            WHEN COALESCE(error_count, 0) >= 2 THEN 'failed'
            ELSE 'scheduled'
          END,
          updated_at = NOW()
      WHERE id = $1
    `, [followupId, errorMessage]);
  }

  /**
   * Mark a follow-up as sent (called by commit-state node after successful execution)
   */
  async markFollowupSent(caseId, nextFollowupDate = null) {
    const followupDelayDays = parseInt(process.env.FOLLOWUP_DELAY_DAYS) || 7;

    // Calculate next followup date if not provided
    if (!nextFollowupDate) {
      nextFollowupDate = new Date();
      nextFollowupDate.setDate(nextFollowupDate.getDate() + followupDelayDays);
    }

    await db.query(`
      UPDATE follow_up_schedule
      SET status = 'scheduled',
          followup_count = followup_count + 1,
          last_followup_sent_at = NOW(),
          next_followup_date = $2,
          last_error = NULL,
          scheduled_key = NULL,
          updated_at = NOW()
      WHERE case_id = $1
        AND status = 'processing'
    `, [caseId, nextFollowupDate]);
  }

  /**
   * Mark a follow-up as max reached (no more followups will be sent)
   * Also escalates the case to the phone call queue.
   */
  async markMaxReached(caseId) {
    await db.query(`
      UPDATE follow_up_schedule
      SET status = 'max_reached',
          updated_at = NOW()
      WHERE case_id = $1
    `, [caseId]);

    logger.info('Case reached max followups', { caseId, maxFollowups: MAX_FOLLOWUPS });

    // Escalate to phone call queue
    try {
      await this.escalateToPhoneQueue(caseId, 'followup_max_reached');
    } catch (error) {
      logger.error('Failed to escalate case to phone call queue', { caseId, error: error.message });
    }
  }

  /**
   * Escalate a case to the phone call queue
   * @param {number} caseId
   * @param {string} reason - 'no_email_response' | 'details_needed' | 'complex_inquiry' | 'portal_failed' | 'clarification_difficult'
   * @param {object} opts - { notes, priority }
   */
  async escalateToPhoneQueue(caseId, reason = 'no_email_response', opts = {}) {
    // Check if already in queue
    const existing = await db.getPhoneCallByCaseId(caseId);
    if (existing) {
      logger.info('Case already in phone call queue, skipping', { caseId, existingId: existing.id });
      return existing;
    }

    const caseData = await db.getCaseById(caseId);
    if (!caseData) {
      logger.warn('Case not found for phone escalation', { caseId });
      return null;
    }

    // Check if AI already analyzed a response — route based on intent, not just presence
    const analysis = await db.getLatestResponseAnalysis(caseId);
    if (analysis && analysis.intent) {
      const actionableIntents = ['fee_request', 'question', 'more_info_needed', 'records_ready', 'delivery', 'denial', 'portal_redirect'];
      if (actionableIntents.includes(analysis.intent)) {
        logger.info(`Agency replied with "${analysis.intent}" — skipping phone escalation (AI pipeline handles this)`, { caseId, intent: analysis.intent });
        return null;
      }
      // 'acknowledgment' and other intents fall through — phone may still be appropriate
    }

    // Secondary safety check: skip if agency replied recently but no analysis exists
    const recentInbound = await db.query(
      `SELECT COUNT(*) as cnt FROM messages
       WHERE case_id = $1 AND direction = 'inbound'
       AND received_at > NOW() - INTERVAL '14 days'`, [caseId]
    );
    if (parseInt(recentInbound.rows[0].cnt) > 0) {
      logger.info('Case has recent inbound (no analysis) — skipping phone escalation', { caseId });
      return null;
    }

    // Look up agency phone number
    let agencyPhone = null;
    if (caseData.agency_id) {
      const agency = await db.query('SELECT phone FROM agencies WHERE id = $1', [caseData.agency_id]);
      if (agency.rows[0]?.phone) agencyPhone = agency.rows[0].phone;
    }

    // Calculate days since sent
    let daysSinceSent = null;
    if (caseData.send_date) {
      daysSinceSent = Math.floor((Date.now() - new Date(caseData.send_date).getTime()) / (1000 * 60 * 60 * 24));
    }

    // Default notes based on reason
    const defaultNotes = {
      'no_email_response': `No email response after ${MAX_FOLLOWUPS} follow-ups`,
      'details_needed': 'Agency needs additional details that are difficult to communicate via email',
      'complex_inquiry': 'Complex inquiry requiring direct phone conversation',
      'portal_failed': 'Portal submission failed - need to verify submission status by phone',
      'clarification_difficult': 'Agency asked for clarification that requires phone discussion'
    };

    // Priority: explicit > time-based > reason-based
    const reasonPriority = reason === 'portal_failed' ? 1 : 0;
    const timePriority = daysSinceSent > 30 ? 2 : (daysSinceSent > 21 ? 1 : 0);
    const priority = opts.priority ?? Math.max(timePriority, reasonPriority);

    const phoneTask = await db.createPhoneCallTask({
      case_id: caseId,
      agency_name: caseData.agency_name,
      agency_phone: agencyPhone,
      agency_state: caseData.state,
      reason,
      priority,
      notes: opts.notes || defaultNotes[reason] || `Phone call needed: ${reason}`,
      days_since_sent: daysSinceSent
    });

    // Auto-generate briefing (fire-and-forget)
    const aiService = require('./ai-service');
    db.getMessagesByCaseId(caseId, 20)
      .then(messages => aiService.generatePhoneCallBriefing(phoneTask, caseData, messages))
      .then(briefing => db.updatePhoneCallBriefing(phoneTask.id, briefing))
      .catch(err => logger.error(`Auto-briefing failed for call #${phoneTask.id}:`, err.message));

    // Update case status
    await db.updateCaseStatus(caseId, 'needs_phone_call', {
      substatus: 'No email response after follow-ups'
    });

    // Log activity
    await db.logActivity('phone_call_escalated',
      `Case escalated to phone call queue: ${caseData.case_name} (${reason})`,
      { case_id: caseId, phone_task_id: phoneTask.id }
    );

    // Sync to Notion
    try {
      const notionService = require('./notion-service');
      await notionService.syncStatusToNotion(caseId);
    } catch (err) {
      logger.warn('Failed to sync phone escalation to Notion', { caseId, error: err.message });
    }

    logger.info('Case escalated to phone call queue', { caseId, phoneTaskId: phoneTask.id, reason });

    // Fire-and-forget async phone lookup if no phone on file
    if (!agencyPhone) {
      this._asyncPhoneLookup(caseData, phoneTask.id).catch(err =>
        logger.warn('Async phone lookup failed', { caseId, error: err.message })
      );
    }

    return phoneTask;
  }

  /**
   * Async phone lookup: run Notion and web search in parallel.
   * Builds phone_options JSONB with both results and auto-selects best default.
   * Updates phone_call_queue, and agencies table if found.
   */
  async _asyncPhoneLookup(caseData, phoneTaskId) {
    const notionService = require('./notion-service');

    // Run both lookups in parallel
    const [notionResult, webResult] = await Promise.allSettled([
      caseData.notion_page_id
        ? notionService.lookupPhoneFromNotion(caseData.notion_page_id)
        : Promise.resolve({ phone: null, pdPageId: null }),
      caseData.agency_name
        ? notionService.searchForAgencyPhone(caseData.agency_name, caseData.state)
        : Promise.resolve({ phone: null, confidence: 'low', reasoning: 'No agency name' })
    ]);

    const notion = notionResult.status === 'fulfilled' ? notionResult.value : { phone: null, pdPageId: null };
    const web = webResult.status === 'fulfilled' ? webResult.value : { phone: null, confidence: 'low', reasoning: 'lookup failed' };

    // Build phone_options JSONB
    const phoneOptions = {
      notion: {
        phone: notion.phone || null,
        source: 'Notion PD Card',
        pd_page_id: notion.pdPageId || null,
        pd_page_url: notion.pdPageId
          ? `https://www.notion.so/${notion.pdPageId.replace(/-/g, '')}`
          : null
      },
      web_search: {
        phone: web.phone || null,
        source: 'Web Search (GPT)',
        confidence: web.confidence || null,
        reasoning: web.reasoning || null
      }
    };

    // Pick best default: Notion preferred, else web search
    const bestPhone = notion.phone || web.phone || null;

    logger.info('Dual phone lookup completed', {
      caseId: caseData.id,
      phoneTaskId,
      notionPhone: notion.phone,
      webPhone: web.phone,
      selected: bestPhone
    });

    // Update phone_call_queue with phone_options and best default
    const setClauses = ['phone_options = $1', 'updated_at = NOW()'];
    const values = [JSON.stringify(phoneOptions)];
    let paramIdx = 2;

    if (bestPhone) {
      setClauses.push(`agency_phone = $${paramIdx}`);
      values.push(bestPhone);
      paramIdx++;
    }

    values.push(phoneTaskId);
    await db.query(
      `UPDATE phone_call_queue SET ${setClauses.join(', ')} WHERE id = $${paramIdx}`,
      values
    );

    // Update agencies table if linked and we found a phone
    if (bestPhone && caseData.agency_id) {
      await db.query(
        'UPDATE agencies SET phone = $1 WHERE id = $2 AND (phone IS NULL OR phone = \'\')',
        [bestPhone, caseData.agency_id]
      );
    }
  }

  /**
   * Pause follow-ups for a case (e.g., when response received)
   */
  async pauseFollowups(caseId) {
    await db.query(`
      UPDATE follow_up_schedule
      SET status = 'paused',
          updated_at = NOW()
      WHERE case_id = $1
        AND status IN ('scheduled', 'processing')
    `, [caseId]);
  }

  /**
   * Resume follow-ups for a case
   */
  async resumeFollowups(caseId, nextDate = null) {
    const followupDelayDays = parseInt(process.env.FOLLOWUP_DELAY_DAYS) || 7;

    if (!nextDate) {
      nextDate = new Date();
      nextDate.setDate(nextDate.getDate() + followupDelayDays);
    }

    await db.query(`
      UPDATE follow_up_schedule
      SET status = 'scheduled',
          next_followup_date = $2,
          updated_at = NOW()
      WHERE case_id = $1
        AND status = 'paused'
    `, [caseId, nextDate]);
  }

  /**
   * Cancel follow-ups for a case (e.g., case closed)
   */
  async cancelFollowups(caseId) {
    await db.query(`
      UPDATE follow_up_schedule
      SET status = 'cancelled',
          updated_at = NOW()
      WHERE case_id = $1
        AND status NOT IN ('cancelled', 'max_reached')
    `, [caseId]);
  }

  /**
   * Get follow-up status for a case
   */
  async getFollowupStatus(caseId) {
    const result = await db.query(`
      SELECT * FROM follow_up_schedule
      WHERE case_id = $1
      ORDER BY created_at DESC
      LIMIT 1
    `, [caseId]);

    return result.rows[0];
  }

  /**
   * Manual trigger for testing
   */
  async manualTrigger() {
    logger.info('Manual followup check triggered');
    return await this.processFollowups();
  }
}

// Export singleton
const followupScheduler = new FollowupScheduler();

module.exports = followupScheduler;
