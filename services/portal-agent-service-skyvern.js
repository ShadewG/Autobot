const axios = require('axios');

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
     * Submit to portal using Skyvern
     */
    async submitToPortal(caseData, portalUrl, options = {}) {
        const { maxSteps = 25, dryRun = false } = options;

        if (!this.apiKey) {
            throw new Error('SKYVERN_API_KEY not set! Get your key from https://app.skyvern.com');
        }

        try {
            console.log(`🤖 Starting Skyvern agent for case: ${caseData.case_name}`);
            console.log(`   Portal: ${portalUrl}`);
            console.log(`   Max steps: ${maxSteps}`);
            console.log(`   Dry run: ${dryRun}`);
            console.log(`   API: ${this.baseUrl}`);

            // Build navigation goal
            const navigationGoal = this.buildNavigationGoal(caseData, dryRun);

            // Build navigation payload (data to fill in)
            const navigationPayload = this.buildNavigationPayload(caseData);

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
                return {
                    success: true,
                    caseId: caseData.id,
                    portalUrl: portalUrl,
                    taskId: taskId,
                    status: finalTask.status,
                    recording_url: finalTask.recording_url || `https://app.skyvern.com/tasks/${taskId}`,
                    extracted_data: finalTask.extracted_information,
                    steps: finalTask.actions?.length || finalTask.steps || 0,
                    dryRun
                };
            } else if (finalTask.status === 'failed') {
                return {
                    success: false,
                    error: finalTask.failure_reason || 'Task failed',
                    taskId: taskId,
                    recording_url: finalTask.recording_url || `https://app.skyvern.com/tasks/${taskId}`,
                    steps: finalTask.actions?.length || finalTask.steps || 0
                };
            } else {
                // Task still running or other status
                return {
                    success: false,
                    error: `Task ended with status: ${finalTask.status}`,
                    taskId: taskId,
                    status: finalTask.status,
                    recording_url: finalTask.recording_url || `https://app.skyvern.com/tasks/${taskId}`
                };
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

            return {
                success: false,
                error: errorMessage
            };
        }
    }

    /**
     * Build navigation goal (natural language instructions)
     */
    buildNavigationGoal(caseData, dryRun) {
        const email = process.env.REQUESTS_INBOX || 'requests@foib-request.com';

        return `You are filling out a FOIA (Freedom of Information Act) records request on a government portal.

INSTRUCTIONS:
1. If the portal requires account creation or login:
   - Create a new account using the email: ${email}
   - Generate a secure password
   - Fill in any required account information
   - Complete any email verification if needed

2. Once on the request form, fill out ALL fields using the data provided in the navigation_payload

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
     * Build navigation payload (structured data for form filling)
     */
    buildNavigationPayload(caseData) {
        const email = process.env.REQUESTS_INBOX || 'requests@foib-request.com';

        return {
            // Contact Information
            email: email,
            requester_name: caseData.subject_name || 'Samuel Hylton',
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
