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
                await this.performType(action.target, action.value || '', action.reason);
                return { typed: action.value };
            case 'fill':
                await this.performType(
                    action.target && action.target !== 'auto'
                        ? action.target
                        : this.buildAdaptiveSelector(action.reason, 'input'),
                    action.value || '',
                    action.reason
                );
                return { filled: action.value };
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

        let explicitTarget = target;

        // Try to parse as JSON only if it looks like valid JSON
        // (not a CSS selector like [aria-label="..."])
        if (target.startsWith('{') || (target.startsWith('[') && !target.includes('='))) {
            try {
                const payload = JSON.parse(target);
                if (payload.text) {
                    explicitTarget = null;
                    await this.page.getByText(payload.text, { exact: payload.exact || false }).first().click();
                    return;
                }
            } catch (jsonError) {
                // Not valid JSON, treat as CSS selector
                console.log(`      ℹ️  Not valid JSON, treating as CSS selector: ${target}`);
            }
        }

        const textHint = this.extractTextHint(explicitTarget);

        try {
            if (explicitTarget) {
                await this.page.click(explicitTarget, { timeout: 5000 });
                return;
            }
        } catch (_) {
            console.warn(`      ⚠️  Direct click failed, trying fallback strategies...`);
        }

        await this.page.mouse.wheel(0, 400);
        await this.page.waitForTimeout(300);

        const fallbacks = [];
        if (textHint) {
            const regex = new RegExp(textHint, 'i');
            fallbacks.push(
                () => this.page.getByRole('button', { name: regex }).first().click({ timeout: 4000 }),
                () => this.page.getByRole('link', { name: regex }).first().click({ timeout: 4000 }),
                () => this.page.getByText(regex).first().click({ timeout: 4000 }),
                () => this.page.locator(`button:has-text("${textHint}")`).first().click({ timeout: 4000 }),
                () => this.page.locator(`input[value*="${textHint}"]`).first().click({ timeout: 4000 }),
                () => this.page.locator(`input[title*="${textHint}"]`).first().click({ timeout: 4000 }),
                () => this.page.locator(`input[alt*="${textHint}"]`).first().click({ timeout: 4000 }),
                () => this.page.locator(`text=${textHint}`).first().click({ timeout: 4000 }),
                () => this.clickViaEvaluate(textHint)
            );
        }

        fallbacks.push(
            () => this.page.locator('input[id*="btnnew"]').first().click({ timeout: 4000 }),
            () => this.page.locator('input[type="submit"][value*="Create"]').first().click({ timeout: 4000 })
        );

        if (explicitTarget) {
            fallbacks.push(() => this.page.locator(explicitTarget).click({ timeout: 4000, force: true }));
        }

        for (const attempt of fallbacks) {
            try {
                console.log(`      🔁 Trying fallback click...`);
                await attempt();
                return;
            } catch (_) {
                continue;
            }
        }

        if (textHint) {
            const regex = new RegExp(textHint, 'i');
            const button = await this.page.getByRole('button', { name: regex }).first();
            if (await button.count()) {
                await button.click({ timeout: 4000, force: true });
                return;
            }
            const link = await this.page.getByRole('link', { name: regex }).first();
            if (await link.count()) {
                await link.click({ timeout: 4000, force: true });
                return;
            }
            const input = await this.page.locator(`input[value*="${textHint}"]`).first();
            if (await input.count()) {
                await input.click({ timeout: 4000, force: true });
                return;
            }
        }

        if (explicitTarget) {
            await this.page.locator(explicitTarget).click({ timeout: 4000, force: true });
            return;
        }

        // Last resort: click via bounding box of text hint
        if (textHint) {
            const element = this.page.getByText(new RegExp(textHint, 'i')).first();
            if (await element.count()) {
                const box = await element.boundingBox();
                if (box) {
                    await this.page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
                    return;
                }
            }
        }

        throw new Error(`Unable to click target: ${target}`);
    }

    async performType(target, value, reason = '') {
        if (!target) throw new Error('Type action missing target');

        const selectors = [target, ...this.buildSelectorFallbacks(target, reason)];
        let lastError = null;

        for (const selector of selectors) {
            if (!selector) {
                continue;
            }

            try {
                await this.page.fill(selector, value || '', { timeout: 10000 });
                return;
            } catch (err) {
                lastError = err;
            }
        }

        if (lastError) {
            throw lastError;
        }
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

    buildSelectorFallbacks(target, reason = '') {
        const hints = [];
        const lowerTarget = target ? target.toLowerCase() : '';
        const lowerReason = (reason || '').toLowerCase();
        const text = `${lowerTarget} ${lowerReason}`;

        const labelToXpath = (label) => `xpath=//span[contains(translate(normalize-space(.), 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), "${label}")]/ancestor::tr[1]//input`;

        if (text.includes('first')) {
            hints.push(
                'input[id*="First"]',
                'input[name*="First"]',
                'input[aria-label*="First"]',
                'input[placeholder*="First"]',
                labelToXpath('first name'),
                'table input[id*="RequesDetailsFormLayout"][id$="_I"]'
            );
        }

        if (text.includes('last')) {
            hints.push(
                'input[id*="Last"]',
                'input[name*="Last"]',
                'input[aria-label*="Last"]',
                'input[placeholder*="Last"]',
                labelToXpath('last name'),
                'table input[id*="RequesDetailsFormLayout"][id$="_I"]'
            );
        }

        if (text.includes('email')) {
            hints.push(
                'input[id*="Email"]',
                'input[name*="Email"]'
            );
        }

        if (text.includes('password')) {
            hints.push(
                'input[type="password"]'
            );
        }

        if (text.includes('confirm')) {
            hints.push(
                'input[id*="Confirm"]',
                'input[name*="Confirm"]'
            );
        }

        return hints;
    }

    extractTextHint(selector) {
        if (!selector || typeof selector !== 'string') return null;

        const titleMatch = selector.match(/title\s*=\s*["']([^"']+)["']/i);
        if (titleMatch) return titleMatch[1].trim();

        const textMatch = selector.match(/text\s*=?\s*["']([^"']+)["']/i);
        if (textMatch) return textMatch[1].trim();

        const ariaMatch = selector.match(/aria-label\s*=\s*["']([^"']+)["']/i);
        if (ariaMatch) return ariaMatch[1].trim();

        if (/create[\s-]?account/i.test(selector)) {
            return 'Create Account';
        }

        return null;
    }

    async clickViaEvaluate(text) {
        if (!text) return;
        await this.page.evaluate((hint) => {
            const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT, null);
            while (walker.nextNode()) {
                const node = walker.currentNode;
                const content = (node.textContent || '').trim().toLowerCase();
                if (content.includes(hint.toLowerCase())) {
                    node.click();
                    return;
                }
            }
        }, text);
    }
}

module.exports = PortalAgentKit;
