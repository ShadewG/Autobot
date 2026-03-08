/**
 * Local test script for portal automation
 * Tests Playwright form filling WITHOUT deploying to Railway
 *
 * Usage:
 *   node test-portal-local.js [portal-url]
 *
 * Example:
 *   node test-portal-local.js "https://lawenforcementrecordsrequest.delawarecountypa.gov/"
 */

require('dotenv').config();
const { chromium } = require('playwright');

// Test data based on the "Smoke, Silence, and Second-Degree Murder" case
const TEST_CASE_DATA = {
    case_name: 'Smoke, Silence, and Second-Degree Murder',
    subject_name: 'Gavonte & Shantrell',
    agency_name: 'Test Police Department',
    state: 'PA',
    incident_date: '2024-01-15',
    incident_location: '123 Main St, Philadelphia, PA',
    requested_records: ['Police report', 'Body cam footage', 'Incident report'],
    additional_details: 'Double homicide investigation'
};

/**
 * Analyze form fields on the page
 */
async function analyzeForm(page) {
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
 * Map form field to case data
 */
function mapFieldToCaseData(field, caseData) {
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
    if (label.includes('location') || (label.includes('address') && label.includes('incident'))) {
        return caseData.incident_location || '';
    }

    // Record type (checkbox/select)
    if (label.includes('record type') || label.includes('document type')) {
        if (field.options) {
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
 * Fill form fields
 */
async function fillForm(page, formAnalysis, caseData) {
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

            let value = mapFieldToCaseData(field, caseData);

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
                await page.selectOption(selector, { label: value });
                filledFields.push({ field: field.label || field.name, value });
            } else if (field.type === 'checkbox') {
                if (value === true || value === 'true') {
                    await page.check(selector);
                    filledFields.push({ field: field.label || field.name, value: 'checked' });
                }
            } else if (field.type === 'radio') {
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
                await page.fill(selector, value.toString());
                filledFields.push({ field: field.label || field.name, value });
            }

            console.log(`✓ Filled: ${field.label || field.name} = ${value}`);

        } catch (error) {
            console.warn(`⚠ Could not fill field ${field.name}:`, error.message);
        }
    }

    return filledFields;
}

/**
 * Find submit button
 */
async function findSubmitButton(page) {
    const buttons = await page.evaluate(() => {
        const buttonElements = [];

        document.querySelectorAll('button, input[type="submit"]').forEach((btn, index) => {
            const text = btn.textContent?.trim() || btn.value || '';
            const lowerText = text.toLowerCase();

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
 * Main test function
 */
async function testPortal(portalUrl) {
    console.log('\n=================================');
    console.log('🧪 PORTAL AUTOMATION TEST');
    console.log('=================================\n');
    console.log(`Portal URL: ${portalUrl}`);
    console.log(`Test Mode: DRY RUN (will NOT submit)\n`);

    let browser, context, page;

    try {
        console.log('🚀 Launching browser...');
        browser = await chromium.launch({
            headless: false, // Set to false so you can see what's happening
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox'
            ]
        });

        context = await browser.newContext({
            viewport: { width: 1280, height: 720 },
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        });

        page = await context.newPage();

        console.log('🌐 Navigating to portal...');
        await page.goto(portalUrl, { waitUntil: 'networkidle', timeout: 30000 });
        await page.waitForTimeout(2000);

        console.log('📸 Taking initial screenshot...');
        await page.screenshot({ path: 'portal-initial.png', fullPage: true });
        console.log('   Saved: portal-initial.png');

        console.log('\n🔍 Analyzing form fields...');
        const formAnalysis = await analyzeForm(page);
        console.log(`   Found ${formAnalysis.visibleFields} visible fields (${formAnalysis.totalFields} total)\n`);

        console.log('📝 Form fields detected:');
        formAnalysis.fields.forEach((f, i) => {
            console.log(`   ${i + 1}. ${f.label || f.name} (${f.type})`);
        });

        console.log('\n✍️  Filling form fields...');
        const filledFields = await fillForm(page, formAnalysis, TEST_CASE_DATA);

        console.log(`\n✅ Successfully filled ${filledFields.length} fields:`);
        filledFields.forEach(f => {
            const displayValue = f.value.length > 100 ? f.value.substring(0, 100) + '...' : f.value;
            console.log(`   • ${f.field}: ${displayValue}`);
        });

        console.log('\n📸 Taking filled screenshot...');
        await page.screenshot({ path: 'portal-filled.png', fullPage: true });
        console.log('   Saved: portal-filled.png');

        console.log('\n🔘 Finding submit button...');
        const submitButton = await findSubmitButton(page);

        if (submitButton) {
            console.log(`   Found: "${submitButton.text}"`);
            console.log(`\n🛑 DRY RUN - NOT submitting (would click: "${submitButton.text}")`);
        } else {
            console.log('   ⚠️  No submit button found!');
        }

        console.log('\n=================================');
        console.log('✅ TEST COMPLETE');
        console.log('=================================\n');
        console.log('Results:');
        console.log(`  • Fields found: ${formAnalysis.visibleFields}`);
        console.log(`  • Fields filled: ${filledFields.length}`);
        console.log(`  • Submit button: ${submitButton ? '✓' : '✗'}`);
        console.log(`  • Screenshots: portal-initial.png, portal-filled.png\n`);

        // Keep browser open for 5 seconds so you can see the result
        console.log('Keeping browser open for 5 seconds...\n');
        await page.waitForTimeout(5000);

    } catch (error) {
        console.error('\n❌ ERROR:', error.message);
        if (page) {
            await page.screenshot({ path: 'portal-error.png', fullPage: true });
            console.log('Error screenshot saved: portal-error.png');
        }
        throw error;
    } finally {
        if (browser) {
            await browser.close();
            console.log('Browser closed.\n');
        }
    }
}

// Run the test
const portalUrl = process.argv[2] || 'https://lawenforcementrecordsrequest.delawarecountypa.gov/';

testPortal(portalUrl)
    .then(() => {
        console.log('✅ Test completed successfully');
        process.exit(0);
    })
    .catch(error => {
        console.error('❌ Test failed:', error);
        process.exit(1);
    });
