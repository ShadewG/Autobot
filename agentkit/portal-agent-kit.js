const EmailVerificationHelper = require('./email-helper');

class PortalAgentKit {
    constructor({ page, caseData, portalUrl, dryRun = false, inboxAddress } = {}) {
        this.page = page;
        this.caseData = caseData;
        this.portalUrl = portalUrl;
        this.dryRun = dryRun;
        this.emailHelper = new EmailVerificationHelper({ inboxAddress });
    }

    buildInstruction() {
        const caseData = this.caseData || {};
        return `You are an autonomous agent that completes FOIA portal workflows end-to-end.

TASK:
${this.dryRun ? 'Fill the form and stop before the final submit button (dry run).' : 'Fill the form and submit the request.'}

DATA TO USE:
- Requester Name: ${caseData.subject_name || 'Samuel Hylton'}
- Agency Name: ${caseData.agency_name || 'Unknown Agency'}
- State: ${caseData.state || 'Unknown'}
- Incident Date: ${caseData.incident_date || 'Unknown'}
- Incident Location: ${caseData.incident_location || 'Unknown'}
- Records Requested: ${caseData.requested_records || 'Body-worn camera, dash camera, 911 audio, incident and arrest reports'}
- Additional Details: ${caseData.additional_details || 'Full narrative of the incident and supporting materials'}
- Email: ${process.env.REQUESTS_INBOX || 'requests@foib-request.com'}

WHEN PORTAL REQUIRES ACCOUNT CREATION:
- Look for buttons/links such as "Create Account", "Sign up", "Register".
- Use the same email above for account creation.
- If a verification code is emailed, request it via ACTION wait_for_email_code (details below).

AVAILABLE ACTIONS:
- click / type / select / scroll / wait / complete / error
- wait_for_email_code → fetches a verification code from inbox. TARGET should be JSON: {"pattern":"code (\\d{6})","timeout":120000,"from":"govqa.us"}

ACTION FORMAT (must be followed exactly):
THOUGHT: describe what you see and plan next
ACTION: one of the actions above
TARGET: CSS selector, element description, or JSON payload for wait_for_email_code
VALUE: text to type or select (omit for click/wait/complete)
REASON: why you're doing this

When the flow is fully completed (or ready to submit in dry run), respond with ACTION: complete.`;
    }

    getSystemPrompt() {
        return `You control a Chromium browser via Playwright. Output only the required ACTION format.

Guidelines:
- Use semantic selectors when possible (#id, [name="..."], text selectors).
- If the page needs scrolling, use ACTION: scroll with TARGET: {"x":0,"y":600}.
- For multi-step portals (account creation, login, form, review), narrate progress in THOUGHT before picking the next action.
- To fetch verification codes emailed to you, use ACTION: wait_for_email_code with TARGET JSON containing a regex pattern capturing the numeric/alphanumeric code.`;
    }

    async getPageState() {
        const title = await this.page.title();
        const url = this.page.url();
        const forms = await this.page.$$eval('form', (els) => els.length);
        const inputs = await this.page.$$eval('input, textarea, select', (els) => els.length);
        return `Page title: ${title}\nURL: ${url}\nForms visible: ${forms}\nInputs: ${inputs}`;
    }

    parseAction(rawText) {
        const action = {
            type: 'wait',
            target: null,
            value: null,
            reason: ''
        };

        const lines = rawText.split('\n').map(l => l.trim());
        for (const line of lines) {
            if (line.toUpperCase().startsWith('ACTION:')) {
                action.type = line.substring(7).trim().toLowerCase();
            } else if (line.toUpperCase().startsWith('TARGET:')) {
                action.target = line.substring(7).trim();
            } else if (line.toUpperCase().startsWith('VALUE:')) {
                action.value = line.substring(6).trim();
            } else if (line.toUpperCase().startsWith('REASON:')) {
                action.reason = line.substring(7).trim();
            }
        }

        if (!action.type) {
            action.type = 'wait';
        }

        return action;
    }

    async executeAction(action) {
        const page = this.page;
        switch (action.type) {
            case 'wait':
                await page.waitForTimeout(1500);
                return { waited: true };
            case 'scroll': {
                let payload = { x: 0, y: 400 };
                try {
                    payload = JSON.parse(action.target);
                } catch (_) {
                    // ignore JSON parse errors
                }
                await page.mouse.wheel(payload.x || 0, payload.y || 400);
                return { scrolled: payload };
            }
            case 'click':
                await this.performClick(action.target);
                return { clicked: action.target };
            case 'type':
                await this.performType(action.target, action.value || '');
                return { typed: action.value };
            case 'select':
                await this.performSelect(action.target, action.value);
                return { selected: action.value };
            case 'wait_for_email_code':
                return await this.performWaitForEmail(action.target);
            case 'complete':
                return { completed: true };
            case 'error':
                throw new Error(action.reason || 'Agent reported error');
            default:
                throw new Error(`Unknown action: ${action.type}`);
        }
    }

    async performClick(target) {
        if (!target) throw new Error('Click action missing target');
        if (target.startsWith('{') || target.startsWith('[')) {
            const payload = JSON.parse(target);
            if (payload.text) {
                await this.page.getByText(payload.text, { exact: payload.exact || false }).first().click();
                return;
            }
        }
        await this.page.click(target, { timeout: 10000 });
    }

    async performType(target, value) {
        if (!target) throw new Error('Type action missing target');
        await this.page.fill(target, value || '', { timeout: 10000 });
    }

    async performSelect(target, value) {
        if (!target) throw new Error('Select action missing target');
        await this.page.selectOption(target, { label: value || '', value: value || undefined });
    }

    async performWaitForEmail(rawTarget) {
        let payload = {};
        try {
            payload = JSON.parse(rawTarget);
        } catch {
            payload.pattern = rawTarget;
        }

        const code = await this.emailHelper.waitForCode({
            pattern: payload.pattern || '(\\d{6})',
            timeoutMs: payload.timeout || 120000,
            fromEmail: payload.from
        });

        return { code };
    }
}

module.exports = PortalAgentKit;
