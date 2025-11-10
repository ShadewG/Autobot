const axios = require('axios');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const database = require('./database');

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
    }

    /**
     * Generate a secure password for new accounts
     */
    _generateSecurePassword() {
        const length = 16;
        const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*';
        let password = '';
        const randomBytes = crypto.randomBytes(length);
        for (let i = 0; i < length; i++) {
            password += chars[randomBytes[i] % chars.length];
        }
        return password;
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

            // Check if we have existing portal credentials
            console.log(`\n🔍 Checking for existing portal account...`);
            const existingAccount = await database.getPortalAccountByUrl(portalUrl);

            let navigationGoal, navigationPayload, accountPassword;

            if (existingAccount) {
                console.log(`✅ Found existing account: ${existingAccount.email}`);
                console.log(`   Account ID: ${existingAccount.id}`);
                console.log(`   Last used: ${existingAccount.last_used_at || 'Never'}`);

                // Build instructions to LOG IN with existing credentials
                navigationGoal = this.buildNavigationGoalWithLogin(caseData, existingAccount, dryRun);
                navigationPayload = this.buildNavigationPayloadWithLogin(caseData, existingAccount);
                accountPassword = null; // We're not creating a new account

                // Update last used timestamp
                await database.updatePortalAccountLastUsed(existingAccount.id);
            } else {
                console.log(`❌ No existing account found - will create new account`);

                // Generate a password that we'll tell Skyvern to use
                accountPassword = this._generateSecurePassword();
                console.log(`   Generated password for new account`);

                // Build instructions to CREATE ACCOUNT
                navigationGoal = this.buildNavigationGoalWithAccountCreation(caseData, dryRun, accountPassword);
                navigationPayload = this.buildNavigationPayloadWithAccountCreation(caseData, accountPassword);
            }

            console.log(`\n📝 Navigation Goal:\n${navigationGoal}\n`);
            console.log(`⏳ Creating task...\n`);

            // Create task via Skyvern API
            const response = await axios.post(
                `${this.baseUrl}/tasks`,
                {
                    url: portalUrl,
                    navigation_goal: navigationGoal,
                    navigation_payload: navigationPayload,
                    max_steps_override: maxSteps,
                    engine: 'skyvern-2.0'  // Use latest engine
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

            // Log full response for debugging
            console.log(`\n📊 Full API Response:`);
            console.log(JSON.stringify(task, null, 2));

            // Task is async - need to poll for completion
            const taskId = task.task_id || task.id;
            if (!taskId) {
                throw new Error('No task ID returned from API');
            }

            console.log(`\n⏳ Polling for task completion (max 10 minutes)...`);

            const maxPolls = 120; // 10 minutes (5 seconds per poll)
            let polls = 0;
            let finalTask = null;

            while (polls < maxPolls) {
                await new Promise(resolve => setTimeout(resolve, 5000)); // Wait 5 seconds
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

            // Check if task completed successfully
            if (finalTask.status === 'completed') {
                // If we created a new account, save credentials to database
                if (!existingAccount && accountPassword) {
                    console.log(`\n💾 Saving new portal account credentials...`);
                    try {
                        const email = process.env.REQUESTS_INBOX || 'requests@foib-request.com';
                        const savedAccount = await database.createPortalAccount({
                            portal_url: portalUrl,
                            email: email,
                            password: accountPassword,
                            first_name: caseData.subject_name ? caseData.subject_name.split(' ')[0] : 'FOIB',
                            last_name: caseData.subject_name ? caseData.subject_name.split(' ').slice(1).join(' ') : 'Request',
                            portal_type: 'Auto-detected',
                            additional_info: {
                                case_id: caseData.id,
                                created_by_task: taskId
                            }
                        });
                        console.log(`   ✅ Saved account ID: ${savedAccount.id}`);
                    } catch (saveError) {
                        console.error(`   ⚠️  Failed to save account: ${saveError.message}`);
                        // Continue anyway - don't fail the whole task
                    }
                }

                const result = {
                    success: true,
                    caseId: caseData.id,
                    portalUrl: portalUrl,
                    taskId: taskId,
                    status: finalTask.status,
                    recording_url: finalTask.recording_url || `https://app.skyvern.com/tasks/${taskId}`,
                    extracted_data: finalTask.extracted_information,
                    steps: finalTask.actions?.length || finalTask.steps || 0,
                    dryRun,
                    usedExistingAccount: !!existingAccount,
                    savedNewAccount: !existingAccount && !!accountPassword,
                    runId
                };

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
                        recording_url: result.recording_url,
                        steps_completed: result.steps
                    }
                );

                return result;
            } else if (finalTask.status === 'failed') {
                const result = {
                    success: false,
                    error: finalTask.failure_reason || 'Task failed',
                    taskId: taskId,
                    recording_url: finalTask.recording_url || `https://app.skyvern.com/tasks/${taskId}`,
                    steps: finalTask.actions?.length || finalTask.steps || 0,
                    runId
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
                        recording_url: result.recording_url,
                        steps_completed: result.steps,
                        error: result.error
                    }
                );

                return result;
            } else {
                // Task still running or other status
                const result = {
                    success: false,
                    error: `Task ended with status: ${finalTask.status}`,
                    taskId: taskId,
                    status: finalTask.status,
                    recording_url: finalTask.recording_url || `https://app.skyvern.com/tasks/${taskId}`,
                    runId
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
    buildNavigationGoalWithAccountCreation(caseData, dryRun, password) {
        const email = process.env.REQUESTS_INBOX || 'requests@foib-request.com';

        return `You are filling out a FOIA (Freedom of Information Act) records request on a government portal.

INSTRUCTIONS:
1. CREATE A NEW ACCOUNT on the portal:
   - Email: ${email}
   - Password: ${password}
   - IMPORTANT: Use exactly this password: ${password}
   - Fill in any required account information (name, state, etc.)
   - Complete any email verification if needed

2. Once the account is created and you're logged in, fill out the FOIA request form with ALL fields using the data provided in the navigation_payload

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
     * Build navigation payload for LOGIN (existing account)
     */
    buildNavigationPayloadWithLogin(caseData, existingAccount) {
        return {
            // Login credentials
            login_email: existingAccount.email,
            login_password: existingAccount.password,

            // Contact Information
            email: existingAccount.email,
            requester_name: caseData.subject_name || existingAccount.first_name + ' ' + existingAccount.last_name,
            requester_email: existingAccount.email,

            // Case Information
            case_name: caseData.case_name || 'Records Request',
            subject_name: caseData.subject_name || '',
            agency_name: caseData.agency_name || '',

            // Location & Date
            state: caseData.state || '',
            incident_date: caseData.incident_date || '',
            incident_location: caseData.incident_location || '',

            // Request Details
            records_requested: caseData.requested_records || 'Body-worn camera footage, dashcam footage, incident reports, 911 calls, arrest reports, booking photos',
            request_description: caseData.additional_details || 'Requesting all records related to this incident including police reports, witness statements, forensic evidence, and any other relevant documentation.',

            // Additional fields
            delivery_format: 'electronic',
            fee_waiver_requested: true,
            fee_waiver_reason: 'Request as member of press/media for public interest reporting'
        };
    }

    /**
     * Build navigation payload for ACCOUNT CREATION (new account)
     */
    buildNavigationPayloadWithAccountCreation(caseData, password) {
        const email = process.env.REQUESTS_INBOX || 'requests@foib-request.com';

        return {
            // Account Creation fields
            account_email: email,
            account_password: password,
            account_password_confirm: password,
            first_name: caseData.subject_name ? caseData.subject_name.split(' ')[0] : 'FOIB',
            last_name: caseData.subject_name ? caseData.subject_name.split(' ').slice(1).join(' ') : 'Request',

            // Contact Information
            email: email,
            requester_name: caseData.subject_name || 'FOIB Request',
            requester_email: email,

            // Case Information
            case_name: caseData.case_name || 'Records Request',
            subject_name: caseData.subject_name || '',
            agency_name: caseData.agency_name || '',

            // Location & Date
            state: caseData.state || '',
            incident_date: caseData.incident_date || '',
            incident_location: caseData.incident_location || '',

            // Request Details
            records_requested: caseData.requested_records || 'Body-worn camera footage, dashcam footage, incident reports, 911 calls, arrest reports, booking photos',
            request_description: caseData.additional_details || 'Requesting all records related to this incident including police reports, witness statements, forensic evidence, and any other relevant documentation.',

            // Additional fields
            delivery_format: 'electronic',
            fee_waiver_requested: true,
            fee_waiver_reason: 'Request as member of press/media for public interest reporting'
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
}

module.exports = new PortalAgentServiceSkyvern();
