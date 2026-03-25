/**
 * AI Vision helper for portal automation.
 * Uses GPT-4o to analyze screenshots when rule-based logic fails.
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

/**
 * Analyze a page screenshot and return structured data.
 */
async function analyzeScreenshot(screenshotBuffer, prompt, options = {}) {
    if (!process.env.OPENAI_API_KEY) return null;
    try {
        const base64 = screenshotBuffer.toString('base64');
        const response = await getOpenAI().chat.completions.create({
            model: options.model || MODEL,
            max_tokens: options.maxTokens || 500,
            messages: [{
                role: 'user',
                content: [
                    { type: 'text', text: prompt },
                    { type: 'image_url', image_url: { url: `data:image/png;base64,${base64}`, detail: 'low' } },
                ],
            }],
        });
        return response.choices[0]?.message?.content?.trim() || null;
    } catch (err) {
        return null;
    }
}

/**
 * Detect page type from screenshot.
 * Returns: 'login_page', 'registration_form', 'request_form', 'confirmation_page',
 *          'department_selection', 'landing_page', 'error_page', 'unknown'
 */
async function detectPageKind(page) {
    const screenshot = await page.screenshot({ type: 'png' }).catch(() => null);
    if (!screenshot) return null;
    const result = await analyzeScreenshot(screenshot,
        'What type of page is this? Respond with ONLY one of these exact words:\n' +
        '- login_page (has email/password fields for signing in)\n' +
        '- registration_form (account creation form)\n' +
        '- request_form (a form to submit a public records/FOIA request, with fields like description, name, date)\n' +
        '- confirmation_page (shows a confirmation number or "thank you" message after submission)\n' +
        '- department_selection (shows departments or categories to choose from)\n' +
        '- landing_page (informational page with links but no form)\n' +
        '- error_page (shows an error message)\n' +
        '- unknown\n\nRespond with ONLY the type name, nothing else.'
    );
    return result?.toLowerCase().replace(/[^a-z_]/g, '') || null;
}

/**
 * Find the submit button on a page when rule-based detection fails.
 * Returns the button text/label to help locate it.
 */
async function findSubmitButton(page) {
    const screenshot = await page.screenshot({ type: 'png' }).catch(() => null);
    if (!screenshot) return null;
    const result = await analyzeScreenshot(screenshot,
        'This is a form page. I need to find the SUBMIT button to submit this form.\n' +
        'Look for a button that says something like "Submit", "Send", "Make Request", "Submit Request", "Create Request", etc.\n' +
        'Respond with a JSON object: {"found": true/false, "buttonText": "exact text on the button", "location": "brief description of where it is"}\n' +
        'If the button appears disabled/greyed out, include "disabled": true.\n' +
        'Respond with ONLY the JSON, no other text.'
    );
    try { return JSON.parse(result); } catch { return null; }
}

/**
 * Map a form field to the correct value using AI.
 * Used when rule-based mapFieldValue returns null.
 */
async function mapUnknownField(page, fieldLabel, caseData, requester) {
    const screenshot = await page.screenshot({ type: 'png' }).catch(() => null);
    if (!screenshot) return null;
    const context = [
        `Requester: ${requester.name}, ${requester.email}, ${requester.phone}`,
        `Address: ${requester.address}, ${requester.city}, ${requester.state} ${requester.zip}`,
        `Subject: ${caseData.subject_name || caseData.case_name}`,
        `Incident date: ${caseData.incident_date || 'unknown'}`,
        `Location: ${caseData.incident_location || 'unknown'}`,
        `Records requested: ${JSON.stringify(caseData.requested_records || [])}`,
    ].join('\n');
    const result = await analyzeScreenshot(screenshot,
        `This is a public records request form. I need to fill the field labeled "${fieldLabel}".\n\n` +
        `Here is the case information:\n${context}\n\n` +
        'What value should I enter in this field? If it\'s a dropdown/select, what option should I choose?\n' +
        'If this field should be left blank or is not applicable, respond with "SKIP".\n' +
        'Respond with ONLY the value to enter, nothing else.'
    );
    if (!result || result === 'SKIP' || result === 'skip') return null;
    return result;
}

/**
 * Check if a submission was confirmed after clicking submit.
 */
async function detectConfirmation(page) {
    const screenshot = await page.screenshot({ type: 'png' }).catch(() => null);
    if (!screenshot) return null;
    const result = await analyzeScreenshot(screenshot,
        'I just submitted a form on a government records request portal. Was the submission successful?\n' +
        'Look for: confirmation numbers, "thank you" messages, "request received" text, reference numbers, or any success indicators.\n' +
        'Also check for: error messages, validation warnings, or the same form still showing (meaning it was NOT submitted).\n' +
        'Respond with a JSON object: {"confirmed": true/false, "confirmationNumber": "the number if visible" or null, "reason": "brief explanation"}\n' +
        'Respond with ONLY the JSON, no other text.'
    );
    try { return JSON.parse(result); } catch { return null; }
}

/**
 * Decide which link/button to click for navigation.
 */
async function chooseNavigationTarget(page, agencyName, goal) {
    const screenshot = await page.screenshot({ type: 'png' }).catch(() => null);
    if (!screenshot) return null;
    const result = await analyzeScreenshot(screenshot,
        `I'm on a government portal for "${agencyName}". My goal: ${goal}\n` +
        'What link or button should I click? Respond with a JSON object:\n' +
        '{"clickText": "exact text to click", "elementType": "link" or "button" or "tile", "confidence": 0-100}\n' +
        'Respond with ONLY the JSON, no other text.'
    );
    try { return JSON.parse(result); } catch { return null; }
}

module.exports = {
    analyzeScreenshot,
    detectPageKind,
    findSubmitButton,
    mapUnknownField,
    detectConfirmation,
    chooseNavigationTarget,
};
