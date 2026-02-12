const { CronJob } = require('cron');
const notionService = require('./notion-service');
const followupScheduler = require('./followup-scheduler');  // Phase 6: New Run Engine scheduler
const { generateQueue } = require('../queues/email-queue');
const db = require('./database');
const stuckResponseDetector = require('./stuck-response-detector');
const agencyNotionSync = require('./agency-notion-sync');

// Feature flag: Use new Run Engine follow-up scheduler
const USE_RUN_ENGINE_FOLLOWUPS = process.env.USE_RUN_ENGINE_FOLLOWUPS !== 'false';

class CronService {
    constructor() {
        this.jobs = {};
    }

    /**
     * Start all cron jobs
     */
    start() {
        console.log('Starting cron services...');

        // Sync from Notion every 15 minutes
        this.jobs.notionSync = new CronJob('*/15 * * * *', async () => {
            try {
                console.log('Running Notion sync...');
                const cases = await notionService.syncCasesFromNotion('Ready To Send');

                // Auto-process new cases if enabled
                if (cases.length > 0) {
                    console.log(`Synced ${cases.length} new cases from Notion`);

                    for (const caseData of cases) {
                        // Queue for generation and sending
                        await generateQueue.add('generate-and-send', {
                            caseId: caseData.id
                        });
                    }

                    await db.logActivity('notion_sync', `Synced and queued ${cases.length} cases from Notion`);
                }
            } catch (error) {
                console.error('Error in Notion sync cron:', error);
            }
        }, null, true, 'America/New_York');

        // Start follow-up scheduler (Phase 6: Run Engine integration)
        if (USE_RUN_ENGINE_FOLLOWUPS) {
            followupScheduler.start();
            console.log('✓ Follow-up scheduler (Run Engine): Every 15 minutes');
        } else {
            // Legacy mode: direct email sending
            const followUpService = require('./follow-up-service');
            followUpService.start();
            console.log('✓ Follow-ups (legacy): Daily at 9 AM');
        }

        // Clean up old activity logs every day at midnight
        this.jobs.cleanup = new CronJob('0 0 * * *', async () => {
            try {
                console.log('Running cleanup job...');
                // Keep only 90 days of activity logs
                await db.query(`
                    DELETE FROM activity_log
                    WHERE created_at < NOW() - INTERVAL '90 days'
                `);
                console.log('Cleanup completed');
            } catch (error) {
                console.error('Error in cleanup cron:', error);
            }
        }, null, true, 'America/New_York');

        // Health check / keep-alive every 5 minutes
        this.jobs.healthCheck = new CronJob('*/5 * * * *', async () => {
            try {
                const health = await db.healthCheck();
                if (!health.healthy) {
                    console.error('Database health check failed:', health.error);
                }
            } catch (error) {
                console.error('Error in health check cron:', error);
            }
        }, null, true, 'America/New_York');

        // Check for stuck responses every 30 minutes
        this.jobs.stuckResponseCheck = new CronJob('*/30 * * * *', async () => {
            try {
                console.log('Checking for stuck responses...');
                const result = await stuckResponseDetector.detectAndFlagStuckResponses();
                if (result.flagged > 0) {
                    console.log(`⚠️ Flagged ${result.flagged} stuck response(s) for human review`);
                }
            } catch (error) {
                console.error('Error in stuck response check cron:', error);
            }
        }, null, true, 'America/New_York');

        // Sync agencies from Notion every hour
        this.jobs.agencySync = new CronJob('0 * * * *', async () => {
            try {
                console.log('Running agency sync from Notion...');
                const result = await agencyNotionSync.syncFromNotion({ fullSync: false, limit: 1000 });
                console.log(`Agency sync completed: ${result.created} created, ${result.updated} updated, ${result.skipped} skipped`);
                if (result.errors.length > 0) {
                    console.warn(`Agency sync had ${result.errors.length} errors`);
                }

                // Link any new cases to agencies
                await this.linkCasesToAgencies();
            } catch (error) {
                console.error('Error in agency sync cron:', error);
            }
        }, null, true, 'America/New_York');

        // Run initial agency sync on startup (delayed by 30 seconds to let DB connect)
        setTimeout(async () => {
            try {
                console.log('Running initial agency sync from Notion...');
                const result = await agencyNotionSync.syncFromNotion({ fullSync: false, limit: 2000 });
                console.log(`Initial agency sync completed: ${result.created} created, ${result.updated} updated`);

                // Link any unlinked cases to agencies
                await this.linkCasesToAgencies();
            } catch (error) {
                console.error('Error in initial agency sync:', error);
            }
        }, 30000);

        // Phone call escalation: sweep for 14-day no-response email cases (daily at 10 AM)
        this.jobs.phoneCallSweep = new CronJob('0 10 * * *', async () => {
            try {
                console.log('Running phone call escalation sweep...');
                const result = await this.sweepNoResponseCases();
                if (result.escalated > 0) {
                    console.log(`Escalated ${result.escalated} case(s) to phone call queue`);
                }
            } catch (error) {
                console.error('Error in phone call sweep cron:', error);
            }
        }, null, true, 'America/New_York');

        // Stuck portal & orphaned review sweep (every 30 minutes)
        this.jobs.stuckPortalSweep = new CronJob('*/30 * * * *', async () => {
            try {
                console.log('Running stuck portal & orphaned review sweep...');
                const result = await this.sweepStuckPortalCases();
                console.log(`Stuck portal sweep: ${result.portalEscalated} portal, ${result.proposalsCreated} orphan proposals, ${result.followUpFixed} follow-up fixes`);
            } catch (error) {
                console.error('Error in stuck portal sweep cron:', error);
            }
        }, null, true, 'America/New_York');

        console.log('✓ Notion sync: Every 15 minutes');
        console.log('✓ Cleanup: Daily at midnight');
        console.log('✓ Health check: Every 5 minutes');
        console.log('✓ Stuck response check: Every 30 minutes');
        console.log('✓ Agency sync: Every hour + on startup');
        console.log('✓ Phone call sweep: Daily at 10 AM');
        console.log('✓ Stuck portal sweep: Every 30 minutes');
    }

    /**
     * Link cases to agencies by matching names (with fuzzy matching)
     */
    async linkCasesToAgencies() {
        try {
            // First, exact match on name + state
            const exactResult = await db.query(`
                UPDATE cases c
                SET agency_id = a.id
                FROM agencies a
                WHERE c.agency_name = a.name
                  AND (c.state = a.state OR (c.state IS NULL AND a.state IS NULL))
                  AND c.agency_id IS NULL
            `);

            // Then, fuzzy match: normalize names by removing common suffixes
            // and match on the core name
            const fuzzyResult = await db.query(`
                UPDATE cases c
                SET agency_id = a.id
                FROM agencies a
                WHERE c.agency_id IS NULL
                  AND c.agency_name IS NOT NULL
                  AND (c.state = a.state OR c.state IS NULL OR a.state IS NULL)
                  AND (
                    -- Normalize both names: lowercase, remove common suffixes
                    LOWER(REGEXP_REPLACE(c.agency_name, '\\s*(Police\\s*Dep(ar)?t(ment)?|PD|Sheriff.s?\\s*(Office|Dep(ar)?t(ment)?)?|Law\\s*Enforcement|LEA)\\s*$', '', 'i'))
                    =
                    LOWER(REGEXP_REPLACE(a.name, '\\s*(Police\\s*Dep(ar)?t(ment)?|PD|Sheriff.s?\\s*(Office|Dep(ar)?t(ment)?)?|Law\\s*Enforcement|LEA)\\s*$', '', 'i'))
                  )
            `);

            const totalLinked = (exactResult.rowCount || 0) + (fuzzyResult.rowCount || 0);
            if (totalLinked > 0) {
                console.log(`Linked ${totalLinked} cases to agencies (${exactResult.rowCount || 0} exact, ${fuzzyResult.rowCount || 0} fuzzy)`);
            }

            return { exact: exactResult.rowCount || 0, fuzzy: fuzzyResult.rowCount || 0 };
        } catch (error) {
            console.error('Error linking cases to agencies:', error);
            return { exact: 0, fuzzy: 0, error: error.message };
        }
    }

    /**
     * Sweep for email-only cases with no response after 14 days.
     * Creates phone call queue entries for any that slipped through followup scheduling.
     */
    async sweepNoResponseCases() {
        let escalated = 0;
        try {
            const result = await db.query(`
                SELECT c.*
                FROM cases c
                WHERE c.status IN ('sent', 'awaiting_response')
                  AND c.send_date < NOW() - INTERVAL '14 days'
                  AND (c.portal_url IS NULL OR c.portal_url = '')
                  AND NOT EXISTS (
                    SELECT 1 FROM phone_call_queue pcq WHERE pcq.case_id = c.id
                  )
                ORDER BY c.send_date ASC
                LIMIT 50
            `);

            for (const caseData of result.rows) {
                try {
                    const daysSinceSent = Math.floor(
                        (Date.now() - new Date(caseData.send_date).getTime()) / (1000 * 60 * 60 * 24)
                    );

                    // Look up agency phone number
                    let agencyPhone = null;
                    if (caseData.agency_id) {
                        const agency = await db.query('SELECT phone FROM agencies WHERE id = $1', [caseData.agency_id]);
                        if (agency.rows[0]?.phone) agencyPhone = agency.rows[0].phone;
                    }

                    const phoneTask = await db.createPhoneCallTask({
                        case_id: caseData.id,
                        agency_name: caseData.agency_name,
                        agency_phone: agencyPhone,
                        agency_state: caseData.state,
                        reason: 'no_email_response',
                        priority: daysSinceSent > 30 ? 2 : (daysSinceSent > 21 ? 1 : 0),
                        notes: `No response after ${daysSinceSent} days (sweep)`,
                        days_since_sent: daysSinceSent
                    });

                    // Auto-generate briefing (fire-and-forget)
                    const aiService = require('./ai-service');
                    db.getMessagesByCaseId(caseData.id, 20)
                        .then(messages => aiService.generatePhoneCallBriefing(phoneTask, caseData, messages))
                        .then(briefing => db.updatePhoneCallBriefing(phoneTask.id, briefing))
                        .catch(err => console.error(`Auto-briefing failed for call #${phoneTask.id}:`, err.message));

                    await db.updateCaseStatus(caseData.id, 'needs_phone_call', {
                        substatus: 'No email response after 14+ days'
                    });

                    await db.logActivity('phone_call_escalated',
                        `Case escalated to phone call queue via sweep: ${caseData.case_name}`,
                        { case_id: caseData.id }
                    );

                    // Sync to Notion
                    try {
                        const notionService = require('./notion-service');
                        await notionService.syncStatusToNotion(caseData.id);
                    } catch (err) {
                        console.warn('Failed to sync phone escalation to Notion:', err.message);
                    }

                    escalated++;
                    console.log(`Phone call escalation: case ${caseData.id} (${caseData.case_name})`);
                } catch (error) {
                    console.error(`Error escalating case ${caseData.id}:`, error.message);
                }
            }
        } catch (error) {
            console.error('Error in sweepNoResponseCases:', error);
        }

        return { escalated };
    }

    /**
     * Sweep for stuck portal cases, orphaned reviews, and stale follow-up records.
     */
    async sweepStuckPortalCases() {
        let portalEscalated = 0;
        let proposalsCreated = 0;
        let followUpFixed = 0;

        // Sweep 1: Stuck portal_in_progress > 60 minutes
        try {
            const stuckPortal = await db.query(`
                SELECT c.* FROM cases c
                WHERE c.status = 'portal_in_progress'
                  AND c.updated_at < NOW() - INTERVAL '60 minutes'
            `);

            for (const caseData of stuckPortal.rows) {
                try {
                    // Extract error from Skyvern response
                    let portalError = 'Unknown';
                    let recordingUrl = caseData.last_portal_recording_url;
                    let taskUrl = caseData.last_portal_task_url;
                    if (caseData.last_portal_details) {
                        try {
                            const d = JSON.parse(caseData.last_portal_details);
                            portalError = d.error || d.failure_reason || d.message || `Status: ${d.status || 'unknown'}`;
                        } catch (_) { portalError = caseData.last_portal_details.substring(0, 200); }
                    }

                    await db.updateCaseStatus(caseData.id, 'needs_human_review', {
                        substatus: `Portal timed out (>60 min): ${portalError}`.substring(0, 100),
                        requires_human: true
                    });

                    // Create proposal with full error context
                    await db.upsertProposal({
                        proposalKey: `${caseData.id}:portal_stuck_timeout:SUBMIT_PORTAL:1`,
                        caseId: caseData.id,
                        actionType: 'SUBMIT_PORTAL',
                        reasoning: [
                            { step: 'Portal submission timed out', detail: 'Stuck in portal_in_progress for >60 min' },
                            { step: 'Skyvern error', detail: portalError }
                        ],
                        confidence: 0, requiresHuman: true, canAutoExecute: false,
                        draftSubject: `Manual portal submission needed: ${caseData.case_name}`,
                        draftBodyText: [
                            `Portal: ${caseData.portal_url || 'N/A'}`,
                            `Error: ${portalError}`,
                            recordingUrl ? `Recording: ${recordingUrl}` : null,
                            taskUrl ? `Task: ${taskUrl}` : null
                        ].filter(Boolean).join('\n'),
                        status: 'PENDING_APPROVAL'
                    });

                    await db.logActivity('portal_stuck_escalated',
                        `Case ${caseData.case_name} stuck >60min. Error: ${portalError}`,
                        { case_id: caseData.id, portal_error: portalError, recording_url: recordingUrl });
                    try { await notionService.syncStatusToNotion(caseData.id); } catch (_) {}
                    portalEscalated++;
                    console.log(`Stuck portal escalated: case ${caseData.id} (${caseData.case_name}) — ${portalError}`);
                } catch (err) {
                    console.error(`Error escalating stuck portal case ${caseData.id}:`, err.message);
                }
            }
        } catch (error) {
            console.error('Error in stuck portal sweep:', error);
        }

        // Sweep 2: Orphaned needs_human_review > 48 hours with no pending proposals — AI triage
        try {
            const orphaned = await db.query(`
                SELECT c.* FROM cases c
                WHERE c.status = 'needs_human_review'
                  AND c.updated_at < NOW() - INTERVAL '48 hours'
                  AND NOT EXISTS (
                    SELECT 1 FROM proposals p
                    WHERE p.case_id = c.id AND p.status IN ('PENDING_APPROVAL', 'DRAFT')
                  )
            `);

            const aiService = require('./ai-service');
            const today = new Date().toISOString().slice(0, 10);

            for (const caseData of orphaned.rows) {
                try {
                    // Gather context for AI triage
                    const messages = await db.getMessagesByCaseId(caseData.id, 10);
                    const priorProposalsResult = await db.query(
                        `SELECT action_type, status, reasoning FROM proposals
                         WHERE case_id = $1 ORDER BY created_at DESC LIMIT 5`,
                        [caseData.id]
                    );
                    const priorProposals = priorProposalsResult.rows;

                    // AI triage: determine the right action
                    const triage = await aiService.triageStuckCase(caseData, messages, priorProposals);
                    const actionType = triage.actionType || 'ESCALATE';

                    await db.upsertProposal({
                        proposalKey: `${caseData.id}:sweep_orphan:TRIAGE:${today}`,
                        caseId: caseData.id,
                        actionType: actionType,
                        reasoning: [
                            { step: 'AI triage summary', detail: triage.summary },
                            { step: 'Recommendation', detail: triage.recommendation }
                        ],
                        confidence: triage.confidence || 0,
                        requiresHuman: true,
                        canAutoExecute: false,
                        draftSubject: `${actionType}: ${caseData.case_name}`,
                        draftBodyText: `${triage.summary}\n\nRecommendation: ${triage.recommendation}`,
                        status: 'PENDING_APPROVAL'
                    });
                    await db.logActivity('human_review_proposal_created',
                        `AI triage → ${actionType} for orphaned case ${caseData.case_name} (confidence: ${triage.confidence})`,
                        { case_id: caseData.id, triage_action: actionType }
                    );
                    proposalsCreated++;
                    console.log(`AI triage proposal: case ${caseData.id} (${caseData.case_name}) → ${actionType} (${triage.confidence})`);
                } catch (err) {
                    console.error(`Error triaging orphaned case ${caseData.id}:`, err.message);
                }
            }
        } catch (error) {
            console.error('Error in orphaned review sweep:', error);
        }

        // Sweep 3: Fix follow_up_schedule records with status='sent' → 'scheduled'
        try {
            const fixResult = await db.query(`
                UPDATE follow_up_schedule
                SET status = 'scheduled'
                WHERE status = 'sent'
                RETURNING id
            `);
            followUpFixed = fixResult.rowCount || 0;
            if (followUpFixed > 0) {
                console.log(`Fixed ${followUpFixed} follow_up_schedule records: 'sent' → 'scheduled'`);
                await db.logActivity('followup_status_fixed',
                    `Fixed ${followUpFixed} follow_up_schedule records from 'sent' to 'scheduled'`,
                    {}
                );
            }
        } catch (error) {
            console.error('Error in follow-up status fix sweep:', error);
        }

        return { portalEscalated, proposalsCreated, followUpFixed };
    }

    /**
     * Stop all cron jobs
     */
    stop() {
        console.log('Stopping cron services...');
        Object.values(this.jobs).forEach(job => job.stop());

        // Stop follow-up scheduler
        if (USE_RUN_ENGINE_FOLLOWUPS) {
            followupScheduler.stop();
        } else {
            const followUpService = require('./follow-up-service');
            followUpService.stop();
        }

        console.log('All cron jobs stopped');
    }

    /**
     * Get status of all jobs
     */
    getStatus() {
        // Get follow-up status based on which scheduler is active
        let followUpStatus = false;
        if (USE_RUN_ENGINE_FOLLOWUPS) {
            followUpStatus = followupScheduler.cronJob?.running || false;
        } else {
            const followUpService = require('./follow-up-service');
            followUpStatus = followUpService.cronJob?.running || false;
        }

        return {
            notionSync: this.jobs.notionSync?.running || false,
            followUp: followUpStatus,
            followUpEngine: USE_RUN_ENGINE_FOLLOWUPS ? 'run_engine' : 'legacy',
            cleanup: this.jobs.cleanup?.running || false,
            healthCheck: this.jobs.healthCheck?.running || false,
            stuckResponseCheck: this.jobs.stuckResponseCheck?.running || false
        };
    }
}

module.exports = new CronService();
