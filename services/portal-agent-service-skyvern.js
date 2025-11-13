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

        console.log(`\n⏳ Polling for task completion (max 40 minutes)...`);

        const maxPolls = 480; // 480 polls * 5 seconds = 40 minutes
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
            await database.updateCasePortalStatus(caseData.id, {
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
            });

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
                    confirmation_number: extracted.confirmation_number || null
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

        return {
            success: false,
            result: {
                success: false,
                error: finalTask.failure_reason || `Task ended with status ${finalTask.status}`,
                taskId,
                recording_url: finalTask.recording_url || failureTaskUrl,
                extracted_data: extracted
            }
        };
    }

    /**
     * Generate a secure password for new accounts
     */
    _generateSecurePassword() {
        return process.env.PORTAL_DEFAULT_PASSWORD || 'Insanity!0M';
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
            let accountPassword = existingAccount?.password || 'Insanity!0M';
            const hadExistingAccount = !!existingAccount;

            if (hadExistingAccount) {
                await database.updatePortalAccountLastUsed(existingAccount.id);
            }

            const contactInfo = this.buildStandardContactInfo(caseData);

            const accountStage = await this._runAccountStage({
                caseData,
                portalUrl,
                accountEmail: accountEmailUsed,
                accountPassword,
                contactInfo,
                existingAccount,
                dryRun,
                maxSteps,
                runId
            });

            if (!accountStage.success) {
                return accountStage.result;
            }

            if (!hadExistingAccount) {
                await this._persistNewPortalAccount({
                    caseData,
                    portalUrl,
                    taskId: accountStage.taskId,
                    email: accountEmailUsed,
                    password: accountPassword
                });
            }

            const submissionUrl = accountStage.requestFormUrl || caseData.last_portal_task_url || portalUrl;
            const portalProvider = existingAccount?.portal_type || accountStage.extracted?.portal_provider || 'Auto-detected';

            await database.updateCasePortalStatus(caseData.id, {
                portal_url: portalUrl,
                portal_provider: portalProvider,
                last_portal_task_url: submissionUrl,
                last_portal_details: JSON.stringify(accountStage.extracted || {})
            });

            const submissionStage = await this._runSubmissionStage({
                caseData,
                portalUrl,
                accountEmail: accountEmailUsed,
                accountPassword,
                contactInfo,
                submissionUrl,
                dryRun,
                maxSteps,
                runId,
                portalProvider
            });

            return submissionStage.result;
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

    buildAccountStageGoal(caseData, { email, password, dryRun, hasExistingAccount, verificationCode }) {
        return `You are preparing the FOIA portal for ${caseData.case_name}.

ACCOUNT STAGE OBJECTIVE:
1. If an account already exists, log in with Email: ${email} and Password: ${password}. If not, create it with the same credentials.
2. Complete any profile fields (address, phone, etc.) using the provided data.
3. Solve CAPTCHAs if needed.
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
4. ${dryRun ? 'Stop on the final review screen without submitting.' : 'Submit the request and capture confirmation details.'}
5. Use Set Extracted Information with this schema:
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
            state: caseData.requester_state || process.env.REQUESTER_STATE || caseData.state || 'WA',
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
