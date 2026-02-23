#!/usr/bin/env node
/**
 * Prompt Simulation Test Suite
 *
 * Local testing of AI prompts without API calls to staging.
 * Tests analyzeResponse() and generator functions against golden fixtures.
 *
 * Usage:
 *   node scripts/test-prompt-suite.js                  # Run all tests
 *   node scripts/test-prompt-suite.js --fixture=portal # Run specific fixture
 *   node scripts/test-prompt-suite.js --category=no_response
 *   node scripts/test-prompt-suite.js --verbose        # Show all output
 *   node scripts/test-prompt-suite.js --dry-run        # Don't call AI, just validate fixtures
 *
 * Pass Standards:
 *   - 100% JSON valid responses from analyzeResponse()
 *   - 100% portal_redirect → requires_response=false
 *   - 0% "email validity" arguments when portal exists
 *   - 0% statute citations on no-response intents
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');

// Lazy load AI service (only when not in dry-run mode)
let aiService = null;
function getAIService() {
    if (!aiService) {
        aiService = require('../services/ai-service');
    }
    return aiService;
}

// Load fixtures
const fixturesPath = path.join(__dirname, '../tests/fixtures/inbound/golden-fixtures.json');
const fixtures = JSON.parse(fs.readFileSync(fixturesPath, 'utf8'));

// ============================================================================
// INVARIANTS - Hard rules that must NEVER be violated
// ============================================================================

const INVARIANTS = {
    // Intents that must NEVER generate a response
    NO_RESPONSE_INTENTS: ['portal_redirect', 'acknowledgment', 'records_ready', 'delivery', 'partial_delivery', 'wrong_agency'],

    // Forbidden phrases in drafts when portal is mentioned
    PORTAL_FORBIDDEN_PHRASES: [
        'email is valid',
        'email is a valid',
        'treat this email',
        'law requires',
        'statute requires',
        'legally required to accept',
        'must process',
        'obligated to process'
    ],

    // Forbidden phrases in no-response scenarios
    NO_RESPONSE_FORBIDDEN_PHRASES: [
        'pursuant to',
        'per statute',
        'under statute',
        'ILCS',
        'Gov Code',
        'FOIL',
        '§'  // Section symbol
    ],

    // Word limits by intent
    WORD_LIMITS: {
        'more_info_needed': 100,
        'question': 100,
        'fee_request': 150,
        'denial': 200,
        'hostile': 150,
        'followup_1': 120,
        'followup_2': 150,
        'followup_3': 180
    }
};

// ============================================================================
// VALIDATION FUNCTIONS
// ============================================================================

/**
 * Validate JSON structure from analyzeResponse
 */
function validateJsonStructure(analysis) {
    const errors = [];

    // Required fields
    const requiredFields = ['intent', 'requires_response', 'suggested_action'];
    for (const field of requiredFields) {
        if (analysis[field] === undefined) {
            errors.push(`Missing required field: ${field}`);
        }
    }

    // Intent must be from allowed list
    const allowedIntents = [
        'portal_redirect', 'records_ready', 'acknowledgment', 'fee_request',
        'more_info_needed', 'question', 'partial_delivery', 'delivery',
        'denial', 'wrong_agency', 'hostile', 'other'
    ];
    if (analysis.intent && !allowedIntents.includes(analysis.intent)) {
        errors.push(`Invalid intent: ${analysis.intent}`);
    }

    // requires_response must be boolean
    if (typeof analysis.requires_response !== 'boolean') {
        errors.push(`requires_response must be boolean, got: ${typeof analysis.requires_response}`);
    }

    // confidence must be number 0-1
    if (analysis.confidence !== undefined) {
        if (typeof analysis.confidence !== 'number' || analysis.confidence < 0 || analysis.confidence > 1) {
            errors.push(`confidence must be number 0-1, got: ${analysis.confidence}`);
        }
    }

    // portal_url extraction when portal_redirect
    if (analysis.intent === 'portal_redirect' && !analysis.portal_url) {
        errors.push(`portal_redirect intent but no portal_url extracted`);
    }

    // fee_amount extraction when fee_request
    if (analysis.intent === 'fee_request' && analysis.fee_amount === undefined) {
        errors.push(`fee_request intent but no fee_amount extracted`);
    }

    return errors;
}

/**
 * Validate portal redirect handling
 */
function validatePortalRedirect(analysis, draft) {
    const errors = [];

    if (analysis.intent === 'portal_redirect') {
        // Must have requires_response = false
        if (analysis.requires_response !== false) {
            errors.push(`INVARIANT VIOLATION: portal_redirect must have requires_response=false`);
        }

        // Must not have generated a draft
        if (draft && draft.body_text) {
            errors.push(`INVARIANT VIOLATION: portal_redirect generated a draft email`);

            // Check for forbidden phrases
            const lowerDraft = draft.body_text.toLowerCase();
            for (const phrase of INVARIANTS.PORTAL_FORBIDDEN_PHRASES) {
                if (lowerDraft.includes(phrase.toLowerCase())) {
                    errors.push(`INVARIANT VIOLATION: Draft contains forbidden phrase: "${phrase}"`);
                }
            }
        }
    }

    return errors;
}

/**
 * Validate no-response intents
 */
function validateNoResponseIntent(analysis, draft, fixture) {
    const errors = [];

    if (INVARIANTS.NO_RESPONSE_INTENTS.includes(analysis.intent)) {
        // Must have requires_response = false
        if (analysis.requires_response !== false) {
            errors.push(`INVARIANT VIOLATION: ${analysis.intent} must have requires_response=false`);
        }

        // Must not generate draft
        if (draft && draft.body_text && draft.should_auto_reply) {
            errors.push(`INVARIANT VIOLATION: ${analysis.intent} generated a draft email`);

            // Check for statute citations
            const lowerDraft = draft.body_text.toLowerCase();
            for (const phrase of INVARIANTS.NO_RESPONSE_FORBIDDEN_PHRASES) {
                if (lowerDraft.includes(phrase.toLowerCase())) {
                    errors.push(`INVARIANT VIOLATION: No-response draft contains statute language: "${phrase}"`);
                }
            }
        }
    }

    return errors;
}

/**
 * Validate draft content
 */
function validateDraft(draft, analysis, fixture) {
    const errors = [];
    const warnings = [];

    if (!draft || !draft.body_text) {
        return { errors, warnings };
    }

    const text = draft.body_text;
    const wordCount = text.trim().split(/\s+/).filter(w => w.length > 0).length;

    // Check word limits
    const limit = INVARIANTS.WORD_LIMITS[analysis.intent] || 200;
    if (wordCount > limit) {
        errors.push(`Word count ${wordCount} exceeds limit ${limit} for ${analysis.intent}`);
    }

    // Check for forbidden phrases based on fixture
    if (fixture.expected?.draft_constraints?.must_not_include) {
        const lowerText = text.toLowerCase();
        for (const phrase of fixture.expected.draft_constraints.must_not_include) {
            if (lowerText.includes(phrase.toLowerCase())) {
                errors.push(`Draft contains forbidden phrase: "${phrase}"`);
            }
        }
    }

    // Check for required phrases
    if (fixture.expected?.draft_constraints?.must_include) {
        const lowerText = text.toLowerCase();
        for (const phrase of fixture.expected.draft_constraints.must_include) {
            if (!lowerText.includes(phrase.toLowerCase())) {
                warnings.push(`Draft missing required phrase: "${phrase}"`);
            }
        }
    }

    // Check signature
    if (!text.includes('Samuel Hylton') && !text.includes('Dr Insanity')) {
        warnings.push(`Draft missing proper signature`);
    }

    return { errors, warnings };
}

/**
 * Check if analysis matches expected values
 */
function validateExpected(analysis, expected, fixture) {
    const errors = [];
    const warnings = [];

    // Intent match
    if (expected.intent && analysis.intent !== expected.intent) {
        errors.push(`Intent mismatch: got "${analysis.intent}", expected "${expected.intent}"`);
    }

    // requires_response match
    if (expected.requires_response !== undefined && analysis.requires_response !== expected.requires_response) {
        errors.push(`requires_response mismatch: got ${analysis.requires_response}, expected ${expected.requires_response}`);
    }

    // suggested_action match
    if (expected.suggested_action && analysis.suggested_action !== expected.suggested_action) {
        warnings.push(`suggested_action mismatch: got "${analysis.suggested_action}", expected "${expected.suggested_action}"`);
    }

    // Portal URL extraction
    if (expected.portal_url && !analysis.portal_url) {
        errors.push(`Portal URL not extracted (expected: ${expected.portal_url})`);
    }

    // Fee amount extraction
    if (expected.fee_amount !== undefined) {
        const actualFee = analysis.fee_amount || analysis.extracted_fee_amount;
        if (actualFee !== expected.fee_amount) {
            warnings.push(`Fee amount mismatch: got ${actualFee}, expected ${expected.fee_amount}`);
        }
    }

    return { errors, warnings };
}

// ============================================================================
// TEST RUNNER
// ============================================================================

/**
 * Run a single fixture test
 */
async function runFixture(fixture, options = {}) {
    const result = {
        fixture_id: fixture.fixture_id,
        category: fixture.category,
        description: fixture.description,
        passed: false,
        invariant_violations: [],
        errors: [],
        warnings: [],
        analysis: null,
        draft: null,
        duration_ms: 0
    };

    const startTime = Date.now();

    try {
        if (options.dryRun) {
            // Dry run - just validate fixture structure
            if (!fixture.message) result.errors.push('Missing message field');
            if (!fixture.expected) result.errors.push('Missing expected field');
            if (!fixture.expected?.intent) result.errors.push('Missing expected.intent');
            result.passed = result.errors.length === 0;
            return result;
        }

        // Step 1: Run analyzeResponse
        if (options.verbose) {
            console.log(`  Analyzing response...`);
        }

        const analysis = await getAIService().analyzeResponse(
            fixture.message,
            fixture.case_data || {}
        );
        result.analysis = analysis;

        // Step 2: Validate JSON structure
        const jsonErrors = validateJsonStructure(analysis);
        result.errors.push(...jsonErrors);

        // Step 3: Validate against expected
        const expectedValidation = validateExpected(analysis, fixture.expected, fixture);
        result.errors.push(...expectedValidation.errors);
        result.warnings.push(...expectedValidation.warnings);

        // Step 4: Validate invariants
        const portalErrors = validatePortalRedirect(analysis, null);
        result.invariant_violations.push(...portalErrors);

        const noResponseErrors = validateNoResponseIntent(analysis, null, fixture);
        result.invariant_violations.push(...noResponseErrors);

        // Step 5: Generate draft if requires_response=true
        let draft = null;
        if (analysis.requires_response === true && fixture.expected?.should_draft_email !== false) {
            if (options.verbose) {
                console.log(`  Generating draft (${analysis.intent})...`);
            }

            // Choose appropriate generator based on intent
            if (analysis.intent === 'denial') {
                draft = await getAIService().generateAutoReply(
                    fixture.message,
                    analysis,
                    fixture.case_data || {}
                );
            } else if (analysis.intent === 'fee_request') {
                const feeAmount = analysis.fee_amount || fixture.expected?.fee_amount || 50;
                if (feeAmount <= 100) {
                    draft = await getAIService().generateFeeAcceptance(fixture.case_data || {}, feeAmount);
                } else {
                    draft = await getAIService().generateFeeResponse(fixture.case_data || {}, {
                        feeAmount,
                        recommendedAction: 'negotiate'
                    });
                }
            } else if (analysis.intent === 'more_info_needed' || analysis.intent === 'question') {
                draft = await getAIService().generateClarificationResponse(
                    fixture.message,
                    analysis,
                    fixture.case_data || {}
                );
            } else {
                draft = await getAIService().generateAutoReply(
                    fixture.message,
                    analysis,
                    fixture.case_data || {}
                );
            }

            result.draft = draft;

            // Validate draft
            const draftValidation = validateDraft(draft, analysis, fixture);
            result.errors.push(...draftValidation.errors);
            result.warnings.push(...draftValidation.warnings);

            // Re-check invariants with draft
            const portalWithDraft = validatePortalRedirect(analysis, draft);
            result.invariant_violations.push(...portalWithDraft);

            const noResponseWithDraft = validateNoResponseIntent(analysis, draft, fixture);
            result.invariant_violations.push(...noResponseWithDraft);
        }

        // Step 6: Check if draft was generated when it shouldn't be
        if (fixture.expected?.should_draft_email === false) {
            // Try to generate and verify it returns no draft
            const testDraft = await getAIService().generateAutoReply(
                fixture.message,
                analysis,
                fixture.case_data || {}
            );

            if (testDraft && testDraft.should_auto_reply && testDraft.body_text) {
                result.invariant_violations.push(`Draft generated when should_draft_email=false`);
                result.draft = testDraft;
            }
        }

        // Determine pass/fail
        result.passed = result.invariant_violations.length === 0 && result.errors.length === 0;

    } catch (error) {
        result.errors.push(`Exception: ${error.message}`);
        result.passed = false;
    }

    result.duration_ms = Date.now() - startTime;
    return result;
}

/**
 * Run followup fixture test
 */
async function runFollowupFixture(fixture, options = {}) {
    const result = {
        fixture_id: fixture.fixture_id,
        category: fixture.category,
        description: fixture.description,
        passed: false,
        invariant_violations: [],
        errors: [],
        warnings: [],
        draft: null,
        duration_ms: 0
    };

    const startTime = Date.now();

    try {
        if (options.dryRun) {
            result.passed = true;
            return result;
        }

        const followupCount = fixture.case_data?.followup_count || 0;

        if (options.verbose) {
            console.log(`  Generating followup #${followupCount + 1}...`);
        }

        const draft = await getAIService().generateFollowUp(
            fixture.case_data,
            followupCount
        );
        result.draft = draft;

        // Validate draft
        const intentKey = `followup_${followupCount + 1}`;
        const draftValidation = validateDraft(draft, { intent: intentKey }, fixture);
        result.errors.push(...draftValidation.errors);
        result.warnings.push(...draftValidation.warnings);

        result.passed = result.errors.length === 0 && result.invariant_violations.length === 0;

    } catch (error) {
        result.errors.push(`Exception: ${error.message}`);
        result.passed = false;
    }

    result.duration_ms = Date.now() - startTime;
    return result;
}

// ============================================================================
// REPORTING
// ============================================================================

/**
 * Generate summary statistics
 */
function generateSummary(results) {
    const total = results.length;
    const passed = results.filter(r => r.passed).length;
    const failed = results.filter(r => !r.passed).length;
    const invariantViolations = results.reduce((sum, r) => sum + r.invariant_violations.length, 0);
    const warnings = results.reduce((sum, r) => sum + r.warnings.length, 0);

    // Specific pass standards
    const jsonValid = results.filter(r =>
        !r.errors.some(e => e.includes('Missing required field') || e.includes('Invalid intent'))
    ).length;

    const portalCorrect = results.filter(r =>
        !r.invariant_violations.some(v => v.includes('portal_redirect'))
    ).length;

    const noEmailValidity = results.filter(r =>
        !r.invariant_violations.some(v => v.includes('email validity') || v.includes('forbidden phrase'))
    ).length;

    const noStatuteCitations = results.filter(r =>
        !r.invariant_violations.some(v => v.includes('statute language'))
    ).length;

    return {
        total,
        passed,
        failed,
        passRate: Math.round((passed / total) * 100),
        invariantViolations,
        warnings,
        // Pass standards
        jsonValidRate: Math.round((jsonValid / total) * 100),
        portalCorrectRate: Math.round((portalCorrect / total) * 100),
        noEmailValidityRate: Math.round((noEmailValidity / total) * 100),
        noStatuteCitationsRate: Math.round((noStatuteCitations / total) * 100)
    };
}

/**
 * Print results to console
 */
function printResults(results, summary, verbose) {
    console.log('\n' + '='.repeat(80));
    console.log('PROMPT SIMULATION TEST RESULTS');
    console.log('='.repeat(80));

    // Group by category
    const byCategory = {};
    for (const result of results) {
        if (!byCategory[result.category]) {
            byCategory[result.category] = [];
        }
        byCategory[result.category].push(result);
    }

    for (const [category, categoryResults] of Object.entries(byCategory)) {
        const categoryPassed = categoryResults.filter(r => r.passed).length;
        console.log(`\n### ${category} (${categoryPassed}/${categoryResults.length})`);

        for (const result of categoryResults) {
            const status = result.passed ? '✅' : '❌';
            console.log(`  ${status} ${result.fixture_id} (${result.duration_ms}ms)`);

            if (!result.passed || verbose) {
                for (const v of result.invariant_violations) {
                    console.log(`      🚨 ${v}`);
                }
                for (const e of result.errors) {
                    console.log(`      ❌ ${e}`);
                }
            }
            if (verbose) {
                for (const w of result.warnings) {
                    console.log(`      ⚠️ ${w}`);
                }
            }
        }
    }

    // Summary
    console.log('\n' + '='.repeat(80));
    console.log('SUMMARY');
    console.log('='.repeat(80));
    console.log(`Total:    ${summary.total}`);
    console.log(`Passed:   ${summary.passed} (${summary.passRate}%)`);
    console.log(`Failed:   ${summary.failed}`);
    console.log(`Warnings: ${summary.warnings}`);
    console.log(`Invariant Violations: ${summary.invariantViolations}`);

    // Pass standards
    console.log('\n--- PASS STANDARDS ---');
    console.log(`JSON Valid:           ${summary.jsonValidRate}% (target: 100%)`);
    console.log(`Portal → No Response: ${summary.portalCorrectRate}% (target: 100%)`);
    console.log(`No Email Validity:    ${summary.noEmailValidityRate}% (target: 100%)`);
    console.log(`No Statute Citations: ${summary.noStatuteCitationsRate}% (target: 100%)`);

    const allStandardsMet =
        summary.jsonValidRate === 100 &&
        summary.portalCorrectRate === 100 &&
        summary.noEmailValidityRate === 100 &&
        summary.noStatuteCitationsRate === 100;

    console.log('\n' + (allStandardsMet ? '✅ ALL PASS STANDARDS MET' : '❌ SOME PASS STANDARDS NOT MET'));
}

/**
 * Write JSON report
 */
function writeReport(results, summary) {
    const reportsDir = path.join(__dirname, '../tests/reports');
    if (!fs.existsSync(reportsDir)) {
        fs.mkdirSync(reportsDir, { recursive: true });
    }

    const report = {
        timestamp: new Date().toISOString(),
        summary,
        pass_standards: {
            json_valid: { target: 100, actual: summary.jsonValidRate },
            portal_no_response: { target: 100, actual: summary.portalCorrectRate },
            no_email_validity_args: { target: 100, actual: summary.noEmailValidityRate },
            no_statute_citations: { target: 100, actual: summary.noStatuteCitationsRate }
        },
        results
    };

    fs.writeFileSync(
        path.join(reportsDir, 'prompt-simulation-report.json'),
        JSON.stringify(report, null, 2)
    );

    console.log(`\nReport written to: tests/reports/prompt-simulation-report.json`);
}

// ============================================================================
// MAIN
// ============================================================================

async function main() {
    const args = process.argv.slice(2);
    const fixtureFilter = args.find(a => a.startsWith('--fixture='))?.split('=')[1];
    const categoryFilter = args.find(a => a.startsWith('--category='))?.split('=')[1];
    const verbose = args.includes('--verbose') || args.includes('-v');
    const dryRun = args.includes('--dry-run');

    console.log('='.repeat(80));
    console.log('PROMPT SIMULATION TEST SUITE');
    console.log('='.repeat(80));
    console.log(`Fixtures: ${fixtures.fixtures.length}`);
    console.log(`Mode: ${dryRun ? 'DRY RUN (no AI calls)' : 'LIVE (calling AI)'}`);
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
        console.log(`Running: ${fixture.fixture_id}...`);

        let result;
        if (fixture.category === 'followup') {
            result = await runFollowupFixture(fixture, { verbose, dryRun });
        } else {
            result = await runFixture(fixture, { verbose, dryRun });
        }

        results.push(result);

        const status = result.passed ? '✅' : '❌';
        console.log(`  ${status} (${result.duration_ms}ms)`);
    }

    const summary = generateSummary(results);
    printResults(results, summary, verbose);
    writeReport(results, summary);

    // Exit with error if any failed
    process.exit(summary.failed > 0 ? 1 : 0);
}

main().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
});
