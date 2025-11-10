require('dotenv').config();
const portalAgentService = require('./services/portal-agent-service-hyperbrowser');

/**
 * Test the autonomous portal agent with Hyperbrowser
 *
 * Usage: node test-portal-hyperbrowser.js "https://portal-url-here.com/form"
 *
 * This uses Hyperbrowser (cloud browser) so you won't see the browser locally,
 * but you'll get screenshots of each step the AI agent takes.
 */
async function testPortalAgent() {
    console.log('🚀 Testing Portal Agent with Hyperbrowser + Anthropic Computer Use\n');

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
        console.log('   Usage: node test-portal-hyperbrowser.js "https://portal-url-here.com/form"\n');
    }

    console.log('Case:', testCase.case_name);
    console.log('Portal:', portalUrl);
    console.log('\n🤖 Starting autonomous agent...\n');
    console.log('💡 TIP: Using cloud browser - check screenshots to see what the AI is doing!\n');

    try {
        const result = await portalAgentService.submitToPortal(testCase, portalUrl, {
            maxSteps: 20,      // Limit steps for testing
            dryRun: true       // Don't actually submit (just fill form)
        });

        if (result.success) {
            console.log('\n✅ SUCCESS!');
            console.log(`   Steps completed: ${result.stepsCompleted}`);
            console.log(`   Final URL: ${result.finalUrl}`);
            console.log(`   Session ID: ${result.sessionId}`);
            console.log(`   Dry run: ${result.dryRun ? 'Yes (did not submit)' : 'No (submitted)'}`);
            console.log('\n📋 Step-by-step log:');
            result.stepLog.forEach((step, i) => {
                console.log(`   ${i + 1}. ${step.action.type}: ${step.action.reason || 'N/A'}`);
            });
        } else {
            console.log('\n❌ FAILED');
            console.log(`   Error: ${result.error}`);
            if (result.sessionId) {
                console.log(`   Session ID: ${result.sessionId}`);
            }
            if (result.stepLog.length > 0) {
                console.log(`   Completed ${result.stepLog.length} steps before failing`);
            }
        }

        // Save screenshots
        const fs = require('fs');
        const path = require('path');

        // Create screenshots directory
        const screenshotsDir = './portal-screenshots-hyperbrowser';
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
            const screenshotPath = './portal-agent-result-hyperbrowser.png';
            fs.writeFileSync(screenshotPath, Buffer.from(result.finalScreenshot, 'base64'));
            console.log(`\n📸 Final screenshot saved: ${screenshotPath}`);
        }

        // Save error screenshot if present
        if (result.errorScreenshot) {
            const errorScreenshotPath = './portal-agent-error-hyperbrowser.png';
            fs.writeFileSync(errorScreenshotPath, Buffer.from(result.errorScreenshot, 'base64'));
            console.log(`\n📸 Error screenshot saved: ${errorScreenshotPath}`);
        }

        // Save detailed JSON log
        const logPath = './portal-agent-log-hyperbrowser.json';
        const logData = {
            success: result.success,
            caseId: result.caseId,
            portalUrl: result.portalUrl,
            stepsCompleted: result.stepsCompleted,
            finalUrl: result.finalUrl,
            sessionId: result.sessionId,
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

        // Try to get result from portal agent service even on error
        // (might have partial stepLog with screenshots)
        let partialResult = null;
        try {
            // Check if error object has result data attached
            if (error.result) {
                partialResult = error.result;
            }
        } catch (_) {
            // Ignore
        }

        // Save error details and any screenshots we captured
        const fs = require('fs');
        const path = require('path');

        // Create screenshots directory
        const screenshotsDir = './portal-screenshots-hyperbrowser';
        if (!fs.existsSync(screenshotsDir)) {
            fs.mkdirSync(screenshotsDir, { recursive: true });
        }

        // Save any screenshots we got before failure
        if (partialResult && partialResult.stepLog && partialResult.stepLog.length > 0) {
            console.log(`\n📸 Saving ${partialResult.stepLog.length} screenshots from failed attempt...`);
            partialResult.stepLog.forEach((step, index) => {
                if (step.screenshot) {
                    const filename = `step-${String(index + 1).padStart(2, '0')}-${step.action.type}.png`;
                    const filepath = path.join(screenshotsDir, filename);
                    fs.writeFileSync(filepath, Buffer.from(step.screenshot, 'base64'));
                    console.log(`   ✅ Saved: ${filename}`);
                }
            });
        }

        const logPath = './portal-agent-log-hyperbrowser.json';
        const errorLog = {
            success: false,
            error: error.message,
            stack: error.stack,
            stepLog: partialResult?.stepLog || []
        };
        fs.writeFileSync(logPath, JSON.stringify(errorLog, null, 2));
        console.log(`\n📝 Error log saved: ${logPath}`);
    } finally {
        await portalAgentService.closeSession();
        console.log('\n🏁 Test complete!');
    }
}

// Run the test
testPortalAgent().catch(console.error);
