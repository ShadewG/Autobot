/**
 * AI Vision for portal automation.
 * Uses Claude (Anthropic) as primary, GPT-4o as fallback.
 */

const PROVIDER = process.env.PORTAL_AI_VISION_PROVIDER || (process.env.ANTHROPIC_API_KEY ? 'anthropic' : 'openai');
const CLAUDE_MODEL = process.env.PORTAL_AI_CLAUDE_MODEL || 'claude-sonnet-4-20250514';
const OPENAI_MODEL = process.env.PORTAL_AI_OPENAI_MODEL || 'gpt-4o';

let _anthropic = null;
let _openai = null;

function getAnthropic() {
    if (!_anthropic) {
        const Anthropic = require('@anthropic-ai/sdk');
        _anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    }
    return _anthropic;
}

function getOpenAI() {
    if (!_openai) {
        const OpenAI = require('openai');
        _openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    }
    return _openai;
}

async function analyzeScreenshot(screenshotBuffer, prompt, options = {}) {
    const base64 = screenshotBuffer.toString('base64');

    // Try Claude first
    if (PROVIDER === 'anthropic' && process.env.ANTHROPIC_API_KEY) {
        try {
            const response = await getAnthropic().messages.create({
                model: options.model || CLAUDE_MODEL,
                max_tokens: options.maxTokens || 800,
                messages: [{
                    role: 'user',
                    content: [
                        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: base64 } },
                        { type: 'text', text: prompt },
                    ],
                }],
            });
            return response.content[0]?.text?.trim() || null;
        } catch (err) {
            // Fall through to OpenAI
        }
    }

    // OpenAI fallback
    if (process.env.OPENAI_API_KEY) {
        try {
            const response = await getOpenAI().chat.completions.create({
                model: options.model || OPENAI_MODEL,
                max_tokens: options.maxTokens || 800,
                messages: [{
                    role: 'user',
                    content: [
                        { type: 'text', text: prompt },
                        { type: 'image_url', image_url: { url: `data:image/png;base64,${base64}`, detail: 'low' } },
                    ],
                }],
            });
            return response.choices[0]?.message?.content?.trim() || null;
        } catch {}
    }

    return null;
}

/**
 * Full page analysis with case context.
 */
async function analyzePage(page, context = {}) {
    const screenshot = await page.screenshot({ type: 'png' }).catch(() => null);
    if (!screenshot) return null;

    const caseInfo = context.caseData ? [
        `Subject: ${context.caseData.subject_name || context.caseData.case_name || 'unknown'}`,
        `Incident date: ${context.caseData.incident_date || 'unknown'}`,
        `Location: ${context.caseData.incident_location || 'unknown'}`,
        `Agency: ${context.caseData.agency_name || 'unknown'}`,
    ].join('\n') : '';

    const requesterInfo = context.requester ? [
        `Name: ${context.requester.name}`,
        `Email: ${context.requester.email}`,
        `Phone: ${context.requester.phone || ''}`,
        `Address: ${context.requester.address || ''}, ${context.requester.city || ''}, ${context.requester.state || ''} ${context.requester.zip || ''}`,
    ].join('\n') : '';

    const result = await analyzeScreenshot(screenshot,
        `You are a portal automation assistant. Analyze this government records portal page.\n\n` +
        `GOAL: Submit a public records / FOIA request.\n` +
        (caseInfo ? `\nCASE:\n${caseInfo}\n` : '') +
        (requesterInfo ? `\nREQUESTER:\n${requesterInfo}\n` : '') +
        `\nURL: ${page.url()}\n\n` +
        `Respond with JSON only:\n` +
        `{"pageType":"login"|"registration"|"request_form"|"confirmation"|"department_selection"|"landing"|"error"|"unknown",` +
        `"isSubmissionConfirmed":true/false,"confirmationNumber":"if visible" or null,` +
        `"action":"fill_form"|"click_button"|"click_link"|"select_department"|"login"|"submit"|"done"|"error",` +
        `"target":"exact text to click" or null,` +
        `"fields":[{"label":"field","value":"value"}],` +
        `"submitButton":"button text" or null,` +
        `"hasErrors":true/false,"errorMessage":null,` +
        `"notes":"what you see"}`,
        { maxTokens: 1200 }
    );
    try { return JSON.parse(result); } catch { return null; }
}

async function detectPageKind(page) {
    const screenshot = await page.screenshot({ type: 'png' }).catch(() => null);
    if (!screenshot) return null;
    const result = await analyzeScreenshot(screenshot,
        'What type of page is this? Respond with ONLY one word:\n' +
        'login_page, registration_form, request_form, confirmation_page, department_selection, landing_page, error_page, or unknown'
    );
    return result?.toLowerCase().replace(/[^a-z_]/g, '') || null;
}

async function findSubmitButton(page) {
    const screenshot = await page.screenshot({ type: 'png' }).catch(() => null);
    if (!screenshot) return null;
    const result = await analyzeScreenshot(screenshot,
        'Find the SUBMIT button on this form. Respond with JSON only:\n' +
        '{"found":true/false,"buttonText":"exact text","disabled":true/false}'
    );
    try { return JSON.parse(result); } catch { return null; }
}

async function mapUnknownField(page, fieldLabel, caseData, requester) {
    const screenshot = await page.screenshot({ type: 'png' }).catch(() => null);
    if (!screenshot) return null;
    const context = [
        `Requester: ${requester.name}, ${requester.email}, ${requester.phone || ''}`,
        `Address: ${requester.address || ''}, ${requester.city || ''}, ${requester.state || ''} ${requester.zip || ''}`,
        `Subject: ${caseData.subject_name || caseData.case_name || ''}`,
        `Date: ${caseData.incident_date || 'unknown'}`,
        `Location: ${caseData.incident_location || 'unknown'}`,
    ].join('\n');
    const result = await analyzeScreenshot(screenshot,
        `Fill the field "${fieldLabel}" on this records request form.\n\n${context}\n\n` +
        'Respond with ONLY the value to enter. If blank, respond "SKIP".'
    );
    if (!result || result.toUpperCase() === 'SKIP') return null;
    return result;
}

async function detectConfirmation(page) {
    const screenshot = await page.screenshot({ type: 'png' }).catch(() => null);
    if (!screenshot) return null;
    const result = await analyzeScreenshot(screenshot,
        'Was a form submission successful? Look for confirmation numbers, thank you messages, request received text.\n' +
        'Respond with JSON only: {"confirmed":true/false,"confirmationNumber":"number" or null,"reason":"explanation"}'
    );
    try { return JSON.parse(result); } catch { return null; }
}

async function chooseNavigationTarget(page, agencyName, goal) {
    const screenshot = await page.screenshot({ type: 'png' }).catch(() => null);
    if (!screenshot) return null;
    const result = await analyzeScreenshot(screenshot,
        `On a portal for "${agencyName}". Goal: ${goal}\n` +
        'What should I click? Respond with JSON only: {"clickText":"exact text","elementType":"link"|"button"|"tile","confidence":0-100}'
    );
    try { return JSON.parse(result); } catch { return null; }
}

async function handleAuthPage(page, credentials = {}) {
    const screenshot = await page.screenshot({ type: 'png' }).catch(() => null);
    if (!screenshot) return null;
    const result = await analyzeScreenshot(screenshot,
        `Login/auth page on a government portal. Credentials: email="${credentials.email || ''}"\n` +
        `URL: ${page.url()}\n\n` +
        'Respond with JSON only:\n' +
        '{"action":"login"|"click_link"|"already_logged_in"|"needs_registration"|"stuck",' +
        '"emailFieldVisible":true/false,"passwordFieldVisible":true/false,' +
        '"loginButtonText":"text" or null,"isActuallyLoggedIn":true/false,' +
        '"linkToClick":"text" or null,"notes":"what you see"}'
    );
    try { return JSON.parse(result); } catch { return null; }
}

async function navigateToForm(page, context = {}, maxSteps = 8) {
    const steps = [];
    for (let i = 0; i < maxSteps; i++) {
        const analysis = await analyzePage(page, context);
        if (!analysis) break;

        steps.push({ step: i, pageType: analysis.pageType, action: analysis.action, target: analysis.target });

        if (analysis.pageType === 'request_form') return { success: true, steps };
        if (analysis.pageType === 'confirmation') return { success: true, confirmed: true, steps };
        if (analysis.action === 'done' || analysis.action === 'error') break;

        if ((analysis.action === 'click_link' || analysis.action === 'click_button' || analysis.action === 'select_department') && analysis.target) {
            // Try text match first, then button role
            let clicked = false;
            for (const strategy of [
                () => page.locator(`text="${analysis.target}"`).first(),
                () => page.getByRole('button', { name: analysis.target }).first(),
                () => page.getByRole('link', { name: analysis.target }).first(),
            ]) {
                const loc = strategy();
                if (await loc.isVisible().catch(() => false)) {
                    await loc.click({ force: true }).catch(() => {});
                    clicked = true;
                    break;
                }
            }
            if (clicked) {
                await page.waitForTimeout(4000);
                await page.waitForLoadState('networkidle').catch(() => {});
                continue;
            }
        }

        if (analysis.action === 'login' && context.credentials) {
            const emailField = page.locator('input[type=email], input[type=text]').first();
            const pwField = page.locator('input[type=password]').first();
            if (await emailField.isVisible().catch(() => false)) await emailField.fill(context.credentials.email || '');
            if (await pwField.isVisible().catch(() => false)) await pwField.fill(context.credentials.password || '');
            await page.locator('input[type=submit], button[type=submit]').first().click({ force: true }).catch(() => {});
            await page.waitForTimeout(5000);
            await page.waitForLoadState('networkidle').catch(() => {});
            continue;
        }

        if (analysis.action === 'fill_form' && analysis.fields?.length) {
            // AI provided field values — fill them
            for (const field of analysis.fields) {
                if (!field.label || !field.value) continue;
                const loc = page.getByLabel(field.label).first();
                if (await loc.isVisible().catch(() => false)) {
                    await loc.fill(field.value).catch(() => {});
                }
            }
            continue;
        }

        break;
    }
    return { success: false, steps };
}

module.exports = {
    analyzeScreenshot,
    analyzePage,
    detectPageKind,
    findSubmitButton,
    mapUnknownField,
    detectConfirmation,
    chooseNavigationTarget,
    handleAuthPage,
    navigateToForm,
};
