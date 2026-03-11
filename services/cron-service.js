const { CronJob } = require('cron');
const notionService = require('./notion-service');
const followupScheduler = require('./followup-scheduler');  // Phase 6: New Run Engine scheduler
// generateQueue import removed — ready_to_send sweep now uses Run Engine via dispatch-helper
const db = require('./database');
const { DRAFT_REQUIRED_ACTIONS } = require('../constants/action-types');
const stuckResponseDetector = require('./stuck-response-detector');
const agencyNotionSync = require('./agency-notion-sync');
const pdContactService = require('./pd-contact-service');
const triggerDispatch = require('./trigger-dispatch-service');
const discordService = require('./discord-service');
const draftQualityEvalService = require('./draft-quality-eval-service');
const qualityReportService = require('./quality-report-service');
const errorTrackingService = require('./error-tracking-service');
const portalStatusMonitorService = require('./portal-status-monitor-service');
const { transitionCaseRuntime, CaseLockContention } = require('./case-runtime');
const { countsTowardDismissCircuitBreaker } = require('./proposal-lifecycle');
const { tasks } = require('@trigger.dev/sdk');

function normalizePortalTimeoutError(rawError) {
    const value = String(rawError || '').trim();
    if (!value || value === 'Unknown') {
        return 'No active submit-portal run';
    }
    if (/^Status:\s*created$/i.test(value)) {
        return 'No active submit-portal run; last portal task status was created';
    }
    return value;
}

class CronService {
    // Stable lock IDs for each cron job (arbitrary offset to avoid collisions with app locks)
    static LOCK_IDS = {
        notionSync:              100001,
        cleanup:                 100002,
        screenshotCleanup:       100003,
        healthCheck:             100004,
        operationalAlerts:       100005,
        weeklyQualityReport:     100006,
        draftQualityEval:        100007,
        dailyOperatorDigest:     100008,
        priorityAutoEscalate:    100009,
        stuckResponseCheck:      100010,
        readyToSendSweep:        100011,
        agencySync:              100012,
        deadlineEscalationSweep: 100013,
        stuckPortalSweep:        100014,
        staleRunReaper:          100015,
        loopBreaker:             100016,
        proposalDispatchRecovery:100017,
        triggerDispatchRecovery: 100018,
        orphanReviewRecovery:    100019,
        portalDispatch:          100020,
        portalStatusMonitoring:  100021,
    };

    constructor() {
        this.jobs = {};
        this.runningJobs = new Set();
        this.lastOperationalAlert = {
            portalHardTimeout: null,
            processInboundSuperseded: null,
            inboundLinkageGaps: null,
            emptyNormalizedInbound: null,
            proposalMessageMismatch: null,
        };
    }

    /**
     * Prevent duplicate cron execution across Railway replicas.
     *
     * Claims a per-job, per-minute slot by INSERTing a row with a unique key
     * into cron_locks. If the INSERT conflicts (another instance already
     * claimed this tick), the job silently skips. Old rows are auto-pruned.
     */
    async runWithDbLock(lockId, fn) {
        const jobName = Object.entries(CronService.LOCK_IDS).find(([, v]) => v === lockId)?.[0] || `lock_${lockId}`;
        const tickKey = `${jobName}:${new Date().toISOString().slice(0, 16)}`; // job:YYYY-MM-DDTHH:MM
        try {
            const result = await db.query(
                `INSERT INTO cron_locks (lock_key, acquired_at)
                 VALUES ($1, NOW())
                 ON CONFLICT (lock_key) DO NOTHING
                 RETURNING lock_key`,
                [tickKey]
            );
            if (result.rowCount === 0) {
                console.log(`[cron-lock] Skipped ${jobName} — already claimed for this tick`);
                return null;
            }
            try {
                return await fn();
            } finally {
                // Prune rows older than 1 hour (fire-and-forget)
                db.query(`DELETE FROM cron_locks WHERE acquired_at < NOW() - INTERVAL '1 hour'`).catch(() => {});
            }
        } catch (err) {
            // If cron_locks table doesn't exist yet, fall through and run anyway
            if (err.code === '42P01') {
                console.warn('[cron-lock] cron_locks table missing — running without lock');
                return await fn();
            }
            throw err;
        }
    }

    async runWithoutOverlap(jobName, fn) {
        if (this.runningJobs.has(jobName)) {
            console.warn(`[cron] ${jobName} is still running; skipping overlapping invocation`);
            return null;
        }

        this.runningJobs.add(jobName);
        try {
            return await fn();
        } finally {
            this.runningJobs.delete(jobName);
        }
    }

    /**
     * Start all cron jobs
     */
    start() {
        console.log('Starting cron services...');

        // Sync from Notion every 5 minutes
        // Notion sync still runs on cron (Notion has no webhooks), but generation
        // queuing is now reactive — db.createCase() and db.updateCaseStatus() auto-dispatch.
        this.jobs.notionSync = new CronJob('*/5 * * * *', () => {
            this.runWithDbLock(CronService.LOCK_IDS.notionSync, async () => {
                try {
                    console.log('Running Notion sync...');
                    const cases = await notionService.syncCasesFromNotion('Ready To Send');

                    if (cases.length > 0) {
                        console.log(`Synced ${cases.length} cases from Notion (reactive dispatch handles queuing)`);
                        await db.logActivity('notion_sync', `Synced ${cases.length} cases from Notion`);
                    }
                } catch (error) {
                    await errorTrackingService.captureException(error, {
                        sourceService: 'cron_service',
                        operation: 'notion_sync_cron',
                    });
                    console.error('Error in Notion sync cron:', error);
                }
            });
        }, null, true, 'America/New_York');

        // Start follow-up scheduler (Run Engine) unconditionally.
        // Overdue escalation/research flow is always active as well.
        followupScheduler.start();
        console.log('✓ Follow-up scheduler (Run Engine): Every 15 minutes');

        // Clean up old activity logs every day at midnight
        this.jobs.cleanup = new CronJob('0 0 * * *', () => {
            this.runWithDbLock(CronService.LOCK_IDS.cleanup, async () => {
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
            });
        }, null, true, 'America/New_York');

        // Delete screenshot files older than 7 days — runs daily at 1 AM
        this.jobs.screenshotCleanup = new CronJob('0 1 * * *', () => {
            this.runWithDbLock(CronService.LOCK_IDS.screenshotCleanup, async () => {
                try {
                    const fs = require('fs');
                    const path = require('path');
                    const screenshotDir = '/data/screenshots';
                    if (!fs.existsSync(screenshotDir)) return;
                    const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
                    const caseDirs = fs.readdirSync(screenshotDir);
                    let deleted = 0;
                    for (const dir of caseDirs) {
                        const dirPath = path.join(screenshotDir, dir);
                        if (!fs.statSync(dirPath).isDirectory()) continue;
                        const files = fs.readdirSync(dirPath);
                        for (const file of files) {
                            const filePath = path.join(dirPath, file);
                            if (fs.statSync(filePath).mtimeMs < cutoff) {
                                fs.unlinkSync(filePath);
                                deleted++;
                            }
                        }
                        if (fs.readdirSync(dirPath).length === 0) {
                            fs.rmdirSync(dirPath);
                        }
                    }
                    if (deleted > 0) console.log(`Screenshot cleanup: deleted ${deleted} files`);
                } catch (error) {
                    console.error('Error in screenshot cleanup cron:', error);
                }
            });
        }, null, true, 'America/New_York');

        // Health check / keep-alive every 5 minutes
        // Staggered to minute 2,7,12,... to avoid pile-up with Notion sync
        this.jobs.healthCheck = new CronJob('2,7,12,17,22,27,32,37,42,47,52,57 * * * *', () => {
            this.runWithDbLock(CronService.LOCK_IDS.healthCheck, async () => {
                try {
                    const health = await db.healthCheck();
                    if (!health.healthy) {
                        console.error('Database health check failed:', health.error);
                    }
                } catch (error) {
                    await errorTrackingService.captureException(error, {
                        sourceService: 'cron_service',
                        operation: 'health_check_cron',
                    });
                    console.error('Error in health check cron:', error);
                }
            });
        }, null, true, 'America/New_York');

        // Operational alerting: check key failure/supersede counters in a rolling 1h window.
        // Staggered to minute 6,21,36,51 to avoid collision with triggerDispatchRecovery
        this.jobs.operationalAlerts = new CronJob('6,21,36,51 * * * *', () => {
            this.runWithDbLock(CronService.LOCK_IDS.operationalAlerts, async () => {
                try {
                    await this.runWithoutOverlap('operational_alert_check', () => this.checkOperationalAlerts());
                } catch (error) {
                    await errorTrackingService.captureException(error, {
                        sourceService: 'cron_service',
                        operation: 'operational_alert_check',
                    });
                    console.error('Error in operational alert check:', error);
                }
            });
        }, null, true, 'America/New_York');

        this.jobs.weeklyQualityReport = new CronJob('0 9 * * 1', () => {
            this.runWithDbLock(CronService.LOCK_IDS.weeklyQualityReport, async () => {
                try {
                    console.log('Running weekly quality report...');
                    await this.sendWeeklyQualityReport();
                } catch (error) {
                    await errorTrackingService.captureException(error, {
                        sourceService: 'cron_service',
                        operation: 'weekly_quality_report_cron',
                    });
                    console.error('Error in weekly quality report cron:', error);
                }
            });
        }, null, true, 'America/New_York');

        this.jobs.draftQualityEval = new CronJob('30 9 * * *', () => {
            this.runWithDbLock(CronService.LOCK_IDS.draftQualityEval, async () => {
                try {
                    console.log('Running resolved draft quality eval sweep...');
                    await this.runResolvedDraftQualityEvalSweep();
                } catch (error) {
                    await errorTrackingService.captureException(error, {
                        sourceService: 'cron_service',
                        operation: 'draft_quality_eval_cron',
                    });
                    console.error('Error in resolved draft quality eval cron:', error);
                }
            });
        }, null, true, 'America/New_York');

        // Daily operator digest — 8:00 AM ET
        this.jobs.dailyOperatorDigest = new CronJob('0 8 * * *', () => {
            this.runWithDbLock(CronService.LOCK_IDS.dailyOperatorDigest, async () => {
                try {
                    console.log('Running daily operator digest...');
                    await this.runWithoutOverlap('daily_operator_digest_cron', () => this.sendDailyOperatorDigest());
                } catch (error) {
                    await errorTrackingService.captureException(error, {
                        sourceService: 'cron_service',
                        operation: 'daily_operator_digest_cron',
                    });
                    console.error('Error in daily operator digest cron:', error);
                }
            });
        }, null, true, 'America/New_York');

        // Auto-escalate priority for cases approaching deadlines — runs at 7:00 AM ET
        this.jobs.priorityAutoEscalate = new CronJob('0 7 * * *', () => {
            this.runWithDbLock(CronService.LOCK_IDS.priorityAutoEscalate, async () => {
                try {
                    const result = await this.runPriorityAutoEscalate();
                    if (result.escalated > 0) {
                        console.log(`Auto-escalated ${result.escalated} case(s) to urgent (deadline within 3 days)`);
                    }
                } catch (error) {
                    console.error('Error in priority auto-escalate cron:', error);
                }
            });
        }, null, true, 'America/New_York');

        // Check for stuck responses every 30 minutes
        // Staggered to minute 9 and 39 to avoid pile-up
        this.jobs.stuckResponseCheck = new CronJob('9,39 * * * *', () => {
            this.runWithDbLock(CronService.LOCK_IDS.stuckResponseCheck, async () => {
                try {
                    console.log('Checking for stuck responses...');
                    const result = await stuckResponseDetector.detectAndFlagStuckResponses();
                    if (result.flagged > 0) {
                        console.log(`⚠️ Flagged ${result.flagged} stuck response(s) for human review`);
                    }
                } catch (error) {
                    console.error('Error in stuck response check cron:', error);
                }
            });
        }, null, true, 'America/New_York');

        // Safety net: dispatch any orphaned ready_to_send cases every 10 minutes via Run Engine
        // Catches cases that entered ready_to_send before reactive dispatch, or where dispatch failed
        // Staggered to 2,12,22,32,42,52 to avoid pile-up with */5 jobs
        this.jobs.readyToSendSweep = new CronJob('2,12,22,32,42,52 * * * *', () => {
            this.runWithDbLock(CronService.LOCK_IDS.readyToSendSweep, async () => {
                try {
                    const readyCases = await db.getCasesByStatus('ready_to_send');
                    if (readyCases.length === 0) return;
                    const { dispatchReadyToSend } = require('./dispatch-helper');
                    let dispatched = 0;
                    for (const c of readyCases) {
                        try {
                            const result = await dispatchReadyToSend(c.id, { source: 'cron_sweep' });
                            if (result.dispatched) dispatched++;
                        } catch (e) {
                            if (!(e.code === '23505' && String(e.constraint || '').includes('one_active_per_case'))) {
                                console.error(`[sweep] Failed to dispatch case ${c.id}:`, e.message);
                            }
                        }
                    }
                    if (dispatched > 0) {
                        console.log(`[sweep] Dispatched ${dispatched} ready_to_send cases via Run Engine`);
                    }
                } catch (error) {
                    console.error('Error in ready_to_send sweep:', error);
                }
            });
        }, null, true, 'America/New_York');

        // Sync agencies from Notion every hour
        this.jobs.agencySync = new CronJob('0 * * * *', () => {
            this.runWithDbLock(CronService.LOCK_IDS.agencySync, async () => {
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
            });
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

        // Deadline escalation: sweep overdue cases continuously, research contacts,
        // and route to phone/proposals/human review.
        // Staggered to minute 7,22,37,52 to avoid pile-up with other periodic jobs
        this.jobs.deadlineEscalationSweep = new CronJob('7,22,37,52 * * * *', () => {
            this.runWithDbLock(CronService.LOCK_IDS.deadlineEscalationSweep, async () => {
                try {
                    console.log('Running deadline escalation sweep...');
                    const result = await this.runWithoutOverlap('deadline_escalation_sweep', () => this.sweepOverdueCases());
                    if (result) {
                        console.log(`Deadline escalation sweep: ${result.phoneCalls} phone calls, ${result.humanReviews} human reviews, ${result.contactUpdates} contact updates, ${result.skipped} skipped`);
                    }
                } catch (error) {
                    console.error('Error in deadline escalation sweep cron:', error);
                }
            });
        }, null, true, 'America/New_York');

        // Stuck portal & orphaned review sweep (every 30 minutes)
        // Staggered to minute 12 and 42 to avoid pile-up
        this.jobs.stuckPortalSweep = new CronJob('12,42 * * * *', () => {
            this.runWithDbLock(CronService.LOCK_IDS.stuckPortalSweep, async () => {
                try {
                    console.log('Running stuck portal & orphaned review sweep...');
                    const result = await this.sweepStuckPortalCases();
                    console.log(`Stuck portal sweep: ${result.portalEscalated} portal, ${result.proposalsCreated} orphan proposals, ${result.feeProposalsCreated || 0} fee proposals, ${result.followUpFixed} follow-up fixes, ${result.staleHumanFlagsCleared || 0} stale flags cleared`);
                } catch (error) {
                    console.error('Error in stuck portal sweep cron:', error);
                }
            });
        }, null, true, 'America/New_York');

        // Stale run reaper: clean up stuck agent_runs every 15 minutes
        // Staggered to minute 5,20,35,50 to avoid pile-up
        this.jobs.staleRunReaper = new CronJob('5,20,35,50 * * * *', () => {
            this.runWithDbLock(CronService.LOCK_IDS.staleRunReaper, async () => {
                try {
                    // Mark runs stuck in created/queued/running for >2 hours as failed
                    // NOTE: 'waiting' is excluded — it's the normal state while paused for human input
                    // 'paused' is also excluded — it indicates a human gate in progress
                    const result = await db.query(`
                        UPDATE agent_runs
                        SET status = 'failed',
                            error = 'Reaped: stuck in ' || status || ' for >2 hours',
                            ended_at = NOW()
                        WHERE status IN ('created', 'queued', 'running')
                          AND started_at < NOW() - INTERVAL '2 hours'
                        RETURNING id, case_id, status
                    `);
                    if (result.rowCount > 0) {
                        console.log(`[reaper] Cleaned ${result.rowCount} stuck agent runs`);
                        await db.logActivity('stale_run_reaped', `Cleaned ${result.rowCount} stuck agent runs`, {
                            run_ids: result.rows.map(r => r.id)
                        });

                        // Cancel corresponding Trigger.dev runs to release per-case queue locks
                        const { runs } = require('@trigger.dev/sdk');
                        for (const row of result.rows) {
                            try {
                                const meta = await db.query(
                                    `SELECT metadata->>'triggerRunId' as trigger_run_id FROM agent_runs WHERE id = $1`,
                                    [row.id]
                                );
                                const triggerRunId = meta.rows[0]?.trigger_run_id;
                                if (triggerRunId) {
                                    await runs.cancel(triggerRunId);
                                    console.log(`[reaper] Cancelled Trigger.dev run ${triggerRunId} for agent_run ${row.id}`);
                                }
                            } catch (e) { /* best-effort */ }
                        }
                    }
                } catch (error) {
                    console.error('Error in stale run reaper:', error);
                }
            });
        }, null, true, 'America/New_York');

        // Loop breaker: detect cases with excessive failed runs (circuit breaker)
        // Staggered to minute 17 and 47 to avoid pile-up
        this.jobs.loopBreaker = new CronJob('17,47 * * * *', () => {
            this.runWithDbLock(CronService.LOCK_IDS.loopBreaker, async () => {
                try {
                    // Find cases with 10+ failed runs in the last 24 hours
                    const result = await db.query(`
                        SELECT case_id, COUNT(*) as fail_count
                        FROM agent_runs
                        WHERE status = 'failed'
                          AND started_at > NOW() - INTERVAL '24 hours'
                        GROUP BY case_id
                        HAVING COUNT(*) >= 10
                    `);
                    for (const row of result.rows) {
                        // Check if already flagged
                        const caseData = await db.getCaseById(row.case_id);
                        if (!caseData || caseData.pause_reason === 'LOOP_DETECTED') continue;

                        try {
                            await transitionCaseRuntime(row.case_id, 'CASE_ESCALATED', {
                                substatus: `Circuit breaker: ${row.fail_count} failed runs in 24h`,
                                pauseReason: 'LOOP_DETECTED',
                            });
                        } catch (err) {
                            if (err.name === 'CaseLockContention') {
                                console.warn(`[loop-breaker] Case ${row.case_id} locked — skipping`);
                                continue;
                            }
                            console.error(`[loop-breaker] Error flagging case ${row.case_id}:`, err.message);
                            continue;
                        }
                        console.log(`[loop-breaker] Case ${row.case_id} flagged: ${row.fail_count} failed runs in 24h`);
                        await db.logActivity('loop_detected', `Circuit breaker tripped: ${row.fail_count} failed runs in 24h`, {
                            case_id: row.case_id, fail_count: row.fail_count
                        });
                    }
                } catch (error) {
                    console.error('Error in loop breaker:', error);
                }
            });
        }, null, true, 'America/New_York');

        // Proposal recovery watchdog: unstick decisions that were accepted but never dispatched.
        // Staggered to minute 1,6,11,... to avoid pile-up with other */5 jobs
        this.jobs.proposalDispatchRecovery = new CronJob('1,6,11,16,21,26,31,36,41,46,51,56 * * * *', () => {
            this.runWithDbLock(CronService.LOCK_IDS.proposalDispatchRecovery, async () => {
                try {
                    const result = await db.query(`
                        UPDATE proposals p
                        SET status = 'PENDING_APPROVAL',
                            human_decision = NULL,
                            updated_at = NOW()
                        WHERE p.status = 'DECISION_RECEIVED'
                          AND p.waitpoint_token IS NULL
                          AND p.updated_at < NOW() - INTERVAL '5 minutes'
                          AND NOT EXISTS (
                              SELECT 1 FROM agent_runs ar
                              WHERE ar.case_id = p.case_id
                                AND ar.status IN ('created', 'queued', 'processing', 'running', 'waiting')
                          )
                        RETURNING p.id, p.case_id, p.action_type
                    `);

                    if (result.rowCount > 0) {
                        for (const row of result.rows) {
                            await db.logActivity('proposal_recovered', `Recovered stuck proposal #${row.id} (${row.action_type}) back to PENDING_APPROVAL`, {
                                case_id: row.case_id,
                                proposal_id: row.id,
                                action_type: row.action_type
                            });
                        }
                        console.log(`[proposal-recovery] Recovered ${result.rowCount} stuck proposals`);
                    }
                } catch (error) {
                    console.error('Error in proposal dispatch recovery watchdog:', error);
                }
            });
        }, null, true, 'America/New_York');

        // Trigger dispatch recovery: re-dispatch runs stuck in queued + pending-version/no-machine states.
        // Staggered to minute 3,8,13,... to avoid pile-up
        this.jobs.triggerDispatchRecovery = new CronJob('3,8,13,18,23,28,33,38,43,48,53,58 * * * *', () => {
            this.runWithDbLock(CronService.LOCK_IDS.triggerDispatchRecovery, async () => {
                try {
                    const result = await triggerDispatch.recoverStaleQueuedRuns({
                        maxAgeMinutes: 6,
                        limit: 20,
                        maxAttempts: 3
                    });
                    if ((result.recovered || 0) > 0 || (result.failed || 0) > 0) {
                        console.log(`[trigger-recovery] scanned=${result.scanned} recovered=${result.recovered} failed=${result.failed}`);
                        await db.logActivity('trigger_dispatch_recovery',
                            `Trigger dispatch recovery scanned ${result.scanned}, recovered ${result.recovered}, failed ${result.failed}`,
                            result
                        );
                    }
                } catch (error) {
                    console.error('Error in trigger dispatch recovery watchdog:', error);
                }
            });
        }, null, true, 'America/New_York');

        // Orphaned human-review recovery: case says "decision required" but has no actionable proposal.
        // Auto-reprocesses from latest inbound up to 2 times/day before leaving it for human triage.
        // Staggered to minute 4,9,14,... to avoid pile-up
        this.jobs.orphanReviewRecovery = new CronJob('4,9,14,19,24,29,34,39,44,49,54,59 * * * *', () => {
            this.runWithDbLock(CronService.LOCK_IDS.orphanReviewRecovery, async () => {
                try {
                    const candidates = await db.query(`
                        SELECT c.id AS case_id, c.case_name, c.autopilot_mode,
                               lm.id AS message_id
                        FROM cases c
                        LEFT JOIN LATERAL (
                          SELECT m.id
                          FROM messages m
                          WHERE m.case_id = c.id AND m.direction = 'inbound'
                          ORDER BY m.created_at DESC
                          LIMIT 1
                        ) lm ON TRUE
                        WHERE c.status = 'needs_human_review'
                          AND c.requires_human = true
                          AND c.pause_reason = 'PENDING_APPROVAL'
                          AND lm.id IS NOT NULL
                          AND NOT EXISTS (
                            SELECT 1 FROM proposals p
                            WHERE p.case_id = c.id
                              AND p.status IN ('PENDING_APPROVAL', 'BLOCKED', 'DECISION_RECEIVED', 'PENDING_PORTAL')
                          )
                          AND NOT EXISTS (
                            SELECT 1 FROM agent_runs ar
                            WHERE ar.case_id = c.id
                              AND ar.status IN ('created', 'queued', 'running', 'waiting', 'processing')
                          )
                          AND (
                            SELECT COUNT(*)
                            FROM activity_log al
                            WHERE al.case_id = c.id
                              AND al.event_type = 'orphan_review_auto_reprocess'
                              AND al.created_at > NOW() - INTERVAL '24 hours'
                          ) < 2
                        ORDER BY c.updated_at ASC
                        LIMIT 10
                    `);

                    let recovered = 0;
                    for (const row of candidates.rows) {
                        try {
                            const run = await db.createAgentRunFull({
                                case_id: row.case_id,
                                trigger_type: 'orphan_review_reprocess',
                                message_id: row.message_id,
                                status: 'queued',
                                autopilot_mode: row.autopilot_mode || 'SUPERVISED',
                                langgraph_thread_id: `orphan-review:${row.case_id}:msg-${row.message_id}:${Date.now()}`,
                                metadata: { source: 'orphan_review_recovery' }
                            });

                            await triggerDispatch.triggerTask('process-inbound', {
                                runId: run.id,
                                caseId: row.case_id,
                                messageId: row.message_id,
                                autopilotMode: row.autopilot_mode || 'SUPERVISED',
                                triggerType: 'ORPHAN_REVIEW_RECOVERY',
                            }, {
                                queue: `case-${row.case_id}`,
                                idempotencyKey: `orphan-review-reprocess:${row.case_id}:${run.id}`,
                                idempotencyKeyTTL: '1h',
                            }, {
                                runId: run.id,
                                caseId: row.case_id,
                                triggerType: 'orphan_review_reprocess',
                                source: 'orphan_review_recovery',
                                verifyMs: 8000,
                                pollMs: 1200,
                            });

                            await db.logActivity('orphan_review_auto_reprocess',
                                `Auto-reprocessed orphaned decision-required case from inbound #${row.message_id}`,
                                { case_id: row.case_id, message_id: row.message_id, run_id: run.id }
                            );
                            recovered++;
                        } catch (err) {
                            await db.logActivity('orphan_review_reprocess_failed',
                                `Auto-reprocess failed for orphaned decision-required case: ${err.message}`,
                                { case_id: row.case_id, message_id: row.message_id, error: err.message }
                            );
                        }
                    }

                    if (recovered > 0) {
                        console.log(`[orphan-review-recovery] Auto-reprocessed ${recovered} orphaned review case(s)`);
                    }
                } catch (error) {
                    console.error('Error in orphaned review recovery:', error);
                }
            });
        }, null, true, 'America/New_York');

        // Portal submission dispatch (every 3 minutes)
        // submit-portal is dispatched from Railway (top-level) instead of from within
        // Trigger.dev tasks to avoid child-task PENDING_VERSION during deploys.
        // Runs at minute 1,4,7,10,... to avoid pile-up with */5 jobs
        this.jobs.portalDispatch = new CronJob('1-59/3 * * * *', () => {
            this.runWithDbLock(CronService.LOCK_IDS.portalDispatch, async () => {
                try {
                    const dispatched = await this.dispatchPendingPortalTasks();
                    if (dispatched > 0) {
                        console.log(`Portal dispatch: triggered ${dispatched} submit-portal task(s)`);
                    }
                } catch (error) {
                    console.error('Error in portal dispatch cron:', error);
                }
            });
        }, null, true, 'America/New_York');

        this.jobs.portalStatusMonitoring = new CronJob('13 */6 * * *', () => {
            this.runWithDbLock(CronService.LOCK_IDS.portalStatusMonitoring, async () => {
                try {
                    const result = await portalStatusMonitorService.monitorSubmittedPortalCases({ limit: 5 });
                    if (result.checked > 0 || result.failures > 0) {
                        console.log(`Portal status monitoring: checked ${result.checked}, records_ready ${result.recordsReady}, alerts ${result.alerts}, failures ${result.failures}`);
                    }
                } catch (error) {
                    await errorTrackingService.captureException(error, {
                        sourceService: 'cron_service',
                        operation: 'portal_status_monitor_cron',
                    });
                    console.error('Error in portal status monitoring cron:', error);
                }
            });
        }, null, true, 'America/New_York');

        console.log('✓ Notion sync: Every 5 min (:00,:05,:10,...)');
        console.log('✓ Cleanup: Daily at midnight');
        console.log('✓ Health check: Every 5 min (:00,:05,:10,...)');
        console.log('✓ Operational alerts: ~15 min (:03,:18,:33,:48)');
        console.log('✓ Stuck response check: ~30 min (:09,:39)');
        console.log('✓ Agency sync: Every hour + on startup');
        console.log('✓ Deadline escalation sweep: ~15 min (:07,:22,:37,:52)');
        console.log('✓ Stuck portal sweep: ~30 min (:12,:42)');
        console.log('✓ Stale run reaper: ~15 min (:05,:20,:35,:50)');
        console.log('✓ Loop breaker: ~30 min (:17,:47)');
        console.log('✓ Proposal dispatch recovery: ~5 min (:01,:06,:11,...)');
        console.log('✓ Trigger dispatch recovery: ~5 min (:03,:08,:13,...)');
        console.log('✓ Orphan review recovery: ~5 min (:04,:09,:14,...)');
        console.log('✓ Portal submission dispatch: Every 3 min (:01,:04,:07,...)');
        console.log('✓ Portal status monitoring: Every 6 hours');
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
     * Sweep for cases past their statutory deadline with no response.
     * Researches contact info, then routes to phone call (email cases) or human review (portal/unknown).
     */
    async sweepOverdueCases() {
        let phoneCalls = 0;
        let humanReviews = 0;
        let contactUpdates = 0;
        let skipped = 0;

        try {
            const result = await db.query(`
                SELECT c.*
                FROM cases c
                WHERE (
                    LOWER(c.status) IN ('sent', 'awaiting_response')
                    OR (
                        LOWER(c.status) IN (
                            'needs_human_review',
                            'needs_phone_call',
                            'needs_contact_info',
                            'needs_human_fee_approval',
                            'needs_rebuttal',
                            'pending_fee_decision',
                            'id_state'
                        )
                        AND UPPER(COALESCE(c.pause_reason, '')) = 'RESEARCH_HANDOFF'
                    )
                )
                  AND c.deadline_date IS NOT NULL
                  AND c.deadline_date < CURRENT_DATE
                  AND (
                    c.last_contact_research_at IS NULL
                    OR c.last_contact_research_at < NOW() - INTERVAL '7 days'
                  )
                  AND NOT EXISTS (
                    SELECT 1 FROM phone_call_queue pcq WHERE pcq.case_id = c.id
                  )
                  AND NOT EXISTS (
                    SELECT 1 FROM messages m
                    WHERE m.case_id = c.id
                      AND m.direction = 'inbound'
                      AND m.received_at > CURRENT_DATE - INTERVAL '14 days'
                  )
                ORDER BY c.deadline_date ASC
                LIMIT 20
            `);

            for (const caseData of result.rows) {
                try {
                    const daysOverdue = Math.floor(
                        (Date.now() - new Date(caseData.deadline_date).getTime()) / (1000 * 60 * 60 * 24)
                    );
                    const daysSinceSent = caseData.send_date
                        ? Math.floor((Date.now() - new Date(caseData.send_date).getTime()) / (1000 * 60 * 60 * 24))
                        : daysOverdue;

                    // Check if AI already analyzed a response for this case
                    const analysis = await db.getLatestResponseAnalysis(caseData.id);
                    if (analysis && analysis.intent) {
                        const handled = await this._handleAnalyzedOverdueCase(caseData, analysis, daysOverdue);
                        if (handled) {
                            if (handled === 'completed') {
                                skipped++;
                            } else {
                                humanReviews++;
                            }
                            await db.logActivity('deadline_escalation',
                                `Case ${caseData.case_name} routed by AI analysis (intent: ${analysis.intent})`,
                                { case_id: caseData.id, days_overdue: daysOverdue, intent: analysis.intent }
                            );
                            try { await notionService.syncStatusToNotion(caseData.id); } catch (_) {}
                            continue;
                        }
                    }

                    // Mark as researched immediately to prevent re-processing on next sweep
                    await db.updateCase(caseData.id, { last_contact_research_at: new Date() });

                    // Research agency contact info
                    let research = null;
                    try {
                        research = await pdContactService.lookupContact(
                            caseData.agency_name,
                            caseData.state || caseData.incident_location,
                            { forceSearch: true }
                        );
                    } catch (lookupErr) {
                        if (lookupErr.code === 'SERVICE_UNAVAILABLE') {
                            console.warn(`Deadline sweep: pd-contact unavailable, skipping case ${caseData.id}`);
                            // Clear research timestamp so it retries next sweep
                            await db.updateCase(caseData.id, { last_contact_research_at: null });
                            skipped++;
                            continue;
                        }
                        console.warn(`Deadline sweep: lookup failed for case ${caseData.id}: ${lookupErr.message}`);
                    }

                    // Compare research results to case data
                    const contactChanged = this._contactInfoChanged(caseData, research);
                    const isEmailCase = !caseData.portal_url || caseData.portal_url === '';

                    if (contactChanged && research) {
                        // Contact info is WRONG — update case and continue with actionable fallback
                        // (do not block on human approval for routine follow-up research).
                        const updates = {
                            contact_research_notes: [
                                `Deadline sweep: contact info differs from research`,
                                research.contact_email ? `Found email: ${research.contact_email}` : null,
                                research.portal_url ? `Found portal: ${research.portal_url}` : null,
                                research.records_officer ? `Records officer: ${research.records_officer}` : null,
                                `Confidence: ${research.confidence || 'unknown'}`
                            ].filter(Boolean).join('. ')
                        };
                        if (research.contact_email && research.contact_email !== caseData.agency_email) {
                            updates.alternate_agency_email = research.contact_email;
                        }
                        if (research.portal_url) {
                            const { normalizePortalUrl, isSupportedPortalUrl, detectPortalProviderByUrl } = require('../utils/portal-utils');
                            const normalized = normalizePortalUrl(research.portal_url);
                            if (normalized && isSupportedPortalUrl(normalized)) {
                                updates.portal_url = normalized;
                                updates.portal_provider = research.portal_provider || detectPortalProviderByUrl(normalized)?.name || null;
                            }
                        }
                        await db.updateCase(caseData.id, updates);

                        let agencyPhone = research?.contact_phone || null;
                        if (!agencyPhone && caseData.agency_id) {
                            const agency = await db.query('SELECT phone FROM agencies WHERE id = $1', [caseData.agency_id]);
                            if (agency.rows[0]?.phone) agencyPhone = agency.rows[0].phone;
                        }

                        const phoneTask = await db.createPhoneCallTask({
                            case_id: caseData.id,
                            agency_name: caseData.agency_name,
                            agency_phone: agencyPhone,
                            agency_state: caseData.state,
                            reason: 'deadline_passed',
                            priority: daysOverdue > 14 ? 2 : (daysOverdue > 7 ? 1 : 0),
                            notes: `Contact info changed during overdue research. ${updates.contact_research_notes}`,
                            days_since_sent: daysSinceSent
                        });

                        const aiService = require('./ai-service');
                        db.getMessagesByCaseId(caseData.id, 20)
                            .then(messages => aiService.generatePhoneCallBriefing(phoneTask, caseData, messages))
                            .then(briefing => db.updatePhoneCallBriefing(phoneTask.id, briefing))
                            .catch(err => console.error(`Auto-briefing failed for call #${phoneTask.id}:`, err.message));

                        await transitionCaseRuntime(caseData.id, 'CASE_ESCALATED', {
                            targetStatus: 'needs_phone_call',
                            substatus: `Deadline passed + contact updated (${daysOverdue}d overdue)`,
                            pauseReason: 'DEADLINE_PHONE_CALL',
                        });

                        contactUpdates++;
                        phoneCalls++;
                        console.log(`Deadline escalation: case ${caseData.id} (${caseData.case_name}) → phone call (contact changed)`);
                    } else if (isEmailCase) {
                        // Contact correct (or no research result) + email case → phone call
                        let agencyPhone = research?.contact_phone || null;
                        if (!agencyPhone && caseData.agency_id) {
                            const agency = await db.query('SELECT phone FROM agencies WHERE id = $1', [caseData.agency_id]);
                            if (agency.rows[0]?.phone) agencyPhone = agency.rows[0].phone;
                        }

                        const phoneTask = await db.createPhoneCallTask({
                            case_id: caseData.id,
                            agency_name: caseData.agency_name,
                            agency_phone: agencyPhone,
                            agency_state: caseData.state,
                            reason: 'deadline_passed',
                            priority: daysOverdue > 14 ? 2 : (daysOverdue > 7 ? 1 : 0),
                            notes: `Statutory deadline passed ${daysOverdue} days ago (deadline: ${caseData.deadline_date})`,
                            days_since_sent: daysSinceSent
                        });

                        // Auto-generate briefing (fire-and-forget)
                        const aiService = require('./ai-service');
                        db.getMessagesByCaseId(caseData.id, 20)
                            .then(messages => aiService.generatePhoneCallBriefing(phoneTask, caseData, messages))
                            .then(briefing => db.updatePhoneCallBriefing(phoneTask.id, briefing))
                            .catch(err => console.error(`Auto-briefing failed for call #${phoneTask.id}:`, err.message));

                        await transitionCaseRuntime(caseData.id, 'CASE_ESCALATED', {
                            targetStatus: 'needs_phone_call',
                            substatus: `Deadline passed ${daysOverdue}d ago — no response`,
                            pauseReason: 'DEADLINE_PHONE_CALL',
                        });

                        phoneCalls++;
                        console.log(`Deadline escalation: case ${caseData.id} (${caseData.case_name}) → phone call (${daysOverdue}d overdue)`);
                    } else {
                        // Portal/no-contact path:
                        // Prefer phone-call action over generic human escalation so
                        // overdue cases keep moving without manual triage.
                        try {
                            let agencyPhone = research?.contact_phone || null;
                            if (!agencyPhone && caseData.agency_id) {
                                const agency = await db.query('SELECT phone FROM agencies WHERE id = $1', [caseData.agency_id]);
                                if (agency.rows[0]?.phone) agencyPhone = agency.rows[0].phone;
                            }

                            const phoneTask = await db.createPhoneCallTask({
                                case_id: caseData.id,
                                agency_name: caseData.agency_name,
                                agency_phone: agencyPhone,
                                agency_state: caseData.state,
                                reason: 'deadline_passed',
                                priority: daysOverdue > 14 ? 2 : (daysOverdue > 7 ? 1 : 0),
                                notes: `Statutory deadline passed ${daysOverdue} days ago (deadline: ${caseData.deadline_date}). ${caseData.portal_url ? `Existing portal: ${caseData.portal_url}` : 'No portal/email contact available.'}`,
                                days_since_sent: daysSinceSent
                            });

                            // Auto-generate briefing (fire-and-forget)
                            const aiService = require('./ai-service');
                            db.getMessagesByCaseId(caseData.id, 20)
                                .then(messages => aiService.generatePhoneCallBriefing(phoneTask, caseData, messages))
                                .then(briefing => db.updatePhoneCallBriefing(phoneTask.id, briefing))
                                .catch(err => console.error(`Auto-briefing failed for call #${phoneTask.id}:`, err.message));

                            await transitionCaseRuntime(caseData.id, 'CASE_ESCALATED', {
                                targetStatus: 'needs_phone_call',
                                substatus: `Deadline passed ${daysOverdue}d ago — portal/no-contact fallback to phone`,
                                pauseReason: 'DEADLINE_PHONE_CALL',
                            });

                            phoneCalls++;
                            console.log(`Deadline escalation: case ${caseData.id} (${caseData.case_name}) → phone call (${caseData.portal_url ? 'portal fallback' : 'no contact fallback'})`);
                        } catch (phoneErr) {
                            // Last resort only: if we cannot create a phone task, ask for manual escalation.
                            await db.upsertProposal({
                                proposalKey: `${caseData.id}:deadline_sweep:ESCALATE`,
                                caseId: caseData.id,
                                actionType: 'ESCALATE',
                                reasoning: [
                                    { step: 'Deadline passed', detail: `${daysOverdue} days overdue (deadline: ${caseData.deadline_date})` },
                                    { step: 'Fallback failed', detail: `Phone escalation failed: ${phoneErr.message}` },
                                    { step: 'Portal case', detail: caseData.portal_url ? `Portal: ${caseData.portal_url}` : 'No contact research results' }
                                ],
                                confidence: 0,
                                requiresHuman: true,
                                canAutoExecute: false,
                                draftSubject: `Deadline overdue: ${caseData.case_name}`,
                                draftBodyText: `${daysOverdue} days past statutory deadline. Automated phone fallback failed: ${phoneErr.message}`,
                                status: 'PENDING_APPROVAL'
                            });

                            await transitionCaseRuntime(caseData.id, 'CASE_ESCALATED', {
                                substatus: `Deadline passed ${daysOverdue}d ago — phone fallback failed`,
                                pauseReason: 'DEADLINE_NO_CONTACT',
                            });

                            humanReviews++;
                            console.log(`Deadline escalation: case ${caseData.id} (${caseData.case_name}) → human review (phone fallback failed)`);
                        }
                    }

                    await db.logActivity('deadline_escalation',
                        `Case ${caseData.case_name} escalated: ${daysOverdue}d past deadline`,
                        { case_id: caseData.id, days_overdue: daysOverdue, contact_changed: contactChanged }
                    );

                    // Sync to Notion
                    try {
                        await notionService.syncStatusToNotion(caseData.id);
                    } catch (err) {
                        console.warn('Failed to sync deadline escalation to Notion:', err.message);
                    }
                } catch (error) {
                    console.error(`Error in deadline escalation for case ${caseData.id}:`, error.message);
                }
            }
        } catch (error) {
            console.error('Error in sweepOverdueCases:', error);
        }

        return { phoneCalls, humanReviews, contactUpdates, skipped };
    }

    /**
     * Compare research results to existing case contact data.
     * Returns true if research found meaningfully different contact info.
     */
    _contactInfoChanged(caseData, research) {
        if (!research) return false;

        // Check email difference (normalize to lowercase)
        if (research.contact_email) {
            const researchEmail = research.contact_email.toLowerCase().trim();
            const caseEmail = (caseData.agency_email || '').toLowerCase().trim();
            if (researchEmail && caseEmail && researchEmail !== caseEmail) return true;
        }

        // Check portal: found portal where none existed, or different portal
        if (research.portal_url) {
            const { normalizePortalUrl } = require('../utils/portal-utils');
            const researchPortal = normalizePortalUrl(research.portal_url) || '';
            const casePortal = normalizePortalUrl(caseData.portal_url || '') || '';
            if (researchPortal && !casePortal) return true;
            if (researchPortal && casePortal && researchPortal !== casePortal) return true;
        }

        return false;
    }

    /**
     * Handle an overdue case that already has an AI response analysis.
     * Routes based on the AI-determined intent instead of blind escalation.
     * Returns a truthy string ('proposal' or 'completed') if handled, or null to fall through.
     */
    async _handleAnalyzedOverdueCase(caseData, analysis, daysOverdue) {
        const intent = analysis.intent;
        // Static key base (no date) — dedup relies on case-level guard in upsertProposal
        const proposalKeyBase = `${caseData.id}:deadline_sweep_ai`;

        switch (intent) {
            case 'fee_request': {
                const feeAmount = parseFloat(analysis.extracted_fee_amount) || 0;
                const actionType = feeAmount > 0 && feeAmount <= parseFloat(process.env.FEE_AUTO_APPROVE_MAX || '100')
                    ? 'ACCEPT_FEE' : 'NEGOTIATE_FEE';
                await db.upsertProposal({
                    proposalKey: `${proposalKeyBase}:${actionType}`,
                    caseId: caseData.id,
                    actionType,
                    reasoning: [
                        { step: 'AI detected fee request', detail: `Agency quoted ${feeAmount > 0 ? '$' + feeAmount.toFixed(2) : 'unknown amount'}` },
                        { step: 'Deadline passed', detail: `${daysOverdue} days overdue` }
                    ],
                    confidence: analysis.confidence_score || 0,
                    requiresHuman: true,
                    canAutoExecute: false,
                    draftSubject: `Fee decision needed: ${caseData.case_name}`,
                    draftBodyText: `Agency quoted a fee${feeAmount > 0 ? ' of $' + feeAmount.toFixed(2) : ''}. ${daysOverdue} days past deadline.`,
                    status: 'PENDING_APPROVAL'
                });
                await transitionCaseRuntime(caseData.id, 'CASE_ESCALATED', {
                    targetStatus: 'pending_fee_decision',
                    substatus: `Fee quoted${feeAmount > 0 ? ': $' + feeAmount.toFixed(2) : ''} (${daysOverdue}d overdue)`,
                    pauseReason: 'FEE_DECISION_NEEDED',
                });
                console.log(`Deadline sweep: case ${caseData.id} → ${actionType} (AI detected fee_request)`);
                return 'proposal';
            }

            case 'question':
            case 'more_info_needed': {
                await db.upsertProposal({
                    proposalKey: `${proposalKeyBase}:SEND_CLARIFICATION`,
                    caseId: caseData.id,
                    actionType: 'SEND_CLARIFICATION',
                    reasoning: [
                        { step: 'AI detected clarification request', detail: analysis.suggested_action || 'Agency asked for more information' },
                        { step: 'Deadline passed', detail: `${daysOverdue} days overdue` }
                    ],
                    confidence: analysis.confidence_score || 0,
                    requiresHuman: true,
                    canAutoExecute: false,
                    draftSubject: `Clarification needed: ${caseData.case_name}`,
                    draftBodyText: `Agency asked for clarification. Key points: ${(analysis.key_points || []).join('; ') || 'See analysis'}`,
                    status: 'PENDING_APPROVAL'
                });
                await transitionCaseRuntime(caseData.id, 'CASE_ESCALATED', {
                    substatus: `Agency asked for clarification (${daysOverdue}d overdue)`,
                    pauseReason: 'CLARIFICATION_NEEDED',
                });
                console.log(`Deadline sweep: case ${caseData.id} → SEND_CLARIFICATION (AI detected ${intent})`);
                return 'proposal';
            }

            case 'records_ready':
            case 'delivery': {
                await transitionCaseRuntime(caseData.id, 'CASE_COMPLETED', {
                    substatus: `Records available (detected by AI, ${daysOverdue}d overdue)`,
                });
                await db.logActivity('case_completed_by_ai',
                    `Case ${caseData.case_name} marked completed — AI detected ${intent}`,
                    { case_id: caseData.id, days_overdue: daysOverdue }
                );
                console.log(`Deadline sweep: case ${caseData.id} → completed (AI detected ${intent})`);
                return 'completed';
            }

            case 'denial': {
                await db.upsertProposal({
                    proposalKey: `${proposalKeyBase}:SEND_REBUTTAL`,
                    caseId: caseData.id,
                    actionType: 'SEND_REBUTTAL',
                    reasoning: [
                        { step: 'AI detected denial', detail: analysis.suggested_action || 'Agency denied the request' },
                        { step: 'Deadline passed', detail: `${daysOverdue} days overdue` }
                    ],
                    confidence: analysis.confidence_score || 0,
                    requiresHuman: true,
                    canAutoExecute: false,
                    draftSubject: `Denial rebuttal needed: ${caseData.case_name}`,
                    draftBodyText: `Agency denied the request. Key points: ${(analysis.key_points || []).join('; ') || 'See analysis'}`,
                    status: 'PENDING_APPROVAL'
                });
                await transitionCaseRuntime(caseData.id, 'CASE_ESCALATED', {
                    targetStatus: 'needs_rebuttal',
                    substatus: `Denial received (${daysOverdue}d overdue)`,
                    pauseReason: 'DENIAL_REBUTTAL_NEEDED',
                });
                console.log(`Deadline sweep: case ${caseData.id} → SEND_REBUTTAL (AI detected denial)`);
                return 'proposal';
            }

            case 'portal_redirect': {
                await db.upsertProposal({
                    proposalKey: `${proposalKeyBase}:SUBMIT_PORTAL`,
                    caseId: caseData.id,
                    actionType: 'SUBMIT_PORTAL',
                    reasoning: [
                        `Agency directed to portal: ${analysis.suggested_action || 'Portal redirect detected'}`,
                        `Response deadline ${daysOverdue} days overdue`
                    ],
                    confidence: analysis.confidence_score || 0,
                    requiresHuman: true,
                    canAutoExecute: false,
                    draftSubject: `Portal submission: ${caseData.case_name}`.substring(0, 200),
                    draftBodyText: `Agency redirected to portal.\n${caseData.portal_url ? 'Portal URL: ' + caseData.portal_url : 'No portal URL on file — needs research.'}`,
                    status: 'PENDING_APPROVAL'
                });
                await transitionCaseRuntime(caseData.id, 'CASE_ESCALATED', {
                    substatus: `Portal redirect (${daysOverdue}d overdue)`,
                    pauseReason: 'PORTAL_REDIRECT',
                });
                console.log(`Deadline sweep: case ${caseData.id} → SUBMIT_PORTAL (AI detected portal_redirect)`);
                return 'proposal';
            }

            case 'acknowledgment':
                // Agency acknowledged but hasn't delivered — fall through to existing escalation logic
                console.log(`Deadline sweep: case ${caseData.id} — acknowledgment only, proceeding with standard escalation`);
                return null;

            default:
                // Unknown intent — fall through to existing logic
                return null;
        }
    }

    /**
     * Sweep for stuck portal cases, orphaned reviews, and stale follow-up records.
     */
    async sweepStuckPortalCases() {
        let portalEscalated = 0;
        let proposalsCreated = 0;
        let followUpFixed = 0;

        // Sweep 1: Stuck portal_in_progress > 30 minutes
        try {
            const stuckPortal = await db.query(`
                SELECT c.* FROM cases c
                WHERE c.status = 'portal_in_progress'
                  AND c.updated_at < NOW() - INTERVAL '30 minutes'
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
                    portalError = normalizePortalTimeoutError(portalError);

                    await transitionCaseRuntime(caseData.id, 'PORTAL_STUCK', {
                        substatus: `Portal timed out (>30 min): ${portalError}`.substring(0, 100),
                    });

                    // Create proposal with full error context
                    await db.upsertProposal({
                        proposalKey: `${caseData.id}:portal_stuck_timeout:SUBMIT_PORTAL:1`,
                        caseId: caseData.id,
                        actionType: 'SUBMIT_PORTAL',
                        reasoning: [
                            'Automated portal submission timed out after 30+ minutes',
                            `Error: ${portalError}`,
                            'Approve to retry automated submission, or dismiss to handle manually'
                        ],
                        confidence: 0, requiresHuman: true, canAutoExecute: false,
                        draftSubject: `Portal retry: ${caseData.case_name}`.substring(0, 200),
                        draftBodyText: [
                            `Portal URL: ${caseData.portal_url || 'N/A'}`,
                            `Previous attempt failed: ${portalError}`,
                            '',
                            'Approving will retry the automated portal submission.',
                            recordingUrl ? `Last attempt recording: ${recordingUrl}` : null,
                            taskUrl ? `Last attempt task: ${taskUrl}` : null
                        ].filter(Boolean).join('\n'),
                        status: 'PENDING_APPROVAL'
                    });

                    await db.logActivity('portal_stuck_escalated',
                        `Case ${caseData.case_name} stuck >30min. Error: ${portalError}`,
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
        // Guard: skip cases that already have active proposals OR were recently triaged (last 48h)
        try {
            const orphaned = await db.query(`
                SELECT c.* FROM cases c
                WHERE c.status = 'needs_human_review'
                  AND c.updated_at < NOW() - INTERVAL '48 hours'
                  AND NOT EXISTS (
                    SELECT 1 FROM proposals p
                    WHERE p.case_id = c.id
                      AND (
                        p.status IN ('PENDING_APPROVAL', 'DRAFT', 'DECISION_RECEIVED', 'BLOCKED', 'PENDING_PORTAL')
                        OR (p.status = 'DISMISSED' AND p.updated_at > NOW() - INTERVAL '48 hours')
                      )
                  )
            `);

            const aiService = require('./ai-service');

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

                    // Hard circuit breaker: if 3+ proposals have been dismissed for this case,
                    // force ESCALATE — the AI keeps proposing actions the human doesn't want.
                    const countedDismissals = priorProposals.filter((p) => countsTowardDismissCircuitBreaker(p));
                    const dismissedCount = countedDismissals.length;
                    if (dismissedCount >= 3) {
                        console.log(`Circuit breaker: case ${caseData.id} has ${dismissedCount} dismissed proposals — forcing ESCALATE`);
                        await db.upsertProposal({
                            proposalKey: `${caseData.id}:sweep_orphan:ESCALATE_CIRCUIT_BREAKER`,
                            caseId: caseData.id,
                            actionType: 'ESCALATE',
                            reasoning: [
                                { step: 'Circuit breaker', detail: `${dismissedCount} proposals have been dismissed for this case — AI cannot find an acceptable action` },
                                { step: 'Prior dismissed actions', detail: countedDismissals.map(p => p.action_type).join(', ') }
                            ],
                            confidence: 0,
                            requiresHuman: true,
                            canAutoExecute: false,
                            draftSubject: `Manual attention needed: ${caseData.case_name}`,
                            draftBodyText: `This case has had ${dismissedCount} proposals dismissed. The automated system cannot determine the right action.\n\nPrior dismissed actions: ${countedDismissals.map(p => p.action_type).join(', ')}\n\nPlease review the case and decide the next step manually.`,
                            status: 'PENDING_APPROVAL'
                        });
                        await db.logActivity('circuit_breaker_escalation',
                            `Case ${caseData.case_name}: ${dismissedCount} dismissed proposals → forced ESCALATE`,
                            { case_id: caseData.id, dismissed_count: dismissedCount }
                        );
                        proposalsCreated++;
                        continue;
                    }

                    // AI triage: determine the right action
                    const triage = await aiService.triageStuckCase(caseData, messages, priorProposals);
                    let actionType = triage.actionType || 'ESCALATE';

                    // Generate an actual email draft (not just the triage summary)
                    let draftSubject = null;
                    let draftBodyText = null;
                    let draftBodyHtml = null;
                    let triggerMessageId = null;

                    try {
                        if (actionType === 'SEND_FOLLOWUP') {
                            const followupSchedule = await db.getFollowUpScheduleByCaseId(caseData.id);
                            const attemptNumber = (followupSchedule?.followup_count || 0) + 1;
                            const draft = await aiService.generateFollowUp(caseData, attemptNumber);
                            draftSubject = draft.subject;
                            draftBodyText = draft.body_text;
                            draftBodyHtml = draft.body_html || null;
                        } else if (actionType === 'SEND_REBUTTAL') {
                            // Find the denial message to rebuttal against
                            const latestInbound = messages.find(m => m.direction === 'inbound') || null;
                            const latestAnalysis = latestInbound
                                ? await db.getResponseAnalysisByMessageId(latestInbound.id)
                                : null;
                            if (latestInbound && latestAnalysis) {
                                triggerMessageId = latestInbound.id;
                                const constraints = caseData.constraints_jsonb || [];
                                const exemptItems = (Array.isArray(constraints) ? constraints : [])
                                    .filter(c => typeof c === 'string' && c.endsWith('_EXEMPT'));
                                const draft = await aiService.generateDenialRebuttal(
                                    latestInbound, latestAnalysis, caseData,
                                    { excludeItems: exemptItems, scopeItems: caseData.scope_items_jsonb || [] }
                                );
                                draftSubject = draft.subject || `RE: ${latestInbound.subject || 'Public Records Request'}`;
                                draftBodyText = draft.body_text;
                                draftBodyHtml = draft.body_html || null;
                            }
                        } else if (actionType === 'SEND_CLARIFICATION') {
                            const latestInbound = messages.find(m => m.direction === 'inbound') || null;
                            const latestAnalysis = latestInbound
                                ? await db.getResponseAnalysisByMessageId(latestInbound.id)
                                : null;
                            if (latestInbound) {
                                triggerMessageId = latestInbound.id;
                                if (typeof aiService.generateClarificationResponse === 'function') {
                                    const draft = await aiService.generateClarificationResponse(
                                        latestInbound, latestAnalysis, caseData
                                    );
                                    draftSubject = draft.subject || `RE: ${latestInbound.subject || 'Public Records Request'}`;
                                    draftBodyText = draft.body_text;
                                } else {
                                    const draft = await aiService.generateAutoReply(
                                        latestInbound, latestAnalysis, caseData
                                    );
                                    draftSubject = draft.subject || `RE: ${latestInbound.subject || 'Public Records Request'}`;
                                    draftBodyText = draft.body_text;
                                }
                            }
                        }
                    } catch (draftErr) {
                        console.error(`Draft generation failed for case ${caseData.id} (${actionType}):`, draftErr.message);
                    }

                    // Fallback: if draft generation failed or action doesn't have a draft path
                    if (!draftBodyText) {
                        // Draft generation failed — don't create email action with triage text as body.
                        // Force ESCALATE so a human writes the draft.
                        if (DRAFT_REQUIRED_ACTIONS.includes(actionType)) {
                            console.warn(`Draft generation failed for case ${caseData.id} — downgrading ${actionType} to ESCALATE`);
                            actionType = 'ESCALATE';
                        }
                        draftSubject = `Action needed: ${caseData.case_name}`;
                        draftBodyText = `AI triage recommends: ${triage.recommendation || triage.summary}\n\n(Draft generation failed — manual action required)`;
                    }

                    await db.upsertProposal({
                        proposalKey: `${caseData.id}:sweep_orphan:${actionType}`,
                        caseId: caseData.id,
                        triggerMessageId: triggerMessageId,
                        actionType: actionType,
                        reasoning: [
                            { step: 'AI triage summary', detail: triage.summary },
                            { step: 'Recommendation', detail: triage.recommendation }
                        ],
                        confidence: triage.confidence || 0,
                        requiresHuman: true,
                        canAutoExecute: false,
                        draftSubject: draftSubject,
                        draftBodyText: draftBodyText,
                        draftBodyHtml: draftBodyHtml,
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

        // Sweep 2b: Fee-stranded cases — dismissed fee proposal, no active proposal, case not in review
        // These cases had a fee_request/partial_delivery intent and the operator dismissed the proposal,
        // but reconcileCaseAfterDismiss moved the case out of review with no new proposal.
        // Fast sweep (1h window instead of 48h) to re-create a fee decision proposal.
        let feeProposalsCreated = 0;
        try {
            const feeStranded = await db.query(`
                SELECT DISTINCT c.id, c.case_name, c.agency_email,
                    latest_ra.intent, latest_ra.extracted_fee_amount,
                    latest_ra.requires_action,
                    latest_ra.suggested_action,
                    p.action_type as dismissed_action
                FROM cases c
                JOIN LATERAL (
                    SELECT ra.*
                    FROM messages m
                    JOIN response_analysis ra ON ra.message_id = m.id
                    WHERE m.case_id = c.id
                      AND m.direction = 'inbound'
                    ORDER BY COALESCE(ra.created_at, m.received_at, m.created_at) DESC, ra.id DESC
                    LIMIT 1
                ) latest_ra ON TRUE
                LEFT JOIN proposals dp ON dp.case_id = c.id
                    AND dp.action_type IN ('ACCEPT_FEE', 'NEGOTIATE_FEE', 'DECLINE_FEE', 'SEND_FEE_WAIVER_REQUEST')
                    AND dp.status = 'DISMISSED'
                    AND dp.updated_at > NOW() - INTERVAL '7 days'
                WHERE c.status NOT IN ('completed', 'cancelled', 'closed')
                  AND latest_ra.intent IN ('FEE_QUOTE', 'PARTIAL_DELIVERY')
                  AND latest_ra.created_at > NOW() - INTERVAL '7 days'
                  AND COALESCE(latest_ra.requires_action, false) = true
                  AND COALESCE(NULLIF(UPPER(TRIM(latest_ra.suggested_action)), ''), 'WAIT') NOT IN ('WAIT', 'NONE', 'MONITOR')
                  AND NOT EXISTS (
                    SELECT 1 FROM proposals p2
                    WHERE p2.case_id = c.id
                      AND p2.status IN ('PENDING_APPROVAL', 'BLOCKED', 'DRAFT', 'DECISION_RECEIVED', 'PENDING_PORTAL')
                  )
                  AND NOT EXISTS (
                    SELECT 1 FROM agent_runs ar
                    WHERE ar.case_id = c.id AND ar.status IN ('created', 'queued', 'running', 'processing')
                  )
                ORDER BY c.id
            `);

            for (const row of feeStranded.rows) {
                try {
                    const feeAmount = row.extracted_fee_amount ? `$${row.extracted_fee_amount}` : 'unspecified amount';
                    await db.upsertProposal({
                        proposalKey: `${row.id}:fee_sweep:NEGOTIATE_FEE`,
                        caseId: row.id,
                        actionType: 'NEGOTIATE_FEE',
                        reasoning: [
                            { step: 'Fee sweep', detail: `Agency sent fee notice (${feeAmount}) but the prior fee proposal was dismissed. Re-creating for operator review.` },
                            { step: 'Intent', detail: row.intent },
                        ],
                        confidence: 0.5,
                        requiresHuman: true,
                        canAutoExecute: false,
                        draftSubject: `RE: ${row.case_name || 'Records Request'} - Fee Response`,
                        draftBodyText: `A fee of ${feeAmount} was quoted by the agency. The previous proposal (${row.dismissed_action || 'fee action'}) was dismissed.\n\nPlease review and decide:\n- Accept the fee\n- Negotiate a lower fee\n- Decline and request fee waiver\n- Close the case`,
                        status: 'PENDING_APPROVAL'
                    });
                    feeProposalsCreated++;
                    console.log(`Fee sweep: created NEGOTIATE_FEE proposal for case ${row.id} (${row.case_name})`);
                    await db.logActivity('fee_sweep_proposal',
                        `Fee sweep: re-created fee proposal for case ${row.case_name} (${feeAmount})`,
                        { case_id: row.id, fee_amount: row.extracted_fee_amount, dismissed_action: row.dismissed_action }
                    );
                } catch (err) {
                    console.error(`Error creating fee sweep proposal for case ${row.id}:`, err.message);
                }
            }
        } catch (error) {
            console.error('Error in fee-stranded sweep:', error);
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

        // Sweep 4: Clean up stuck agent runs
        // - queued/running > 1 hour
        // - waiting > 2 hours with no active proposal (orphaned wait state)
        let stuckRunsCleaned = 0;
        try {
            const stuckResult = await db.query(`
                UPDATE agent_runs
                SET status = 'failed',
                    ended_at = NOW(),
                    error = CASE
                        WHEN status = 'waiting' THEN 'Auto-cleaned: orphaned waiting run >2h with no active proposal'
                        ELSE 'Auto-cleaned: stuck in queued/running for >1h'
                    END
                WHERE (
                    status IN ('queued', 'running')
                    AND started_at < NOW() - INTERVAL '1 hour'
                ) OR (
                    status = 'waiting'
                    AND started_at < NOW() - INTERVAL '2 hours'
                    AND NOT EXISTS (
                        SELECT 1
                        FROM proposals p
                        WHERE p.case_id = agent_runs.case_id
                          AND p.status IN ('PENDING_APPROVAL', 'BLOCKED', 'DECISION_RECEIVED', 'PENDING_PORTAL')
                    )
                )
                RETURNING id, case_id
            `);
            stuckRunsCleaned = stuckResult.rowCount || 0;
            if (stuckRunsCleaned > 0) {
                console.log(`Cleaned ${stuckRunsCleaned} stuck agent runs`);
            }
        } catch (error) {
            console.error('Error in stuck agent run cleanup:', error);
        }

        // Sweep 4b: Transition cases stuck with "Resolving:" substatus > 30 min
        // These had a human-review reprocess dispatched but ALL runs failed/were cleaned,
        // leaving the case with requires_human=false and a stale substatus.
        let staleResolvingFixed = 0;
        try {
            const staleResult = await db.query(`
                UPDATE cases
                SET requires_human = true,
                    substatus = 'Reprocess failed — needs review',
                    pause_reason = 'agent_run_failed'
                WHERE substatus LIKE 'Resolving:%'
                  AND updated_at < NOW() - INTERVAL '30 minutes'
                  AND NOT EXISTS (
                      SELECT 1 FROM agent_runs ar
                      WHERE ar.case_id = cases.id
                        AND ar.status IN ('queued', 'running', 'waiting')
                  )
                RETURNING id
            `);
            staleResolvingFixed = staleResult.rowCount || 0;
            if (staleResolvingFixed > 0) {
                const caseIds = staleResult.rows.map(r => r.id);
                console.log(`Fixed ${staleResolvingFixed} cases stuck with stale Resolving substatus: ${caseIds.join(', ')}`);
                await db.logActivity('stale_resolving_fixed',
                    `Fixed ${staleResolvingFixed} cases with stale "Resolving:" substatus`,
                    { case_ids: caseIds }
                );
            }
        } catch (error) {
            console.error('Error in stale Resolving substatus sweep:', error);
        }

        // Sweep 5: Retry proposals stuck in DECISION_RECEIVED > 5 minutes
        // These are proposals the user approved but the resume job failed (e.g. Redis timeout)
        // Max 5 retries — after that, mark as failed and escalate
        let stuckDecisionsRetried = 0;
        try {
            const stuckDecisions = await db.query(`
                SELECT p.id, p.case_id, p.action_type, p.human_decision,
                       COALESCE((p.human_decision->>'retry_count')::int, 0) AS retry_count
                FROM proposals p
                WHERE p.status = 'DECISION_RECEIVED'
                  AND p.updated_at < NOW() - INTERVAL '5 minutes'
            `);

            for (const proposal of stuckDecisions.rows) {
                try {
                    const retryCount = proposal.retry_count || 0;

                    // Circuit breaker: after 5 retries, give up and escalate
                    if (retryCount >= 5) {
                        console.error(`Proposal #${proposal.id} stuck in DECISION_RECEIVED after ${retryCount} retries — marking EXECUTION_FAILED`);
                        await db.query(
                            `UPDATE proposals SET status = 'DISMISSED', updated_at = NOW(),
                             human_decision = COALESCE(human_decision, '{}'::jsonb) || '{"failure_reason": "execution_retry_exhausted", "auto_dismiss_reason": "execution_retry_exhausted"}'::jsonb,
                             human_decided_by = COALESCE(human_decided_by, 'system'),
                             human_decided_at = COALESCE(human_decided_at, NOW())
                             WHERE id = $1`,
                            [proposal.id]
                        );
                        await transitionCaseRuntime(proposal.case_id, 'CASE_ESCALATED', {
                            substatus: `Approved proposal #${proposal.id} failed after ${retryCount} retries`,
                            pauseReason: 'EXECUTION_RETRY_EXHAUSTED',
                        });
                        await db.logActivity('execution_retry_exhausted',
                            `Proposal #${proposal.id} (${proposal.action_type}) failed to execute after ${retryCount} retries`,
                            { case_id: proposal.case_id, proposal_id: proposal.id, retry_count: retryCount }
                        );
                        continue;
                    }

                    // Increment retry count
                    await db.query(
                        `UPDATE proposals SET human_decision = COALESCE(human_decision, '{}'::jsonb) || jsonb_build_object('retry_count', $2)
                         WHERE id = $1`,
                        [proposal.id, retryCount + 1]
                    );

                    // Check if there's already an active agent run for this case
                    const activeRun = await db.query(`
                        SELECT id FROM agent_runs
                        WHERE case_id = $1 AND status IN ('created', 'queued', 'running', 'processing', 'waiting', 'paused')
                        LIMIT 1
                    `, [proposal.case_id]);

                    if (activeRun.rows.length > 0) {
                        continue; // Already has a run in progress
                    }

                    // Re-trigger through Trigger.dev
                    const run = await db.createAgentRunFull({
                        case_id: proposal.case_id,
                        trigger_type: 'resume_retry',
                        status: 'queued',
                        autopilot_mode: 'SUPERVISED',
                        langgraph_thread_id: `resume:${proposal.case_id}:proposal-${proposal.id}`
                    });

                    if (proposal.action_type === 'SEND_INITIAL_REQUEST') {
                        await triggerDispatch.triggerTask('process-initial-request', {
                            runId: run.id,
                            caseId: proposal.case_id,
                            autopilotMode: 'SUPERVISED',
                        }, {
                            queue: `case-${proposal.case_id}`,
                            idempotencyKey: `resume-retry-initial:${proposal.case_id}:${run.id}`,
                            idempotencyKeyTTL: '1h',
                        }, {
                            runId: run.id,
                            caseId: proposal.case_id,
                            triggerType: 'resume_retry',
                            source: 'cron_stuck_decision_retry',
                        });
                    } else {
                        await triggerDispatch.triggerTask('process-inbound', {
                            runId: run.id,
                            caseId: proposal.case_id,
                            messageId: proposal.trigger_message_id,
                            autopilotMode: 'SUPERVISED',
                        }, {
                            queue: `case-${proposal.case_id}`,
                            idempotencyKey: `resume-retry-inbound:${proposal.case_id}:${run.id}`,
                            idempotencyKeyTTL: '1h',
                        }, {
                            runId: run.id,
                            caseId: proposal.case_id,
                            triggerType: 'resume_retry',
                            source: 'cron_stuck_decision_retry',
                        });
                    }

                    stuckDecisionsRetried++;
                    console.log(`Retried stuck DECISION_RECEIVED proposal #${proposal.id} for case #${proposal.case_id}`);
                } catch (retryErr) {
                    console.error(`Failed to retry proposal #${proposal.id}:`, retryErr.message);
                }
            }

            if (stuckDecisionsRetried > 0) {
                console.log(`Retried ${stuckDecisionsRetried} stuck DECISION_RECEIVED proposals`);
            }
        } catch (error) {
            console.error('Error in stuck decision retry sweep:', error.message);
        }

        // Sweep 6: Clear stale requires_human flags
        // Cases where requires_human=true but no active proposal and no active run exist.
        // Only clear for non-review statuses (review statuses are handled by sweep 2 orphan triage).
        let staleHumanFlagsCleared = 0;
        try {
            const staleResult = await db.query(`
                UPDATE cases
                SET requires_human = false,
                    pause_reason = null,
                    updated_at = NOW()
                WHERE requires_human = true
                  AND status NOT IN ('needs_human_review', 'needs_phone_call', 'needs_contact_info', 'needs_human_fee_approval')
                  AND status NOT IN ('completed', 'cancelled')
                  AND NOT EXISTS (
                    SELECT 1 FROM proposals p
                    WHERE p.case_id = cases.id
                      AND p.status IN ('PENDING_APPROVAL', 'BLOCKED')
                  )
                  AND NOT EXISTS (
                    SELECT 1 FROM agent_runs ar
                    WHERE ar.case_id = cases.id
                      AND ar.status IN ('created', 'queued', 'processing', 'running', 'waiting')
                  )
                RETURNING id, status
            `);
            staleHumanFlagsCleared = staleResult.rowCount || 0;
            if (staleHumanFlagsCleared > 0) {
                const caseIds = staleResult.rows.map(r => r.id);
                console.log(`Cleared ${staleHumanFlagsCleared} stale requires_human flags: ${caseIds.join(', ')}`);
                await db.logActivity('stale_human_flag_cleared',
                    `Cleared stale requires_human on ${staleHumanFlagsCleared} cases: ${caseIds.join(', ')}`,
                    { case_ids: caseIds }
                );
            }
        } catch (error) {
            console.error('Error in stale human flag sweep:', error);
        }

        // Sweep 7: portal_tasks stuck IN_PROGRESS >30min with no active portal run
        let stuckPortalTasksCleaned = 0;
        try {
            const stuckTasks = await db.query(`
                SELECT pt.id, pt.case_id FROM portal_tasks pt
                WHERE pt.status = 'IN_PROGRESS'
                  AND pt.updated_at < NOW() - INTERVAL '30 minutes'
                  AND NOT EXISTS (
                    SELECT 1 FROM agent_runs ar
                    WHERE ar.case_id = pt.case_id
                      AND ar.trigger_type IN ('submit_portal', 'portal_submit')
                      AND ar.status IN ('created', 'queued', 'running', 'processing', 'waiting')
                  )
            `);
            for (const pt of stuckTasks.rows) {
                // CAS pre-check: skip if already transitioned by another writer
                const casCheck = await db.query(
                    `SELECT id FROM portal_tasks WHERE id = $1 AND status = 'IN_PROGRESS'`,
                    [pt.id]
                );
                if (casCheck.rowCount === 0) continue;

                try {
                    await transitionCaseRuntime(pt.case_id, 'STUCK_PORTAL_TASK_FAILED', {
                        portalTaskId: pt.id,
                        error: 'Auto-failed: stuck IN_PROGRESS >30min with no active run',
                        portalMetadata: {
                            last_portal_status: 'Auto-failed: portal task stuck IN_PROGRESS >30min (no active run)',
                            last_portal_status_at: new Date(),
                        },
                    });
                    stuckPortalTasksCleaned++;
                    console.log(`Auto-failed stuck portal_task ${pt.id} for case ${pt.case_id}`);

                    try {
                        const caseSnapshot = await db.getCaseById(pt.case_id);
                        const latestPortalFailure = await db.query(
                            `SELECT completion_notes, status
                               FROM portal_tasks
                              WHERE case_id = $1
                                AND id != $2
                              ORDER BY updated_at DESC
                              LIMIT 1`,
                            [pt.case_id, pt.id]
                        );
                        const failureContext = [
                            caseSnapshot?.last_portal_status || '',
                            latestPortalFailure.rows[0]?.completion_notes || '',
                        ].join('\n').toLowerCase();
                        const retryLikelyBlocked = /blocked words|spam filter|cannot determine which specific words|cannot alter the user-provided text|generic error message about blocked words/.test(failureContext);
                        const proposalActionType = retryLikelyBlocked ? 'ESCALATE' : 'SUBMIT_PORTAL';
                        const proposalBody = retryLikelyBlocked
                            ? `Portal task #${pt.id} was auto-failed after being stuck in IN_PROGRESS for more than 30 minutes with no active run.\n\nThe most recent portal failure indicates the request text is being rejected by a blocked-words or spam filter, so retrying unchanged automation is unlikely to work.\n\nUse the Manual Submit Helper to complete the portal submission manually or adjust the submission plan before retrying.`
                            : `Portal task #${pt.id} was auto-failed after being stuck in IN_PROGRESS for more than 30 minutes with no active run.\n\nApprove to retry portal submission, or choose manual fallback.`;
                        const proposalReasoning = retryLikelyBlocked
                            ? [
                                `Portal task #${pt.id} was stuck IN_PROGRESS for over 30 minutes with no active submit-portal run.`,
                                'The last portal failure indicates blocked-words/spam-filter rejection, so manual fallback is safer than retrying unchanged automation.'
                            ]
                            : [
                                `Portal task #${pt.id} was stuck IN_PROGRESS for over 30 minutes with no active submit-portal run.`,
                                'Review and approve to retry portal submission or switch to manual handling.'
                            ];

                        await db.upsertProposal({
                            proposalKey: `${pt.case_id}:stuck_portal_task:${pt.id}:${proposalActionType}`,
                            caseId: pt.case_id,
                            actionType: proposalActionType,
                            reasoning: proposalReasoning,
                            confidence: 0,
                            requiresHuman: true,
                            canAutoExecute: false,
                            draftSubject: retryLikelyBlocked
                                ? `Manual portal fallback recommended for case ${pt.case_id}`
                                : `Portal retry recommended for case ${pt.case_id}`,
                            draftBodyText: proposalBody,
                            status: 'PENDING_APPROVAL',
                            gateOptions: retryLikelyBlocked ? ['ADJUST', 'DISMISS'] : ['APPROVE', 'ADJUST', 'DISMISS']
                        });
                    } catch (proposalErr) {
                        console.error(`Failed to create stuck portal retry proposal for case ${pt.case_id}:`, proposalErr.message);
                    }

                    await db.logActivity(
                        'stuck_portal_task_auto_failed',
                        `Auto-failed stuck portal task #${pt.id} and marked case ${pt.case_id} for human review`,
                        { case_id: pt.case_id, portal_task_id: pt.id }
                    );
                } catch (err) {
                    if (err.name === 'CaseLockContention') {
                        console.warn(`Case ${pt.case_id} locked during stuck portal task cleanup — skipping`);
                        continue;
                    }
                    console.error(`Error cleaning stuck portal_task ${pt.id} for case ${pt.case_id}:`, err.message);
                }
            }
            if (stuckPortalTasksCleaned > 0) {
                await db.logActivity('stuck_portal_tasks_cleaned',
                    `Auto-failed ${stuckPortalTasksCleaned} stuck portal_tasks`,
                    { count: stuckPortalTasksCleaned }
                );
            }
        } catch (error) {
            console.error('Error in stuck portal_tasks sweep:', error);
        }

        return { portalEscalated, proposalsCreated, feeProposalsCreated, followUpFixed, stuckRunsCleaned, staleResolvingFixed, stuckDecisionsRetried, staleHumanFlagsCleared, stuckPortalTasksCleaned };
    }

    /**
     * Dispatch pending portal submissions as top-level Trigger.dev tasks.
     * Replaces in-task child triggers that got stuck in PENDING_VERSION during deploys.
     */
    async dispatchPendingPortalTasks() {
        let dispatched = 0;

        // Find actionable portal_tasks that are PENDING and have no active submit-portal Trigger.dev run
        const pending = await db.query(`
            SELECT pt.id, pt.case_id, pt.instructions, pt.action_type,
                   c.portal_url, c.portal_provider
            FROM portal_tasks pt
            JOIN cases c ON c.id = pt.case_id
            WHERE pt.status = 'PENDING'
              AND c.status NOT IN ('sent', 'awaiting_response', 'responded', 'completed', 'cancelled')
              AND pt.created_at > NOW() - INTERVAL '24 hours'
              AND NOT EXISTS (
                  SELECT 1 FROM agent_runs ar
                  WHERE ar.case_id = pt.case_id
                    AND ar.trigger_type = 'submit_portal'
                    AND ar.status IN ('created', 'queued', 'running', 'processing', 'waiting')
              )
            ORDER BY pt.created_at ASC
            LIMIT 10
        `);

        for (const pt of pending.rows) {
            try {
                // Claim task atomically to prevent duplicate dispatches across concurrent cron workers.
                const claimed = await db.query(
                    `UPDATE portal_tasks
                     SET status = 'IN_PROGRESS',
                         updated_at = NOW(),
                         completion_notes = NULL
                     WHERE id = $1
                       AND status = 'PENDING'
                     RETURNING id`,
                    [pt.id]
                );
                if (claimed.rowCount === 0) {
                    continue;
                }

                // Create an agent run to track this dispatch
                const run = await db.createAgentRunFull({
                    case_id: pt.case_id,
                    trigger_type: 'submit_portal',
                    status: 'queued',
                    autopilot_mode: 'SUPERVISED',
                    langgraph_thread_id: `submit-portal:${pt.case_id}:${pt.id}:${Date.now()}`,
                    metadata: {
                        source: 'portal_dispatch_cron',
                        portal_task_id: pt.id,
                    }
                });

                await triggerDispatch.triggerTask('submit-portal', {
                    caseId: pt.case_id,
                    portalUrl: pt.portal_url,
                    provider: pt.portal_provider || null,
                    instructions: pt.instructions || 'Submit through agency portal',
                    portalTaskId: pt.id,
                    agentRunId: run.id,
                }, {
                    idempotencyKey: `portal-cron:${pt.case_id}:${pt.id}`,
                    idempotencyKeyTTL: '1h',
                }, {
                    runId: run.id,
                    caseId: pt.case_id,
                    triggerType: 'submit_portal',
                    source: 'portal_dispatch_cron',
                });

                dispatched++;
            } catch (err) {
                console.error(`Failed to dispatch submit-portal for case ${pt.case_id}:`, err.message);
                try {
                    await db.query(
                        `UPDATE portal_tasks
                         SET status = 'PENDING',
                             updated_at = NOW(),
                             completion_notes = $2
                         WHERE id = $1
                           AND status = 'IN_PROGRESS'`,
                        [pt.id, `Dispatch failed: ${String(err.message || err).substring(0, 400)}`]
                    );
                } catch (rollbackErr) {
                    console.error(`Failed to rollback portal task claim ${pt.id}:`, rollbackErr.message);
                }
            }
        }

        return dispatched;
    }

    /**
     * Stop all cron jobs
     */
    stop() {
        console.log('Stopping cron services...');
        Object.values(this.jobs).forEach(job => job.stop());

        // Stop follow-up scheduler
        followupScheduler.stop();

        console.log('All cron jobs stopped');
    }

    /**
     * Get status of all jobs
     */
    getStatus() {
        // Follow-up scheduling is always run via Run Engine.
        const followUpStatus = followupScheduler.cronJob?.running || false;
        const followUpEngine = 'run_engine';

        return {
            notionSync: this.jobs.notionSync?.running || false,
            followUp: followUpStatus,
            followUpEngine: followUpEngine,
            cleanup: this.jobs.cleanup?.running || false,
            healthCheck: this.jobs.healthCheck?.running || false,
            operationalAlerts: this.jobs.operationalAlerts?.running || false,
            weeklyQualityReport: this.jobs.weeklyQualityReport?.running || false,
            draftQualityEval: this.jobs.draftQualityEval?.running || false,
            stuckResponseCheck: this.jobs.stuckResponseCheck?.running || false,
            deadlineEscalationSweep: this.jobs.deadlineEscalationSweep?.running || false
        };
    }

    async runResolvedDraftQualityEvalSweep() {
        const capture = await draftQualityEvalService.captureResolvedDraftQualityEvalCases({ windowDays: 30 });
        const triggered = [];

        for (const item of capture.captured) {
            const handle = await tasks.trigger('eval-decision', {
                evalCaseId: item.eval_case_id,
                evaluationType: 'draft_quality',
            });
            triggered.push({
                eval_case_id: item.eval_case_id,
                trigger_run_id: handle.id,
            });
        }

        if (capture.captured_count > 0) {
            await db.logActivity('draft_quality_eval_capture', 'Captured resolved drafts for quality scoring', {
                window_days: capture.window_days,
                captured_count: capture.captured_count,
                triggered_count: triggered.length,
                eval_case_ids: capture.captured.map((item) => item.eval_case_id),
            });
        }

        return { capture, triggered };
    }

    async sendWeeklyQualityReport() {
        const report = await qualityReportService.buildWeeklyQualityReport({ windowDays: 7 });
        const confusion = await qualityReportService.buildClassificationConfusionMatrix({ windowDays: 30 });

        const topAdjustment = report.common_adjustments[0]?.adjustment || 'None';
        const topFailure = report.common_failures[0]
            ? `${report.common_failures[0].failure_category} (${report.common_failures[0].count})`
            : 'None';
        const topConfusion = confusion.top_confusions[0]
            ? `${confusion.top_confusions[0].predicted_classification} -> ${confusion.top_confusions[0].actual_classification} (${confusion.top_confusions[0].count})`
            : 'None';

        await db.logActivity('weekly_quality_report', 'Generated weekly quality report', {
            report_window_days: report.window_days,
            confusion_window_days: confusion.window_days,
            cases_processed: report.overview.cases_processed,
            cases_resolved: report.overview.cases_resolved,
            approval_rate: report.overview.approval_rate,
            top_adjustment: topAdjustment,
            top_failure: topFailure,
            top_confusion: topConfusion,
        });

        await discordService.notify({
            title: 'Weekly Quality Report',
            description: `Last ${report.window_days} days: ${report.overview.cases_processed} cases processed, ${report.overview.cases_resolved} resolved.`,
            color: 0x3182ce,
            fields: [
                { name: 'Approval Rate', value: report.overview.approval_rate != null ? `${Math.round(report.overview.approval_rate * 100)}%` : 'N/A', inline: true },
                { name: 'Adjust Rate', value: report.overview.adjust_rate != null ? `${Math.round(report.overview.adjust_rate * 100)}%` : 'N/A', inline: true },
                { name: 'Dismiss Rate', value: report.overview.dismiss_rate != null ? `${Math.round(report.overview.dismiss_rate * 100)}%` : 'N/A', inline: true },
                { name: 'Avg Resolution Days', value: report.overview.avg_resolution_days != null ? `${report.overview.avg_resolution_days}` : 'N/A', inline: true },
                { name: 'Top Adjustment', value: topAdjustment, inline: false },
                { name: 'Top Failure', value: topFailure, inline: false },
                { name: 'Top Confusion', value: topConfusion, inline: false },
            ],
        });

        return { report, confusion };
    }

    /**
     * Daily operator digest: stuck cases, stale proposals, bounced emails, portal failures.
     * Sends a Discord notification summarizing overnight system health.
     */
    async sendDailyOperatorDigest() {
        const digestResult = await db.query(`
            SELECT
                (
                    SELECT COUNT(*)::int
                    FROM cases
                    WHERE status IN ('processing', 'classifying', 'deciding', 'drafting', 'researching')
                      AND updated_at < NOW() - INTERVAL '24 hours'
                ) AS stuck_count,
                (
                    SELECT COUNT(*)::int
                    FROM proposals
                    WHERE status = 'PENDING_APPROVAL'
                      AND created_at < NOW() - INTERVAL '48 hours'
                ) AS stale_count,
                (
                    SELECT COUNT(*)::int
                    FROM email_events
                    WHERE event_type IN ('bounce', 'dropped', 'deferred')
                      AND created_at > NOW() - INTERVAL '24 hours'
                ) AS bounced_count,
                (
                    SELECT COUNT(*)::int
                    FROM portal_tasks
                    WHERE status IN ('FAILED', 'ERROR', 'TIMED_OUT', 'failed', 'error', 'timed_out')
                      AND updated_at > NOW() - INTERVAL '24 hours'
                ) AS portal_fail_count,
                (
                    SELECT COUNT(*) FILTER (WHERE status = 'ready_to_send')::int
                    FROM cases
                ) AS ready_to_send,
                (
                    SELECT COUNT(*) FILTER (WHERE status = 'pending_portal')::int
                    FROM cases
                ) AS pending_portal,
                (
                    SELECT COUNT(*) FILTER (WHERE status = 'needs_review')::int
                    FROM cases
                ) AS needs_review
        `);

        const row = digestResult.rows[0] || {};
        const stuckCount = row.stuck_count || 0;
        const staleCount = row.stale_count || 0;
        const bouncedCount = row.bounced_count || 0;
        const portalFailCount = row.portal_fail_count || 0;
        const queue = {
            ready_to_send: row.ready_to_send || 0,
            pending_portal: row.pending_portal || 0,
            needs_review: row.needs_review || 0,
        };

        const issues = [];
        if (stuckCount > 0) issues.push(`${stuckCount} stuck case(s)`);
        if (staleCount > 0) issues.push(`${staleCount} stale proposal(s) (>48h)`);
        if (bouncedCount > 0) issues.push(`${bouncedCount} bounced email(s)`);
        if (portalFailCount > 0) issues.push(`${portalFailCount} portal failure(s)`);

        const healthy = issues.length === 0;
        const statusLine = healthy ? 'All systems healthy' : issues.join(' · ');

        await db.logActivity('daily_operator_digest', statusLine, {
            stuck_cases: stuckCount,
            stale_proposals: staleCount,
            bounced_emails: bouncedCount,
            portal_failures: portalFailCount,
            queue_ready_to_send: queue.ready_to_send || 0,
            queue_pending_portal: queue.pending_portal || 0,
            queue_needs_review: queue.needs_review || 0,
        });

        await discordService.notify({
            title: `Daily Digest — ${healthy ? '✅ Healthy' : '⚠️ Action Needed'}`,
            description: statusLine,
            color: healthy ? 0x38a169 : 0xe53e3e,
            fields: [
                { name: 'Stuck Cases (>24h)', value: `${stuckCount}`, inline: true },
                { name: 'Stale Proposals (>48h)', value: `${staleCount}`, inline: true },
                { name: 'Bounced Emails (24h)', value: `${bouncedCount}`, inline: true },
                { name: 'Portal Failures (24h)', value: `${portalFailCount}`, inline: true },
                { name: 'Queue: Ready to Send', value: `${queue.ready_to_send || 0}`, inline: true },
                { name: 'Queue: Pending Portal', value: `${queue.pending_portal || 0}`, inline: true },
                { name: 'Queue: Needs Review', value: `${queue.needs_review || 0}`, inline: true },
            ],
        });

        console.log(`Daily digest: ${statusLine}`);
        return { stuckCount, staleCount, bouncedCount, portalFailCount, queue };
    }

    async runPriorityAutoEscalate() {
        const result = await db.query(`
            UPDATE cases
            SET priority = 2,
                updated_at = NOW()
            WHERE COALESCE(priority, 0) < 2
              AND deadline_date IS NOT NULL
              AND deadline_date::date <= (CURRENT_DATE + INTERVAL '3 days')::date
              AND status NOT IN ('completed', 'closed', 'denied', 'cancelled', 'withdrawn', 'draft')
            RETURNING id, deadline_date
        `);

        const rows = result.rows || [];
        for (const row of rows) {
            await db.logActivity(
                'priority_auto_escalate',
                'Auto-escalated priority to urgent (deadline within 3 days)',
                {
                    case_id: row.id,
                    actor_type: 'system',
                    source_service: 'cron_service',
                    deadline_date: row.deadline_date,
                    escalated_to_priority: 2,
                }
            );
        }

        return {
            escalated: rows.length,
            caseIds: rows.map((row) => row.id),
        };
    }

    /**
     * Check operational counters and emit threshold-based alerts.
     * Defaults:
     * - portal_hard_timeout_total > 0 in 1h window
     * - process_inbound_superseded_total > 5 in 1h window
     */
    async checkOperationalAlerts() {
        const portalThresholdRaw = parseInt(process.env.PORTAL_HARD_TIMEOUT_ALERT_THRESHOLD || '0', 10);
        const supersededThresholdRaw = parseInt(process.env.PROCESS_INBOUND_SUPERSEDED_ALERT_THRESHOLD || '5', 10);
        const inboundLinkageThresholdRaw = parseInt(process.env.INBOUND_LINKAGE_GAP_ALERT_THRESHOLD || '0', 10);
        const emptyNormalizedThresholdRaw = parseInt(process.env.EMPTY_NORMALIZED_INBOUND_ALERT_THRESHOLD || '0', 10);
        const proposalMismatchThresholdRaw = parseInt(process.env.PROPOSAL_MESSAGE_MISMATCH_ALERT_THRESHOLD || '0', 10);
        const portalThreshold = Number.isFinite(portalThresholdRaw) ? portalThresholdRaw : 0;
        const supersededThreshold = Number.isFinite(supersededThresholdRaw) ? supersededThresholdRaw : 5;
        const inboundLinkageThreshold = Number.isFinite(inboundLinkageThresholdRaw) ? inboundLinkageThresholdRaw : 0;
        const emptyNormalizedThreshold = Number.isFinite(emptyNormalizedThresholdRaw) ? emptyNormalizedThresholdRaw : 0;
        const proposalMismatchThreshold = Number.isFinite(proposalMismatchThresholdRaw) ? proposalMismatchThresholdRaw : 0;

        const countersResult = await db.query(`
            SELECT
                (
                    SELECT COUNT(*) FILTER (WHERE event_type = 'portal_hard_timeout')::int
                    FROM activity_log
                    WHERE created_at > NOW() - INTERVAL '1 hour'
                ) AS portal_hard_timeout_total,
                (
                    SELECT COUNT(*) FILTER (WHERE event_type = 'portal_soft_timeout')::int
                    FROM activity_log
                    WHERE created_at > NOW() - INTERVAL '1 hour'
                ) AS portal_soft_timeout_total,
                (
                    SELECT COUNT(*)::int
                    FROM agent_runs
                    WHERE status = 'cancelled'
                      AND (error = 'superseded' OR error LIKE 'deduped to active%')
                      AND COALESCE(ended_at, started_at) > NOW() - INTERVAL '1 hour'
                ) AS process_inbound_superseded_total,
                (
                    SELECT COUNT(*)::int
                    FROM messages m
                    WHERE m.direction = 'inbound'
                      AND COALESCE(m.received_at, m.created_at) > NOW() - INTERVAL '1 hour'
                      AND m.case_id IS NULL
                      AND (m.thread_id IS NULL OR NOT EXISTS (
                          SELECT 1 FROM email_threads t
                          WHERE t.id = m.thread_id
                            AND t.case_id IS NOT NULL
                      ))
                      AND NOT EXISTS (SELECT 1 FROM proposals p WHERE p.trigger_message_id = m.id)
                      AND NOT EXISTS (SELECT 1 FROM agent_runs ar WHERE ar.message_id = m.id)
                      AND COALESCE(m.message_type, '') NOT IN ('simulated_inbound', 'manual_trigger')
                      AND COALESCE(m.metadata->>'source', '') NOT IN ('synthetic', 'simulation')
                ) AS inbound_linkage_gap_total,
                (
                    SELECT COUNT(*)::int
                    FROM messages m
                    WHERE m.direction = 'inbound'
                      AND COALESCE(m.received_at, m.created_at) > NOW() - INTERVAL '1 hour'
                      AND COALESCE(NULLIF(m.normalized_body_text, ''), '') = ''
                      AND (
                        COALESCE(NULLIF(m.body_text, ''), NULLIF(m.body_html, '')) IS NOT NULL
                        OR COALESCE(m.attachment_count, 0) > 0
                      )
                      AND COALESCE(m.message_type, '') NOT IN ('simulated_inbound', 'manual_trigger')
                      AND COALESCE(m.metadata->>'source', '') NOT IN ('synthetic', 'simulation')
                ) AS empty_normalized_inbound_total,
                (
                    SELECT COUNT(*)::int
                    FROM proposals p
                    JOIN messages m ON m.id = p.trigger_message_id
                    WHERE m.case_id IS NOT NULL
                      AND m.case_id <> p.case_id
                      AND COALESCE(p.created_at, m.created_at) > NOW() - INTERVAL '1 hour'
                ) AS proposal_message_mismatch_total
        `);

        const counters = countersResult.rows[0] || {};
        const portalHardTimeoutTotal = parseInt(counters.portal_hard_timeout_total || 0, 10);
        const portalSoftTimeoutTotal = parseInt(counters.portal_soft_timeout_total || 0, 10);
        const processInboundSupersededTotal = parseInt(
            counters.process_inbound_superseded_total || 0,
            10
        );
        const inboundLinkageGapTotal = parseInt(counters.inbound_linkage_gap_total || 0, 10);
        const emptyNormalizedInboundTotal = parseInt(counters.empty_normalized_inbound_total || 0, 10);
        const proposalMessageMismatchTotal = parseInt(counters.proposal_message_mismatch_total || 0, 10);

        const windowHour = new Date();
        const hourBucket = `${windowHour.getUTCFullYear()}-${windowHour.getUTCMonth() + 1}-${windowHour.getUTCDate()}-${windowHour.getUTCHours()}`;

        if (portalHardTimeoutTotal > portalThreshold) {
            const dedupeKey = `${hourBucket}:${portalHardTimeoutTotal}`;
            if (this.lastOperationalAlert.portalHardTimeout !== dedupeKey) {
                this.lastOperationalAlert.portalHardTimeout = dedupeKey;
                await db.logActivity(
                    'operational_alert',
                    `portal_hard_timeout_total=${portalHardTimeoutTotal} exceeded threshold ${portalThreshold} in last 1h`,
                    {
                        metric: 'portal_hard_timeout_total',
                        value: portalHardTimeoutTotal,
                        threshold: portalThreshold,
                        window: '1h',
                        soft_timeouts_in_window: portalSoftTimeoutTotal,
                    }
                );
                await discordService.notify({
                    title: 'Operational Alert: Portal Hard Timeouts',
                    description: `Last 1h hard timeouts: ${portalHardTimeoutTotal} (threshold ${portalThreshold})`,
                    color: 0xf56565,
                    fields: [
                        { name: 'Metric', value: 'portal_hard_timeout_total', inline: true },
                        { name: 'Value', value: `${portalHardTimeoutTotal}`, inline: true },
                        { name: 'Threshold', value: `>${portalThreshold}`, inline: true },
                        { name: 'Soft Timeouts (1h)', value: `${portalSoftTimeoutTotal}`, inline: true },
                    ],
                });
            }
        }

        if (processInboundSupersededTotal > supersededThreshold) {
            const dedupeKey = `${hourBucket}:${processInboundSupersededTotal}`;
            if (this.lastOperationalAlert.processInboundSuperseded !== dedupeKey) {
                this.lastOperationalAlert.processInboundSuperseded = dedupeKey;
                await db.logActivity(
                    'operational_alert',
                    `process_inbound_superseded_total=${processInboundSupersededTotal} exceeded threshold ${supersededThreshold} in last 1h`,
                    {
                        metric: 'process_inbound_superseded_total',
                        value: processInboundSupersededTotal,
                        threshold: supersededThreshold,
                        window: '1h',
                    }
                );
                await discordService.notify({
                    title: 'Operational Alert: Process-Inbound Superseded',
                    description: `Last 1h superseded runs: ${processInboundSupersededTotal} (threshold ${supersededThreshold})`,
                    color: 0xed8936,
                    fields: [
                        { name: 'Metric', value: 'process_inbound_superseded_total', inline: true },
                        { name: 'Value', value: `${processInboundSupersededTotal}`, inline: true },
                        { name: 'Threshold', value: `>${supersededThreshold}`, inline: true },
                    ],
                });
            }
        }

        if (inboundLinkageGapTotal > inboundLinkageThreshold) {
            const dedupeKey = `${hourBucket}:${inboundLinkageGapTotal}`;
            if (this.lastOperationalAlert.inboundLinkageGaps !== dedupeKey) {
                this.lastOperationalAlert.inboundLinkageGaps = dedupeKey;
                await db.logActivity(
                    'operational_alert',
                    `inbound_linkage_gap_total=${inboundLinkageGapTotal} exceeded threshold ${inboundLinkageThreshold} in last 1h`,
                    {
                        metric: 'inbound_linkage_gap_total',
                        value: inboundLinkageGapTotal,
                        threshold: inboundLinkageThreshold,
                        window: '1h',
                    }
                );
                await discordService.notify({
                    title: 'Operational Alert: Inbound Linkage Gaps',
                    description: `Last 1h inbound messages with no case/thread/proposal linkage: ${inboundLinkageGapTotal}`,
                    color: 0xf56565,
                    fields: [
                        { name: 'Metric', value: 'inbound_linkage_gap_total', inline: true },
                        { name: 'Value', value: `${inboundLinkageGapTotal}`, inline: true },
                        { name: 'Threshold', value: `>${inboundLinkageThreshold}`, inline: true },
                    ],
                });
            }
        }

        if (emptyNormalizedInboundTotal > emptyNormalizedThreshold) {
            const dedupeKey = `${hourBucket}:${emptyNormalizedInboundTotal}`;
            if (this.lastOperationalAlert.emptyNormalizedInbound !== dedupeKey) {
                this.lastOperationalAlert.emptyNormalizedInbound = dedupeKey;
                await db.logActivity(
                    'operational_alert',
                    `empty_normalized_inbound_total=${emptyNormalizedInboundTotal} exceeded threshold ${emptyNormalizedThreshold} in last 1h`,
                    {
                        metric: 'empty_normalized_inbound_total',
                        value: emptyNormalizedInboundTotal,
                        threshold: emptyNormalizedThreshold,
                        window: '1h',
                    }
                );
                await discordService.notify({
                    title: 'Operational Alert: Empty Normalized Inbound',
                    description: `Last 1h inbound messages with empty normalized body text: ${emptyNormalizedInboundTotal}`,
                    color: 0xed8936,
                    fields: [
                        { name: 'Metric', value: 'empty_normalized_inbound_total', inline: true },
                        { name: 'Value', value: `${emptyNormalizedInboundTotal}`, inline: true },
                        { name: 'Threshold', value: `>${emptyNormalizedThreshold}`, inline: true },
                    ],
                });
            }
        }

        if (proposalMessageMismatchTotal > proposalMismatchThreshold) {
            const dedupeKey = `${hourBucket}:${proposalMessageMismatchTotal}`;
            if (this.lastOperationalAlert.proposalMessageMismatch !== dedupeKey) {
                this.lastOperationalAlert.proposalMessageMismatch = dedupeKey;
                await db.logActivity(
                    'operational_alert',
                    `proposal_message_mismatch_total=${proposalMessageMismatchTotal} exceeded threshold ${proposalMismatchThreshold} in last 1h`,
                    {
                        metric: 'proposal_message_mismatch_total',
                        value: proposalMessageMismatchTotal,
                        threshold: proposalMismatchThreshold,
                        window: '1h',
                    }
                );
                await discordService.notify({
                    title: 'Operational Alert: Proposal/Message Case Mismatch',
                    description: `Last 1h proposals whose trigger message points at a different case: ${proposalMessageMismatchTotal}`,
                    color: 0xf56565,
                    fields: [
                        { name: 'Metric', value: 'proposal_message_mismatch_total', inline: true },
                        { name: 'Value', value: `${proposalMessageMismatchTotal}`, inline: true },
                        { name: 'Threshold', value: `>${proposalMismatchThreshold}`, inline: true },
                    ],
                });
            }
        }
    }
}

module.exports = new CronService();
