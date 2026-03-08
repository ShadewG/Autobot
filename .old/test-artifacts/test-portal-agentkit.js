const portalAgentKitService = require('./services/portal-agentkit-service');
const db = require('./services/database');

async function run() {
    try {
        const portalUrl = process.argv[2];
        const caseId = process.argv[3];

        if (!portalUrl) {
            console.error('Usage: node test-portal-agentkit.js <portal-url> [caseId]');
            process.exit(1);
        }

        let caseData;
        if (caseId) {
            caseData = await db.getCaseById(caseId);
            if (!caseData) {
                throw new Error(`Case ${caseId} not found`);
            }
        } else {
            caseData = {
                case_name: 'Test Case - Portal AgentKit',
                subject_name: 'Samuel Hylton',
                agency_name: 'Collier County Sheriff',
                state: 'FL',
                incident_date: '2024-01-01',
                incident_location: 'Collier County, FL',
                requested_records: 'Body camera, 911 calls, incident report',
                additional_details: 'Testing AgentKit portal automation'
            };
        }

        console.log('🤖 Running OpenAI AgentKit portal automation...');
        const result = await portalAgentKitService.submitCase(caseData, portalUrl, { dryRun: true });
        console.log('✅ Automation complete!');
        console.log(JSON.stringify(result, null, 2));
    } catch (error) {
        console.error('❌ AgentKit portal test failed:', error.message);
        process.exit(1);
    }
}

run();
