require('dotenv').config();
const portalAgentService = require('./services/portal-agent-service');

/**
 * Test the autonomous portal agent
 *
 * This will open a browser window (visible) and you can watch the AI agent
 * autonomously navigate and fill out the FOIA portal.
 */
async function testPortalAgent() {
    console.log('🚀 Testing Portal Agent with Anthropic Computer Use\n');

    // Sample case data
    const testCase = {
        id: 999,
        case_name: 'Test Case - Portal Agent Demo',
        subject_name: 'John Doe',
        agency_name: 'San Francisco Police Department',
        state: 'CA',
        incident_date: '2024-01-15',
        incident_location: '123 Main St, San Francisco, CA',
        requested_records: 'Body-worn camera footage, dashcam footage, incident reports, 911 calls',
        additional_details: 'Request relates to incident at 123 Main St on January 15, 2024'
    };

    // Example portal URL (replace with real portal)
    const portalUrl = 'https://example.com/foia-request-form';
    // OR use a test form:
    // const portalUrl = 'https://formspree.io/f/YOUR_FORM_ID'; // Create free test form

    console.log('Case:', testCase.case_name);
    console.log('Portal:', portalUrl);
    console.log('\n🤖 Starting autonomous agent...\n');
    console.log('💡 TIP: Watch the browser window - you\'ll see the AI navigating!\n');

    try {
        const result = await portalAgentService.submitToPortal(testCase, portalUrl, {
            maxSteps: 20,      // Limit steps for testing
            dryRun: true       // Don't actually submit (just fill form)
        });

        if (result.success) {
            console.log('\n✅ SUCCESS!');
            console.log(`   Steps completed: ${result.stepsCompleted}`);
            console.log(`   Final URL: ${result.finalUrl}`);
            console.log(`   Dry run: ${result.dryRun ? 'Yes (did not submit)' : 'No (submitted)'}`);
            console.log('\n📋 Step-by-step log:');
            result.stepLog.forEach((step, i) => {
                console.log(`   ${i + 1}. ${step.action.type}: ${step.action.reason || 'N/A'}`);
            });
        } else {
            console.log('\n❌ FAILED');
            console.log(`   Error: ${result.error}`);
            if (result.stepLog.length > 0) {
                console.log(`   Completed ${result.stepLog.length} steps before failing`);
            }
        }

        // Save screenshots
        if (result.finalScreenshot) {
            const fs = require('fs');
            const screenshotPath = './portal-agent-result.png';
            fs.writeFileSync(screenshotPath, Buffer.from(result.finalScreenshot, 'base64'));
            console.log(`\n📸 Screenshot saved: ${screenshotPath}`);
        }

    } catch (error) {
        console.error('\n💥 Test failed:', error.message);
        console.error(error.stack);
    } finally {
        await portalAgentService.closeBrowser();
        console.log('\n🏁 Test complete!');
    }
}

// Run the test
testPortalAgent().catch(console.error);
