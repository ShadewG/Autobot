const { chromium } = require('playwright');
const OpenAI = require('openai');
const db = require('./database');

class PortalService {
    constructor() {
        this.openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
        this.browser = null;
    }

    /**
     * Launch browser (reuse if already launched)
     */
    async launchBrowser() {
        if (!this.browser) {
            console.log('Launching Chromium browser...');
            this.browser = await chromium.launch({
                headless: true,
                args: [
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--disable-dev-shm-usage',
                    '--disable-gpu'
                ]
            });
            console.log('Browser launched successfully');
        }
        return this.browser;
    }

    /**
     * Close browser
     */
    async closeBrowser() {
        if (this.browser) {
            await this.browser.close();
            this.browser = null;
            console.log('Browser closed');
        }
    }

    /**
     * Test a portal by filling the form (without submitting)
     */
    async testPortal(portalUrl, caseData, options = {}) {
        const { dryRun = true } = options;

        let context, page;

        try {
            const browser = await this.launchBrowser();
            context = await browser.newContext({
                viewport: { width: 1280, height: 720 },
                userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            });

            page = await context.newPage();

            console.log(`Navigating to portal: ${portalUrl}`);
            await page.goto(portalUrl, { waitUntil: 'networkidle', timeout: 30000 });

            // Wait a bit for any JS to load
            await page.waitForTimeout(2000);

            // Take initial screenshot
            const initialScreenshot = await page.screenshot({ fullPage: true });

            console.log('Analyzing form fields...');
            const formAnalysis = await this.analyzeForm(page, initialScreenshot);

            console.log('Found fields:', formAnalysis.fields.map(f => f.label || f.name));

            // Fill the form
            console.log('Filling form fields...');
            const filledFields = await this.fillForm(page, formAnalysis, caseData);

            // Take screenshot after filling
            const filledScreenshot = await page.screenshot({ fullPage: true });

            // Find submit button but don't click if dry run
            const submitButton = await this.findSubmitButton(page);

            const result = {
                success: true,
                url: portalUrl,
                fieldsFound: formAnalysis.fields.length,
                fieldsFilled: filledFields.length,
                submitButtonFound: !!submitButton,
                submitButtonText: submitButton?.text || null,
                screenshots: {
                    initial: initialScreenshot.toString('base64'),
                    filled: filledScreenshot.toString('base64')
                },
                fields: filledFields,
                dryRun
            };

            if (dryRun) {
                console.log(`✓ DRY RUN: Would submit to ${submitButton?.text || 'Submit'} button`);
            } else {
                // Actually submit if not dry run
                if (submitButton?.selector) {
                    await page.click(submitButton.selector);
                    await page.waitForTimeout(3000);
                    const confirmationScreenshot = await page.screenshot({ fullPage: true });
                    result.screenshots.confirmation = confirmationScreenshot.toString('base64');
                    result.submitted = true;
                }
            }

            return result;

        } catch (error) {
            console.error('Error testing portal:', error);
            return {
                success: false,
                error: error.message,
                url: portalUrl
            };
        } finally {
            if (page) await page.close();
            if (context) await context.close();
        }
    }

    /**
     * Analyze form fields on the page
     */
    async analyzeForm(page, screenshot) {
        // Extract all input fields
        const formFields = await page.evaluate(() => {
            const fields = [];

            // Get all input, textarea, select, and contenteditable elements
            document.querySelectorAll('input, textarea, select, [contenteditable="true"]').forEach((el, index) => {
                const field = {
                    index,
                    tag: el.tagName.toLowerCase(),
                    type: el.type || (el.getAttribute('contenteditable') === 'true' ? 'contenteditable' : 'text'),
                    name: el.name || el.id || '',
                    id: el.id || '',
                    placeholder: el.placeholder || '',
                    required: el.required || el.hasAttribute('required'),
                    value: el.value || '',
                    visible: el.offsetParent !== null
                };

                // Try to find associated label
                let label = '';
                if (el.id) {
                    const labelEl = document.querySelector(`label[for="${el.id}"]`);
                    if (labelEl) label = labelEl.textContent.trim();
                }

                // If no label found, look for nearby text
                if (!label && el.parentElement) {
                    const parentText = el.parentElement.textContent.trim();
                    if (parentText.length < 100) {
                        label = parentText.replace(el.value || '', '').trim();
                    }
                }

                field.label = label;

                // For select elements, get options
                if (el.tagName === 'SELECT') {
                    field.options = Array.from(el.options).map(opt => ({
                        value: opt.value,
                        text: opt.textContent.trim()
                    }));
                }

                fields.push(field);
            });

            return fields;
        });

        // Filter out hidden and submit buttons
        const visibleFields = formFields.filter(f =>
            f.visible &&
            f.type !== 'submit' &&
            f.type !== 'button' &&
            f.type !== 'hidden'
        );

        return {
            fields: visibleFields,
            totalFields: formFields.length,
            visibleFields: visibleFields.length
        };
    }

    /**
     * Fill form fields intelligently based on case data
     */
    async fillForm(page, formAnalysis, caseData) {
        const filledFields = [];
        let hasFilledDescription = false;

        for (const field of formAnalysis.fields) {
            try {
                // Build selector - special handling for contenteditable
                let selector;
                if (field.id) {
                    selector = `#${field.id}`;
                } else if (field.type === 'contenteditable') {
                    selector = `[contenteditable="true"]`;
                } else if (field.name) {
                    selector = `[name="${field.name}"]`;
                } else {
                    continue; // Skip if no way to select
                }

                let value = this.mapFieldToCaseData(field, caseData);

                // If this is a contenteditable with no label and we haven't filled description yet,
                // assume it's the main request description
                if (!value && field.type === 'contenteditable' && !hasFilledDescription) {
                    const records = Array.isArray(caseData.requested_records)
                        ? caseData.requested_records.join(', ')
                        : caseData.requested_records || 'police records';
                    value = `Requesting ${records} related to an incident involving ${caseData.subject_name || 'subject'} on ${caseData.incident_date || 'the date in question'} at ${caseData.incident_location || 'the location in question'}. ${caseData.additional_details || ''}`;
                    hasFilledDescription = true;
                }

                if (!value) continue;

                if (field.tag === 'select') {
                    // Handle dropdown
                    await page.selectOption(selector, { label: value });
                    filledFields.push({ field: field.label || field.name, value });
                } else if (field.type === 'checkbox') {
                    // Handle checkbox
                    if (value === true || value === 'true') {
                        await page.check(selector);
                        filledFields.push({ field: field.label || field.name, value: 'checked' });
                    }
                } else if (field.type === 'radio') {
                    // Handle radio
                    await page.check(selector);
                    filledFields.push({ field: field.label || field.name, value });
                } else if (field.type === 'contenteditable') {
                    // Handle contenteditable (rich text editors)
                    await page.click(selector);
                    await page.evaluate(({ sel, val }) => {
                        const el = document.querySelector(sel);
                        if (el) el.textContent = val;
                    }, { sel: selector, val: value.toString() });
                    filledFields.push({ field: field.label || field.name || 'Request description', value });
                } else {
                    // Handle text inputs
                    await page.fill(selector, value.toString());
                    filledFields.push({ field: field.label || field.name, value });
                }

                console.log(`✓ Filled: ${field.label || field.name} = ${value}`);

            } catch (error) {
                console.warn(`Could not fill field ${field.name}:`, error.message);
            }
        }

        return filledFields;
    }

    /**
     * Map form field to case data
     */
    mapFieldToCaseData(field, caseData) {
        const label = (field.label || field.name || field.placeholder).toLowerCase();

        // Email (check this first before name fields)
        if (label.includes('email') || field.type === 'email') {
            return process.env.REQUESTER_EMAIL || 'shadewofficial@gmail.com';
        }

        // Phone
        if (label.includes('phone')) {
            return process.env.REQUESTER_PHONE || '';
        }

        // Address/Street address/City/State/Zip
        if (label.includes('street') || label.includes('city') || label.includes('zip')) {
            return ''; // Leave blank for now
        }

        if (label.includes('address') && !label.includes('email')) {
            return process.env.REQUESTER_ADDRESS || '';
        }

        // Redaction/agreement fields - auto-agree
        if (label.includes('redaction') || label.includes('agree') || label.includes('acknowledge')) {
            if (field.type === 'checkbox') {
                return true;
            }
            return 'Yes'; // For text fields asking "Yes or No"
        }

        // Company/Organization
        if (label.includes('company') || label.includes('organization')) {
            return ''; // Leave blank
        }

        // Name fields - IMPROVED LOGIC
        if (label.includes('name')) {
            // Subject name only if explicitly mentioned
            if (label.includes('subject') || label.includes('individual') || label.includes('person of interest')) {
                return caseData.subject_name || caseData.case_name;
            }
            // Otherwise default to requester name (most forms ask for YOUR name)
            return process.env.REQUESTER_NAME || 'Samuel Hylton';
        }

        // Description/Details/Request
        if (label.includes('description') || label.includes('details') ||
            label.includes('request') || label.includes('information sought')) {
            const records = Array.isArray(caseData.requested_records)
                ? caseData.requested_records.join(', ')
                : caseData.requested_records || 'police records';

            return `Requesting ${records} related to an incident involving ${caseData.subject_name || 'subject'} on ${caseData.incident_date || 'the date in question'} at ${caseData.incident_location || 'the location in question'}. ${caseData.additional_details || ''}`;
        }

        // Date
        if (label.includes('date') && !label.includes('birth')) {
            return caseData.incident_date || '';
        }

        // Location
        if (label.includes('location') || label.includes('address') && label.includes('incident')) {
            return caseData.incident_location || '';
        }

        // Record type (checkbox/select)
        if (label.includes('record type') || label.includes('document type')) {
            if (field.options) {
                // Try to match requested records to options
                const records = caseData.requested_records || [];
                for (const opt of field.options) {
                    if (records.some(r => opt.text.toLowerCase().includes(r.toLowerCase()))) {
                        return opt.value;
                    }
                }
            }
        }

        return null;
    }

    /**
     * Find submit button
     */
    async findSubmitButton(page) {
        const buttons = await page.evaluate(() => {
            const buttonElements = [];

            // Find all buttons and inputs with type submit
            document.querySelectorAll('button, input[type="submit"]').forEach((btn, index) => {
                const text = btn.textContent?.trim() || btn.value || '';
                const lowerText = text.toLowerCase();

                // Look for submit-like text
                if (lowerText.includes('submit') ||
                    lowerText.includes('send') ||
                    lowerText.includes('request') ||
                    lowerText.includes('apply')) {

                    buttonElements.push({
                        index,
                        text,
                        id: btn.id,
                        class: btn.className,
                        type: btn.type
                    });
                }
            });

            return buttonElements;
        });

        if (buttons.length > 0) {
            const btn = buttons[0];
            return {
                ...btn,
                selector: btn.id ? `#${btn.id}` : `button:has-text("${btn.text}")`
            };
        }

        return null;
    }

    /**
     * Submit to portal (full workflow)
     */
    async submitToPortal(caseId, portalUrl, dryRun = false) {
        try {
            const caseData = await db.getCaseById(caseId);
            if (!caseData) {
                throw new Error(`Case ${caseId} not found`);
            }

            const result = await this.testPortal(portalUrl, caseData, { dryRun });

            // Log to activity
            await db.logActivity(
                dryRun ? 'portal_test' : 'portal_submit',
                `${dryRun ? 'Tested' : 'Submitted to'} portal for case: ${caseData.case_name}`,
                {
                    case_id: caseId,
                    portal_url: portalUrl,
                    fields_filled: result.fieldsFilled,
                    success: result.success
                }
            );

            return result;

        } catch (error) {
            console.error('Error in submitToPortal:', error);
            throw error;
        }
    }
}

module.exports = new PortalService();
