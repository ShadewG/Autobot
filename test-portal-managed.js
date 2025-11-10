require('dotenv').config();
const portalAgentService = require('./services/portal-agent-service-managed');

/**
 * Test the Hyperbrowser managed Claude Computer Use agent
 *
 * Usage: node test-portal-managed.js "https://portal-url-here.com/form"
 *
 * This uses Hyperbrowser's built-in Claude Computer Use agent, which is
 * much simpler than manually managing the agent loop!
 */
async function testPortalAgent() {
    console.log('🚀 Testing Hyperbrowser Managed Claude Computer Use Agent\n');

    // Get portal URL from command line or use default
    const portalUrl = process.argv[2] || 'https://example.com/foia-request-form';

    // Sample case data
    const testCase = {
        id: 999,
        case_name: 'Michael Allen Pritchard - Florida Man Murder Case',
        subject_name: 'Michael Allen Pritchard',
        agency_name: 'Collier County Sheriff\'s Office',
        state: 'FL',
        incident_date: '2024-01-15',
        incident_location: 'Collier County, FL',
        requested_records: 'Body-worn camera footage, dashcam footage, incident reports, 911 calls, arrest reports, booking photos',
        additional_details: 'Request relates to the Michael Allen Pritchard murder case. Requesting all records related to the investigation, arrest, and prosecution of Michael Allen Pritchard for the murder of his roommate, including but not limited to: police reports, witness statements, forensic evidence, body camera footage, dashcam footage, 911 calls, and any other relevant documentation.'
    };

    if (!process.argv[2]) {
        console.log('⚠️  No portal URL provided, using example URL');
        console.log('   Usage: node test-portal-managed.js "https://portal-url-here.com/form"\n');
    }

    console.log('Case:', testCase.case_name);
    console.log('Portal:', portalUrl);
    console.log('\n💡 TIP: Hyperbrowser manages everything - you just describe the task!\n');
    console.log('=========================================================\n');

    try {
        const result = await portalAgentService.submitToPortal(testCase, portalUrl, {
            maxSteps: 100,     // Increased from 25 to allow completion
            dryRun: true,      // Don't actually submit (just fill form)
            llm: 'claude-haiku-4-5-20251001'  // Fast and cheap
            // llm: 'claude-sonnet-4-5'  // Use this if Haiku struggles
        });

        console.log('\n=========================================================\n');

        if (result.success) {
            console.log('✅ SUCCESS!\n');
            console.log(`Steps completed: ${result.stepsCompleted}`);
            console.log(`Job ID: ${result.jobId}`);
            if (result.liveUrl) {
                console.log(`Watch live: ${result.liveUrl}`);
            }
            console.log(`Dry run: ${result.dryRun ? 'Yes (did not submit)' : 'No (submitted)'}`);

            console.log(`\n📋 Final Result:\n${result.finalResult}\n`);

            if (result.steps && result.steps.length > 0) {
                console.log(`📝 Steps taken:`);
                result.steps.forEach((step, i) => {
                    console.log(`   ${i + 1}. ${step.action || 'Action'}`);
                });
            }
        } else {
            console.log('❌ FAILED\n');
            console.log(`Error: ${result.error}`);
            if (result.jobId) {
                console.log(`Job ID: ${result.jobId}`);
            }
            if (result.liveUrl) {
                console.log(`Watch recording: ${result.liveUrl}`);
            }
            if (result.steps && result.steps.length > 0) {
                console.log(`Completed ${result.steps.length} steps before failing`);
            }
        }

        // Save results
        const fs = require('fs');
        const logPath = './portal-agent-managed-log.json';
        fs.writeFileSync(logPath, JSON.stringify(result, null, 2));
        console.log(`\n📝 Log saved: ${logPath}`);

        // Note about screenshots
        if (result.liveUrl) {
            console.log(`\n💡 View the session recording at: ${result.liveUrl}`);
        }

    } catch (error) {
        console.error('\n💥 Test failed:', error.message);
        console.error(error.stack);

        // Save error details
        const fs = require('fs');
        const logPath = './portal-agent-managed-log.json';
        const errorLog = {
            success: false,
            error: error.message,
            stack: error.stack
        };
        fs.writeFileSync(logPath, JSON.stringify(errorLog, null, 2));
        console.log(`\n📝 Error log saved: ${logPath}`);
    } finally {
        console.log('\n🏁 Test complete!');
    }
}

// Run the test
testPortalAgent().catch(console.error);
