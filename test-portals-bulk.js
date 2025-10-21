/**
 * Bulk test portal automation
 * Tests multiple portals and generates a report
 */

require('dotenv').config();
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

// Test data
const TEST_CASE_DATA = {
    case_name: 'Test FOIA Request',
    subject_name: 'John Doe',
    agency_name: 'Test Police Department',
    state: 'CA',
    incident_date: '2024-01-15',
    incident_location: '123 Main St, Test City',
    requested_records: ['Police report', 'Body cam footage', 'Incident report'],
    additional_details: 'Test request for automation testing'
};

// Portal URLs to test
const PORTAL_URLS = [
    'https://abilenetxopenrecords.nextrequest.com/requests/new',
    'https://alamedaca.nextrequest.com/requests/new',
    'https://albanyny.nextrequest.com/requests/new',
    'https://alexandriava.nextrequest.com/requests/new',
    'https://annarbormi.nextrequest.com/requests/new',
    'https://arlingtontx.nextrequest.com/requests/new',
    'https://atlantaga.nextrequest.com/requests/new',
    'https://austintexas.nextrequest.com/requests/new',
    'https://batonrougela.nextrequest.com/requests/new',
    'https://berkeleyka.nextrequest.com/requests/new',
    'https://birminghamal.nextrequest.com/requests/new',
    'https://bocaratonfl.nextrequest.com/requests/new',
    'https://boiseid.nextrequest.com/requests/new',
    'https://bostonma.nextrequest.com/requests/new',
    'https://bouldercolorado.nextrequest.com/requests/new',
    'https://cambridgema.nextrequest.com/requests/new',
    'https://charlottenc.nextrequest.com/requests/new',
    'https://chattanoogatn.nextrequest.com/requests/new',
    'https://chicagoil.nextrequest.com/requests/new',
    'https://cincinnatioh.nextrequest.com/requests/new',
    'https://columbusga.nextrequest.com/requests/new',
    'https://dallastexas.nextrequest.com/requests/new',
    'https://denverco.nextrequest.com/requests/new',
    'https://detroitmi.nextrequest.com/requests/new',
    'https://durhamny.nextrequest.com/requests/new',
    'https://elpasotexas.nextrequest.com/requests/new',
    'https://evanstonil.nextrequest.com/requests/new',
    'https://fortworthtx.nextrequest.com/requests/new',
    'https://fresnoca.nextrequest.com/requests/new',
    'https://grandrapidsmi.nextrequest.com/requests/new'
];

/**
 * Analyze form fields
 */
async function analyzeForm(page) {
    const formFields = await page.evaluate(() => {
        const fields = [];
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

            let label = '';
            if (el.id) {
                const labelEl = document.querySelector(`label[for="${el.id}"]`);
                if (labelEl) label = labelEl.textContent.trim();
            }

            if (!label && el.parentElement) {
                const parentText = el.parentElement.textContent.trim();
                if (parentText.length < 100) {
                    label = parentText.replace(el.value || '', '').trim();
                }
            }

            field.label = label;

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
 * Map field to case data
 */
function mapFieldToCaseData(field, caseData) {
    const label = (field.label || field.name || field.placeholder).toLowerCase();

    if (label.includes('email') || field.type === 'email') {
        return 'test@example.com';
    }

    if (label.includes('phone')) {
        return '';
    }

    if (label.includes('street') || label.includes('city') || label.includes('zip')) {
        return '';
    }

    if (label.includes('address') && !label.includes('email')) {
        return '';
    }

    if (label.includes('redaction') || label.includes('agree') || label.includes('acknowledge')) {
        if (field.type === 'checkbox') {
            return true;
        }
        return 'Yes';
    }

    if (label.includes('company') || label.includes('organization')) {
        return '';
    }

    if (label.includes('name')) {
        if (label.includes('subject') || label.includes('individual') || label.includes('person of interest')) {
            return caseData.subject_name || caseData.case_name;
        }
        return 'Test User';
    }

    if (label.includes('description') || label.includes('details') ||
        label.includes('request') || label.includes('information sought')) {
        const records = Array.isArray(caseData.requested_records)
            ? caseData.requested_records.join(', ')
            : caseData.requested_records || 'police records';

        return `Requesting ${records} related to an incident involving ${caseData.subject_name || 'subject'} on ${caseData.incident_date || 'the date in question'} at ${caseData.incident_location || 'the location in question'}. ${caseData.additional_details || ''}`;
    }

    if (label.includes('date') && !label.includes('birth')) {
        return caseData.incident_date || '';
    }

    if (label.includes('location') || (label.includes('address') && label.includes('incident'))) {
        return caseData.incident_location || '';
    }

    return null;
}

/**
 * Fill form
 */
async function fillForm(page, formAnalysis, caseData) {
    const filledFields = [];
    let hasFilledDescription = false;

    for (const field of formAnalysis.fields) {
        try {
            let selector;
            if (field.id) {
                selector = `#${field.id}`;
            } else if (field.type === 'contenteditable') {
                selector = `[contenteditable="true"]`;
            } else if (field.name) {
                selector = `[name="${field.name}"]`;
            } else {
                continue;
            }

            let value = mapFieldToCaseData(field, caseData);

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

        } catch (error) {
            // Silently skip fields that can't be filled
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
 * Test single portal
 */
async function testPortal(browser, portalUrl, index, total) {
    const startTime = Date.now();
    console.log(`\n[${index}/${total}] Testing: ${portalUrl}`);

    let context, page;

    try {
        context = await browser.newContext({
            viewport: { width: 1280, height: 720 },
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        });

        page = await context.newPage();

        await page.goto(portalUrl, { waitUntil: 'networkidle', timeout: 30000 });
        await page.waitForTimeout(2000);

        const formAnalysis = await analyzeForm(page);
        const filledFields = await fillForm(page, formAnalysis, TEST_CASE_DATA);
        const submitButton = await findSubmitButton(page);

        const duration = Date.now() - startTime;

        console.log(`   ✅ Fields: ${filledFields.length}/${formAnalysis.visibleFields} | Submit: ${submitButton ? '✓' : '✗'} | ${duration}ms`);

        return {
            url: portalUrl,
            success: true,
            fieldsFound: formAnalysis.visibleFields,
            fieldsFilled: filledFields.length,
            submitButtonFound: !!submitButton,
            submitButtonText: submitButton?.text || null,
            duration
        };

    } catch (error) {
        const duration = Date.now() - startTime;
        console.log(`   ❌ Error: ${error.message} | ${duration}ms`);

        return {
            url: portalUrl,
            success: false,
            error: error.message,
            duration
        };
    } finally {
        if (page) await page.close();
        if (context) await context.close();
    }
}

/**
 * Main function
 */
async function runBulkTest() {
    console.log('🧪 BULK PORTAL TESTING');
    console.log('======================\n');
    console.log(`Testing ${PORTAL_URLS.length} portals...\n`);

    const results = [];
    let browser;

    try {
        console.log('🚀 Launching browser...');
        browser = await chromium.launch({
            headless: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox']
        });

        for (let i = 0; i < PORTAL_URLS.length; i++) {
            const result = await testPortal(browser, PORTAL_URLS[i], i + 1, PORTAL_URLS.length);
            results.push(result);

            // Small delay between tests
            await new Promise(resolve => setTimeout(resolve, 1000));
        }

    } finally {
        if (browser) {
            await browser.close();
        }
    }

    // Generate report
    console.log('\n\n📊 RESULTS SUMMARY');
    console.log('==================\n');

    const successful = results.filter(r => r.success);
    const failed = results.filter(r => !r.success);
    const withSubmitButton = successful.filter(r => r.submitButtonFound);
    const avgFields = successful.reduce((sum, r) => sum + r.fieldsFilled, 0) / successful.length;

    console.log(`Total Tested: ${results.length}`);
    console.log(`✅ Successful: ${successful.length} (${Math.round(successful.length / results.length * 100)}%)`);
    console.log(`❌ Failed: ${failed.length} (${Math.round(failed.length / results.length * 100)}%)`);
    console.log(`🔘 With Submit Button: ${withSubmitButton.length}`);
    console.log(`📝 Avg Fields Filled: ${avgFields.toFixed(1)}`);

    // Save detailed results
    const reportPath = 'portal-test-results.json';
    fs.writeFileSync(reportPath, JSON.stringify({
        timestamp: new Date().toISOString(),
        summary: {
            total: results.length,
            successful: successful.length,
            failed: failed.length,
            withSubmitButton: withSubmitButton.length,
            avgFieldsFilled: avgFields
        },
        results
    }, null, 2));

    console.log(`\n📄 Detailed results saved to: ${reportPath}`);

    // Show top performers
    console.log('\n🏆 Top 5 Portals (Most Fields Filled):');
    successful
        .sort((a, b) => b.fieldsFilled - a.fieldsFilled)
        .slice(0, 5)
        .forEach((r, i) => {
            console.log(`${i + 1}. ${r.url.replace('https://', '').substring(0, 40)}... (${r.fieldsFilled} fields)`);
        });

    // Show failures
    if (failed.length > 0) {
        console.log('\n❌ Failed Portals:');
        failed.forEach((r, i) => {
            console.log(`${i + 1}. ${r.url}`);
            console.log(`   Error: ${r.error}`);
        });
    }
}

runBulkTest()
    .then(() => {
        console.log('\n✅ Bulk testing complete!');
        process.exit(0);
    })
    .catch(error => {
        console.error('\n❌ Bulk testing failed:', error);
        process.exit(1);
    });
