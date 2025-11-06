require('dotenv').config();
const portalAgentService = require('./services/portal-agent-service');

async function testRealPortal() {
    console.log('🚀 Testing Portal Agent on REAL LAPD Portal\n');
    console.log('Portal: Los Angeles Police Department NextRequest');
    console.log('URL: https://recordsrequest.lacity.org/\n');

    const testCase = {
        id: 1001,
        case_name: 'LAPD Public Records Test',
        subject_name: 'John Doe',
        agency_name: 'Los Angeles Police Department',
        state: 'CA',
        incident_date: '2024-11-01',
        incident_location: '100 W 1st St, Los Angeles, CA 90012',
        requested_records: 'Police reports, body-worn camera footage, and dashcam footage related to incident on November 1, 2024',
        additional_details: 'Request for records pursuant to California Public Records Act'
    };

    console.log('Test Case:', testCase.case_name);
    console.log('Subject:', testCase.subject_name);
    console.log('Records:', testCase.requested_records);
    console.log('\n🤖 Starting autonomous agent...\n');
    console.log('⏱️  This may take 1-2 minutes...\n');

    try {
        const result = await portalAgentService.submitToPortal(
            testCase,
            'https://recordsrequest.lacity.org/',
            {
                maxSteps: 30,
                dryRun: true  // Don't actually submit (just test form filling)
            }
        );

        console.log('\n' + '='.repeat(60));
        if (result.success) {
            console.log('✅ SUCCESS! Agent completed the task\n');
            console.log(`📊 Stats:`);
            console.log(`   Steps taken: ${result.stepsCompleted}`);
            console.log(`   Final URL: ${result.finalUrl}`);
            console.log(`   Mode: ${result.dryRun ? 'DRY RUN (did not submit)' : 'LIVE (submitted)'}`);
            
            console.log('\n📝 Step-by-step breakdown:');
            result.stepLog.forEach((step, i) => {
                console.log(`   ${i + 1}. ${step.action.type.toUpperCase()}: ${step.action.reason || 'N/A'}`);
                if (step.action.value) {
                    console.log(`      Value: "${step.action.value.substring(0, 50)}${step.action.value.length > 50 ? '...' : ''}"`);
                }
            });

            // Save screenshots
            if (result.finalScreenshot) {
                const fs = require('fs');
                const path = './test-results';
                if (!fs.existsSync(path)) {
                    fs.mkdirSync(path);
                }
                
                const screenshotPath = `${path}/lapd-portal-final.png`;
                fs.writeFileSync(screenshotPath, Buffer.from(result.finalScreenshot, 'base64'));
                console.log(`\n📸 Final screenshot saved: ${screenshotPath}`);
                
                // Save step screenshots
                result.stepLog.forEach((step, i) => {
                    if (step.screenshot) {
                        const stepPath = `${path}/lapd-portal-step-${i + 1}.png`;
                        fs.writeFileSync(stepPath, Buffer.from(step.screenshot, 'base64'));
                    }
                });
                console.log(`📸 All step screenshots saved to: ${path}/`);
            }

            // Save full report
            const fs = require('fs');
            const reportPath = './test-results/agent-report.json';
            fs.writeFileSync(reportPath, JSON.stringify({
                ...result,
                finalScreenshot: '[base64 removed for readability]',
                stepLog: result.stepLog.map(s => ({
                    ...s,
                    screenshot: '[base64 removed]'
                }))
            }, null, 2));
            console.log(`📄 Full report saved: ${reportPath}`);

        } else {
            console.log('❌ FAILED\n');
            console.log(`Error: ${result.error}`);
            console.log(`\nCompleted ${result.stepLog?.length || 0} steps before failing`);
            
            if (result.stepLog && result.stepLog.length > 0) {
                console.log('\n📝 Steps before failure:');
                result.stepLog.forEach((step, i) => {
                    console.log(`   ${i + 1}. ${step.action.type}: ${step.action.reason || step.action.target}`);
                });
            }

            if (result.errorScreenshot) {
                const fs = require('fs');
                const path = './test-results';
                if (!fs.existsSync(path)) {
                    fs.mkdirSync(path);
                }
                const errorPath = `${path}/lapd-portal-error.png`;
                fs.writeFileSync(errorPath, Buffer.from(result.errorScreenshot, 'base64'));
                console.log(`\n📸 Error screenshot saved: ${errorPath}`);
            }
        }
        console.log('='.repeat(60) + '\n');

    } catch (error) {
        console.error('\n💥 Test crashed:', error.message);
        console.error(error.stack);
    } finally {
        await portalAgentService.closeBrowser();
        console.log('✅ Browser closed');
        console.log('\n🏁 Test complete!\n');
    }
}

// Run the test
testRealPortal().catch(console.error);
