require('dotenv').config();
const portalAgentService = require('./services/portal-agent-service');

/**
 * Test the autonomous portal agent
 *
 * Usage: node test-portal-agent.js "https://portal-url-here.com/form"
 *
 * This will open a browser window (visible) and you can watch the AI agent
 * autonomously navigate and fill out the FOIA portal.
 */
async function testPortalAgent() {
    console.log('🚀 Testing Portal Agent with Anthropic Computer Use\n');

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
        console.log('   Usage: node test-portal-agent.js "https://portal-url-here.com/form"\n');
    }

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
        const fs = require('fs');
        const path = require('path');

        // Create screenshots directory
        const screenshotsDir = './portal-screenshots';
        if (!fs.existsSync(screenshotsDir)) {
            fs.mkdirSync(screenshotsDir, { recursive: true });
        }

        // Save step-by-step screenshots
        if (result.stepLog && result.stepLog.length > 0) {
            console.log(`\n📸 Saving ${result.stepLog.length} step screenshots...`);
            result.stepLog.forEach((step, index) => {
                if (step.screenshot) {
                    const filename = `step-${String(index + 1).padStart(2, '0')}-${step.action.type}.png`;
                    const filepath = path.join(screenshotsDir, filename);
                    fs.writeFileSync(filepath, Buffer.from(step.screenshot, 'base64'));
                    console.log(`   ✅ Saved: ${filename}`);
                }
            });
        }

        // Save final screenshot
        if (result.finalScreenshot) {
            const screenshotPath = './portal-agent-result.png';
            fs.writeFileSync(screenshotPath, Buffer.from(result.finalScreenshot, 'base64'));
            console.log(`\n📸 Final screenshot saved: ${screenshotPath}`);
        }

        // Save detailed JSON log
        const logPath = './portal-agent-log.json';
        const logData = {
            success: result.success,
            caseId: result.caseId,
            portalUrl: result.portalUrl,
            stepsCompleted: result.stepsCompleted,
            finalUrl: result.finalUrl,
            dryRun: result.dryRun,
            stepLog: result.stepLog.map(step => ({
                step: step.step,
                action: step.action,
                result: step.result,
                url: step.url
                // Exclude screenshot from JSON (too large)
            }))
        };
        fs.writeFileSync(logPath, JSON.stringify(logData, null, 2));
        console.log(`📝 Detailed log saved: ${logPath}`);

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
