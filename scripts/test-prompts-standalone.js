#!/usr/bin/env node
/**
 * Standalone Prompt Tester
 *
 * Tests AI prompts directly against OpenAI without needing database.
 * Used for validating prompt changes before deploying.
 *
 * Usage:
 *   node scripts/test-prompts-standalone.js
 *   node scripts/test-prompts-standalone.js --fixture=portal
 *   node scripts/test-prompts-standalone.js --category=no_response
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const OpenAI = require('openai');

// Load prompts directly
const responseHandlingPrompts = require('../prompts/response-handling-prompts');

// Initialize OpenAI
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Load fixtures
const fixturesPath = path.join(__dirname, '../tests/fixtures/inbound/golden-fixtures.json');
const fixtures = JSON.parse(fs.readFileSync(fixturesPath, 'utf8'));

// ============================================================================
// INVARIANTS
// ============================================================================

// Canonical intent enum - must match prompts/response-handling-prompts.js
const VALID_INTENTS = [
    'portal_redirect', 'acknowledgment', 'fee_request', 'question',
    'more_info_needed', 'partial_delivery', 'records_ready', 'denial',
    'wrong_agency', 'hostile', 'other'
];

// Strict no-response intents - these should NEVER require a response
const NO_RESPONSE_INTENTS = ['portal_redirect', 'acknowledgment', 'wrong_agency'];

// Blocking intents - these MUST require a response (they block progress)
const BLOCKING_INTENTS = ['fee_request', 'question', 'more_info_needed', 'hostile'];

// Suggested action by denial subtype
const DENIAL_ACTIONS = {
    'ongoing_investigation': 'send_rebuttal',
    'privacy_exemption': 'send_rebuttal',
    'no_records': 'respond',
    'retention_expired': 'respond',
    'other': 'send_rebuttal'
};

const PORTAL_FORBIDDEN = [
    'email is valid', 'email is a valid', 'treat this email',
    'law requires', 'statute requires', 'legally required'
];

// ============================================================================
// PROMPT TESTING
// ============================================================================

/**
 * Call OpenAI with analysis prompt
 */
async function analyzeWithPrompt(message, caseData) {
    const userMessage = `
Analyze this agency response:

FROM: ${message.from_email || 'agency@gov'}
SUBJECT: ${message.subject || 'Response'}
BODY:
${message.body_text}

CASE CONTEXT:
- Agency: ${caseData?.agency_name || 'Unknown Agency'}
- State: ${caseData?.state || 'Unknown'}
- Request: ${caseData?.request_summary || 'FOIA request'}
`;

    const response = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        temperature: 0,
        messages: [
            { role: 'system', content: responseHandlingPrompts.analysisSystemPrompt },
            { role: 'user', content: userMessage }
        ],
        response_format: { type: 'json_object' }
    });

    const content = response.choices[0].message.content;
    return JSON.parse(content);
}

/**
 * Generate follow-up email with OpenAI
 */
async function generateFollowup(caseData, followupNumber) {
    const userMessage = `
Generate follow-up #${followupNumber} for this overdue FOIA request:

CASE:
- Agency: ${caseData.agency_name}
- State: ${caseData.state}
- Original send date: ${caseData.send_date}
- Current follow-up count: ${caseData.followup_count}
- Request summary: ${caseData.request_summary || 'Public records request for incident report and related materials'}
`;

    const response = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        temperature: 0.3,
        messages: [
            { role: 'system', content: responseHandlingPrompts.followUpSystemPrompt },
            { role: 'user', content: userMessage }
        ]
    });

    return response.choices[0].message.content;
}

/**
 * Validate follow-up email against constraints
 */
function validateFollowup(followupText, expected, caseData) {
    const errors = [];
    const warnings = [];

    // Word count
    const wordCount = followupText.split(/\s+/).filter(w => w.length > 0).length;
    const maxWords = expected.draft_constraints?.max_words || 200;
    if (wordCount > maxWords) {
        errors.push(`Follow-up exceeds max words: ${wordCount} > ${maxWords}`);
    }

    // Forbidden words
    const mustNotInclude = expected.draft_constraints?.must_not_include || [];
    const textLower = followupText.toLowerCase();
    for (const forbidden of mustNotInclude) {
        if (textLower.includes(forbidden.toLowerCase())) {
            errors.push(`Follow-up contains forbidden phrase: "${forbidden}"`);
        }
    }

    // Should include
    const shouldInclude = expected.draft_constraints?.should_include || [];
    for (const required of shouldInclude) {
        if (!textLower.includes(required.toLowerCase())) {
            warnings.push(`Follow-up should include: "${required}"`);
        }
    }

    // Check for legal citations in follow-up #1 (forbidden)
    if (expected.followup_number === 1) {
        const legalPhrases = ['statute', 'pursuant', 'law requires', 'legally required', 'code §'];
        for (const phrase of legalPhrases) {
            if (textLower.includes(phrase.toLowerCase())) {
                errors.push(`Follow-up #1 must not contain legal citations: found "${phrase}"`);
            }
        }
    }

    return { errors, warnings, wordCount };
}

/**
 * Validate analysis against expected
 */
function validateAnalysis(analysis, expected, fixture) {
    const errors = [];
    const warnings = [];

    // Validate intent is in canonical list
    if (!VALID_INTENTS.includes(analysis.intent)) {
        errors.push(`Non-canonical intent: "${analysis.intent}" (valid: ${VALID_INTENTS.join(', ')})`);
    }

    // Intent match (supports array of acceptable intents)
    if (expected.intent) {
        const acceptableIntents = Array.isArray(expected.intent) ? expected.intent : [expected.intent];
        if (!acceptableIntents.includes(analysis.intent)) {
            errors.push(`Intent mismatch: got "${analysis.intent}", expected one of [${acceptableIntents.join(', ')}]`);
        }
    }

    // requires_response match
    if (expected.requires_response !== undefined) {
        if (analysis.requires_response !== expected.requires_response) {
            errors.push(`requires_response mismatch: got ${analysis.requires_response}, expected ${expected.requires_response}`);
        }
    }

    // Portal URL extraction (single canonical field)
    const portalUrl = analysis.portal_url;
    if (expected.portal_url && !portalUrl) {
        errors.push(`Portal URL not extracted (expected: ${expected.portal_url})`);
    }

    // HARD RULE: fee_request MUST have fee_amount as number
    if (analysis.intent === 'fee_request') {
        if (typeof analysis.fee_amount !== 'number' || analysis.fee_amount === null) {
            errors.push(`HARD RULE: fee_request must have fee_amount as number, got ${analysis.fee_amount}`);
        }
    }

    // Fee amount extraction - check if expected
    if (expected.fee_amount !== undefined) {
        const actualFee = analysis.fee_amount;
        if (actualFee !== expected.fee_amount) {
            errors.push(`Fee amount mismatch: got ${actualFee}, expected ${expected.fee_amount}`);
        }
    }

    // INVARIANT 1: No-response intents must have requires_response=false
    if (NO_RESPONSE_INTENTS.includes(analysis.intent)) {
        if (analysis.requires_response !== false) {
            errors.push(`INVARIANT: ${analysis.intent} must have requires_response=false`);
        }
    }

    // INVARIANT 2: Blocking intents must have requires_response=true
    if (BLOCKING_INTENTS.includes(analysis.intent)) {
        if (analysis.requires_response !== true) {
            errors.push(`INVARIANT: ${analysis.intent} must have requires_response=true`);
        }
    }

    // INVARIANT 3: portal_redirect must have portal_url
    if (analysis.intent === 'portal_redirect') {
        // Only error if the fixture message actually contains a URL
        const messageText = fixture.message?.body_text || '';
        const hasUrlInText = /https?:\/\/[^\s]+/.test(messageText);
        if (hasUrlInText && !portalUrl) {
            errors.push(`portal_redirect with URL in text must extract portal_url`);
        }
    }

    // INVARIANT 4: denial suggested_action must match subtype
    if (analysis.intent === 'denial' && analysis.denial_subtype) {
        const expectedAction = DENIAL_ACTIONS[analysis.denial_subtype];
        if (expectedAction && analysis.suggested_action !== expectedAction) {
            warnings.push(`Denial subtype ${analysis.denial_subtype} should have suggested_action=${expectedAction}, got ${analysis.suggested_action}`);
        }
    }

    // INVARIANT 5: suggested_action must be valid for intent
    if (analysis.intent === 'portal_redirect' && analysis.suggested_action !== 'use_portal') {
        errors.push(`portal_redirect must have suggested_action=use_portal, got ${analysis.suggested_action}`);
    }
    if (analysis.intent === 'acknowledgment' && analysis.suggested_action !== 'wait') {
        errors.push(`acknowledgment must have suggested_action=wait, got ${analysis.suggested_action}`);
    }
    if (analysis.intent === 'wrong_agency' && analysis.suggested_action !== 'find_correct_agency') {
        errors.push(`wrong_agency must have suggested_action=find_correct_agency, got ${analysis.suggested_action}`);
    }

    return { errors, warnings };
}

/**
 * Run a single fixture
 */
async function runFixture(fixture, options = {}) {
    const result = {
        fixture_id: fixture.fixture_id,
        category: fixture.category,
        passed: false,
        errors: [],
        warnings: [],
        analysis: null,
        followup_text: null,
        duration_ms: 0
    };

    const startTime = Date.now();

    try {
        // Handle followup fixtures (test follow-up generation)
        if (fixture.category === 'followup') {
            const followupNumber = fixture.expected.followup_number;
            const followupText = await generateFollowup(fixture.case_data, followupNumber);
            result.followup_text = followupText;

            // Validate followup
            const validation = validateFollowup(followupText, fixture.expected, fixture.case_data);
            result.errors = validation.errors;
            result.warnings = validation.warnings;
            result.word_count = validation.wordCount;

            result.passed = result.errors.length === 0;
            result.duration_ms = Date.now() - startTime;
            return result;
        }

        // Analyze the message (standard fixtures)
        const analysis = await analyzeWithPrompt(fixture.message, fixture.case_data);
        result.analysis = analysis;

        // Validate
        const validation = validateAnalysis(analysis, fixture.expected, fixture);
        result.errors = validation.errors;
        result.warnings = validation.warnings;

        result.passed = result.errors.length === 0;

    } catch (error) {
        result.errors.push(`Exception: ${error.message}`);
        result.passed = false;
    }

    result.duration_ms = Date.now() - startTime;
    return result;
}

// ============================================================================
// MAIN
// ============================================================================

async function main() {
    const args = process.argv.slice(2);
    const fixtureFilter = args.find(a => a.startsWith('--fixture='))?.split('=')[1];
    const categoryFilter = args.find(a => a.startsWith('--category='))?.split('=')[1];
    const verbose = args.includes('--verbose') || args.includes('-v');

    console.log('='.repeat(80));
    console.log('STANDALONE PROMPT TESTER (No Database Required)');
    console.log('='.repeat(80));
    console.log(`OpenAI Model: gpt-4o-mini`);
    console.log(`Fixtures: ${fixtures.fixtures.length}`);
    if (fixtureFilter) console.log(`Filter: fixture="${fixtureFilter}"`);
    if (categoryFilter) console.log(`Filter: category="${categoryFilter}"`);
    console.log('');

    // Filter fixtures
    let testFixtures = fixtures.fixtures;
    if (fixtureFilter) {
        testFixtures = testFixtures.filter(f =>
            f.fixture_id.toLowerCase().includes(fixtureFilter.toLowerCase())
        );
    }
    if (categoryFilter) {
        testFixtures = testFixtures.filter(f => f.category === categoryFilter);
    }

    console.log(`Running ${testFixtures.length} fixtures...\n`);

    const results = [];

    for (const fixture of testFixtures) {
        process.stdout.write(`Testing: ${fixture.fixture_id}...`);

        const result = await runFixture(fixture, { verbose });
        results.push(result);

        const status = result.passed ? '✅' : '❌';
        console.log(` ${status} (${result.duration_ms}ms)`);

        if (!result.passed || verbose) {
            for (const e of result.errors) {
                console.log(`    ❌ ${e}`);
            }
        }
        if (verbose) {
            for (const w of result.warnings) {
                console.log(`    ⚠️ ${w}`);
            }
            if (result.analysis) {
                console.log(`    Analysis: intent=${result.analysis.intent}, requires_response=${result.analysis.requires_response}`);
            }
        }
    }

    // Summary
    const passed = results.filter(r => r.passed).length;
    const failed = results.filter(r => !r.passed).length;

    console.log('\n' + '='.repeat(80));
    console.log('SUMMARY');
    console.log('='.repeat(80));
    console.log(`Total:  ${results.length}`);
    console.log(`Passed: ${passed} (${Math.round((passed / results.length) * 100)}%)`);
    console.log(`Failed: ${failed}`);

    // Check pass standards
    const noResponseResults = results.filter(r =>
        NO_RESPONSE_INTENTS.includes(r.analysis?.intent)
    );
    const portalCorrect = noResponseResults.filter(r =>
        r.analysis?.requires_response === false
    ).length;

    console.log('\n--- PASS STANDARDS ---');
    console.log(`No-response → requires_response=false: ${portalCorrect}/${noResponseResults.length}`);

    const allPassed = failed === 0;
    console.log('\n' + (allPassed ? '✅ ALL TESTS PASSED' : '❌ SOME TESTS FAILED'));

    // Write report
    const reportsDir = path.join(__dirname, '../tests/reports');
    if (!fs.existsSync(reportsDir)) fs.mkdirSync(reportsDir, { recursive: true });

    fs.writeFileSync(
        path.join(reportsDir, 'standalone-prompt-report.json'),
        JSON.stringify({
            timestamp: new Date().toISOString(),
            model: 'gpt-4o-mini',
            summary: { passed, failed, total: results.length },
            results
        }, null, 2)
    );

    console.log(`\nReport: tests/reports/standalone-prompt-report.json`);

    process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
});
