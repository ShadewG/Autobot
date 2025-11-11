/**
 * Generate sample FOIA requests from recent cases
 */
require('dotenv').config();
const db = require('./services/database');
const aiService = require('./services/ai-service');

async function generateSamples() {
    try {
        console.log('🔍 Initializing database...');
        await db.initialize();

        // Get cases from different states
        console.log('\n📋 Fetching cases from different states...');
        const result = await db.query(`
            SELECT id, case_name, subject_name, agency_name, state, incident_date, incident_location, additional_details
            FROM cases
            WHERE status IN ('sent', 'ready_to_send')
            ORDER BY
                CASE
                    WHEN state = 'CA' THEN 1
                    WHEN state = 'TX' THEN 2
                    WHEN state = 'NY' THEN 3
                    WHEN state = 'FL' THEN 4
                    ELSE 5
                END,
                created_at DESC
            LIMIT 3
        `);

        if (result.rows.length === 0) {
            console.log('❌ No cases found');
            process.exit(0);
        }

        console.log(`\nFound ${result.rows.length} cases from different states\n`);

        // Generate sample for each case
        for (let i = 0; i < result.rows.length; i++) {
            const caseRow = result.rows[i];
            console.log(`\n${'='.repeat(100)}`);
            console.log(`SAMPLE ${i + 1}/${result.rows.length}`);
            console.log('='.repeat(100));
            console.log(`Case #${caseRow.id}: ${caseRow.case_name}`);
            console.log(`State: ${caseRow.state} | Agency: ${caseRow.agency_name}`);
            console.log(`Subject: ${caseRow.subject_name}`);
            console.log(`Date: ${caseRow.incident_date || 'Not specified'}`);
            console.log(`Location: ${caseRow.incident_location || 'Not specified'}`);

            if (caseRow.additional_details) {
                console.log(`\nAdditional Context (first 200 chars):`);
                console.log(caseRow.additional_details.substring(0, 200) + '...');
            }

            console.log(`\n${'-'.repeat(100)}`);
            console.log('GENERATED REQUEST:');
            console.log('-'.repeat(100));

            try {
                const caseData = await db.getCaseById(caseRow.id);
                const generated = await aiService.generateFOIARequest(caseData);

                console.log(generated.request_text);

                console.log(`\n${'-'.repeat(100)}`);
                console.log(`Model used: ${generated.model}`);
                console.log(`Length: ${generated.request_text.length} characters`);
                console.log(`Words: ${generated.request_text.split(/\s+/).length} words`);

                // Check for issues
                const issues = [];
                if (generated.request_text.includes(caseRow.case_name)) {
                    issues.push(`⚠️  WARNING: Request contains case name "${caseRow.case_name}"`);
                }
                if (!generated.request_text.toLowerCase().includes('body')) {
                    issues.push('⚠️  WARNING: No mention of body camera footage');
                }
                if (!generated.request_text.toLowerCase().includes(caseRow.state.toLowerCase())) {
                    issues.push(`⚠️  WARNING: State (${caseRow.state}) not mentioned`);
                }
                if (generated.request_text.length < 300) {
                    issues.push('⚠️  WARNING: Request seems too short');
                }
                if (generated.request_text.length > 1000) {
                    issues.push('⚠️  WARNING: Request seems too long');
                }

                if (issues.length > 0) {
                    console.log('\nISSUES DETECTED:');
                    issues.forEach(issue => console.log(issue));
                } else {
                    console.log('\n✅ No issues detected');
                }

                // Wait a bit between requests to avoid rate limits
                if (i < result.rows.length - 1) {
                    console.log('\nWaiting 3 seconds before next generation...');
                    await new Promise(resolve => setTimeout(resolve, 3000));
                }

            } catch (genError) {
                console.error('❌ Generation failed:', genError.message);
            }
        }

        console.log(`\n${'='.repeat(100)}`);
        console.log('SUMMARY');
        console.log('='.repeat(100));
        console.log(`Generated ${result.rows.length} sample requests`);
        console.log(`States covered: ${[...new Set(result.rows.map(r => r.state))].join(', ')}`);

        await db.close();
        process.exit(0);

    } catch (error) {
        console.error('Error:', error);
        process.exit(1);
    }
}

generateSamples();
