/**
 * AI Vision for portal automation.
 * Uses GPT-4o to guide every step of portal interaction.
 */

let _openai = null;
function getOpenAI() {
    if (!_openai) {
        const OpenAI = require('openai');
        _openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    }
    return _openai;
}
const MODEL = process.env.PORTAL_AI_VISION_MODEL || 'gpt-4o-mini';

async function analyzeScreenshot(screenshotBuffer, prompt, options = {}) {
    if (!process.env.OPENAI_API_KEY) return null;
    try {
        const base64 = screenshotBuffer.toString('base64');
        const response = await getOpenAI().chat.completions.create({
            model: options.model || MODEL,
            max_tokens: options.maxTokens || 800,
            messages: [{
                role: 'user',
                content: [
                    { type: 'text', text: prompt },
                    { type: 'image_url', image_url: { url: `data:image/png;base64,${base64}`, detail: options.detail || 'low' } },
                ],
            }],
        });
        return response.choices[0]?.message?.content?.trim() || null;
    } catch (err) {
        return null;
    }
}

/**
 * Full page analysis — classify the page, identify all interactive elements,
 * and recommend the next action.
 */
async function analyzePage(page, context = {}) {
    const screenshot = await page.screenshot({ type: 'png' }).catch(() => null);
    if (!screenshot) return null;

    const caseInfo = context.caseData ? [
        `Subject: ${context.caseData.subject_name || context.caseData.case_name || 'unknown'}`,
        `Incident date: ${context.caseData.incident_date || 'unknown'}`,
        `Location: ${context.caseData.incident_location || 'unknown'}`,
        `Agency: ${context.caseData.agency_name || 'unknown'}`,
        `Records: ${JSON.stringify(context.caseData.requested_records || []).substring(0, 200)}`,
    ].join('\n') : '';

    const requesterInfo = context.requester ? [
        `Name: ${context.requester.name}`,
        `Email: ${context.requester.email}`,
        `Phone: ${context.requester.phone || ''}`,
        `Address: ${context.requester.address || ''}, ${context.requester.city || ''}, ${context.requester.state || ''} ${context.requester.zip || ''}`,
    ].join('\n') : '';

    const result = await analyzeScreenshot(screenshot,
        `You are a portal automation assistant. Analyze this government records portal page and tell me exactly what to do.\n\n` +
        `GOAL: Submit a public records / FOIA request on this portal.\n\n` +
        (caseInfo ? `CASE INFO:\n${caseInfo}\n\n` : '') +
        (requesterInfo ? `REQUESTER INFO:\n${requesterInfo}\n\n` : '') +
        `Current URL: ${page.url()}\n\n` +
        `Respond with a JSON object:\n` +
        `{\n` +
        `  "pageType": "login"|"registration"|"request_form"|"confirmation"|"department_selection"|"landing"|"error"|"unknown",\n` +
        `  "isSubmissionConfirmed": true/false (if this looks like a success/confirmation page),\n` +
        `  "confirmationNumber": "number if visible" or null,\n` +
        `  "action": "fill_form"|"click_button"|"click_link"|"select_department"|"login"|"submit"|"done"|"error",\n` +
        `  "target": "exact text of the button/link to click" or null,\n` +
        `  "fields": [{"label": "field label", "value": "value to enter"}] (only for fill_form action),\n` +
        `  "submitButton": "exact text on the submit button" or null,\n` +
        `  "hasErrors": true/false,\n` +
        `  "errorMessage": "the error text" or null,\n` +
        `  "notes": "brief description of what you see"\n` +
        `}\n\n` +
        `Respond with ONLY the JSON, no other text.`,
        { maxTokens: 1200, detail: 'low' }
    );
    try { return JSON.parse(result); } catch { return null; }
}

/**
 * Detect page type from screenshot.
 */
async function detectPageKind(page) {
    const screenshot = await page.screenshot({ type: 'png' }).catch(() => null);
    if (!screenshot) return null;
    const result = await analyzeScreenshot(screenshot,
        'What type of page is this? Respond with ONLY one of these exact words:\n' +
        '- login_page (has email/password fields for signing in)\n' +
        '- registration_form (account creation form)\n' +
        '- request_form (a form to submit a public records/FOIA request)\n' +
        '- confirmation_page (shows a confirmation number or "thank you" message)\n' +
        '- department_selection (shows departments or categories to choose from)\n' +
        '- landing_page (informational page with links but no form)\n' +
        '- error_page (shows an error message)\n' +
        '- unknown\n\nRespond with ONLY the type name.'
    );
    return result?.toLowerCase().replace(/[^a-z_]/g, '') || null;
}

/**
 * Find the submit button on a form page.
 */
async function findSubmitButton(page) {
    const screenshot = await page.screenshot({ type: 'png' }).catch(() => null);
    if (!screenshot) return null;
    const result = await analyzeScreenshot(screenshot,
        'Find the SUBMIT button on this form. Look for buttons like "Submit", "Send", "Make Request", etc.\n' +
        'Respond with JSON: {"found": true/false, "buttonText": "exact text on button", "disabled": true/false}\n' +
        'Respond with ONLY the JSON.'
    );
    try { return JSON.parse(result); } catch { return null; }
}

/**
 * Map a form field to the correct value.
 */
async function mapUnknownField(page, fieldLabel, caseData, requester) {
    const screenshot = await page.screenshot({ type: 'png' }).catch(() => null);
    if (!screenshot) return null;
    const context = [
        `Requester: ${requester.name}, ${requester.email}, ${requester.phone || ''}`,
        `Address: ${requester.address || ''}, ${requester.city || ''}, ${requester.state || ''} ${requester.zip || ''}`,
        `Subject: ${caseData.subject_name || caseData.case_name || ''}`,
        `Incident date: ${caseData.incident_date || 'unknown'}`,
        `Location: ${caseData.incident_location || 'unknown'}`,
        `Records: ${JSON.stringify(caseData.requested_records || []).substring(0, 200)}`,
    ].join('\n');
    const result = await analyzeScreenshot(screenshot,
        `Fill the field "${fieldLabel}" on this records request form.\n\n${context}\n\n` +
        'Respond with ONLY the value to enter. If the field should be left blank, respond "SKIP".'
    );
    if (!result || result.toUpperCase() === 'SKIP') return null;
    return result;
}

/**
 * Check if a submission was confirmed.
 */
async function detectConfirmation(page) {
    const screenshot = await page.screenshot({ type: 'png' }).catch(() => null);
    if (!screenshot) return null;
    const result = await analyzeScreenshot(screenshot,
        'Was a form submission successful on this page? Look for confirmation numbers, "thank you" messages, "request received", etc.\n' +
        'Respond with JSON: {"confirmed": true/false, "confirmationNumber": "number" or null, "reason": "brief explanation"}\n' +
        'Respond with ONLY the JSON.'
    );
    try { return JSON.parse(result); } catch { return null; }
}

/**
 * Choose what to click for navigation.
 */
async function chooseNavigationTarget(page, agencyName, goal) {
    const screenshot = await page.screenshot({ type: 'png' }).catch(() => null);
    if (!screenshot) return null;
    const result = await analyzeScreenshot(screenshot,
        `On a government portal for "${agencyName}". Goal: ${goal}\n` +
        'What should I click? Respond with JSON: {"clickText": "exact text to click", "elementType": "link"|"button"|"tile", "confidence": 0-100}\n' +
        'Respond with ONLY the JSON.'
    );
    try { return JSON.parse(result); } catch { return null; }
}

module.exports = {
    analyzeScreenshot,
    analyzePage,
    detectPageKind,
    findSubmitButton,
    mapUnknownField,
    detectConfirmation,
    chooseNavigationTarget,
};
