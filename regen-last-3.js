/**
 * Regenerate FOIA requests for the last 3 sent cases
 */
require('dotenv').config();
const db = require('./services/database');
const aiService = require('./services/ai-service');

async function regenLast3() {
    try {
        console.log('🔍 Initializing database...');
        await db.initialize();

        console.log('\n📋 Fetching last 3 sent cases...');
        const result = await db.query(`
            SELECT id, case_name, subject_name, agency_name, state, incident_date,
                   incident_location, additional_details, requested_records, send_date
            FROM cases
            WHERE status = 'sent'
            ORDER BY send_date DESC
            LIMIT 3
        `);

        if (result.rows.length === 0) {
            console.log('❌ No sent cases found');
            await db.close();
            process.exit(0);
        }

        console.log(`\nFound ${result.rows.length} recently sent cases\n`);

        // Generate sample for each case
        for (let i = 0; i < result.rows.length; i++) {
            const caseRow = result.rows[i];

            console.log(`\n${'='.repeat(100)}`);
            console.log(`REGENERATION ${i + 1}/${result.rows.length}`);
            console.log('='.repeat(100));
            console.log(`Case #${caseRow.id}: ${caseRow.case_name}`);
            console.log(`State: ${caseRow.state} | Agency: ${caseRow.agency_name}`);
            console.log(`Subject: ${caseRow.subject_name}`);
            console.log(`Date: ${caseRow.incident_date || 'Not specified'}`);
            console.log(`Location: ${caseRow.incident_location || 'Not specified'}`);
            console.log(`Sent: ${new Date(caseRow.send_date).toLocaleString()}`);

            if (caseRow.requested_records) {
                console.log(`Requested Records: ${JSON.stringify(caseRow.requested_records)}`);
            }

            if (caseRow.additional_details) {
                const preview = caseRow.additional_details.substring(0, 300);
                console.log(`\nContext Preview:`);
                console.log(preview + (caseRow.additional_details.length > 300 ? '...' : ''));
            }

            console.log(`\n${'-'.repeat(100)}`);
            console.log('REGENERATED REQUEST:');
            console.log('-'.repeat(100));

            try {
                const caseData = await db.getCaseById(caseRow.id);
                const generated = await aiService.generateFOIARequest(caseData);

                // Create subject line
                const simpleName = (caseData.subject_name || 'Information Request')
                    .split(' - ')[0]
                    .split('(')[0]
                    .trim();
                const subject = `Public Records Request - ${simpleName}`;

                console.log(`\n📧 SUBJECT: ${subject}\n`);
                console.log(generated.request_text);

                console.log(`\n${'-'.repeat(100)}`);
                console.log(`✅ Model: ${generated.model}`);
                console.log(`📊 Stats: ${generated.request_text.length} chars, ${generated.request_text.split(/\s+/).length} words`);

                // Validation checks
                const issues = [];
                const lowerText = generated.request_text.toLowerCase();

                if (generated.request_text.includes(caseRow.case_name)) {
                    issues.push(`❌ Contains case name: "${caseRow.case_name}"`);
                }
                if (!lowerText.includes('body')) {
                    issues.push('⚠️  No mention of body camera');
                }
                if (!lowerText.includes('dashboard') && !lowerText.includes('dash')) {
                    issues.push('⚠️  No mention of dashboard camera');
                }
                if (!lowerText.includes(caseRow.state.toLowerCase())) {
                    issues.push(`⚠️  State (${caseRow.state}) not mentioned`);
                }
                if (!lowerText.includes('footage') && !lowerText.includes('video')) {
                    issues.push('❌ No mention of footage/video');
                }
                if (generated.request_text.length < 200) {
                    issues.push('❌ Too short (< 200 chars)');
                }
                if (generated.request_text.length > 1200) {
                    issues.push('⚠️  Too long (> 1200 chars)');
                }
                if (!lowerText.includes('samuel hylton')) {
                    issues.push('⚠️  Missing requester name');
                }
                if (!lowerText.includes('seattle')) {
                    issues.push('⚠️  Missing requester address');
                }

                if (issues.length > 0) {
                    console.log('\n🚨 ISSUES FOUND:');
                    issues.forEach(issue => console.log(`   ${issue}`));
                } else {
                    console.log('\n✅ No issues detected - request looks good!');
                }

                // Check for improvements
                const improvements = [];
                if (lowerText.includes('30 min') || lowerText.includes('buffer')) {
                    improvements.push('✓ Includes time buffers');
                }
                if (lowerText.includes('native') || lowerText.includes('digital format')) {
                    improvements.push('✓ Specifies format');
                }
                if (lowerText.includes('redact')) {
                    improvements.push('✓ Mentions redaction acceptance');
                }
                if (lowerText.includes('documentary') || lowerText.includes('non-commercial')) {
                    improvements.push('✓ States purpose');
                }
                if (improvements.length > 0) {
                    console.log('\n💪 STRENGTHS:');
                    improvements.forEach(imp => console.log(`   ${imp}`));
                }

                // Wait between requests
                if (i < result.rows.length - 1) {
                    console.log('\n⏳ Waiting 3 seconds...');
                    await new Promise(resolve => setTimeout(resolve, 3000));
                }

            } catch (genError) {
                console.error('❌ Generation failed:', genError.message);
                if (genError.stack) {
                    console.error(genError.stack);
                }
            }
        }

        console.log(`\n${'='.repeat(100)}`);
        console.log('REGENERATION COMPLETE');
        console.log('='.repeat(100));
        console.log(`✅ Regenerated ${result.rows.length} requests`);
        console.log(`📍 States: ${[...new Set(result.rows.map(r => r.state))].join(', ')}`);
        console.log(`🏛️  Agencies: ${result.rows.map(r => r.agency_name).join(', ')}`);

        await db.close();
        process.exit(0);

    } catch (error) {
        console.error('❌ Error:', error);
        if (error.stack) {
            console.error(error.stack);
        }
        process.exit(1);
    }
}

regenLast3();
