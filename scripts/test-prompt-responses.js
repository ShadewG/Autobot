#!/usr/bin/env node
/**
 * Test script to simulate different agency response scenarios
 * and verify AI prompt behavior
 *
 * Run: node scripts/test-prompt-responses.js
 */

require('dotenv').config();
const aiService = require('../services/ai-service');

// Test scenarios
const testScenarios = [
    {
        name: 'Portal Redirect',
        expectedIntent: 'portal_redirect',
        expectedResponse: false,
        message: {
            from_email: 'records@raleighpd.gov',
            subject: 'RE: Public Records Request',
            body_text: `Thank you for your request. The Raleigh Police Department uses NextRequest for all public records requests.

Please submit your request through our online portal at:
https://raleighnc.nextrequest.com

This will ensure faster processing and allow you to track your request status.

Thank you,
Records Division`
        },
        caseData: {
            id: 1,
            case_name: 'Test Case - Portal',
            subject_name: 'John Doe',
            agency_name: 'Raleigh Police Department',
            state: 'NC'
        }
    },
    {
        name: 'Simple Acknowledgment',
        expectedIntent: 'acknowledgment',
        expectedResponse: false,
        message: {
            from_email: 'foia@cityofchicago.org',
            subject: 'RE: FOIA Request Received',
            body_text: `Your FOIA request has been received and assigned tracking number 2024-001234.

We will respond within 5 business days as required by the Illinois FOIA.

Thank you for your patience.`
        },
        caseData: {
            id: 2,
            case_name: 'Test Case - Ack',
            subject_name: 'Jane Smith',
            agency_name: 'Chicago Police Department',
            state: 'IL'
        }
    },
    {
        name: 'Records Ready for Download',
        expectedIntent: 'records_ready',
        expectedResponse: false,
        message: {
            from_email: 'records@seattle.gov',
            subject: 'Your records are ready',
            body_text: `Your requested records are now available for download.

Please click the link below to access your files:
https://seattle.govqa.us/download/abc123

This link will expire in 30 days.

Seattle Police Department Records Unit`
        },
        caseData: {
            id: 3,
            case_name: 'Test Case - Ready',
            subject_name: 'Bob Johnson',
            agency_name: 'Seattle Police Department',
            state: 'WA'
        }
    },
    {
        name: 'Small Fee Quote (Auto-Approve)',
        expectedIntent: 'fee_request',
        expectedResponse: true,
        message: {
            from_email: 'records@lapd.org',
            subject: 'RE: Records Request - Fee Estimate',
            body_text: `We have located responsive records for your request.

The cost for these records is $45.00 for copying and processing.

Please confirm you wish to proceed with payment.

LAPD Records Division`
        },
        caseData: {
            id: 4,
            case_name: 'Test Case - Small Fee',
            subject_name: 'Alice Williams',
            agency_name: 'Los Angeles Police Department',
            state: 'CA'
        }
    },
    {
        name: 'Large Fee Quote (Human Review)',
        expectedIntent: 'fee_request',
        expectedResponse: false,
        needsHumanReview: true,
        message: {
            from_email: 'records@nypd.org',
            subject: 'RE: FOIL Request - Cost Estimate',
            body_text: `We have reviewed your request and estimate the cost at $350.00.

This includes:
- Search time: 2 hours @ $50/hr = $100
- Review time: 3 hours @ $50/hr = $150
- Redaction: 1 hour @ $50/hr = $50
- Media copying: $50

Please confirm if you wish to proceed.

NYPD Records Access`
        },
        caseData: {
            id: 5,
            case_name: 'Test Case - Large Fee',
            subject_name: 'Charlie Brown',
            agency_name: 'New York Police Department',
            state: 'NY'
        }
    },
    {
        name: 'Clarification Request',
        expectedIntent: 'more_info_needed',
        expectedResponse: true,
        message: {
            from_email: 'records@phoenix.gov',
            subject: 'RE: Records Request - Clarification Needed',
            body_text: `Thank you for your request. We need some additional information:

1. What is the exact date of the incident?
2. Can you provide a case number or report number if known?
3. What is the approximate location/address?

This will help us locate the responsive records.

Phoenix PD Records`
        },
        caseData: {
            id: 6,
            case_name: 'Test Case - Clarification',
            subject_name: 'David Lee',
            agency_name: 'Phoenix Police Department',
            state: 'AZ',
            incident_date: '2024-01-15',
            incident_location: '123 Main St'
        }
    },
    {
        name: 'Actual Denial - Ongoing Investigation',
        expectedIntent: 'denial',
        expectedResponse: true,
        message: {
            from_email: 'records@miami.gov',
            subject: 'RE: Public Records Request - Denial',
            body_text: `Your request for records related to the incident on January 10, 2024 is denied.

This matter involves an ongoing criminal investigation. Release of these records at this time would interfere with the investigation and compromise witness safety.

The request is denied pursuant to Florida Statute 119.071(2)(c).

You may re-submit your request after the investigation is closed.

Miami PD Records`
        },
        caseData: {
            id: 7,
            case_name: 'Test Case - Denial Investigation',
            subject_name: 'Eva Martinez',
            agency_name: 'Miami Police Department',
            state: 'FL'
        }
    },
    {
        name: 'Portal Redirect Disguised as Burden',
        expectedIntent: 'portal_redirect',
        expectedResponse: false,
        message: {
            from_email: 'records@raleighpd.gov',
            subject: 'RE: Records Request',
            body_text: `Thank you for your request. Due to the volume of requests we receive, we require all public records requests to be submitted through our NextRequest portal.

Please visit https://raleighnc.nextrequest.com to submit your request.

Submitting through the portal ensures your request is properly tracked and processed in the order received.

Raleigh Police Records Division`
        },
        caseData: {
            id: 8,
            case_name: 'Test Case - Portal as Burden',
            subject_name: 'Frank Wilson',
            agency_name: 'Raleigh Police Department',
            state: 'NC'
        }
    }
];

async function runTests() {
    console.log('='.repeat(80));
    console.log('PROMPT RESPONSE TESTING');
    console.log('='.repeat(80));
    console.log('');

    const results = [];

    for (const scenario of testScenarios) {
        console.log(`\n${'='.repeat(60)}`);
        console.log(`TEST: ${scenario.name}`);
        console.log('='.repeat(60));

        try {
            // Step 1: Analyze the response
            console.log('\n--- ANALYSIS ---');
            const analysis = await aiService.analyzeResponse(scenario.message, scenario.caseData);

            console.log(`Intent: ${analysis.intent} (expected: ${scenario.expectedIntent})`);
            console.log(`Requires Response: ${analysis.requires_response}`);
            console.log(`Portal URL: ${analysis.portal_url || 'none'}`);
            console.log(`Fee Amount: ${analysis.extracted_fee_amount || 'none'}`);
            console.log(`Summary: ${analysis.summary}`);

            const intentMatch = analysis.intent === scenario.expectedIntent;

            // Step 2: Try to generate auto-reply
            console.log('\n--- AUTO-REPLY DECISION ---');
            const reply = await aiService.generateAutoReply(scenario.message, analysis, scenario.caseData);

            console.log(`Should Reply: ${reply.should_auto_reply}`);
            console.log(`Reason: ${reply.reason || 'N/A'}`);

            if (reply.should_auto_reply && reply.body_text) {
                console.log(`\n--- GENERATED RESPONSE ---`);
                console.log(reply.body_text.substring(0, 500) + (reply.body_text.length > 500 ? '...' : ''));
            }

            const responseMatch = reply.should_auto_reply === scenario.expectedResponse;

            // Record result
            const passed = intentMatch && responseMatch;
            results.push({
                name: scenario.name,
                passed,
                intentMatch,
                responseMatch,
                actualIntent: analysis.intent,
                expectedIntent: scenario.expectedIntent,
                shouldReply: reply.should_auto_reply,
                expectedReply: scenario.expectedResponse
            });

            console.log(`\n--- RESULT: ${passed ? 'PASS' : 'FAIL'} ---`);
            if (!intentMatch) console.log(`  Intent mismatch: got ${analysis.intent}, expected ${scenario.expectedIntent}`);
            if (!responseMatch) console.log(`  Response mismatch: got ${reply.should_auto_reply}, expected ${scenario.expectedResponse}`);

        } catch (error) {
            console.error(`ERROR: ${error.message}`);
            results.push({
                name: scenario.name,
                passed: false,
                error: error.message
            });
        }
    }

    // Summary
    console.log('\n\n' + '='.repeat(80));
    console.log('SUMMARY');
    console.log('='.repeat(80));

    const passed = results.filter(r => r.passed).length;
    const failed = results.filter(r => !r.passed).length;

    console.log(`\nPassed: ${passed}/${results.length}`);
    console.log(`Failed: ${failed}/${results.length}`);

    if (failed > 0) {
        console.log('\nFailed tests:');
        results.filter(r => !r.passed).forEach(r => {
            console.log(`  - ${r.name}: ${r.error || `Intent: ${r.actualIntent} (expected ${r.expectedIntent}), Reply: ${r.shouldReply} (expected ${r.expectedReply})`}`);
        });
    }

    console.log('\n');
    return failed === 0;
}

// Run if called directly
if (require.main === module) {
    runTests()
        .then(success => process.exit(success ? 0 : 1))
        .catch(err => {
            console.error(err);
            process.exit(1);
        });
}

module.exports = { runTests, testScenarios };
