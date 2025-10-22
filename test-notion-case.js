require('dotenv').config();
const notionService = require('./services/notion-service');
const aiService = require('./services/ai-service');

async function testNotionCase() {
    try {
        console.log('Fetching any case from Notion database...\n');

        // Fetch any cases from the database (no filter)
        const response = await notionService.notion.databases.query({
            database_id: notionService.databaseId,
            page_size: 1
        });

        if (response.results.length === 0) {
            console.log('No cases found in Notion database');
            return;
        }

        // Parse and enrich the first case
        const testCase = notionService.parseNotionPage(response.results[0]);
        await notionService.enrichWithPoliceDepartment(testCase);

        console.log('📋 CASE DATA EXTRACTED FROM NOTION:');
        console.log('=====================================');
        console.log('Case Name:', testCase.case_name);
        console.log('Notion Page ID:', testCase.notion_page_id);
        console.log('Police Dept ID:', testCase.police_dept_id);
        console.log('\n📧 CONTACT INFO:');
        console.log('Agency Name:', testCase.agency_name);
        console.log('Agency Email:', testCase.agency_email);
        console.log('\n👤 SUBJECT INFO:');
        console.log('Subject Name:', testCase.subject_name);
        console.log('\n📍 LOCATION INFO:');
        console.log('State:', testCase.state);
        console.log('Location:', testCase.incident_location);
        console.log('\n📅 DATE INFO:');
        console.log('Incident Date:', testCase.incident_date);
        console.log('\n📝 DETAILS:');
        console.log('Requested Records:', testCase.requested_records);
        console.log('Additional Details:', testCase.additional_details?.substring(0, 200) + '...');
        console.log('\n🔗 OTHER:');
        console.log('Portal URL:', testCase.portal_url);
        console.log('Status:', testCase.status);

        console.log('\n\n🤖 GENERATING FOIA REQUEST WITH GPT-5...\n');

        // Generate FOIA request
        const generated = await aiService.generateFOIARequest(testCase);

        // Create subject line
        const simpleName = (testCase.subject_name || 'Information Request')
            .split(' - ')[0]
            .split('(')[0]
            .trim();
        const subject = `Public Records Request - ${simpleName}`;

        console.log('📨 EMAIL DETAILS:');
        console.log('=====================================');
        console.log('TO:', testCase.agency_email);
        console.log('FROM:', process.env.SENDGRID_FROM_EMAIL);
        console.log('SUBJECT:', subject);
        console.log('\n📄 EMAIL BODY:');
        console.log('=====================================');
        console.log(generated.request_text);
        console.log('=====================================\n');

        console.log('✅ Test completed successfully!');

    } catch (error) {
        console.error('❌ Error testing Notion case:', error);
        console.error(error.stack);
    }
}

testNotionCase();
