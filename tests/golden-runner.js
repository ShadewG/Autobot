#!/usr/bin/env node
/**
 * Golden Fixture Test Runner
 *
 * Runs deterministic simulations against golden fixtures and validates outputs.
 *
 * Usage:
 *   node tests/golden-runner.js                    # Run all tests
 *   node tests/golden-runner.js --fixture=portal   # Run fixtures matching 'portal'
 *   node tests/golden-runner.js --category=followup # Run only followup tests
 *   node tests/golden-runner.js --update-snapshots # Update expected values
 *
 * Outputs:
 *   tests/reports/report.json
 *   tests/reports/report.md
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');

// Configuration for deterministic runs
const DETERMINISTIC_CONFIG = {
    temperature: 0,
    seed: 42,
    max_tokens: 2000,
    timeout_ms: 30000
};

// Load fixtures
const fixturesPath = path.join(__dirname, 'fixtures/inbound/golden-fixtures.json');
const fixtures = JSON.parse(fs.readFileSync(fixturesPath, 'utf8'));

// Import services (lazy to allow mocking)
let aiService, db;

function loadServices() {
    if (!aiService) {
        aiService = require('../services/ai-service');
        db = require('../services/database');
    }
}

/**
 * Validation rules for each intent type
 */
const VALIDATION_RULES = {
    portal_redirect: {
        requires_response: false,
        should_draft_email: false,
        allowed_actions: ['use_portal'],
        forbidden_in_draft: ['email is valid', 'treat this email', 'law requires', 'statute']
    },
    acknowledgment: {
        requires_response: false,
        should_draft_email: false,
        allowed_actions: ['wait']
    },
    records_ready: {
        requires_response: false,
        should_draft_email: false,
        allowed_actions: ['download']
    },
    delivery: {
        requires_response: false,
        should_draft_email: false,
        allowed_actions: ['download']
    },
    partial_delivery: {
        requires_response: false,
        should_draft_email: false,
        allowed_actions: ['download', 'wait']
    },
    more_info_needed: {
        requires_response: true,
        should_draft_email: true,
        max_words: 100,
        forbidden_in_draft: ['pursuant', 'statute', 'law requires']
    },
    question: {
        requires_response: true,
        should_draft_email: true,
        max_words: 100,
        forbidden_in_draft: ['pursuant', 'statute']
    },
    fee_request: {
        // Conditional based on amount
        check_fee_threshold: true,
        low_fee_max_words: 80,
        high_fee_max_words: 200
    },
    denial: {
        requires_response: true,
        should_draft_email: true,
        max_words: 200,
        forbidden_in_draft: ['hostile', 'demand immediately', 'lawsuit']
    },
    wrong_agency: {
        requires_response: false,
        should_draft_email: false,
        allowed_actions: ['find_correct_agency']
    },
    hostile: {
        requires_response: true,
        should_draft_email: true,
        max_words: 150,
        forbidden_in_draft: ['hostile', 'rude', 'unprofessional', 'threat']
    }
};

/**
 * Count words in text
 */
function countWords(text) {
    if (!text) return 0;
    return text.trim().split(/\s+/).filter(w => w.length > 0).length;
}

/**
 * Check if text contains any forbidden phrases
 */
function containsForbidden(text, forbidden) {
    if (!text || !forbidden) return [];
    const lower = text.toLowerCase();
    return forbidden.filter(phrase => lower.includes(phrase.toLowerCase()));
}

/**
 * Check if text contains required phrases
 */
function containsRequired(text, required) {
    if (!text || !required) return [];
    const lower = text.toLowerCase();
    return required.filter(phrase => !lower.includes(phrase.toLowerCase()));
}

/**
 * Validate analysis output against expected values
 */
function validateAnalysis(analysis, expected, fixture) {
    const errors = [];
    const warnings = [];

    // Intent match
    if (analysis.intent !== expected.intent) {
        errors.push(`Intent mismatch: got '${analysis.intent}', expected '${expected.intent}'`);
    }

    // requires_response match
    const actualRequiresResponse = analysis.requires_response ??
        (analysis.requires_action !== false);  // fallback for old format

    if (actualRequiresResponse !== expected.requires_response) {
        errors.push(`requires_response mismatch: got ${actualRequiresResponse}, expected ${expected.requires_response}`);
    }

    // Portal URL extraction
    if (expected.portal_url !== undefined) {
        if (expected.portal_url && !analysis.portal_url) {
            errors.push(`Portal URL not extracted (expected: ${expected.portal_url})`);
        }
    }

    // Fee amount extraction
    if (expected.fee_amount !== undefined) {
        const actualFee = analysis.extracted_fee_amount || analysis.fee_amount;
        if (actualFee !== expected.fee_amount) {
            warnings.push(`Fee amount: got ${actualFee}, expected ${expected.fee_amount}`);
        }
    }

    // Denial subtype
    if (expected.denial_subtype !== undefined && expected.intent === 'denial') {
        if (analysis.denial_subtype !== expected.denial_subtype) {
            warnings.push(`Denial subtype: got '${analysis.denial_subtype}', expected '${expected.denial_subtype}'`);
        }
    }

    // Sentiment for hostile
    if (expected.sentiment === 'hostile') {
        if (analysis.sentiment !== 'hostile' && analysis.sentiment !== 'negative') {
            warnings.push(`Sentiment should be hostile/negative, got '${analysis.sentiment}'`);
        }
    }

    return { errors, warnings };
}

/**
 * Validate draft output against constraints
 */
function validateDraft(draft, expected, fixture) {
    const errors = [];
    const warnings = [];

    if (!expected.should_draft_email) {
        if (draft && draft.body_text) {
            errors.push('Draft generated when should_draft_email=false');
        }
        return { errors, warnings };
    }

    if (!draft || !draft.body_text) {
        errors.push('No draft generated when should_draft_email=true');
        return { errors, warnings };
    }

    const text = draft.body_text;
    const constraints = expected.draft_constraints || {};
    const rules = VALIDATION_RULES[expected.intent] || {};

    // Word count
    const wordCount = countWords(text);
    const maxWords = constraints.max_words || rules.max_words || 200;
    if (wordCount > maxWords) {
        errors.push(`Word count ${wordCount} exceeds max ${maxWords}`);
    }

    // Forbidden phrases
    const forbidden = [
        ...(constraints.must_not_include || []),
        ...(rules.forbidden_in_draft || [])
    ];
    const foundForbidden = containsForbidden(text, forbidden);
    if (foundForbidden.length > 0) {
        errors.push(`Contains forbidden phrases: ${foundForbidden.join(', ')}`);
    }

    // Required phrases
    const required = constraints.must_include || [];
    const missingRequired = containsRequired(text, required);
    if (missingRequired.length > 0) {
        warnings.push(`Missing suggested phrases: ${missingRequired.join(', ')}`);
    }

    // Should include (soft requirement)
    const shouldInclude = constraints.should_include || [];
    const missingShouldInclude = containsRequired(text, shouldInclude);
    if (missingShouldInclude.length > 0) {
        warnings.push(`Consider including: ${missingShouldInclude.join(', ')}`);
    }

    return { errors, warnings };
}

/**
 * Run a single fixture test
 */
async function runFixture(fixture, options = {}) {
    const startTime = Date.now();
    const result = {
        fixture_id: fixture.fixture_id,
        category: fixture.category,
        description: fixture.description,
        passed: false,
        errors: [],
        warnings: [],
        analysis: null,
        draft: null,
        duration_ms: 0
    };

    try {
        loadServices();

        // For followup fixtures, test generateFollowUp instead
        if (fixture.category === 'followup') {
            const followupDraft = await aiService.generateFollowUp(
                fixture.case_data,
                fixture.case_data.followup_count || 0
            );

            result.draft = followupDraft;

            // Validate followup draft
            const validation = validateDraft(followupDraft, fixture.expected, fixture);
            result.errors = validation.errors;
            result.warnings = validation.warnings;
            result.passed = validation.errors.length === 0;

        } else {
            // Standard inbound message flow

            // Step 1: Analyze response
            const analysis = await aiService.analyzeResponse(
                fixture.message,
                fixture.case_data
            );
            result.analysis = analysis;

            // Step 2: Validate analysis
            const analysisValidation = validateAnalysis(analysis, fixture.expected, fixture);
            result.errors.push(...analysisValidation.errors);
            result.warnings.push(...analysisValidation.warnings);

            // Step 3: Generate draft if needed
            if (fixture.expected.should_draft_email) {
                let draft = null;

                // Determine which generator to use
                if (analysis.intent === 'denial' || fixture.expected.intent === 'denial') {
                    draft = await aiService.generateAutoReply(
                        fixture.message,
                        analysis,
                        fixture.case_data
                    );
                } else if (analysis.intent === 'fee_request' || fixture.expected.intent === 'fee_request') {
                    const feeAmount = fixture.expected.fee_amount || analysis.extracted_fee_amount || 50;
                    if (feeAmount <= 100) {
                        draft = await aiService.generateFeeAcceptance(fixture.case_data, feeAmount);
                    } else {
                        draft = await aiService.generateFeeResponse(fixture.case_data, {
                            feeAmount,
                            recommendedAction: 'negotiate'
                        });
                    }
                } else if (analysis.intent === 'more_info_needed' || analysis.intent === 'question') {
                    draft = await aiService.generateClarificationResponse(
                        fixture.message,
                        analysis,
                        fixture.case_data
                    );
                } else {
                    draft = await aiService.generateAutoReply(
                        fixture.message,
                        analysis,
                        fixture.case_data
                    );
                }

                result.draft = draft;

                // Validate draft
                const draftValidation = validateDraft(draft, fixture.expected, fixture);
                result.errors.push(...draftValidation.errors);
                result.warnings.push(...draftValidation.warnings);
            } else {
                // Verify no draft was generated
                const reply = await aiService.generateAutoReply(
                    fixture.message,
                    analysis,
                    fixture.case_data
                );

                if (reply && reply.should_auto_reply && reply.body_text) {
                    result.errors.push('Draft generated when should_draft_email=false');
                    result.draft = reply;
                }
            }

            result.passed = result.errors.length === 0;
        }

    } catch (error) {
        result.errors.push(`Exception: ${error.message}`);
        result.passed = false;
    }

    result.duration_ms = Date.now() - startTime;
    return result;
}

/**
 * Generate markdown report
 */
function generateMarkdownReport(results, summary) {
    let md = `# Golden Fixture Test Report

Generated: ${new Date().toISOString()}

## Summary

| Metric | Value |
|--------|-------|
| Total | ${summary.total} |
| Passed | ${summary.passed} |
| Failed | ${summary.failed} |
| Warnings | ${summary.warnings} |
| Pass Rate | ${summary.passRate}% |

## Results by Category

`;

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
        md += `### ${category} (${categoryPassed}/${categoryResults.length})\n\n`;
        md += `| Fixture | Status | Duration | Issues |\n`;
        md += `|---------|--------|----------|--------|\n`;

        for (const result of categoryResults) {
            const status = result.passed ? '✅ PASS' : '❌ FAIL';
            const issues = [
                ...result.errors.map(e => `❌ ${e}`),
                ...result.warnings.map(w => `⚠️ ${w}`)
            ].join('<br>') || '-';
            md += `| ${result.fixture_id} | ${status} | ${result.duration_ms}ms | ${issues} |\n`;
        }

        md += '\n';
    }

    // Failed tests detail
    const failed = results.filter(r => !r.passed);
    if (failed.length > 0) {
        md += `## Failed Tests Detail\n\n`;
        for (const result of failed) {
            md += `### ${result.fixture_id}\n\n`;
            md += `**Description:** ${result.description}\n\n`;
            md += `**Errors:**\n`;
            for (const error of result.errors) {
                md += `- ${error}\n`;
            }
            if (result.analysis) {
                md += `\n**Analysis Output:**\n\`\`\`json\n${JSON.stringify(result.analysis, null, 2)}\n\`\`\`\n`;
            }
            if (result.draft && result.draft.body_text) {
                md += `\n**Draft Output:**\n\`\`\`\n${result.draft.body_text}\n\`\`\`\n`;
            }
            md += '\n';
        }
    }

    return md;
}

/**
 * Main runner
 */
async function main() {
    const args = process.argv.slice(2);
    const fixtureFilter = args.find(a => a.startsWith('--fixture='))?.split('=')[1];
    const categoryFilter = args.find(a => a.startsWith('--category='))?.split('=')[1];
    const updateSnapshots = args.includes('--update-snapshots');
    const verbose = args.includes('--verbose') || args.includes('-v');

    console.log('='.repeat(80));
    console.log('GOLDEN FIXTURE TEST RUNNER');
    console.log('='.repeat(80));
    console.log(`Fixtures: ${fixtures.fixtures.length}`);
    console.log(`Deterministic config: temp=${DETERMINISTIC_CONFIG.temperature}, seed=${DETERMINISTIC_CONFIG.seed}`);
    console.log('');

    // Filter fixtures
    let testFixtures = fixtures.fixtures;
    if (fixtureFilter) {
        testFixtures = testFixtures.filter(f =>
            f.fixture_id.toLowerCase().includes(fixtureFilter.toLowerCase())
        );
        console.log(`Filtered to ${testFixtures.length} fixtures matching '${fixtureFilter}'`);
    }
    if (categoryFilter) {
        testFixtures = testFixtures.filter(f => f.category === categoryFilter);
        console.log(`Filtered to ${testFixtures.length} fixtures in category '${categoryFilter}'`);
    }

    const results = [];

    for (const fixture of testFixtures) {
        console.log(`\nRunning: ${fixture.fixture_id}...`);

        const result = await runFixture(fixture, { verbose });
        results.push(result);

        const status = result.passed ? '✅ PASS' : '❌ FAIL';
        console.log(`  ${status} (${result.duration_ms}ms)`);

        if (verbose || !result.passed) {
            for (const error of result.errors) {
                console.log(`    ❌ ${error}`);
            }
        }
        if (verbose) {
            for (const warning of result.warnings) {
                console.log(`    ⚠️ ${warning}`);
            }
        }
    }

    // Summary
    const summary = {
        total: results.length,
        passed: results.filter(r => r.passed).length,
        failed: results.filter(r => !r.passed).length,
        warnings: results.reduce((sum, r) => sum + r.warnings.length, 0),
        passRate: Math.round((results.filter(r => r.passed).length / results.length) * 100)
    };

    console.log('\n' + '='.repeat(80));
    console.log('SUMMARY');
    console.log('='.repeat(80));
    console.log(`Total: ${summary.total}`);
    console.log(`Passed: ${summary.passed} (${summary.passRate}%)`);
    console.log(`Failed: ${summary.failed}`);
    console.log(`Warnings: ${summary.warnings}`);

    // Write reports
    const reportsDir = path.join(__dirname, 'reports');
    if (!fs.existsSync(reportsDir)) {
        fs.mkdirSync(reportsDir, { recursive: true });
    }

    // JSON report
    const jsonReport = {
        timestamp: new Date().toISOString(),
        config: DETERMINISTIC_CONFIG,
        summary,
        results
    };
    fs.writeFileSync(
        path.join(reportsDir, 'report.json'),
        JSON.stringify(jsonReport, null, 2)
    );

    // Markdown report
    const mdReport = generateMarkdownReport(results, summary);
    fs.writeFileSync(
        path.join(reportsDir, 'report.md'),
        mdReport
    );

    console.log(`\nReports written to:`);
    console.log(`  ${path.join(reportsDir, 'report.json')}`);
    console.log(`  ${path.join(reportsDir, 'report.md')}`);

    // Exit with error code if any failed
    process.exit(summary.failed > 0 ? 1 : 0);
}

// Run if called directly
if (require.main === module) {
    main().catch(err => {
        console.error(err);
        process.exit(1);
    });
}

module.exports = { runFixture, validateAnalysis, validateDraft, VALIDATION_RULES };
