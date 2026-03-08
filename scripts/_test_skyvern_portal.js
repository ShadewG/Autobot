require('dotenv').config();
const portalAgentService = require('./services/portal-agent-service-skyvern');

/**
 * Test the Skyvern AI portal agent
 *
 * Usage: node test-portal-skyvern.js "https://portal-url-here.com/form"
 *
 * Skyvern uses LLMs and computer vision to automate browser workflows.
 * It's open-source and can be self-hosted or used via cloud API.
 */
async function testPortalAgent() {
    console.log('🚀 Testing Skyvern AI Portal Agent\n');

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
        console.log('   Usage: node test-portal-skyvern.js "https://portal-url-here.com/form"\n');
    }

    console.log('Case:', testCase.case_name);
    console.log('Portal:', portalUrl);
    console.log('\n💡 TIP: Skyvern uses AI to understand and interact with any website!\n');
    console.log('=========================================================\n');

    try {
        const result = await portalAgentService.submitToPortal(testCase, portalUrl, {
            maxSteps: 25,      // Max steps for the task
            dryRun: true       // Don't actually submit (just fill form)
        });

        console.log('\n=========================================================\n');

        if (result.success) {
            console.log('✅ SUCCESS!\n');
            console.log(`Task ID: ${result.taskId}`);
            console.log(`Status: ${result.status}`);
            console.log(`Steps taken: ${result.steps}`);
            console.log(`Dry run: ${result.dryRun ? 'Yes (did not submit)' : 'No (submitted)'}`);

            if (result.recording_url) {
                console.log(`\n🎥 Recording: ${result.recording_url}`);
            }

            if (result.extracted_data) {
                console.log(`\n📊 Extracted Data:`);
                console.log(JSON.stringify(result.extracted_data, null, 2));
            }
        } else {
            console.log('❌ FAILED\n');
            console.log(`Error: ${result.error}`);
            if (result.taskId) {
                console.log(`Task ID: ${result.taskId}`);
            }
            if (result.status) {
                console.log(`Status: ${result.status}`);
            }
            if (result.recording_url) {
                console.log(`\n🎥 Recording: ${result.recording_url}`);
            }
            if (result.steps) {
                console.log(`Steps completed: ${result.steps}`);
            }
        }

        // Save results
        const fs = require('fs');
        const logPath = './portal-agent-skyvern-log.json';
        fs.writeFileSync(logPath, JSON.stringify(result, null, 2));
        console.log(`\n📝 Log saved: ${logPath}`);

        // Note about recordings
        if (result.recording_url) {
            console.log(`\n💡 Watch the recording to see exactly what Skyvern did!`);
        }

    } catch (error) {
        console.error('\n💥 Test failed:', error.message);
        console.error(error.stack);

        // Save error details
        const fs = require('fs');
        const logPath = './portal-agent-skyvern-log.json';
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
