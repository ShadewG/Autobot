#!/usr/bin/env node
/**
 * Local Portal Worker — polls for pending portal tasks and processes them
 * using local Playwright (stealth, persistent contexts, 2Captcha).
 *
 * Runs on this server instead of Trigger.dev, saving Browserbase costs.
 * Falls back to Browserbase → Skyvern if local fails.
 *
 * Usage:
 *   node scripts/portal-worker.js
 *   POLL_INTERVAL=30 node scripts/portal-worker.js
 */

require('dotenv').config();

const POLL_INTERVAL_MS = parseInt(process.env.PORTAL_WORKER_POLL_INTERVAL || '30000', 10);
const MAX_CONCURRENT = parseInt(process.env.PORTAL_WORKER_MAX_CONCURRENT || '1', 10);
const WORKER_ID = `local-portal-${require('os').hostname()}-${process.pid}`;

let activeJobs = 0;
let shuttingDown = false;

process.on('SIGINT', () => { shuttingDown = true; console.log('\nShutting down gracefully...'); });
process.on('SIGTERM', () => { shuttingDown = true; });

async function main() {
    const db = require('../services/database');
    const playwright = require('../services/portal-agent-service-playwright');
    const caseRuntime = require('../services/case-runtime');
    const logger = require('../services/logger');

    console.log(`Portal Worker started: ${WORKER_ID}`);
    console.log(`Poll interval: ${POLL_INTERVAL_MS}ms | Max concurrent: ${MAX_CONCURRENT}`);
    console.log('---');

    while (!shuttingDown) {
        try {
            if (activeJobs >= MAX_CONCURRENT) {
                await sleep(5000);
                continue;
            }

            // Poll for pending portal tasks
            const pending = await db.query(`
                SELECT pt.id, pt.case_id, pt.portal_url, pt.instructions, pt.action_type,
                       pt.proposal_id, pt.execution_id,
                       c.portal_url AS case_portal_url, c.portal_provider, c.status AS case_status,
                       c.case_name
                FROM portal_tasks pt
                JOIN cases c ON c.id = pt.case_id
                WHERE pt.status = 'PENDING'
                  AND c.status NOT IN ('sent', 'awaiting_response', 'responded', 'completed', 'cancelled', 'needs_phone_call')
                  AND pt.created_at > NOW() - INTERVAL '24 hours'
                  AND NOT EXISTS (
                      SELECT 1 FROM agent_runs ar
                      WHERE ar.case_id = pt.case_id
                        AND ar.trigger_type = 'submit_portal'
                        AND ar.status IN ('created', 'queued', 'running', 'processing', 'waiting')
                  )
                ORDER BY pt.created_at ASC
                LIMIT 1
            `);

            if (pending.rows.length === 0) {
                await sleep(POLL_INTERVAL_MS);
                continue;
            }

            const task = pending.rows[0];
            console.log(`\n[${new Date().toISOString()}] Found task #${task.id} for case #${task.case_id}: ${(task.case_name || '').substring(0, 60)}`);

            // Claim the task atomically
            const claimed = await db.query(
                `UPDATE portal_tasks SET status = 'IN_PROGRESS', assigned_to = $2, updated_at = NOW()
                 WHERE id = $1 AND status = 'PENDING' RETURNING id`,
                [task.id, WORKER_ID]
            );
            if (claimed.rows.length === 0) {
                console.log(`  Task #${task.id} already claimed by another worker`);
                continue;
            }

            // Create agent_run record
            const run = await db.query(
                `INSERT INTO agent_runs (case_id, trigger_type, status, metadata, started_at)
                 VALUES ($1, 'submit_portal', 'running', $2, NOW()) RETURNING id`,
                [task.case_id, JSON.stringify({ source: 'local_portal_worker', portal_task_id: task.id, worker_id: WORKER_ID })]
            );
            const agentRunId = run.rows[0]?.id;

            activeJobs++;
            processPortalTask(db, playwright, caseRuntime, task, agentRunId).finally(() => { activeJobs--; });

        } catch (err) {
            console.error(`Poll error: ${err.message}`);
            await sleep(10000);
        }
    }

    // Wait for active jobs to finish
    while (activeJobs > 0) {
        console.log(`Waiting for ${activeJobs} active job(s) to finish...`);
        await sleep(5000);
    }
    console.log('Worker stopped.');
    process.exit(0);
}

async function processPortalTask(db, playwright, caseRuntime, task, agentRunId) {
    const portalUrl = task.portal_url || task.case_portal_url;
    const startTime = Date.now();

    try {
        console.log(`  Processing: ${portalUrl}`);
        console.log(`  Provider: ${task.portal_provider || 'auto-detect'}`);

        // Load full case data
        const caseData = await db.getCaseById(task.case_id);
        if (!caseData) throw new Error(`Case ${task.case_id} not found`);

        // Mark case as portal in progress
        await caseRuntime.transitionCaseRuntime(task.case_id, 'PORTAL_STARTED', {
            portalTaskId: task.id,
            runId: agentRunId,
            substatus: 'Local portal worker processing',
            portalMetadata: {
                last_portal_status: 'Portal submission started (local worker)',
                last_portal_status_at: new Date(),
            },
        }).catch(() => {});

        // Record submission start
        let submissionRow = null;
        try {
            submissionRow = await db.createPortalSubmission({
                caseId: task.case_id,
                runId: agentRunId,
                status: 'started',
                engine: 'playwright_local',
                accountEmail: caseData.last_portal_account_email || null,
            });
        } catch {}

        // ── PRIMARY: Local Playwright ──
        let result = null;
        let engineUsed = 'playwright_local';
        try {
            result = await playwright.submitToPortal(caseData, portalUrl, {
                dryRun: false,
                trackInAutobot: false,
                ensureAccount: true,
                forceAccountSetup: true,
                instructions: task.instructions,
                browserBackend: 'local',
            });
        } catch (localErr) {
            console.log(`  Local Playwright error: ${localErr.message}`);
        }

        // ── FALLBACK: Browserbase ──
        if ((!result?.success || !result?.submissionConfirmed) && result?.fallback_safe !== false && process.env.BROWSERBASE_API_KEY) {
            console.log('  Falling back to Browserbase...');
            engineUsed = 'playwright_browserbase';
            try {
                result = await playwright.submitToPortal(caseData, portalUrl, {
                    dryRun: false,
                    trackInAutobot: false,
                    ensureAccount: true,
                    forceAccountSetup: true,
                    instructions: task.instructions,
                    browserBackend: 'browserbase',
                });
            } catch (bbErr) {
                console.log(`  Browserbase error: ${bbErr.message}`);
            }
        }

        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

        if (result?.success && result?.submissionConfirmed) {
            // ── SUCCESS ──
            engineUsed = result.engine || engineUsed;
            console.log(`  SUCCESS (${elapsed}s) engine=${engineUsed} confirmation=${result.confirmationNumber || 'none'}`);

            await caseRuntime.transitionCaseRuntime(task.case_id, 'PORTAL_COMPLETED', {
                portalTaskId: task.id,
                runId: agentRunId,
                sendDate: caseData.send_date || new Date().toISOString(),
                confirmationNumber: result.confirmationNumber,
                completedBy: engineUsed,
                portalMetadata: {
                    last_portal_status: `Submission completed (local worker)`,
                    last_portal_status_at: new Date(),
                    last_portal_engine: engineUsed,
                    last_portal_run_id: result.runId || null,
                    last_portal_account_email: result.accountEmail || null,
                },
            }).catch(() => {});

            await db.query(
                `UPDATE portal_tasks SET status = 'COMPLETED', completed_at = NOW(), completed_by = $2,
                 confirmation_number = $3, completion_notes = $4, updated_at = NOW()
                 WHERE id = $1`,
                [task.id, WORKER_ID, result.confirmationNumber || null, `Submitted via ${engineUsed}`]
            );

            if (submissionRow?.id) {
                await db.updatePortalSubmission(submissionRow.id, {
                    status: 'completed', engine: engineUsed,
                    completed_at: new Date(),
                }).catch(() => {});
            }

            await db.query(
                `UPDATE agent_runs SET status = 'completed', ended_at = NOW() WHERE id = $1`,
                [agentRunId]
            ).catch(() => {});

            await db.logActivity('portal_submission', `Portal submitted by local worker for case ${task.case_id}`, {
                case_id: task.case_id, engine: engineUsed, portal_url: portalUrl, worker_id: WORKER_ID,
            }).catch(() => {});

        } else {
            // ── FAILURE ──
            const errorMsg = String(result?.error || result?.status || 'Portal submission failed').substring(0, 500);
            console.log(`  FAILED (${elapsed}s): ${errorMsg.substring(0, 100)}`);

            await caseRuntime.transitionCaseRuntime(task.case_id, 'PORTAL_FAILED', {
                portalTaskId: task.id,
                runId: agentRunId,
                error: errorMsg,
                substatus: 'Portal submission failed - requires human submission',
                portalMetadata: {
                    last_portal_status: `Failed: ${errorMsg.substring(0, 100)}`,
                    last_portal_status_at: new Date(),
                    last_portal_engine: engineUsed,
                },
            }).catch(() => {});

            await db.query(
                `UPDATE portal_tasks SET status = 'FAILED', completed_at = NOW(), completed_by = $2,
                 completion_notes = $3, updated_at = NOW()
                 WHERE id = $1`,
                [task.id, WORKER_ID, errorMsg]
            );

            if (submissionRow?.id) {
                await db.updatePortalSubmission(submissionRow.id, {
                    status: 'failed', engine: engineUsed, error_message: errorMsg,
                    completed_at: new Date(),
                }).catch(() => {});
            }

            await db.query(
                `UPDATE agent_runs SET status = 'failed', ended_at = NOW(), error = $2 WHERE id = $1`,
                [agentRunId, errorMsg]
            ).catch(() => {});

            await db.logActivity('portal_submission_failed', `Portal failed (local worker): ${errorMsg}`, {
                case_id: task.case_id, engine: engineUsed, portal_url: portalUrl, worker_id: WORKER_ID,
            }).catch(() => {});
        }

    } catch (err) {
        console.error(`  CRASH processing task #${task.id}: ${err.message}`);
        await db.query(
            `UPDATE portal_tasks SET status = 'FAILED', completed_at = NOW(), completed_by = $2,
             completion_notes = $3, updated_at = NOW() WHERE id = $1`,
            [task.id, WORKER_ID, `Worker crash: ${err.message}`.substring(0, 500)]
        ).catch(() => {});
        await db.query(
            `UPDATE agent_runs SET status = 'failed', ended_at = NOW(), error = $2 WHERE id = $1`,
            [agentRunId, err.message]
        ).catch(() => {});
    }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

main().catch(err => {
    console.error('Fatal:', err);
    process.exit(1);
});
