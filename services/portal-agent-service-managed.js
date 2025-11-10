const { Hyperbrowser } = require('@hyperbrowser/sdk');

/**
 * Portal Agent using Hyperbrowser's Managed Claude Computer Use
 *
 * This uses Hyperbrowser's built-in Claude Computer Use agent instead of
 * manually managing the agent loop. Much simpler!
 */
class PortalAgentServiceManaged {
    constructor() {
        this.hyperbrowser = new Hyperbrowser({
            apiKey: process.env.HYPERBROWSER_API_KEY
        });
    }

    /**
     * Submit to portal using Hyperbrowser's managed Claude agent
     */
    async submitToPortal(caseData, portalUrl, options = {}) {
        const { maxSteps = 50, dryRun = false, llm = 'claude-haiku-4-5-20251001' } = options;

        try {
            console.log(`🤖 Starting Hyperbrowser managed agent for case: ${caseData.case_name}`);
            console.log(`   Portal: ${portalUrl}`);
            console.log(`   Model: ${llm}`);
            console.log(`   Max steps: ${maxSteps}`);
            console.log(`   Dry run: ${dryRun}`);

            // Build natural language task description
            const task = this.buildTaskDescription(caseData, portalUrl, dryRun);

            console.log(`\n📝 Task Description:\n${task}\n`);
            console.log(`⏳ Starting agent... (this may take a minute)\n`);

            // Use Hyperbrowser's built-in Claude Computer Use agent
            const result = await this.hyperbrowser.agents.claudeComputerUse.startAndWait({
                task: task,
                llm: llm,
                maxSteps: maxSteps,
                useCustomApiKeys: true,
                apiKeys: {
                    anthropic: process.env.ANTHROPIC_API_KEY
                },
                sessionOptions: {
                    acceptCookies: true
                }
            });

            console.log(`\n✅ Agent completed!`);
            console.log(`   Status: ${result.status}`);
            console.log(`   Steps taken: ${result.data?.steps?.length || 0}`);

            if (result.status === 'completed') {
                return {
                    success: true,
                    caseId: caseData.id,
                    portalUrl: portalUrl,
                    stepsCompleted: result.data?.steps?.length || 0,
                    finalResult: result.data?.finalResult,
                    jobId: result.jobId,
                    liveUrl: result.liveUrl,
                    steps: result.data?.steps || [],
                    dryRun
                };
            } else {
                return {
                    success: false,
                    error: result.error || 'Agent failed to complete task',
                    jobId: result.jobId,
                    liveUrl: result.liveUrl,
                    steps: result.data?.steps || []
                };
            }

        } catch (error) {
            console.error('❌ Portal agent failed:', error);

            return {
                success: false,
                error: error.message
            };
        }
    }

    /**
     * Build natural language task description for Claude
     */
    buildTaskDescription(caseData, portalUrl, dryRun) {
        const email = process.env.REQUESTS_INBOX || 'requests@foib-request.com';

        return `You are filling out a FOIA (Freedom of Information Act) records request on a government portal.

PORTAL URL:
${portalUrl}

YOUR TASK:
1. Navigate to the portal
2. If you need to create an account, do so using:
   - Email: ${email}
   - Create a secure password
   - Fill in any required account information
3. If you need to verify your email, wait for the verification email and use the code
4. Once logged in (or if no login required), fill out the records request form with the information below
5. ${dryRun ? 'STOP before clicking the final submit button (this is a test)' : 'Submit the request'}

REQUEST INFORMATION:
- Requester Name: ${caseData.subject_name || 'Samuel Hylton'}
- Case Name: ${caseData.case_name || 'Records Request'}
- Agency: ${caseData.agency_name || 'Unknown Agency'}
- State: ${caseData.state || 'Unknown'}
- Incident Date: ${caseData.incident_date || 'Unknown'}
- Incident Location: ${caseData.incident_location || 'Unknown'}
- Email for correspondence: ${email}

RECORDS BEING REQUESTED:
${caseData.requested_records || 'Body-worn camera footage, dashcam footage, incident reports, 911 calls, arrest reports, booking photos'}

ADDITIONAL DETAILS:
${caseData.additional_details || 'Requesting all records related to this incident including police reports, witness statements, forensic evidence, and any other relevant documentation.'}

IMPORTANT NOTES:
- Use the email ${email} for all form fields requiring an email address
- If asked about fee waivers, request one as a member of the press/media
- If asked about delivery format, prefer electronic delivery
- Be thorough but concise in filling out all required fields
- ${dryRun ? 'DO NOT submit the form - stop at the review/submit page' : 'Complete the full submission'}

When you're done, respond with a summary of what you accomplished.`;
    }

    /**
     * Get status of a running task
     */
    async getTaskStatus(jobId) {
        return await this.hyperbrowser.agents.claudeComputerUse.getStatus(jobId);
    }

    /**
     * Get full results of a completed task
     */
    async getTaskResults(jobId) {
        return await this.hyperbrowser.agents.claudeComputerUse.get(jobId);
    }

    /**
     * Stop a running task
     */
    async stopTask(jobId) {
        return await this.hyperbrowser.agents.claudeComputerUse.stop(jobId);
    }
}

module.exports = new PortalAgentServiceManaged();
