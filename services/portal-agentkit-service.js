const OpenAI = require('openai');

/**
 * Portal automation powered by OpenAI AgentKit / Automations.
 *
 * REQUIREMENTS
 *  - Set OPENAI_API_KEY (already in use across the app)
 *  - Create a Browser-enabled automation inside the OpenAI dashboard
 *    and set OPENAI_PORTAL_AUTOMATION_ID to that automation's ID.
 *
 * The automation should have the Browser tool enabled (headless Chrome)
 * and permissions to visit government domains. The instructions that we
 * send at runtime include the case-specific details and the target portal.
 */
class PortalAgentKitService {
    constructor() {
        if (!process.env.OPENAI_API_KEY) {
            throw new Error('OPENAI_API_KEY is missing');
        }
        if (!process.env.OPENAI_PORTAL_AUTOMATION_ID) {
            throw new Error('OPENAI_PORTAL_AUTOMATION_ID is missing');
        }

        this.client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
        this.automationId = process.env.OPENAI_PORTAL_AUTOMATION_ID;
    }

    /**
     * Submit a case through an external portal using AgentKit
     */
    async submitCase(caseData, portalUrl, options = {}) {
        if (!portalUrl) {
            throw new Error('portalUrl is required');
        }

        const dryRun = options.dryRun !== false;
        const payload = this.buildAutomationInput(caseData, portalUrl, dryRun);

        const run = await this.client.automations.runs.create({
            automation_id: this.automationId,
            input: payload
        });

        return await this.pollRun(run.id);
    }

    buildAutomationInput(caseData, portalUrl, dryRun) {
        const caseBlock = {
            agency: caseData.agency_name,
            subject: caseData.case_name,
            state: caseData.state,
            incident_date: caseData.incident_date,
            incident_location: caseData.incident_location,
            requested_records: caseData.requested_records,
            additional_details: caseData.additional_details
        };

        return {
            instructions: [
                `You are an autonomous FOIA assistant.`,
                `Visit ${portalUrl} and either create an account or log in if prompted.`,
                dryRun
                    ? 'Fill the form completely but stop before the final submit if submission would send a real request.'
                    : 'Fill the form completely and submit the request when ready.',
                'Use the following requester information:',
                JSON.stringify({
                    name: caseData.subject_name || 'Samuel Hylton',
                    email: process.env.REQUESTS_INBOX || 'requests@foib-request.com',
                    phone: caseData.phone || '(555) 555-1212',
                    address: caseData.address || '3021 21st Ave W, Apt 202, Seattle, WA 98199'
                }, null, 2),
                'Case context:',
                JSON.stringify(caseBlock, null, 2)
            ].join('\n\n'),
            metadata: {
                portalUrl,
                dryRun
            }
        };
    }

    async pollRun(runId) {
        while (true) {
            const run = await this.client.automations.runs.retrieve(runId);

            if (run.status === 'completed') {
                return {
                    success: true,
                    runId,
                    output: run.output,
                    screenshots: run.screenshots || []
                };
            }

            if (run.status === 'failed' || run.status === 'cancelled') {
                const err = run.error || {};
                throw new Error(err.message || `Automation ${run.status}`);
            }

            await new Promise((resolve) => setTimeout(resolve, 2000));
        }
    }
}

module.exports = new PortalAgentKitService();
