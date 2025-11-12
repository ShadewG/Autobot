const axios = require('axios');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const database = require('./database');
const EmailVerificationHelper = require('../agentkit/email-helper');

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
        this.emailHelper = new EmailVerificationHelper({
            inboxAddress: process.env.REQUESTS_INBOX || 'requests@foib-request.com'
        });
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

    async _persistNewPortalAccount({ caseData, portalUrl, taskId, email, password }) {
        if (!email || !password) {
            return;
        }

        console.log(`\n💾 Saving new portal account credentials...`);
        try {
            const savedAccount = await database.createPortalAccount({
                portal_url: portalUrl,
                email,
                password,
                first_name: caseData.subject_name ? caseData.subject_name.split(' ')[0] : 'FOIB',
                last_name: caseData.subject_name ? caseData.subject_name.split(' ').slice(1).join(' ') : 'Request',
                portal_type: 'Auto-detected',
                additional_info: {
                    case_id: caseData.id,
                    created_by_task: taskId
                }
            });
            console.log(`   ✅ Saved account ID: ${savedAccount.id}`);
        } catch (error) {
            console.error(`   ⚠️  Failed to save account: ${error.message}`);
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

    async _maybeFetchVerificationCode(portalUrl) {
        const pattern = process.env.PORTAL_VERIFICATION_REGEX || '(\\d{4,8})';
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

    _formatStageLabel(stage) {
        return stage.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
    }

    async _createTaskAndPoll({ portalUrl, navigationGoal, navigationPayload, maxSteps }) {
        console.log(`\n📝 Navigation Goal:\n${navigationGoal}\n`);
        console.log(`⏳ Creating task...\n`);

        const response = await axios.post(
            `${this.baseUrl}/tasks`,
            {
                url: portalUrl,
                navigation_goal: navigationGoal,
                navigation_payload: navigationPayload,
                max_steps_override: maxSteps,
                engine: 'skyvern-2.0'
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

        console.log(`\n⏳ Polling for task completion (max 10 minutes)...`);

        const maxPolls = 120;
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

    /**
     * Generate a secure password for new accounts
     */
    _generateSecurePassword() {
        // Use consistent password for all portal accounts
        return 'Insanity!0M';
    }

    /**
     * Submit to portal using Skyvern
     */
    async submitToPortal(caseData, portalUrl, options = {}) {
        const { maxSteps = 25, dryRun = false } = options;

        if (!this.apiKey) {
            throw new Error('SKYVERN_API_KEY not set! Get your key from https://app.skyvern.com');
        }

        const runId = uuidv4();
        const defaultPortalEmail = process.env.REQUESTS_INBOX || 'requests@foib-request.com';

        try {
            console.log(`🤖 Starting Skyvern agent for case: ${caseData.case_name}`);
            console.log(`   Portal: ${portalUrl}`);
            console.log(`   Max steps: ${maxSteps}`);
            console.log(`   Dry run: ${dryRun}`);
            console.log(`   API: ${this.baseUrl}`);

            await database.logActivity(
                'portal_run_started',
                `Skyvern portal automation started for ${caseData.case_name}`,
                {
                    case_id: caseData.id || null,
                    portal_url: portalUrl,
                    dry_run: dryRun,
                    max_steps: maxSteps,
                    run_id: runId,
                    engine: 'skyvern'
                }
            );

            console.log(`\n🔍 Checking for existing portal account...`);
            let existingAccount = await database.getPortalAccountByUrl(portalUrl);
            let accountEmailUsed = existingAccount?.email || defaultPortalEmail;
            let accountPassword = existingAccount?.password || this._generateSecurePassword();
            const hadExistingAccount = !!existingAccount;

            if (hadExistingAccount) {
                await database.updatePortalAccountLastUsed(existingAccount.id);
            }

            const navigationGoal = this.buildUnifiedNavigationGoal(caseData, {
                dryRun,
                email: accountEmailUsed,
                password: accountPassword,
                hasExistingAccount: hadExistingAccount
            });

            const navigationPayload = this.buildUnifiedNavigationPayload(caseData, {
                email: accountEmailUsed,
                password: accountPassword,
                dryRun
            });

            const submissionTask = await this._runPortalStage({
                stage: 'account_login_submission',
                caseData,
                portalUrl,
                navigationGoal,
                navigationPayload,
                maxSteps
            });

            if (!submissionTask.success) {
                return submissionTask.result;
            }

            const finalTask = submissionTask.finalTask;
            const taskId = submissionTask.taskId;
            const extracted = finalTask.extracted_information || {};
            const submissionUrl = extracted.submission_page_url || extracted.request_form_url || finalTask.last_url || null;

            if (finalTask.status === 'completed') {
                if (!hadExistingAccount) {
                    await this._persistNewPortalAccount({
                        caseData,
                        portalUrl,
                        taskId,
                        email: accountEmailUsed,
                        password: accountPassword
                    });
                }

                const taskUrl = `https://app.skyvern.com/tasks/${taskId}`;
                const actionHistory = finalTask.actions || finalTask.action_history || [];

                const result = {
                    success: true,
                    caseId: caseData.id,
                    portalUrl: portalUrl,
                    taskId: taskId,
                    status: finalTask.status,
                    recording_url: finalTask.recording_url || taskUrl,
                    extracted_data: extracted,
                    steps: actionHistory.length || finalTask.steps || 0,
                    dryRun,
                    usedExistingAccount: hadExistingAccount,
                    savedNewAccount: !hadExistingAccount,
                    runId
                };

                await database.updateCasePortalStatus(caseData.id, {
                    portal_url: portalUrl,
                    portal_provider: extracted.portal_provider || existingAccount?.portal_type || 'Auto-detected',
                    last_portal_run_id: taskId,
                    last_portal_engine: 'skyvern',
                    last_portal_task_url: submissionUrl || taskUrl,
                    last_portal_recording_url: result.recording_url,
                    last_portal_account_email: accountEmailUsed,
                    last_portal_details: JSON.stringify({
                        submission_status: extracted.submission_status || finalTask.status,
                        confirmation_number: extracted.confirmation_number || null,
                        portal_ticket_url: extracted.portal_ticket_url || null,
                        submission_timestamp: extracted.submission_timestamp || null,
                        request_form_url: extracted.request_form_url || null,
                        action_history: actionHistory.slice(-50)
                    })
                });

                await database.logActivity(
                    'portal_run_completed',
                    `Skyvern portal automation completed for ${caseData.case_name}`,
                    {
                        case_id: caseData.id || null,
                        portal_url: portalUrl,
                        dry_run: dryRun,
                        max_steps: maxSteps,
                        run_id: runId,
                        engine: 'skyvern',
                        task_id: taskId,
                        task_url: taskUrl,
                        recording_url: result.recording_url,
                        steps_completed: result.steps,
                        submission_status: extracted.submission_status || finalTask.status,
                        confirmation_number: extracted.confirmation_number || null
                    }
                );

                return result;
            } else if (finalTask.status === 'failed') {
                const failureTaskUrl = taskId ? `https://app.skyvern.com/tasks/${taskId}` : null;
                const result = {
                    success: false,
                    error: finalTask.failure_reason || 'Task failed',
                    taskId: taskId,
                    recording_url: finalTask.recording_url || failureTaskUrl,
                    steps: finalTask.actions?.length || finalTask.steps || 0,
                    runId,
                    extracted_data: extracted
                };

                await database.logActivity(
                    'portal_run_failed',
                    `Skyvern portal automation failed for ${caseData.case_name}: ${result.error}`,
                    {
                        case_id: caseData.id || null,
                        portal_url: portalUrl,
                        dry_run: dryRun,
                        max_steps: maxSteps,
                        run_id: runId,
                        engine: 'skyvern',
                        task_id: taskId,
                        task_url: failureTaskUrl,
                        recording_url: result.recording_url,
                        steps_completed: result.steps,
                        error: result.error
                    }
                );

                return result;
            } else {
                const taskUrlFallback = taskId ? `https://app.skyvern.com/tasks/${taskId}` : null;
                const result = {
                    success: false,
                    error: `Task ended with status: ${finalTask.status}`,
                    taskId: taskId,
                    status: finalTask.status,
                    recording_url: finalTask.recording_url || taskUrlFallback,
                    runId,
                    extracted_data: extracted
                };

                await database.logActivity(
                    'portal_run_failed',
                    `Skyvern portal automation ended with status ${finalTask.status} for ${caseData.case_name}`,
                    {
                        case_id: caseData.id || null,
                        portal_url: portalUrl,
                        dry_run: dryRun,
                        max_steps: maxSteps,
                        run_id: runId,
                        engine: 'skyvern',
                        task_id: taskId,
                        task_url: taskUrlFallback,
                        recording_url: result.recording_url,
                        error: result.error
                    }
                );

                return result;
            }
        } catch (error) {
            console.error('❌ Skyvern agent failed:', error.message);

            // Extract more details from error response
            let errorMessage = error.message;
            if (error.response) {
                errorMessage = error.response.data?.message || error.response.data?.error || error.message;
                console.error(`   Status: ${error.response.status}`);
                console.error(`   Details: ${JSON.stringify(error.response.data, null, 2)}`);
            }

            const result = {
                success: false,
                error: errorMessage,
                runId
            };

            await database.logActivity(
                'portal_run_failed',
                `Skyvern portal automation crashed for ${caseData.case_name}: ${errorMessage}`,
                {
                    case_id: caseData.id || null,
                    portal_url: portalUrl,
                    dry_run: dryRun,
                    max_steps: maxSteps,
                    run_id: runId,
                    engine: 'skyvern',
                    task_url: null,
                    error: errorMessage
                }
            );

            return result;
        }
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

4. ${dryRun ? 'STOP before clicking the final submit button (this is a test/dry run)' : 'Complete the full submission by clicking the submit button'}

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

The stage is successful only when the request submission form is open and ready for future automation.`;
    }

    buildVerificationGoal(caseData, account, verificationCode) {
        return `You already created a portal account for ${account.email}.

VERIFICATION STAGE INSTRUCTIONS:
1. Navigate to the portal login or verification screen.
2. If prompted, request a verification code to be sent to ${account.email}.
3. Enter the verification code ${verificationCode ? `(${verificationCode})` : 'that was emailed to you'} to activate the account.
4. Once the portal confirms the account is verified or allows access to the request form, STOP.

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
            email: process.env.REQUESTS_INBOX || 'requests@foib-request.com',
            requester_name: 'Samuel Hylton',
            requester_email: process.env.REQUESTS_INBOX || 'requests@foib-request.com',
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

    buildUnifiedNavigationGoal(caseData, { dryRun, email, password, hasExistingAccount }) {
        return `You are an autonomous browser agent that must complete the entire FOIA portal workflow end-to-end.

MISSION:
1. If needed, create an account using:
   - Email: ${email}
   - Password: ${password}
   (Use exactly these credentials so we can log in later.)
2. Log in and navigate to the request submission form.
3. Fill the form using the payload data (incident info, records requested, narrative).
4. ${dryRun ? 'Stop on the final review page (do NOT click submit).' : 'Submit the request and capture the confirmation number/status.'}
5. Use the Set Extracted Information tool once you reach each milestone. The JSON must include:
{
  "login_success": boolean,
  "request_form_url": string,
  "submission_page_url": string,
  "submission_status": string,
  "confirmation_number": string,
  "portal_ticket_url": string,
  "verification_required": boolean,
  "verification_reason": string,
  "submission_timestamp": string (ISO8601)
}

VERIFICATION:
- If the portal emails a verification or MFA code, trigger ACTION: wait_for_email_code with TARGET JSON (pattern, timeout, sender) to read the code and proceed within the same task.
- Only set verification_required=true if you cannot continue even after requesting a code.

RULES:
- Always leave the browser on the submission page (or confirmation page) when complete.
- Capture any reference numbers shown on screen.
- Be explicit in action history; explain when you create accounts or enter codes.
- If the portal supports guest submissions, skip account creation but still populate and submit the form.
- If submission truly cannot finish, set submission_status to a clear error reason and stop.`;
    }

    buildUnifiedNavigationPayload(caseData, { email, password, verificationCode, dryRun }) {
        return {
            credentials: {
                email,
                password,
                verification_code: verificationCode || null,
                has_existing_account: verificationCode ? true : undefined
            },
            requester: {
                name: caseData.subject_name || 'FOIA Requester',
                email,
                phone: caseData.requester_phone || null,
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
            agency_name: caseData.agency_name || '',
            case_name: caseData.case_name || 'Records Request',
            dry_run: dryRun,
            delivery_format: 'electronic',
            fee_waiver: {
                requested: true,
                reason: 'Non-commercial documentary / public interest reporting'
            }
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

        const account = await database.getPortalAccountByUrl(portalUrl);
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
6. Do NOT submit or create any new requests. This is read-only status checking.`;
    }
}

module.exports = new PortalAgentServiceSkyvern();
