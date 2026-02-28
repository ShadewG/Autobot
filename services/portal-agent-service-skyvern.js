const axios = require('axios');
const crypto = require('crypto');
// Use built-in crypto.randomUUID() instead of uuid package (ESM-only in v10+)
const database = require('./database');
const notionService = require('./notion-service');
const EmailVerificationHelper = require('../agentkit/email-helper');
const { notify } = require('./event-bus');
const pdfFormService = require('./pdf-form-service');

/**
 * Portal Agent using Skyvern AI
 *
 * Skyvern is an open-source browser automation platform that uses
 * LLMs and computer vision to automate workflows.
 *
 * Can be used via:
 * - Skyvern Cloud API (https://api.skyvern.com)
 * - Self-hosted instance (docker/pip install skyvern)
 */
class PortalAgentServiceSkyvern {
    constructor() {
        // Support both cloud and self-hosted
        this.baseUrl = process.env.SKYVERN_API_URL || 'https://api.skyvern.com/api/v1';
        this.apiKey = process.env.SKYVERN_API_KEY;
        this.workflowId = process.env.SKYVERN_WORKFLOW_ID || 'wpid_461535111447599002';
        this.workflowRunUrl = process.env.SKYVERN_WORKFLOW_RUN_URL || 'https://api.skyvern.com/v1/run/workflows';
        this.workflowStatusUrl = process.env.SKYVERN_WORKFLOW_STATUS_URL || 'https://api.skyvern.com/v1/workflow_runs';
        this.workflowProxyLocation = process.env.SKYVERN_PROXY_LOCATION || 'RESIDENTIAL';
        this.workflowBrowserSessionId = process.env.SKYVERN_BROWSER_SESSION_ID || null;
        this.workflowBrowserAddress = process.env.SKYVERN_BROWSER_ADDRESS || null;
        this.workflowHttpTimeout = parseInt(process.env.SKYVERN_HTTP_TIMEOUT_MS || '120000', 10);
        this.skyvernAppBaseUrl = process.env.SKYVERN_APP_BASE_URL || 'https://app.skyvern.com';
        this.emailHelper = new EmailVerificationHelper({
            inboxAddress: process.env.REQUESTS_INBOX || 'requests@foib-request.com'
        });
    }

    _captchaInputRules() {
        return `CAPTCHA INPUT RULES (CRITICAL):
- If a captcha/verification text input already has any value, CLEAR IT COMPLETELY before typing.
- Use select-all + delete/backspace, then type the captcha once.
- Never append characters to an existing captcha value.
- If captcha fails and a new one appears, clear the field again and replace with the new value.`;
    }

    async _runPortalStage({ stage, caseData, portalUrl, navigationGoal, navigationPayload, maxSteps }) {
        const stageLabel = this._formatStageLabel(stage);
        await database.logActivity(
            'portal_stage_started',
            `Stage ${stageLabel} started for ${caseData.case_name}`,
            {
                case_id: caseData.id || null,
                portal_url: portalUrl,
                stage,
                max_steps: maxSteps
            }
        );

        try {
            const { finalTask, taskId } = await this._createTaskAndPoll({
                portalUrl,
                navigationGoal,
                navigationPayload,
                maxSteps
            });

            if (finalTask.status !== 'completed') {
                const taskUrl = taskId ? `https://app.skyvern.com/tasks/${taskId}` : null;
                const errorMessage = finalTask.failure_reason || `Stage ended with status ${finalTask.status}`;

                await database.logActivity(
                    'portal_stage_failed',
                    `Stage ${stageLabel} failed for ${caseData.case_name}: ${errorMessage}`,
                    {
                        case_id: caseData.id || null,
                        portal_url: portalUrl,
                        stage,
                        status: finalTask.status,
                        task_id: taskId,
                        task_url: taskUrl,
                        error: errorMessage
                    }
                );

                return {
                    success: false,
                    result: {
                        success: false,
                        error: errorMessage,
                        taskId,
                        status: finalTask.status,
                        recording_url: finalTask.recording_url || taskUrl,
                        steps: finalTask.actions?.length || finalTask.steps || 0
                    }
                };
            }

            const taskUrl = taskId ? `https://app.skyvern.com/tasks/${taskId}` : null;

            await database.logActivity(
                'portal_stage_completed',
                `Stage ${stageLabel} completed for ${caseData.case_name}`,
                {
                    case_id: caseData.id || null,
                    portal_url: portalUrl,
                    stage,
                    task_id: taskId,
                    task_url: taskUrl,
                    steps_completed: finalTask.actions?.length || finalTask.steps || 0
                }
            );

            return {
                success: true,
                finalTask,
                taskId,
                recordingUrl: finalTask.recording_url || taskUrl
            };
        } catch (error) {
            await database.logActivity(
                'portal_stage_failed',
                `Stage ${stageLabel} crashed for ${caseData.case_name}: ${error.message}`,
                {
                    case_id: caseData.id || null,
                    portal_url: portalUrl,
                    stage,
                    error: error.message
                }
            );

            return {
                success: false,
                result: {
                    success: false,
                    error: error.message
                }
            };
        }
    }



    _detectVerificationNeeded(finalTask) {
        if (!finalTask) return false;
        const blob = JSON.stringify(finalTask).toLowerCase();
        return blob.includes('verification code') ||
            blob.includes('enter the code') ||
            blob.includes('check your email') ||
            blob.includes('otp') ||
            blob.includes('confirm your email');
    }

    async _maybeFetchVerificationCode(portalUrl, { mode = 'code' } = {}) {
        const defaultCodePattern = '(\\d{4,8})';
        const defaultLinkPattern = "(https?:\\/\\/[^\\s\"']+)";
        const envPattern = process.env.PORTAL_VERIFICATION_REGEX;
        const pattern = envPattern || (mode === 'link' ? defaultLinkPattern : defaultCodePattern);
        const timeoutMs = parseInt(process.env.PORTAL_VERIFICATION_TIMEOUT_MS || '180000', 10);
        let fromEmail = null;
        try {
            const hostname = new URL(portalUrl).hostname;
            fromEmail = hostname.split('.').slice(-2).join('.');
        } catch (_) {
            fromEmail = null;
        }

        try {
            const code = await this.emailHelper.waitForCode({
                pattern,
                timeoutMs,
                fromEmail
            });
            console.log(`🔐 Retrieved verification code from inbox`);
            return code;
        } catch (error) {
            console.warn(`⚠️  Could not auto-fetch verification code: ${error.message}`);
            return null;
        }
    }

    _isVerificationError(message = '') {
        if (!message) return false;
        const haystack = message.toLowerCase();
        return haystack.includes('verification') ||
            haystack.includes('confirm your email') ||
            haystack.includes('confirmation link') ||
            haystack.includes('check your email');
    }

    async _confirmViaLink(link) {
        if (!link) return false;
        try {
            await axios.get(link, {
                maxRedirects: 0,
                validateStatus: () => true
            });
            console.log('✅ Visited verification link successfully');
            return true;
        } catch (error) {
            console.warn(`⚠️  Failed to visit verification link: ${error.message}`);
            return false;
        }
    }

    _formatStageLabel(stage) {
        return stage.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
    }

    async _createTaskAndPoll({ portalUrl, navigationGoal, navigationPayload, maxSteps, maxPolls: maxPollsOverride }) {
        console.log(`\n📝 Navigation Goal:\n${navigationGoal}\n`);
        console.log(`⏳ Creating task...\n`);

        // Email address that receives verification codes
        const totpIdentifier = process.env.REQUESTS_INBOX || 'requests@foib-request.com';

        const response = await axios.post(
            `${this.baseUrl}/tasks`,
            {
                url: portalUrl,
                navigation_goal: navigationGoal,
                navigation_payload: navigationPayload,
                max_steps_override: maxSteps,
                engine: 'skyvern-2.0',
                totp_identifier: totpIdentifier  // Enable TOTP/2FA support
            },
            {
                headers: {
                    'x-api-key': this.apiKey,
                    'Content-Type': 'application/json'
                }
            }
        );

        const task = response.data;
        console.log(`✅ Task created!`);
        console.log(`   Task ID: ${task.task_id || task.id || 'unknown'}`);
        console.log(`\n📊 Full API Response:`);
        console.log(JSON.stringify(task, null, 2));

        const taskId = task.task_id || task.id;
        if (!taskId) {
            throw new Error('No task ID returned from API');
        }

        const maxPollMinutes = Math.round((maxPollsOverride || 480) * 5 / 60);
        console.log(`\n⏳ Polling for task completion (max ${maxPollMinutes} minutes)...`);

        const maxPolls = maxPollsOverride || 480; // default: 480 polls * 5 seconds = 40 minutes
        let polls = 0;
        let finalTask = null;

        while (polls < maxPolls) {
            await new Promise(resolve => setTimeout(resolve, 5000));
            polls++;

            try {
                const statusResponse = await axios.get(
                    `${this.baseUrl}/tasks/${taskId}`,
                    {
                        headers: {
                            'x-api-key': this.apiKey
                        }
                    }
                );

                finalTask = statusResponse.data;
                const status = finalTask.status;

                console.log(`   Poll ${polls}: Status = ${status}`);

                if (status === 'completed' || status === 'failed' || status === 'terminated') {
                    break;
                }
            } catch (pollError) {
                console.log(`   Poll ${polls}: Error polling - ${pollError.message}`);
            }
        }

        if (!finalTask) {
            throw new Error('Failed to get task status');
        }

        console.log(`\n✅ Task finished!`);
        console.log(`   Status: ${finalTask.status}`);

        return { finalTask, taskId };
    }

    async _runAccountStage({ caseData, portalUrl, accountEmail, accountPassword, contactInfo, existingAccount, dryRun, maxSteps, runId }) {
        let verificationCode = null;

        for (let attempt = 0; attempt < 2; attempt++) {
            const navigationGoal = this.buildAccountStageGoal(caseData, {
                email: accountEmail,
                password: accountPassword,
                dryRun,
                hasExistingAccount: !!existingAccount,
                verificationCode
            });

            const navigationPayload = this.buildAccountStagePayload(caseData, {
                email: accountEmail,
                password: accountPassword,
                contactInfo,
                verificationCode
            });

            const stage = await this._runPortalStage({
                stage: 'account_setup',
                caseData,
                portalUrl,
                navigationGoal,
                navigationPayload,
                maxSteps
            });

            if (!stage.success) {
                if (!verificationCode && this._isVerificationError(stage.result?.error || '')) {
                    console.log('🔐 Portal reported verification needed. Attempting to confirm via email link...');
                    const link = await this._maybeFetchVerificationCode(portalUrl, { mode: 'link' });
                    if (link) {
                        const confirmed = await this._confirmViaLink(link);
                        if (confirmed) {
                            continue;
                        }
                    }
                }
                return stage;
            }

            const extracted = stage.finalTask.extracted_information || {};
            if (extracted.verification_required && !verificationCode) {
                console.log('🔐 Verification required, attempting to fetch code...');
                verificationCode = await this._maybeFetchVerificationCode(portalUrl);
                if (!verificationCode) {
                    return {
                        success: false,
                        result: {
                            success: false,
                            error: 'Verification required but no code available',
                            status: 'verification_required'
                        }
                    };
                }
                if (verificationCode.startsWith('http')) {
                    const confirmed = await this._confirmViaLink(verificationCode);
                    verificationCode = null;
                    if (confirmed) {
                        continue;
                    }
                    return {
                        success: false,
                        result: {
                            success: false,
                            error: 'Verification link could not be confirmed',
                            status: 'verification_failed'
                        }
                    };
                }
                continue;
            }

            const requestFormUrl = extracted.request_form_url || extracted.submission_page_url || stage.finalTask.last_url || portalUrl;
            return {
                success: true,
                taskId: stage.taskId,
                extracted,
                requestFormUrl
            };
        }

        return {
            success: false,
            result: {
                success: false,
                error: 'Failed to satisfy verification',
                status: 'verification_failed'
            }
        };
    }

    async _runSubmissionStage({ caseData, portalUrl, accountEmail, accountPassword, contactInfo, submissionUrl, dryRun, maxSteps, runId, portalProvider }) {
        const navigationGoal = this.buildSubmissionStageGoal(caseData, {
            email: accountEmail,
            password: accountPassword,
            submissionUrl,
            dryRun
        });

        const navigationPayload = this.buildSubmissionStagePayload(caseData, {
            email: accountEmail,
            password: accountPassword,
            contactInfo,
            submissionUrl,
            dryRun
        });

        const stage = await this._runPortalStage({
            stage: 'request_submission',
            caseData,
            portalUrl,
            navigationGoal,
            navigationPayload,
            maxSteps
        });

        if (!stage.success) {
            return stage;
        }

        const finalTask = stage.finalTask;
        const taskId = stage.taskId;
        const extracted = finalTask.extracted_information || {};
        const taskUrl = `https://app.skyvern.com/tasks/${taskId}`;
        const actionHistory = finalTask.actions || finalTask.action_history || [];

        if (finalTask.status === 'completed') {
            const portalStatusUpdate = {
                portal_url: portalUrl,
                portal_provider: portalProvider,
                last_portal_run_id: taskId,
                last_portal_engine: 'skyvern',
                last_portal_task_url: extracted.submission_page_url || submissionUrl,
                last_portal_recording_url: finalTask.recording_url || taskUrl,
                last_portal_account_email: accountEmail,
                last_portal_details: JSON.stringify({
                    submission_status: extracted.submission_status || finalTask.status,
                    confirmation_number: extracted.confirmation_number || null,
                    portal_ticket_url: extracted.portal_ticket_url || null,
                    submission_timestamp: extracted.submission_timestamp || null,
                    action_history: actionHistory.slice(-50)
                })
            };

            // Persist confirmation number for inbound email matching
            if (extracted.confirmation_number) {
                portalStatusUpdate.portal_request_number = extracted.confirmation_number;
            }

            await database.updateCasePortalStatus(caseData.id, portalStatusUpdate);

            // Retroactive matching: link deferred unmatched emails by request number
            if (extracted.confirmation_number) {
                try {
                    const unmatchedSignals = await database.findUnmatchedByRequestNumber(extracted.confirmation_number);
                    for (const signal of unmatchedSignals) {
                        await database.markUnmatchedSignalMatched(signal.id, caseData.id);
                        // Link the message to the case if it has one
                        if (signal.message_id) {
                            let thread = await database.getThreadByCaseId(caseData.id);
                            if (!thread) {
                                thread = await database.createEmailThread({
                                    case_id: caseData.id,
                                    thread_id: `retroactive-${signal.message_id}`,
                                    subject: signal.subject || 'Portal notification',
                                    agency_email: signal.from_email,
                                    initial_message_id: null,
                                    status: 'active'
                                });
                            }
                            await database.query(
                                'UPDATE messages SET case_id = $1, thread_id = $2 WHERE id = $3 AND case_id IS NULL',
                                [caseData.id, thread.id, signal.message_id]
                            );
                            console.log(`Retroactively matched message #${signal.message_id} to case #${caseData.id} via request number ${extracted.confirmation_number}`);
                        }
                        await database.logActivity('retroactive_match', `Deferred email matched to case via request number ${extracted.confirmation_number}`, {
                            case_id: caseData.id,
                            signal_id: signal.id,
                            message_id: signal.message_id,
                            request_number: extracted.confirmation_number
                        });
                    }
                    if (unmatchedSignals.length > 0) {
                        console.log(`Retroactively matched ${unmatchedSignals.length} deferred signal(s) for request number ${extracted.confirmation_number}`);
                    }
                } catch (retroErr) {
                    console.warn('Retroactive matching failed:', retroErr.message);
                }
            }

            await database.logActivity('portal_run_completed', `Skyvern portal submission completed for ${caseData.case_name}`, {
                case_id: caseData.id || null,
                portal_url: portalUrl,
                dry_run: dryRun,
                max_steps: maxSteps,
                task_id: taskId,
                run_id: runId,
                submission_status: extracted.submission_status || finalTask.status,
                confirmation_number: extracted.confirmation_number || null
            });
            notify('success', `Portal submission completed for ${caseData.case_name}${extracted.confirmation_number ? ` (#${extracted.confirmation_number})` : ''}`, { case_id: caseData.id });

            return {
                success: true,
                result: {
                    success: true,
                    caseId: caseData.id,
                    portalUrl,
                    taskId,
                    recording_url: finalTask.recording_url || taskUrl,
                    extracted_data: extracted,
                    steps: actionHistory.length || finalTask.steps || 0,
                    submission_status: extracted.submission_status || finalTask.status,
                    confirmation_number: extracted.confirmation_number || null,
                    engine: 'skyvern'
                }
            };
        }

        const failureTaskUrl = taskId ? `https://app.skyvern.com/tasks/${taskId}` : null;
        await database.logActivity('portal_run_failed', `Skyvern portal submission failed for ${caseData.case_name}`, {
            case_id: caseData.id || null,
            portal_url: portalUrl,
            dry_run: dryRun,
            max_steps: maxSteps,
            task_id: taskId,
            run_id: runId,
            error: finalTask.failure_reason || finalTask.status
        });
        notify('error', `Portal submission failed for ${caseData.case_name}: ${finalTask.failure_reason || finalTask.status}`, { case_id: caseData.id });

        return {
            success: false,
            result: {
                success: false,
                error: finalTask.failure_reason || `Task ended with status ${finalTask.status}`,
                taskId,
                recording_url: finalTask.recording_url || failureTaskUrl,
                extracted_data: extracted,
                engine: 'skyvern'
            }
        };
    }

    /**
     * Generate a secure password for new accounts
     */
    _generateSecurePassword() {
        return process.env.PORTAL_DEFAULT_PASSWORD || 'Insanity10M';
    }

    /**
     * Submit to portal using Skyvern (workflow only)
     */
    async submitToPortal(caseData, portalUrl, options = {}) {
        const { dryRun = false, instructions = null, bypassApprovalGate = false } = options;

        // Early detection: document file URLs are not real portals — skip Skyvern entirely
        if (/\.(doc|docx|pdf|xls|xlsx|rtf|odt)(\?|#|$)/i.test(portalUrl)) {
            console.log(`📄 Portal URL is a document download (${portalUrl}) — skipping Skyvern, going to research + fallback`);
            await database.logActivity('portal_not_automatable',
                `Portal URL is a document file, not an online form: ${portalUrl}`, {
                case_id: caseData.id, portal_url: portalUrl
            });
            return this._handleNotRealPortal(caseData, portalUrl, dryRun,
                `URL is a document download (${portalUrl.split('/').pop()}), not an online submission form`);
        }

        if (!this.apiKey) {
            throw new Error('SKYVERN_API_KEY not set! Get your key from https://app.skyvern.com');
        }

        if (!this.workflowId) {
            throw new Error('SKYVERN_WORKFLOW_ID not set but workflow mode is required');
        }

        // ── HARD RATE LIMIT: absolute cap on portal runs per case ──
        const runCounts = await database.query(
            `SELECT
               COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '24 hours') as today,
               COUNT(*) as total
             FROM activity_log
             WHERE event_type IN ('portal_workflow_triggered', 'portal_stage_started')
               AND case_id = $1`,
            [caseData.id]
        );
        const todayRuns = parseInt(runCounts.rows[0]?.today || '0', 10);
        const totalRuns = parseInt(runCounts.rows[0]?.total || '0', 10);
        if (todayRuns >= 3 || totalRuns >= 8) {
            console.error(`🛑 HARD LIMIT: case ${caseData.id} has ${todayRuns} runs today, ${totalRuns} total — blocking portal submission`);
            await database.logActivity('portal_hard_limit', `Portal hard limit hit for case ${caseData.id}: ${todayRuns}/day, ${totalRuns}/total`, {
                case_id: caseData.id, portal_url: portalUrl, today_runs: todayRuns, total_runs: totalRuns
            });
            return { success: false, skipped: true, reason: 'hard_rate_limit' };
        }

        // ── Dedup guard: skip if case already advanced past submission ──
        const freshCase = await database.getCaseById(caseData.id);
        const portalSkipStatuses = ['sent', 'awaiting_response', 'responded', 'completed', 'needs_phone_call'];
        if (freshCase && portalSkipStatuses.includes(freshCase.status)) {
            console.log(`⏭️  Skipping portal for case ${caseData.id} — case already ${freshCase.status}`);
            return { success: true, skipped: true, reason: `case_already_${freshCase.status}` };
        }

        // ── Dedup guard: skip if a successful portal submission happened recently ──
        const recentSuccess = await database.query(
            `SELECT id FROM activity_log
             WHERE event_type = 'portal_stage_completed'
               AND case_id = $1
               AND metadata->>'engine' = 'skyvern_workflow'
               AND created_at > NOW() - INTERVAL '1 hour'
             LIMIT 1`,
            [caseData.id]
        );
        if (recentSuccess.rows.length > 0) {
            console.log(`⏭️  Skipping portal for case ${caseData.id} — successful submission within last hour`);
            return { success: true, skipped: true, reason: 'recent_success' };
        }

        // ── Approval gate: require an in-flight approved proposal before any portal run ──
        // Only APPROVED (just approved, execution starting) and PENDING_PORTAL (portal task created)
        // qualify. EXECUTED means the run already completed — don't reuse old approvals.
        const approvedProposal = await database.query(
            `SELECT id, status FROM proposals
             WHERE case_id = $1
               AND action_type IN ('SUBMIT_PORTAL', 'SEND_INITIAL_REQUEST', 'SEND_FOLLOWUP', 'SEND_REBUTTAL', 'SEND_FEE_RESPONSE')
               AND status IN ('APPROVED', 'PENDING_PORTAL')
             ORDER BY created_at DESC LIMIT 1`,
            [caseData.id]
        );
        if (approvedProposal.rows.length === 0 && !bypassApprovalGate) {
            console.log(`🛑 Portal submission blocked for case ${caseData.id} — no approved proposal found, creating one for review`);
            // Check if there's already a PENDING_APPROVAL proposal for this case (don't create duplicates)
            const existingPending = await database.query(
                `SELECT id FROM proposals
                 WHERE case_id = $1 AND action_type = 'SUBMIT_PORTAL'
                   AND status = 'PENDING_APPROVAL'
                 LIMIT 1`,
                [caseData.id]
            );
            if (existingPending.rows.length === 0) {
                try {
                    // Direct INSERT to avoid upsertProposal dismissing unrelated active proposals
                    await database.query(
                        `INSERT INTO proposals (case_id, action_type, proposal_key, reasoning, confidence,
                         requires_human, can_auto_execute, draft_subject, draft_body_text, status, created_at, updated_at)
                         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW(), NOW())`,
                        [
                            caseData.id,
                            'SUBMIT_PORTAL',
                            `${caseData.id}:portal_gate:SUBMIT_PORTAL:${Date.now()}`,
                            JSON.stringify(['Automatic portal submission requires human approval before running', `Portal: ${portalUrl}`]),
                            0.8,
                            true,
                            false,
                            `Portal submission: ${caseData.case_name || caseData.agency_name || 'Unknown'}`,
                            `Portal URL: ${portalUrl}\n\nThis portal submission was triggered automatically but requires human approval before Skyvern runs.${instructions ? '\n\nInstructions: ' + instructions : ''}`,
                            'PENDING_APPROVAL'
                        ]
                    );
                } catch (proposalErr) {
                    // Constraint violation — another proposal was created concurrently, which is fine
                    console.warn('Could not create approval proposal:', proposalErr.message);
                }
            }
            await database.updateCaseStatus(caseData.id, 'needs_human_review', {
                substatus: 'Portal submission requires approval',
                requires_human: true
            });
            await database.logActivity('portal_submission_blocked',
                `Portal submission blocked for case ${caseData.id} — no approved proposal`, {
                case_id: caseData.id, portal_url: portalUrl
            });
            return { success: false, needsApproval: true, reason: 'no_approved_proposal' };
        }
        if (approvedProposal.rows.length === 0 && bypassApprovalGate) {
            console.log(`✅ Portal submission approval gate bypassed for case ${caseData.id} (manual retry path)`);
        }

        const runId = crypto.randomUUID();

        console.log(`🤖 Starting Skyvern workflow for case: ${caseData.case_name}`);
        console.log(`   Portal: ${portalUrl}`);
        console.log(`   Mode: workflow (forced)`);
        console.log(`   Dry run: ${dryRun}`);
        console.log(`   Workflow endpoint: ${this.workflowRunUrl}`);

        await database.logActivity(
            'portal_run_started',
            `Skyvern portal automation started for ${caseData.case_name}`,
            {
                case_id: caseData.id || null,
                portal_url: portalUrl,
                dry_run: dryRun,
                max_steps: null,
                run_id: runId,
                engine: 'skyvern_workflow'
            }
        );

        try {
            return await this._submitViaWorkflow({
                caseData,
                portalUrl,
                dryRun,
                runId,
                instructions
            });
        } catch (error) {
            console.error('❌ Skyvern workflow submission failed:', error.message);
            throw error;
        }
    }

    /**
     * Cancel a running Skyvern workflow/task run.
     * Uses POST /v1/runs/{run_id}/cancel — works for both task and workflow runs.
     */
    async cancelWorkflowRun(workflowRunId) {
        if (!workflowRunId) return false;
        try {
            await axios.post(
                `https://api.skyvern.com/v1/runs/${workflowRunId}/cancel`,
                {},
                {
                    headers: { 'x-api-key': this.apiKey },
                    timeout: 10000,
                }
            );
            console.log(`🛑 Cancelled Skyvern run ${workflowRunId}`);
            return true;
        } catch (err) {
            console.warn(`⚠️ Failed to cancel Skyvern run ${workflowRunId}: ${err.message}`);
            return false;
        }
    }

    /**
     * Workflow helper utilities
     */
    _buildWorkflowRunUrl(workflowRunId, workflowResponse = {}) {
        const direct =
            workflowResponse.workflow_run_url ||
            workflowResponse.run_url ||
            workflowResponse.url ||
            workflowResponse.workflow_url;
        if (direct) {
            return direct;
        }
        if (!workflowRunId) {
            return null;
        }
        const base = (this.skyvernAppBaseUrl || 'https://app.skyvern.com').replace(/\/$/, '');
        return `${base}/workflows/${this.workflowId}/${workflowRunId}`;
    }

    _formatWorkflowDate(value) {
        if (!value) return null;
        const dateObj = value instanceof Date ? value : new Date(value);
        if (Number.isNaN(dateObj.getTime())) {
            return value;
        }
        return dateObj.toISOString().split('T')[0];
    }

    _normalizeRecordsField(records) {
        if (!records) return [];
        if (Array.isArray(records)) {
            return records.filter(Boolean);
        }
        if (typeof records === 'string') {
            const trimmed = records.trim();
            if (!trimmed) return [];
            if ((trimmed.startsWith('[') && trimmed.endsWith(']')) || (trimmed.startsWith('{') && trimmed.endsWith('}'))) {
                try {
                    const parsed = JSON.parse(trimmed.replace(/^{/, '[').replace(/}$/, ']'));
                    if (Array.isArray(parsed)) {
                        return parsed.filter(Boolean);
                    }
                } catch (_) {
                    // fall through
                }
            }
            if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
                return trimmed
                    .slice(1, -1)
                    .split(',')
                    .map(item => item.replace(/^"+|"+$/g, '').trim())
                    .filter(Boolean);
            }
            return [trimmed];
        }
        return [String(records)];
    }

    _buildWorkflowCaseInfo(caseData, portalUrl, dryRun) {
        // Truncate additional_details to avoid bloating the Skyvern payload
        let additionalDetails = String(caseData.additional_details || '');
        if (additionalDetails.length > 3000) {
            // Cut at last newline before limit to avoid splitting mid-record
            const cutPoint = additionalDetails.lastIndexOf('\n', 3000);
            additionalDetails = additionalDetails.substring(0, cutPoint > 2000 ? cutPoint : 3000) + '\n[truncated]';
        }

        // Keep case_name concise for portal AI context. Prefer suspect/subject name.
        const normalizedSubjectName = String(caseData.subject_name || '').trim();
        const normalizedCaseName = String(caseData.case_name || '').trim();
        const conciseCaseName = normalizedSubjectName || normalizedCaseName || `Case ${caseData.id}`;

        return {
            case_id: caseData.id,
            case_name: conciseCaseName,
            subject_name: caseData.subject_name,
            agency_name: caseData.agency_name,
            agency_email: caseData.agency_email,
            portal_url: portalUrl,
            state: caseData.state,
            incident_date: this._formatWorkflowDate(caseData.incident_date),
            incident_location: caseData.incident_location,
            requested_records: this._normalizeRecordsField(caseData.requested_records),
            additional_details: additionalDetails,
            deadline_date: this._formatWorkflowDate(caseData.deadline_date),
            dry_run: !!dryRun
        };
    }

    _buildWorkflowPersonalInfo(caseData, caseOwner = null) {
        // Use case owner's info if available, fall back to env vars / defaults
        const ownerName = caseOwner?.name || process.env.REQUESTER_NAME || 'Samuel Hylton';
        // Important: requestor contact email should be the case owner's identity,
        // not the shared portal login inbox (REQUESTS_INBOX). Portal confirmations
        // sent to REQUESTS_INBOX don't route to cases properly.
        const ownerEmail = caseOwner?.email || process.env.REQUESTER_EMAIL || 'sam@foib-request.com';
        const ownerPhone = caseOwner?.signature_phone || process.env.REQUESTER_PHONE || '209-800-7702';
        const ownerOrg = caseOwner
            ? (caseOwner.signature_organization ?? '')
            : (process.env.REQUESTER_ORG || 'Dr Insanity / FOIA Request Team');
        const ownerTitle = caseOwner?.signature_title || process.env.REQUESTER_TITLE || 'Documentary Researcher';

        return {
            name: ownerName,
            email: ownerEmail,
            phone: ownerPhone,
            organization: ownerOrg,
            title: ownerTitle,
            address: {
                line1: caseOwner?.address_street || process.env.REQUESTER_ADDRESS || '3021 21st Ave W',
                line2: caseOwner?.address_street2 || process.env.REQUESTER_ADDRESS_LINE2 || 'Apt 202',
                city: caseOwner?.address_city || process.env.REQUESTER_CITY || 'Seattle',
                state: caseOwner?.address_state || process.env.REQUESTER_STATE || 'WA',
                zip: caseOwner?.address_zip || process.env.REQUESTER_ZIP || '98199'
            },
            preferred_delivery: 'electronic',
            fee_waiver: {
                requested: true,
                reason: 'Non-commercial documentary / public interest'
            }
        };
    }

    async _buildWorkflowParameters({ caseData, portalUrl, portalAccount, dryRun, instructions = null, caseOwner = null }) {
        const caseInfo = this._buildWorkflowCaseInfo(caseData, portalUrl, dryRun);
        const personalInfo = this._buildWorkflowPersonalInfo(caseData, caseOwner);

        // Include the drafted FOIA request text so Skyvern uses it instead of raw case_name
        if (instructions) {
            caseInfo.request_text = instructions;
        }

        // NOTE: Do NOT inject previous submission status/memory into case_info.
        // Skyvern's AI interprets "Previously submitted successfully" as "already done"
        // and skips all form filling. Submission memory removed to prevent false positives.

        // Always send login credentials — either from saved account or defaults.
        // This ensures Skyvern uses OUR password when creating accounts, not a random one.
        const defaultEmail = personalInfo.email || process.env.REQUESTER_EMAIL || 'sam@foib-request.com';
        const defaultPassword = process.env.PORTAL_DEFAULT_PASSWORD || 'Insanity10M';
        const loginPayload = JSON.stringify({
            email: portalAccount?.email || defaultEmail,
            password: portalAccount?.password || defaultPassword
        });

        return {
            URL: portalUrl,
            login: loginPayload,
            login_strategy: 'Always attempt login first with provided credentials. Only create account if login fails and no account exists.',
            case_info: caseInfo,
            personal_info: personalInfo
        };
    }

    _isLoginFailureText(value) {
        if (!value) return false;
        return /(login (attempt )?failed|invalid (email.{0,20})?password|wrong password|incorrect password|invalid (email.{0,20})?credentials|authentication failed|account locked|locked out|too many (login |sign.?in )?attempts|sign.?in failed|could not (log|sign) ?in|invalid email\/username)/i.test(String(value));
    }

    async _lockPortalAccountAfterLoginFailure({ portalAccount, portalUrl, userId, failureReason, caseData, runId }) {
        try {
            let account = portalAccount;
            if (!account) {
                account = await database.getPortalAccountByUrl(portalUrl, userId, { includeInactive: true });
            }

            if (!account?.id) {
                console.warn(`⚠️ Login failed for ${portalUrl} but no matching account found to lock`);
                return;
            }

            if (account.account_status !== 'locked') {
                await database.updatePortalAccountStatus(account.id, 'locked');
            }

            await database.logActivity(
                'portal_account_locked',
                `Portal account locked after login failure for ${portalUrl}`,
                {
                    case_id: caseData?.id || null,
                    portal_url: portalUrl,
                    portal_account_id: account.id,
                    account_email: account.email,
                    run_id: runId || null,
                    reason: String(failureReason || 'Login failed').substring(0, 500)
                }
            );

            console.warn(`🔒 Locked portal account ${account.email} for ${portalUrl} after login failure`);
        } catch (lockErr) {
            console.warn('Could not lock portal account after login failure:', lockErr.message);
        }
    }

    async _generateRetryGuidance(caseData, portalUrl, error, workflowResponse) {
        try {
            const OpenAI = require('openai');
            const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

            const response = await openai.chat.completions.create({
                model: process.env.PORTAL_RETRY_MODEL || 'gpt-5.2-2025-12-11',
                messages: [{
                    role: 'system',
                    content: `You are a browser automation expert. A Skyvern workflow to submit a FOIA request on a government portal failed. Analyze the error and provide a short, specific navigation_goal instruction that will help the retry succeed. Focus on what went wrong and how to work around it. Return ONLY a JSON object with: { "navigation_goal": "<instruction for the browser agent>", "should_retry": true/false }`
                }, {
                    role: 'user',
                    content: `Portal: ${portalUrl}\nAgency: ${caseData.agency_name}\nError: ${error}\nWorkflow response: ${JSON.stringify(workflowResponse || {}).slice(0, 2000)}`
                }],
                max_tokens: 300,
                temperature: 0.3
            });

            const text = response.choices[0]?.message?.content || '';
            const jsonMatch = text.match(/\{[\s\S]*\}/);
            if (jsonMatch) {
                return JSON.parse(jsonMatch[0]);
            }
            return { navigation_goal: text.trim(), should_retry: true };
        } catch (err) {
            console.error('AI retry guidance failed:', err.message);
            return { navigation_goal: null, should_retry: true };
        }
    }

    async _ensurePortalAccount({ portalUrl, caseData, caseOwner = null }) {
        // userId and caseOwner are passed in from the caller to avoid double-resolution
        const userId = caseData.user_id || null;

        // Kill switch
        if (process.env.PORTAL_SCOUT_DISABLED === 'true') {
            console.log('🔇 Portal scout disabled via PORTAL_SCOUT_DISABLED — falling back to DB lookup');
            const existing = await database.getPortalAccountByUrl(portalUrl, userId);
            if (existing?.account_status === 'no_account_needed') return null;
            if (existing) await database.updatePortalAccountLastUsed(existing.id);
            return existing;
        }

        // 1. Check DB for existing account (user-specific first, then shared)
        const existing = await database.getPortalAccountByUrl(portalUrl, userId);
        if (existing) {
            if (existing.account_status === 'no_account_needed') {
                console.log(`⏭️  Portal ${portalUrl} marked as no-account-needed — skipping scout`);
                return null;
            }
            console.log(`🔑 Found existing portal account for ${portalUrl} (${existing.email}, user_id=${existing.user_id || 'shared'})`);
            await database.updatePortalAccountLastUsed(existing.id);
            return existing;
        }

        // 2. No account found — run scout task using the case owner's email
        console.log(`🔍 No portal account found for ${portalUrl} (user_id=${userId}) — running scout task...`);
        const email = caseOwner?.email || process.env.REQUESTER_EMAIL || 'sam@foib-request.com';
        const password = process.env.PORTAL_DEFAULT_PASSWORD || 'Insanity10M';

        await database.logActivity('portal_scout_started', `Scout task started for ${portalUrl}`, {
            case_id: caseData.id || null,
            portal_url: portalUrl
        });

        try {
            const navigationGoal = this._buildScoutNavigationGoal({ email, password });
            const navigationPayload = this._buildScoutNavigationPayload({ email, password });

            const { finalTask, taskId } = await this._createTaskAndPoll({
                portalUrl,
                navigationGoal,
                navigationPayload,
                maxSteps: 15,
                maxPolls: 60  // 5 minutes
            });

            const taskUrl = taskId ? `https://app.skyvern.com/tasks/${taskId}` : null;
            const extracted = finalTask?.extracted_information || {};
            const status = finalTask?.status;

            await database.logActivity('portal_scout_completed', `Scout task finished for ${portalUrl}`, {
                case_id: caseData.id || null,
                portal_url: portalUrl,
                task_id: taskId,
                task_url: taskUrl,
                scout_status: status,
                extracted
            });

            // 3. Parse scout results
            // Derive name from case owner or env
            const ownerFirstName = caseOwner?.name?.split(' ')[0] || process.env.REQUESTER_NAME?.split(' ')[0] || 'Samuel';
            const ownerLastName = caseOwner?.name?.split(' ').slice(1).join(' ') || process.env.REQUESTER_NAME?.split(' ').slice(1).join(' ') || 'Hylton';

            if (extracted.requires_account === false) {
                console.log(`📋 Portal ${portalUrl} does not require an account — saving marker`);
                try {
                    await database.createPortalAccount({
                        portal_url: portalUrl,
                        portal_type: extracted.portal_type || null,
                        email,
                        password,
                        first_name: ownerFirstName,
                        last_name: ownerLastName,
                        account_status: 'no_account_needed',
                        user_id: userId
                    });
                } catch (saveErr) {
                    console.warn('Could not save no_account_needed marker:', saveErr.message);
                }
                return null;
            }

            if (extracted.account_created || extracted.account_already_existed) {
                console.log(`✅ Scout ${extracted.account_created ? 'created' : 'found existing'} account on ${portalUrl} for user_id=${userId}`);
                try {
                    const saved = await database.createPortalAccount({
                        portal_url: portalUrl,
                        portal_type: extracted.portal_type || null,
                        email,
                        password,
                        first_name: ownerFirstName,
                        last_name: ownerLastName,
                        account_status: 'active',
                        user_id: userId,
                        additional_info: {
                            created_by: 'portal_scout',
                            scout_task_id: taskId,
                            login_url: extracted.login_url || null,
                            notes: extracted.notes || null
                        }
                    });
                    console.log(`💾 Saved scout account ID: ${saved.id}`);
                    saved.password = password; // createPortalAccount returns without decrypted password
                    return saved;
                } catch (saveErr) {
                    console.warn('Could not save scout account:', saveErr.message);
                    // Return a virtual account object so the workflow can still use creds
                    return { email, password, account_status: 'active' };
                }
            }

            // Scout completed but didn't clearly determine account status
            if (status === 'completed') {
                console.log(`⚠️  Scout completed but unclear result — proceeding without account`);
            } else {
                console.log(`⚠️  Scout ended with status=${status} — proceeding without account`);
            }
            return null;
        } catch (scoutError) {
            // Non-fatal: if scout fails, main workflow proceeds with defaults
            console.warn(`⚠️  Scout task failed: ${scoutError.message} — proceeding without account`);
            await database.logActivity('portal_scout_failed', `Scout task failed for ${portalUrl}: ${scoutError.message}`, {
                case_id: caseData.id || null,
                portal_url: portalUrl,
                error: scoutError.message
            });
            return null;
        }
    }

    async _submitViaWorkflow({ caseData, portalUrl, dryRun, runId, instructions = null, retryContext = null }) {
        if (!this.workflowId) {
            throw new Error('SKYVERN_WORKFLOW_ID not set but workflow mode requested');
        }

        // Resolve case owner for per-user accounts and personal info
        const userId = caseData.user_id || null;
        let caseOwner = null;
        if (userId) {
            try {
                caseOwner = await database.getUserById(userId);
            } catch (e) { /* non-fatal */ }
        }

        console.log('⚙️ Skyvern workflow mode enabled. Building parameters…');
        let portalAccount = null;
        if (!retryContext) {
            // First attempt: do a cheap DB credential lookup only.
            // If none exists, workflow uses default password and attempts login first.
            portalAccount = await database.getPortalAccountByUrl(portalUrl, userId);
            if (portalAccount?.account_status === 'no_account_needed') portalAccount = null;
            if (portalAccount) {
                await database.updatePortalAccountLastUsed(portalAccount.id);
                console.log(`🔑 Using stored portal account for ${portalUrl} (${portalAccount.email}, user_id=${portalAccount.user_id || 'shared'})`);
            } else {
                console.log(`🔑 No stored portal account for ${portalUrl} (user_id=${userId}) — using default login password and login-first workflow path`);
            }
        } else {
            // Retry: fetch existing account; if absent, keep using default credentials
            portalAccount = await database.getPortalAccountByUrl(portalUrl, userId);
            if (portalAccount?.account_status === 'no_account_needed') portalAccount = null;
            if (portalAccount) await database.updatePortalAccountLastUsed(portalAccount.id);
        }

        const totpIdentifier = caseOwner?.email || process.env.TOTP_INBOX || process.env.REQUESTER_EMAIL || 'sam@foib-request.com';
        const parameters = await this._buildWorkflowParameters({ caseData, portalUrl, portalAccount, dryRun, instructions, caseOwner });
        if (retryContext?.navigation_goal) {
            parameters.navigation_goal = retryContext.navigation_goal;
            console.log(`🔄 Retry with AI guidance: ${retryContext.navigation_goal}`);
        }
        const requestBody = {
            workflow_id: this.workflowId,
            parameters,
            proxy_location: this.workflowProxyLocation,
            browser_session_id: this.workflowBrowserSessionId,
            browser_address: this.workflowBrowserAddress,
            run_with: 'agent',
            ai_fallback: true,
            extra_http_headers: {},
            totp_identifier: totpIdentifier
        };

        const safeLog = JSON.parse(JSON.stringify(requestBody));
        if (safeLog.parameters?.login) {
            safeLog.parameters.login = '[redacted credential payload]';
        }
        console.log('📦 Workflow payload:', JSON.stringify(safeLog, null, 2));

        try {
            const response = await axios.post(
                this.workflowRunUrl,
                requestBody,
                {
                    headers: {
                        'Content-Type': 'application/json',
                        'x-api-key': this.apiKey
                    },
                    timeout: this.workflowHttpTimeout
                }
            );

            const workflowResponse = response.data || {};
            const workflowRunId = workflowResponse.workflow_run_id || workflowResponse.run_id || workflowResponse.id || runId;
            const initialStatus = workflowResponse.status || 'workflow_started';
            const workflowRunLink = this._buildWorkflowRunUrl(workflowRunId, workflowResponse);

            await database.updateCasePortalStatus(caseData.id, {
                portal_url: portalUrl,
                portal_provider: caseData.portal_provider || 'Auto-detected',
                last_portal_status: initialStatus,
                last_portal_status_at: new Date(),
                last_portal_engine: 'skyvern_workflow',
                last_portal_run_id: workflowRunId,
                last_portal_details: JSON.stringify(workflowResponse),
                last_portal_task_url: null, // Set after polling confirms the run exists
                last_portal_account_email: portalAccount?.email || null
            });

            await database.logActivity(
                'portal_workflow_triggered',
                `Skyvern workflow triggered for ${caseData.case_name}`,
                {
                    case_id: caseData.id || null,
                    portal_url: portalUrl,
                    run_id: workflowRunId,
                    engine: 'skyvern_workflow',
                    status: initialStatus,
                    task_url: workflowRunLink || null
                }
            );

            const finalResult = workflowRunId
                ? await this._pollWorkflowRun(workflowRunId, caseData.id)
                : null;

            if (!finalResult) {
                console.warn('⚠️ Workflow run status unavailable; manual follow-up required.');
                // Save the Skyvern run link even on timeout so dashboard can link to it
                if (workflowRunLink) {
                    await database.updateCasePortalStatus(caseData.id, {
                        last_portal_task_url: workflowRunLink
                    });
                }
                const timeoutReason = `Polling timeout — check Skyvern run${workflowRunLink ? ': ' + workflowRunLink : ''}`;

                // Record timeout memory before any early returns
                try {
                    const caseAgencies = await database.getCaseAgencies(caseData.id);
                    const primary = caseAgencies?.find(a => a.is_primary) || caseAgencies?.[0];
                    await notionService.addSubmissionComment(caseData.id, {
                        portal_url: portalUrl,
                        provider: caseData.portal_provider || null,
                        account_email: portalAccount?.email || process.env.REQUESTER_EMAIL || 'sam@foib-request.com',
                        status: 'timeout',
                        confirmation_number: null,
                        notes: timeoutReason,
                        agency_notion_page_id: primary?.agency_notion_page_id || null
                    });
                } catch (_) { /* non-critical */ }

                // Try email fallback before escalating to human
                const emailSent = await this._fallbackToEmailIfPossible(caseData, portalUrl, timeoutReason);
                if (emailSent) {
                    try { await notionService.syncStatusToNotion(caseData.id); } catch (_) {}
                    return { success: true, status: 'email_fallback_sent', runId: workflowRunId, engine: 'pdf_form_auto' };
                }
                const timeoutDetail = timeoutReason;
                await database.updateCaseStatus(caseData.id, 'needs_human_review', {
                    substatus: `Portal failed: ${timeoutDetail}`.substring(0, 100),
                    requires_human: true
                });
                try {
                    await database.upsertProposal({
                        proposalKey: `${caseData.id}:portal_failure:SUBMIT_PORTAL:1`,
                        caseId: caseData.id,
                        actionType: 'SUBMIT_PORTAL',
                        reasoning: [
                            `Automated portal submission failed: ${timeoutDetail}`,
                            'Approve to retry automated submission, or dismiss to handle manually'
                        ],
                        confidence: 0,
                        requiresHuman: true,
                        canAutoExecute: false,
                        draftSubject: `Portal retry: ${caseData.case_name}`.substring(0, 200),
                        draftBodyText: `Portal URL: ${portalUrl}\nPrevious attempt failed: ${timeoutDetail}\n\nApproving will retry the automated portal submission.`,
                        status: 'PENDING_APPROVAL'
                    });
                } catch (proposalErr) {
                    console.error('Failed to create proposal on portal timeout:', proposalErr.message);
                }
                try { await notionService.syncStatusToNotion(caseData.id); } catch (_) {}
                return {
                    success: false,
                    status: initialStatus,
                    runId: workflowRunId,
                    workflow_url: workflowRunLink || null,
                    workflow_response: workflowResponse,
                    error: 'Workflow run status unavailable',
                    engine: 'skyvern_workflow'
                };
            }

            const finalStatus = (finalResult.status || finalResult.final_status || '').toLowerCase();
            const completed = ['completed', 'succeeded', 'success'].includes(finalStatus);
            const failed = finalStatus.includes('fail') || finalStatus.includes('error');
            const recordingUrl = finalResult.recording_url || finalResult.recording || workflowResponse.recording_url || null;
            const extractedData = finalResult.outputs || finalResult.extracted_information || finalResult.result || {};
            const finalWorkflowRunLink = this._buildWorkflowRunUrl(workflowRunId, finalResult) || workflowRunLink;

            await database.updateCasePortalStatus(caseData.id, {
                last_portal_status: finalResult.status || finalResult.final_status || (completed ? 'completed' : 'failed'),
                last_portal_status_at: new Date(),
                last_portal_recording_url: recordingUrl || null,
                last_portal_details: JSON.stringify(finalResult),
                last_portal_task_url: finalWorkflowRunLink || null,
                last_portal_screenshot_url: null // Clear live screenshot on completion
            });

            if (completed && !failed) {
                const statusText = finalResult.status || 'completed';
                await database.updateCaseStatus(caseData.id, 'awaiting_response', {
                    substatus: `Portal submission completed (${statusText})`,
                    send_date: new Date()
                });
                // Dismiss only submission-related proposals; keep rebuttals, fee negotiations, etc.
                try { await database.dismissPendingProposals(caseData.id, 'Portal submission completed', ['SUBMIT_PORTAL', 'SEND_FOLLOWUP', 'SEND_INITIAL_REQUEST']); } catch (_) {}
                try { await notionService.syncStatusToNotion(caseData.id); } catch (_) {}

                // Record submission memory on the Notion page (case + PD)
                try {
                    const caseAgencies = await database.getCaseAgencies(caseData.id);
                    const primary = caseAgencies?.find(a => a.is_primary) || caseAgencies?.[0];
                    await notionService.addSubmissionComment(caseData.id, {
                        portal_url: portalUrl,
                        provider: caseData.portal_provider || null,
                        account_email: portalAccount?.email || process.env.REQUESTER_EMAIL || 'sam@foib-request.com',
                        status: finalResult.status || 'completed',
                        confirmation_number: extractedData?.confirmation_number || caseData.portal_request_number || null,
                        agency_notion_page_id: primary?.agency_notion_page_id || null
                    });
                } catch (memErr) {
                    console.warn('Submission memory comment failed (non-critical):', memErr.message);
                }

                // Auto-save portal account if we didn't have one — so future cases reuse it
                if (!portalAccount) {
                    try {
                        const defaultPassword = process.env.PORTAL_DEFAULT_PASSWORD || 'Insanity10M';
                        await database.createPortalAccount({
                            portal_url: portalUrl,
                            portal_type: caseData.portal_provider || null,
                            email: caseOwner?.email || process.env.REQUESTER_EMAIL || 'sam@foib-request.com',
                            password: defaultPassword,
                            first_name: caseOwner?.name?.split(' ')[0] || process.env.REQUESTER_NAME?.split(' ')[0] || 'Samuel',
                            last_name: caseOwner?.name?.split(' ').slice(1).join(' ') || process.env.REQUESTER_NAME?.split(' ').slice(1).join(' ') || 'Hylton',
                            account_status: 'active',
                            user_id: userId
                        });
                        console.log(`💾 Auto-saved portal account for ${portalUrl} (user_id=${userId})`);
                    } catch (saveErr) {
                        // Duplicate or other error — not critical
                        console.warn('Could not auto-save portal account:', saveErr.message);
                    }
                }

                await database.logActivity(
                    'portal_stage_completed',
                    `Skyvern workflow completed for ${caseData.case_name}`,
                    {
                        case_id: caseData.id || null,
                        portal_url: portalUrl,
                        run_id: workflowRunId,
                        engine: 'skyvern_workflow',
                        task_url: finalWorkflowRunLink || null
                    }
                );

                return {
                    success: true,
                    status: finalResult.status || 'completed',
                    submission_status: finalResult.status || 'completed',
                    runId: workflowRunId,
                    recording_url: recordingUrl || null,
                    extracted_data: extractedData,
                    workflow_url: finalWorkflowRunLink || null,
                    engine: 'skyvern_workflow'
                };
            }

            const failureReason = finalResult.error || finalResult.failure_reason || finalResult.message || 'Workflow run failed';
            const fullRunText = JSON.stringify(finalResult).toLowerCase();
            const extractedInfoText = JSON.stringify(extractedData || {}).toLowerCase();
            const loginFailureDetected =
                this._isLoginFailureText(failureReason) ||
                this._isLoginFailureText(fullRunText) ||
                this._isLoginFailureText(extractedInfoText);

            // Login failures MUST be checked before PDF check — the full response JSON
            // contains the FOIA request text which has words like "form", "email", "download"
            // that cause false positives in isPdfFormFailure.
            if (loginFailureDetected) {
                // Lock the bad credentials so they're not reused
                await this._lockPortalAccountAfterLoginFailure({
                    portalAccount,
                    portalUrl,
                    userId,
                    failureReason,
                    caseData,
                    runId: workflowRunId
                });

                await database.logActivity(
                    'portal_login_failed',
                    `Login failed for ${portalUrl} — credentials invalid, will retry with account creation`,
                    {
                        case_id: caseData.id || null,
                        portal_url: portalUrl,
                        run_id: workflowRunId,
                        engine: 'skyvern_workflow',
                        error: failureReason,
                    }
                );

                // If this is the first attempt with stored credentials, retry WITHOUT
                // an account so Skyvern creates a new one (password is always Insanity10M).
                if (portalAccount && !retryContext) {
                    console.log(`🔄 Login failed for ${portalUrl} — retrying with account creation (no stored creds)`);
                    return this._submitViaWorkflow({
                        caseData, portalUrl, dryRun,
                        runId: crypto.randomUUID(),
                        retryContext: { previousError: failureReason, loginFailed: true }
                    });
                }

                // Already retried or no account to lock — escalate to human
                const truncatedReason = String(failureReason || 'Login failed').substring(0, 80);
                await database.updateCaseStatus(caseData.id, 'needs_human_review', {
                    substatus: `Portal login failed: ${truncatedReason}`.substring(0, 100),
                    requires_human: true
                });
                try { await notionService.syncStatusToNotion(caseData.id); } catch (_) {}

                return {
                    success: false,
                    status: finalResult.status || 'failed',
                    runId: workflowRunId,
                    recording_url: recordingUrl || null,
                    workflow_url: finalWorkflowRunLink || null,
                    error: failureReason,
                    workflow_response: finalResult,
                    doNotRetry: true,
                    engine: 'skyvern_workflow'
                };
            }

            // NOT A REAL PORTAL: PDF download, fax-only, cannot-automate, etc.
            // Only check failureReason — NOT fullRunText which contains FOIA text with
            // false-positive words like "form", "email", "download".
            if (pdfFormService.isPdfFormFailure(failureReason, null, portalUrl)) {
                console.log(`🔍 Skyvern confirmed portal not automatable for case ${caseData.id}`);
                await database.logActivity('portal_not_automatable',
                    `Skyvern says not automatable: ${failureReason}`, {
                    case_id: caseData.id, portal_url: portalUrl, error: failureReason
                });
                try {
                    const caseAgencies = await database.getCaseAgencies(caseData.id);
                    const primary = caseAgencies?.find(a => a.is_primary) || caseAgencies?.[0];
                    await notionService.addSubmissionComment(caseData.id, {
                        portal_url: portalUrl,
                        provider: caseData.portal_provider || null,
                        account_email: portalAccount?.email || process.env.REQUESTER_EMAIL || 'sam@foib-request.com',
                        status: 'not_automatable',
                        confirmation_number: null,
                        notes: `Portal not automatable: ${String(failureReason).substring(0, 200)}`,
                        agency_notion_page_id: primary?.agency_notion_page_id || null
                    });
                } catch (_) { /* non-critical */ }
                return this._handleNotRealPortal(caseData, portalUrl, dryRun, failureReason);
            }

            // ── Re-check case status before any retry — prevents duplicate submissions
            //    when Skyvern reports "failed" but the form was actually submitted ──
            const _retrySkipStatuses = ['sent', 'awaiting_response', 'responded', 'completed', 'needs_phone_call'];
            const freshCaseBeforeRetry = await database.getCaseById(caseData.id);
            if (freshCaseBeforeRetry && _retrySkipStatuses.includes(freshCaseBeforeRetry.status)) {
                console.log(`⏭️  Skipping retry for case ${caseData.id} — case already ${freshCaseBeforeRetry.status}`);
                return {
                    success: true,
                    skipped: true,
                    reason: `case_already_${freshCaseBeforeRetry.status}`,
                    engine: 'skyvern_workflow'
                };
            }

            // ACCOUNT EXISTS: If Skyvern created an account but then looped, save creds and retry with login
            const accountAlreadyExists = /email.*already exists|account.*already|duplicate.*email/i.test(failureReason + ' ' + fullRunText);
            if (accountAlreadyExists && !portalAccount && !retryContext) {
                console.log(`🔑 Account already exists on ${portalUrl} — saving credentials and retrying with login`);
                const defaultPassword = process.env.PORTAL_DEFAULT_PASSWORD || 'Insanity10M';
                try {
                    await database.createPortalAccount({
                        portal_url: portalUrl,
                        portal_type: caseData.portal_provider || null,
                        email: caseOwner?.email || process.env.REQUESTER_EMAIL || 'sam@foib-request.com',
                        password: defaultPassword,
                        first_name: caseOwner?.name?.split(' ')[0] || process.env.REQUESTER_NAME?.split(' ')[0] || 'Samuel',
                        last_name: caseOwner?.name?.split(' ').slice(1).join(' ') || process.env.REQUESTER_NAME?.split(' ').slice(1).join(' ') || 'Hylton',
                        account_status: 'active',
                        user_id: userId
                    });
                    console.log(`💾 Auto-saved portal account for ${portalUrl} (user_id=${userId})`);
                } catch (saveErr) {
                    console.warn('Could not save portal account (may already exist):', saveErr.message);
                }

                await database.logActivity('portal_retry_requested',
                    `Account already exists — retrying with saved credentials`, {
                    case_id: caseData.id, portal_url: portalUrl, error: failureReason,
                    run_id: workflowRunId, engine: 'skyvern_workflow'
                });

                return this._submitViaWorkflow({
                    caseData, portalUrl, dryRun,
                    runId: crypto.randomUUID(),
                    retryContext: { navigation_goal: 'Log in with existing credentials and submit the FOIA request. Do NOT create a new account.', previousError: failureReason }
                });
            }

            // RETRY: If this is the first attempt, ask AI for guidance and retry once
            if (!retryContext) {
                console.log(`🔄 First failure for case ${caseData.id}, requesting AI retry guidance...`);

                await database.logActivity('portal_retry_requested',
                    `Portal failed, requesting AI guidance for retry: ${failureReason}`, {
                    case_id: caseData.id, portal_url: portalUrl, error: failureReason,
                    run_id: workflowRunId, engine: 'skyvern_workflow'
                });

                const guidance = await this._generateRetryGuidance(caseData, portalUrl, failureReason, finalResult);

                if (guidance.should_retry !== false) {
                    console.log(`🔄 Retrying portal for case ${caseData.id} with AI guidance`);
                    return this._submitViaWorkflow({
                        caseData, portalUrl, dryRun,
                        runId: crypto.randomUUID(),
                        retryContext: { navigation_goal: guidance.navigation_goal, previousError: failureReason }
                    });
                }
            }

            // ESCALATE: Retry exhausted or AI said don't retry
            console.log(`❌ Portal failed for case ${caseData.id} after ${retryContext ? 'retry' : 'AI declined retry'}`);
            const failureStr = String(failureReason || 'Unknown error');

            // Record portal failure memory before any early returns
            try {
                const caseAgencies = await database.getCaseAgencies(caseData.id);
                const primary = caseAgencies?.find(a => a.is_primary) || caseAgencies?.[0];
                await notionService.addSubmissionComment(caseData.id, {
                    portal_url: portalUrl,
                    provider: caseData.portal_provider || null,
                    account_email: portalAccount?.email || process.env.REQUESTER_EMAIL || 'sam@foib-request.com',
                    status: 'failed',
                    confirmation_number: null,
                    notes: `Error: ${failureStr.substring(0, 200)}`,
                    agency_notion_page_id: primary?.agency_notion_page_id || null
                });
            } catch (_) { /* non-critical */ }

            // Try email fallback before escalating to human
            const emailSent = await this._fallbackToEmailIfPossible(caseData, portalUrl, failureReason);
            if (emailSent) {
                try { await notionService.syncStatusToNotion(caseData.id); } catch (_) {}
                return { success: true, status: 'email_fallback_sent', runId: workflowRunId, engine: 'pdf_form_auto' };
            }

            const truncatedReason = failureStr.substring(0, 80);
            await database.updateCaseStatus(caseData.id, 'needs_human_review', {
                substatus: `Portal failed: ${truncatedReason}`.substring(0, 100),
                requires_human: true
            });
            try {
                await database.upsertProposal({
                    proposalKey: `${caseData.id}:portal_failure:SUBMIT_PORTAL:1`,
                    caseId: caseData.id,
                    actionType: 'SUBMIT_PORTAL',
                    reasoning: [
                        `Automated portal submission failed: ${failureReason}`,
                        'Approve to retry automated submission, or dismiss to handle manually'
                    ],
                    confidence: 0,
                    requiresHuman: true,
                    canAutoExecute: false,
                    draftSubject: `Portal retry: ${caseData.case_name}`.substring(0, 200),
                    draftBodyText: `Portal URL: ${portalUrl}\nPrevious attempt failed: ${failureReason}\n\nApproving will retry the automated portal submission.`,
                    status: 'PENDING_APPROVAL'
                });
            } catch (proposalErr) {
                console.error('Failed to create proposal on portal failure:', proposalErr.message);
            }
            try { await notionService.syncStatusToNotion(caseData.id); } catch (_) {}

            await database.logActivity(
                'portal_stage_failed',
                `Skyvern workflow failed for ${caseData.case_name}: ${failureReason}`,
                {
                    case_id: caseData.id || null,
                    portal_url: portalUrl,
                    run_id: workflowRunId,
                    engine: 'skyvern_workflow',
                    error: failureReason,
                    task_url: finalWorkflowRunLink || workflowRunLink || null
                }
            );

            return {
                success: false,
                status: finalResult.status || 'failed',
                runId: workflowRunId,
                recording_url: recordingUrl || null,
                workflow_url: finalWorkflowRunLink || null,
                error: failureReason,
                workflow_response: finalResult,
                engine: 'skyvern_workflow'
            };
        } catch (error) {
            const message = String(error.response?.data?.message || error.response?.data?.error || error.message || 'Unknown crash');
            console.error('❌ Skyvern workflow API error:', message);
            // workflowRunLink may not be defined if error was thrown before assignment
            const safeRunLink = (typeof workflowRunLink !== 'undefined') ? workflowRunLink : null;

            // Record crash memory before any early returns
            try {
                const caseAgencies = await database.getCaseAgencies(caseData.id);
                const primary = caseAgencies?.find(a => a.is_primary) || caseAgencies?.[0];
                await notionService.addSubmissionComment(caseData.id, {
                    portal_url: portalUrl,
                    provider: caseData.portal_provider || null,
                    account_email: portalAccount?.email || process.env.REQUESTER_EMAIL || 'sam@foib-request.com',
                    status: 'failed',
                    confirmation_number: null,
                    notes: `Crash: ${message.substring(0, 200)}`,
                    agency_notion_page_id: primary?.agency_notion_page_id || null
                });
            } catch (_) { /* non-critical */ }

            // Try email fallback before escalating to human
            const emailSent = await this._fallbackToEmailIfPossible(caseData, portalUrl, message);
            if (emailSent) {
                try { await notionService.syncStatusToNotion(caseData.id); } catch (_) {}
                return { success: true, status: 'email_fallback_sent', engine: 'pdf_form_auto' };
            }

            try {
                const truncatedMsg = (message || 'Unknown error').substring(0, 80);
                await database.updateCaseStatus(caseData.id, 'needs_human_review', {
                    substatus: `Portal failed: ${truncatedMsg}`.substring(0, 100),
                    requires_human: true
                });
                await database.upsertProposal({
                    proposalKey: `${caseData.id}:portal_failure:SUBMIT_PORTAL:1`,
                    caseId: caseData.id,
                    actionType: 'SUBMIT_PORTAL',
                    reasoning: [
                        `Automated portal submission failed: ${message}`,
                        'Approve to retry automated submission, or dismiss to handle manually'
                    ],
                    confidence: 0,
                    requiresHuman: true,
                    canAutoExecute: false,
                    draftSubject: `Portal retry: ${caseData.case_name}`.substring(0, 200),
                    draftBodyText: `Portal URL: ${portalUrl}\nPrevious attempt failed: ${message}\n\nApproving will retry the automated portal submission.`,
                    status: 'PENDING_APPROVAL'
                });
                await notionService.syncStatusToNotion(caseData.id);
            } catch (_) {}

            await database.logActivity(
                'portal_stage_failed',
                `Skyvern workflow crashed for ${caseData.case_name}: ${message}`,
                {
                    case_id: caseData.id || null,
                    portal_url: portalUrl,
                    engine: 'skyvern_workflow',
                    error: message,
                    task_url: safeRunLink
                }
            );
            return {
                success: false,
                status: 'failed',
                error: message,
                workflow_url: safeRunLink,
                engine: 'skyvern_workflow'
            };
        }
    }

    /**
     * Try sending FOIA via email when portal submission fails.
     * Returns true if email was sent, false if fallback not possible.
     */
    async _fallbackToEmailIfPossible(caseData, portalUrl, reason) {
        const targetEmail = caseData.agency_email || caseData.alternate_agency_email;
        if (!targetEmail) return false;

        try {
            console.log(`📧 Portal failed for case ${caseData.id}, falling back to email (${targetEmail})`);
            const pdfResult = await pdfFormService.handlePdfFormFallback(caseData, portalUrl, reason, {});
            if (!pdfResult.success) return false;

            const fs = require('fs');
            const sendgridService = require('./sendgrid-service');
            const attachments = await database.getAttachmentsByCaseId(caseData.id);
            const pdfAttachment = attachments.find(a =>
                a.filename?.startsWith('filled_') && a.content_type === 'application/pdf'
            );
            let pdfBuffer;
            if (pdfAttachment?.storage_path && fs.existsSync(pdfAttachment.storage_path)) {
                pdfBuffer = fs.readFileSync(pdfAttachment.storage_path);
            } else if (pdfAttachment) {
                const fullAtt = await database.getAttachmentById(pdfAttachment.id);
                if (fullAtt?.file_data) pdfBuffer = fullAtt.file_data;
            }
            if (!pdfBuffer) return false;

            const draftSubject = pdfResult.draftSubject || `Public Records Request - ${caseData.subject_name || caseData.case_name}`;
            const sendResult = await sendgridService.sendEmail({
                to: targetEmail, subject: draftSubject, text: pdfResult.draftBodyText,
                caseId: caseData.id, messageType: 'send_pdf_email',
                attachments: [{
                    content: pdfBuffer.toString('base64'), filename: pdfAttachment.filename,
                    type: 'application/pdf', disposition: 'attachment'
                }]
            });

            try { await database.dismissPendingProposals(caseData.id, 'Portal failed, email fallback sent', ['SUBMIT_PORTAL']); } catch (_) {}
            await database.upsertProposal({
                proposalKey: `${caseData.id}:portal_fallback:SEND_PDF_EMAIL:1`,
                caseId: caseData.id, actionType: 'SEND_PDF_EMAIL',
                reasoning: [
                    `Portal submission failed: ${reason}`,
                    `Email fallback sent to ${targetEmail}`
                ],
                confidence: 0.9, requiresHuman: false, canAutoExecute: true,
                draftSubject, draftBodyText: pdfResult.draftBodyText, status: 'EXECUTED'
            });
            await database.updateCaseStatus(caseData.id, 'sent', {
                substatus: `Email fallback to ${targetEmail} (portal failed)`,
                send_date: new Date()
            });
            await database.logActivity('portal_email_fallback',
                `Portal failed, sent via email to ${targetEmail}`, {
                case_id: caseData.id, portal_url: portalUrl,
                sendgrid_message_id: sendResult.messageId
            });
            console.log(`📧 Email fallback sent to ${targetEmail} for case ${caseData.id}`);
            return true;
        } catch (err) {
            console.warn(`📧 Email fallback failed for case ${caseData.id}:`, err.message);
            return false;
        }
    }

    /**
     * Handle a URL that's not a real online portal (document download, fax-only, etc.).
     * 1. Research for a real portal
     * 2. If found, re-submit via Skyvern to the real portal
     * 3. If not found, fall back to PDF form fill + email
     */
    async _handleNotRealPortal(caseData, originalUrl, dryRun, reason) {
        // Step 1: Research for a real portal
        try {
            const pdContactService = require('./pd-contact-service');
            const research = await pdContactService.lookupContact(
                caseData.agency_name, caseData.state
            );
            const newPortal = research?.portal_url;
            const newEmail = research?.contact_email;

            if (newPortal && newPortal !== originalUrl) {
                console.log(`🔍 Research found a real portal for case ${caseData.id}: ${newPortal}`);
                await database.updateCasePortalStatus(caseData.id, {
                    portal_url: newPortal,
                    portal_provider: research.portal_provider || 'Auto-detected'
                });
                await database.logActivity('portal_research_redirect',
                    `Found real portal via research: ${newPortal} (was: ${originalUrl})`, {
                    case_id: caseData.id, old_portal: originalUrl, new_portal: newPortal,
                    source: research.source || 'pd-contact'
                });
                return this.submitToPortal(
                    { ...caseData, portal_url: newPortal },
                    newPortal,
                    { dryRun }
                );
            }

            if (newEmail) {
                console.log(`🔍 No real portal, research found email: ${newEmail} for case ${caseData.id}`);
                await database.logActivity('portal_research_email_found',
                    `No real portal — research suggests email to ${newEmail}`, {
                    case_id: caseData.id, portal_url: originalUrl, contact_email: newEmail
                });
            }

            if (research) {
                await database.query(
                    `UPDATE cases SET contact_research_notes = $2, last_contact_research_at = NOW() WHERE id = $1`,
                    [caseData.id, JSON.stringify(research)]
                );
            }
        } catch (researchErr) {
            console.warn(`🔍 Research failed for case ${caseData.id}:`, researchErr.message);
            await database.logActivity('portal_research_failed',
                `Research for real portal failed: ${researchErr.message}`, {
                case_id: caseData.id, portal_url: originalUrl, error: researchErr.message
            });
        }

        // Step 2: No real portal found — try PDF form fallback
        try {
            console.log(`📄 No real portal found for case ${caseData.id}, trying PDF form fallback...`);
            const pdfResult = await pdfFormService.handlePdfFormFallback(
                caseData, originalUrl, reason, {}
            );
            if (pdfResult.success) {
                // Dismiss any pending proposals for this case (superseded by PDF email fallback)
                await database.dismissPendingProposals(caseData.id, 'Superseded by PDF email fallback');

                const targetEmail = caseData.agency_email || caseData.alternate_agency_email;

                if (targetEmail) {
                    // Auto-send: we have an email and a filled PDF — just send it
                    try {
                        const fs = require('fs');
                        const sendgridService = require('./sendgrid-service');
                        const attachments = await database.getAttachmentsByCaseId(caseData.id);
                        const pdfAttachment = attachments.find(a =>
                            a.filename?.startsWith('filled_') && a.content_type === 'application/pdf'
                        );
                        let pdfBuffer;
                        if (pdfAttachment?.storage_path && fs.existsSync(pdfAttachment.storage_path)) {
                            pdfBuffer = fs.readFileSync(pdfAttachment.storage_path);
                        } else if (pdfAttachment) {
                            const fullAtt = await database.getAttachmentById(pdfAttachment.id);
                            if (fullAtt?.file_data) pdfBuffer = fullAtt.file_data;
                        }
                        if (pdfBuffer) {
                            const draftSubject = pdfResult.draftSubject || `Public Records Request - ${caseData.subject_name || caseData.case_name}`;
                            const sendResult = await sendgridService.sendEmail({
                                to: targetEmail,
                                subject: draftSubject,
                                text: pdfResult.draftBodyText,
                                caseId: caseData.id,
                                messageType: 'send_pdf_email',
                                attachments: [{
                                    content: pdfBuffer.toString('base64'),
                                    filename: pdfAttachment.filename,
                                    type: 'application/pdf',
                                    disposition: 'attachment'
                                }]
                            });
                            await database.upsertProposal({
                                proposalKey: `${caseData.id}:pdf_form:SEND_PDF_EMAIL:1`,
                                caseId: caseData.id,
                                actionType: 'SEND_PDF_EMAIL',
                                reasoning: [
                                    `Portal URL is not a real online form: ${reason}`,
                                    `PDF form filled and auto-sent to ${targetEmail}`
                                ],
                                confidence: 0.9,
                                requiresHuman: false,
                                canAutoExecute: true,
                                draftSubject,
                                draftBodyText: pdfResult.draftBodyText,
                                status: 'EXECUTED'
                            });
                            await database.updateCaseStatus(caseData.id, 'sent', {
                                substatus: `PDF form auto-sent to ${targetEmail} (portal was not a real form)`,
                                send_date: new Date()
                            });
                            await database.logActivity('pdf_email_auto_sent', `PDF form auto-sent to ${targetEmail} for case ${caseData.id}`, {
                                case_id: caseData.id, portal_url: originalUrl,
                                attachment_id: pdfResult.attachmentId, message_id: sendResult.messageId
                            });
                            console.log(`📧 PDF form auto-sent to ${targetEmail} for case ${caseData.id}`);
                            return { success: true, status: 'pdf_email_sent', engine: 'pdf_form_auto' };
                        }
                    } catch (sendErr) {
                        console.warn(`📧 PDF auto-send failed for case ${caseData.id}:`, sendErr.message);
                        // Fall through to PENDING_APPROVAL below
                    }
                }

                // No email or send failed — needs human review
                await database.upsertProposal({
                    proposalKey: `${caseData.id}:pdf_form:SEND_PDF_EMAIL:1`,
                    caseId: caseData.id,
                    actionType: 'SEND_PDF_EMAIL',
                    reasoning: [
                        `Portal URL is not a real online form: ${reason}`,
                        'PDF form filled automatically — needs human to find agency email and send'
                    ],
                    confidence: 0.7,
                    requiresHuman: true,
                    canAutoExecute: false,
                    draftSubject: pdfResult.draftSubject,
                    draftBodyText: pdfResult.draftBodyText,
                    status: 'PENDING_APPROVAL'
                });
                await database.updateCaseStatus(caseData.id, 'needs_human_review', {
                    substatus: 'No real portal found — PDF form filled but no email address on file',
                    requires_human: true
                });
                await database.logActivity('pdf_form_fallback', `PDF form filled for case ${caseData.id} (no real portal, no email)`, {
                    case_id: caseData.id, portal_url: originalUrl,
                    attachment_id: pdfResult.attachmentId, pdf_url: pdfResult.pdfUrl
                });
                return { success: false, status: 'pdf_form_pending', error: reason, engine: 'research_fallback' };
            }
        } catch (pdfErr) {
            console.warn(`📄 PDF fallback failed for case ${caseData.id}:`, pdfErr.message);
            await database.logActivity('pdf_form_fallback_failed', `PDF fallback failed: ${pdfErr.message}`, {
                case_id: caseData.id, portal_url: originalUrl, error: pdfErr.message
            });
        }

        // Step 3: Both research and PDF failed — escalate to human
        await database.updateCaseStatus(caseData.id, 'needs_human_review', {
            substatus: `Not a real portal (${reason.substring(0, 60)}) — needs manual submission`,
            requires_human: true
        });
        return { success: false, status: 'not_real_portal', error: reason, engine: 'research_fallback' };
    }

    async _pollWorkflowRun(workflowRunId, caseId = null) {
        if (!workflowRunId) {
            return null;
        }
        const maxPolls = parseInt(process.env.SKYVERN_WORKFLOW_MAX_POLLS || '480', 10);
        const pollIntervalMs = parseInt(process.env.SKYVERN_WORKFLOW_POLL_INTERVAL_MS || '5000', 10);
        // Correct endpoint: /api/v1/workflows/{workflowId}/runs/{runId}
        const statusUrl = `${this.baseUrl}/workflows/${this.workflowId}/runs/${workflowRunId}`;

        console.log(`⏳ Polling workflow run ${workflowRunId} for completion...`);
        let lastScreenshotUrl = null;
        let screenshotIndex = 0; // tracks how many screenshots we've already logged

        for (let poll = 0; poll < maxPolls; poll++) {
            await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
            try {
                const statusResponse = await axios.get(statusUrl, {
                    headers: {
                        'x-api-key': this.apiKey
                    },
                    timeout: this.workflowHttpTimeout
                });

                const data = statusResponse.data;
                const status = (data.status || data.final_status || '').toLowerCase();
                console.log(`   Poll ${poll + 1}: status=${status || 'unknown'}`);

                // Extract latest screenshot and persist to DB for live view
                if (caseId && Array.isArray(data.screenshot_urls) && data.screenshot_urls.length > 0) {
                    const latestUrl = data.screenshot_urls[data.screenshot_urls.length - 1];
                    if (latestUrl && latestUrl !== lastScreenshotUrl) {
                        lastScreenshotUrl = latestUrl;
                        try {
                            await database.query(
                                'UPDATE cases SET last_portal_screenshot_url = $1 WHERE id = $2',
                                [latestUrl, caseId]
                            );
                        } catch (ssErr) {
                            console.warn(`   Screenshot DB update failed: ${ssErr.message}`);
                        }
                    }

                    // Log NEW screenshots to activity_log for history
                    const newScreenshots = data.screenshot_urls.slice(screenshotIndex);
                    for (let i = 0; i < newScreenshots.length; i++) {
                        try {
                            const logRow = await database.logActivity(
                                'portal_screenshot',
                                `Portal screenshot #${screenshotIndex + i + 1}`,
                                {
                                    case_id: caseId,
                                    url: newScreenshots[i],
                                    run_id: workflowRunId,
                                    sequence_index: screenshotIndex + i,
                                    skyvern_status: status
                                }
                            );

                            // Download from Skyvern and persist to our own storage
                            const storageService = require('./storage-service');
                            if (storageService.isConfigured() && logRow?.id) {
                                try {
                                    const imgResp = await axios.get(newScreenshots[i], { responseType: 'arraybuffer', timeout: 10000 });
                                    const buffer = Buffer.from(imgResp.data);
                                    const filename = `screenshot_${screenshotIndex + i}_${Date.now()}.png`;
                                    const { storageUrl } = await storageService.upload(caseId, `portal_${workflowRunId}`, filename, buffer, 'image/png');
                                    await database.query(
                                        `UPDATE activity_log SET metadata = metadata || $1::jsonb WHERE id = $2`,
                                        [JSON.stringify({ persistent_url: storageUrl }), logRow.id]
                                    );
                                    // Update live screenshot on the case with persistent URL
                                    if (i === newScreenshots.length - 1) {
                                        await database.query(
                                            'UPDATE cases SET last_portal_screenshot_url = $1 WHERE id = $2',
                                            [storageUrl, caseId]
                                        );
                                    }
                                } catch (persistErr) {
                                    console.warn(`   Screenshot persist failed: ${persistErr.message}`);
                                }
                            }
                        } catch (logErr) {
                            console.warn(`   Screenshot log failed: ${logErr.message}`);
                        }
                    }
                    screenshotIndex = data.screenshot_urls.length;
                }

                if (['completed', 'succeeded', 'success', 'failed', 'terminated', 'error'].includes(status)) {
                    return data;
                }
            } catch (pollError) {
                console.warn(`   Poll ${poll + 1}: error fetching workflow status - ${pollError.message}`);
            }
        }

        console.warn('⚠️ Workflow run polling timed out.');
        return null;
    }

    /**
     * Build navigation goal for LOGIN (existing account)
     */
    buildNavigationGoalWithLogin(caseData, existingAccount, dryRun) {
        return `You are filling out a FOIA (Freedom of Information Act) records request on a government portal.

INSTRUCTIONS:
1. LOG IN to the portal using these credentials:
   - Email: ${existingAccount.email}
   - Password: ${existingAccount.password}

   If you see a login form, enter these credentials and log in.

2. Once logged in, fill out the FOIA request form with ALL fields using the data provided in the navigation_payload

3. Key fields to look for and fill:
   - Requester name/contact information
   - Agency name
   - Request description/subject
   - Records being requested (detailed list)
   - Date range or incident information
   - Email for correspondence
   - Delivery format preference (electronic/email)
   - Fee waiver request (if available, request as press/media)

4. ${this._captchaInputRules()}

5. ${dryRun ? 'STOP before clicking the final submit button (this is a test/dry run)' : 'Complete the full submission by clicking the submit button'}

Be thorough and fill out every available field with the provided information. The goal is to create a complete, detailed FOIA request.`;
    }

    /**
     * Build navigation goal for ACCOUNT CREATION (new account)
     */
    buildNavigationGoalWithAccountCreation(caseData, dryRun, password, email) {
        return `You are preparing a FOIA portal account so we can submit a request in a later stage.

ACCOUNT SETUP GOAL:
1. Use the provided portal URL. If you see options like "Create Account" or "Register", create an account using:
   - Email: ${email}
   - Password: ${password}
   - IMPORTANT: use exactly this password for every portal.
   - If the portal says the account already exists, switch to the login page and sign in with the SAME email + password, then continue.
   - Fill in any other required profile fields (name, phone, security questions).

2. After the account is created or you log in, navigate until you reach the actual request submission form (the page where the form fields live). Do NOT submit the FOIA yet, but ensure the form is visible so we know the account is ready.

3. Capture the URL of the submission page and leave the browser on that page when you complete the task.

4. If the portal allows guest submissions without an account, skip account creation and go directly to the submission form, then stop on that page.

5. ${this._captchaInputRules()}

The stage is successful only when the request submission form is open and ready for future automation.`;
    }

    buildVerificationGoal(caseData, account, verificationCode) {
        return `You already created a portal account for ${account.email}.

VERIFICATION STAGE INSTRUCTIONS:
1. Navigate to the portal login or verification screen.
2. If prompted, request a verification code to be sent to ${account.email}.
3. Enter the verification code ${verificationCode ? `(${verificationCode})` : 'that was emailed to you'} to activate the account.
4. Once the portal confirms the account is verified or allows access to the request form, STOP.

5. ${this._captchaInputRules()}

If no verification is required, simply log in successfully and stop.`;
    }

    buildVerificationPayload(caseData, account, verificationCode) {
        return {
            case_id: caseData.id,
            email: account?.email,
            password: account?.password,
            verification_code: verificationCode,
            agency_name: caseData.agency_name,
            case_name: caseData.case_name
        };
    }

    _buildScoutNavigationGoal({ email, password }) {
        return `You are scouting a government FOIA portal to determine if an account is required and, if so, create one.

SCOUT INSTRUCTIONS:
1. Visit the portal URL. Look for any login page, "Create Account", "Register", or "Sign In" links.
2. If the portal requires an account to submit requests:
   a. Create an account using EXACTLY these credentials:
      - Email: ${email}
      - Password: ${password}
      - Name: Samuel Hylton
      - Phone: 209-800-7702
      - Address: 3021 21st Ave W, Apt 202, Seattle, WA 98199
   b. Fill in ALL required profile fields.
   c. If the portal says "email already exists" or "account already exists", that is fine — set account_already_existed=true.
3. If the portal does NOT require an account (e.g., guest/anonymous submissions allowed), set requires_account=false and stop immediately.
4. Do NOT fill out any FOIA request forms. Do NOT submit any records requests. Your ONLY job is account creation.

Use Set Extracted Information to return this JSON:
{
  "requires_account": boolean,
  "account_created": boolean,
  "account_already_existed": boolean,
  "verification_required": boolean,
  "portal_type": string,
  "login_url": string,
  "notes": string
}`;
    }

    _buildScoutNavigationPayload({ email, password }) {
        return {
            account_email: email,
            account_password: password,
            account_password_confirm: password,
            first_name: 'Samuel',
            last_name: 'Hylton',
            email: email,
            phone: '209-800-7702',
            phone_number: '209-800-7702',
            address: '3021 21st Ave W, Apt 202, Seattle, WA 98199',
            street_address: '3021 21st Ave W, Apt 202',
            city: 'Seattle',
            state_abbr: 'WA',
            zip: '98199',
            zip_code: '98199',
            organization: 'Dr Insanity / FOIA Request Team'
        };
    }

    buildNavigationGoalWithoutAccount(caseData, dryRun) {
        return `You are submitting a FOIA (Freedom of Information Act) request on a portal that supports guest submissions.

INSTRUCTIONS:
1. Proceed through the form without creating an account.
2. Fill every required field using the provided data.
3. ${dryRun ? 'Stop before the final submit button (dry run).' : 'Submit the request when finished.'}
`;
    }

    buildNavigationPayloadWithoutAccount(caseData) {
        return {
            // Requester Information (person making the FOIA request)
            email: process.env.REQUESTER_EMAIL || 'sam@foib-request.com',
            requester_name: 'Samuel Hylton',
            requester_email: process.env.REQUESTER_EMAIL || 'sam@foib-request.com',
            first_name: 'Samuel',
            last_name: 'Hylton',
            phone: '209-800-7702',
            phone_number: '209-800-7702',
            address: '3021 21st Ave W, Apt 202, Seattle, WA 98199',
            street_address: '3021 21st Ave W, Apt 202',
            city: 'Seattle',
            state_abbr: 'WA',
            zip: '98199',
            zip_code: '98199',

            // Case/Subject Information (the person involved in the case)
            case_name: caseData.case_name || 'Records Request',
            subject_name: caseData.subject_name || '',
            agency_name: caseData.agency_name || '',
            state: caseData.state || '',
            incident_date: caseData.incident_date || '',
            incident_location: caseData.incident_location || '',
            records_requested: caseData.requested_records || 'Body-worn camera footage, dashcam footage, incident reports, 911 calls, arrest reports, booking photos',
            request_description: caseData.additional_details || '',

            // Request preferences
            delivery_format: 'electronic',
            fee_waiver_requested: true,
            fee_waiver_reason: 'Request as member of press/media for public interest reporting'
        };
    }

    /**
     * Build navigation payload for LOGIN (existing account)
     */
    buildNavigationPayloadWithLogin(caseData, existingAccount) {
        return {
            // Login credentials
            login_email: existingAccount.email,
            login_password: existingAccount.password,

            // Requester Contact Information (person making the FOIA request)
            email: existingAccount.email,
            requester_name: 'Samuel Hylton',
            requester_email: existingAccount.email,
            first_name: 'Samuel',
            last_name: 'Hylton',
            phone: '209-800-7702',
            phone_number: '209-800-7702',
            address: '3021 21st Ave W, Apt 202, Seattle, WA 98199',
            street_address: '3021 21st Ave W, Apt 202',
            city: 'Seattle',
            state_abbr: 'WA',
            zip: '98199',
            zip_code: '98199',

            // Case/Subject Information (the person involved in the case)
            case_name: caseData.case_name || 'Records Request',
            subject_name: caseData.subject_name || '',
            agency_name: caseData.agency_name || '',
            state: caseData.state || '',
            incident_date: caseData.incident_date || '',
            incident_location: caseData.incident_location || '',

            // Request Details
            records_requested: caseData.requested_records || 'Body-worn camera footage, dashcam footage, incident reports, 911 calls, arrest reports, booking photos',
            request_description: caseData.additional_details || 'Requesting all records related to this incident including police reports, witness statements, forensic evidence, and any other relevant documentation.',

            // Request preferences
            delivery_format: 'electronic',
            fee_waiver_requested: true,
            fee_waiver_reason: 'Request as member of press/media for public interest reporting'
        };
    }

    /**
     * Build navigation payload for ACCOUNT CREATION (new account)
     */
    buildNavigationPayloadWithAccountCreation(caseData, password, email) {
        return {
            // Account Creation fields
            account_email: email,
            account_password: password,
            account_password_confirm: password,
            first_name: 'Samuel',
            last_name: 'Hylton',

            // Requester Contact Information (person making the FOIA request)
            email: email,
            requester_name: 'Samuel Hylton',
            requester_email: email,
            phone: '209-800-7702',
            phone_number: '209-800-7702',
            address: '3021 21st Ave W, Apt 202, Seattle, WA 98199',
            street_address: '3021 21st Ave W, Apt 202',
            city: 'Seattle',
            state_abbr: 'WA',
            zip: '98199',
            zip_code: '98199',

            // Case/Subject Information (the person involved in the case)
            case_name: caseData.case_name || 'Records Request',
            subject_name: caseData.subject_name || '',
            agency_name: caseData.agency_name || '',
            state: caseData.state || '',
            incident_date: caseData.incident_date || '',
            incident_location: caseData.incident_location || '',

            // Request Details
            records_requested: caseData.requested_records || 'Body-worn camera footage, dashcam footage, incident reports, 911 calls, arrest reports, booking photos',
            request_description: caseData.additional_details || 'Requesting all records related to this incident including police reports, witness statements, forensic evidence, and any other relevant documentation.',

            // Request preferences
            delivery_format: 'electronic',
            fee_waiver_requested: true,
            fee_waiver_reason: 'Request as member of press/media for public interest reporting'
        };
    }

    buildAccountStageGoal(caseData, { email, password, dryRun, hasExistingAccount, verificationCode }) {
        return `You are preparing the FOIA portal for ${caseData.case_name}.

ACCOUNT STAGE OBJECTIVE:
1. If an account already exists, log in with Email: ${email} and Password: ${password}. If not, create it with the same credentials.
2. Complete any profile fields (address, phone, etc.) using the provided data.
3. Solve CAPTCHAs if needed.
   ${this._captchaInputRules()}
4. Navigate to the "New Request" or submission form and stop there (do NOT submit yet).
5. Use Set Extracted Information with this schema:
{
  "login_success": boolean,
  "request_form_url": string,
  "submission_page_url": string,
  "verification_required": boolean,
  "verification_reason": string,
  "portal_provider": string
}

If the portal demands verification/MFA, request a code (a follow-up attempt will supply it) and set verification_required=true with the reason.` ;
    }

    buildAccountStagePayload(caseData, { email, password, contactInfo, verificationCode }) {
        return {
            credentials: {
                email,
                password,
                verification_code: verificationCode
            },
            contact_info: contactInfo,
            case_name: caseData.case_name,
            agency_name: caseData.agency_name,
            state: caseData.state || '',
            incident_date: caseData.incident_date || '',
            incident_location: caseData.incident_location || '',
            records_requested: Array.isArray(caseData.requested_records)
                ? caseData.requested_records
                : [caseData.requested_records].filter(Boolean)
        };
    }

    buildSubmissionStageGoal(caseData, { email, password, submissionUrl, dryRun }) {
        return `You already have an account for this portal.

SUBMISSION STAGE OBJECTIVE:
1. Go to ${submissionUrl || 'the portal request form'}.
2. Log in with Email: ${email} / Password: ${password} if prompted.
3. Fill out the request form completely using the provided payload.
4. ${this._captchaInputRules()}
5. ${dryRun ? 'Stop on the final review screen without submitting.' : 'Submit the request and capture confirmation details.'}
6. Use Set Extracted Information with this schema:
{
  "submission_status": string,
  "confirmation_number": string,
  "portal_ticket_url": string,
  "submission_page_url": string,
  "submission_timestamp": string
}` ;
    }

    buildSubmissionStagePayload(caseData, { email, password, contactInfo, submissionUrl, dryRun }) {
        return {
            credentials: {
                email,
                password
            },
            submission_url: submissionUrl,
            contact_info: contactInfo,
            requester: {
                name: 'Samuel Hylton',
                email,
                phone: contactInfo.phone,
                title: 'Documentary Researcher'
            },
            incident: {
                state: caseData.state || '',
                date: caseData.incident_date || '',
                location: caseData.incident_location || '',
                description: caseData.additional_details || ''
            },
            records: Array.isArray(caseData.requested_records) && caseData.requested_records.length
                ? caseData.requested_records
                : ['Body-worn camera footage', 'Dash camera footage', 'Incident reports', '911 audio'],
            delivery_format: 'electronic',
            dry_run: dryRun,
            fee_waiver: {
                requested: true,
                reason: 'Non-commercial documentary / public interest'
            }
        };
    }

    buildStandardContactInfo(caseData) {
        return {
            phone: caseData.requester_phone || process.env.REQUESTER_PHONE || '206-555-0198',
            address1: caseData.requester_address || process.env.REQUESTER_ADDRESS || '3021 21st Ave W Apt 202',
            city: caseData.requester_city || process.env.REQUESTER_CITY || 'Seattle',
            state: caseData.requester_state || process.env.REQUESTER_STATE || 'WA',
            zip: caseData.requester_zip || process.env.REQUESTER_ZIP || '98199'
        };
    }


    /**
     * Get task status (for polling)
     */
    async getTaskStatus(taskId) {
        const response = await axios.get(
            `${this.baseUrl}/tasks/${taskId}`,
            {
                headers: {
                    'x-api-key': this.apiKey
                }
            }
        );
        return response.data;
    }

    async checkPortalStatus(caseData, portalUrl, options = {}) {
        const { maxSteps = 20 } = options;

        if (!this.apiKey) {
            throw new Error('SKYVERN_API_KEY not set! Get your key from https://app.skyvern.com');
        }

        const userId = caseData.user_id || null;
        const account = await database.getPortalAccountByUrl(portalUrl, userId);
        if (!account) {
            throw new Error('No saved portal account found for this portal');
        }
        await database.updatePortalAccountLastUsed(account.id);

        console.log(`🤖 Skyvern status check for case: ${caseData.case_name}`);
        console.log(`   Portal: ${portalUrl}`);

        const navigationGoal = this.buildStatusCheckGoal(caseData, account);
        const navigationPayload = this.buildNavigationPayloadWithLogin(caseData, account);

        const { finalTask, taskId } = await this._createTaskAndPoll({
            portalUrl,
            navigationGoal,
            navigationPayload,
            maxSteps
        });

        if (finalTask.status !== 'completed') {
            return {
                success: false,
                error: finalTask.failure_reason || `Task ended with status: ${finalTask.status}`,
                taskId,
                recording_url: finalTask.recording_url || `https://app.skyvern.com/tasks/${taskId}`,
                extracted_data: finalTask.extracted_information
            };
        }

        const extracted = finalTask.extracted_information || {};
        const statusText = extracted.status || extracted.status_text || extracted.summary || null;
        const dueDate = extracted.due_date || extracted.deadline || null;
        const submissionUrl = extracted.request_form_url || extracted.form_url || extracted.page_url || finalTask.last_url || null;

        if (submissionUrl) {
            await database.updateCasePortalStatus(caseData.id, {
                last_portal_task_url: submissionUrl
            });
        }

        return {
            success: true,
            taskId,
            recording_url: finalTask.recording_url || `https://app.skyvern.com/tasks/${taskId}`,
            extracted_data: extracted,
            statusText,
            dueDate,
            submissionUrl,
            raw: finalTask,
            accountEmail: account.email
        };
    }

    buildStatusCheckGoal(caseData, account) {
        return `You are checking the status of a FOIA records request in an online portal.

INSTRUCTIONS:
1. Log in using the provided email (${account.email}) and password.
2. Navigate to the section that lists outstanding or submitted requests (e.g., "My Request Center").
3. Locate the request associated with "${caseData.case_name}" or the most recent request.
4. Record the request status, any due dates, last update timestamps, and summary notes.
5. Use the "Set Extracted Information" tool to return a JSON object with keys:
   - status_text
   - status_detail
   - status_updated_at
   - due_date
   - portal_link
6. ${this._captchaInputRules()}
7. Do NOT submit or create any new requests. This is read-only status checking.`;
    }
}

module.exports = new PortalAgentServiceSkyvern();
