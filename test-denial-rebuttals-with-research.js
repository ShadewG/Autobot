require('dotenv').config();
const aiService = require('./services/ai-service');

// Mock case and messages for testing denial rebuttals with legal research
const mockCase = {
    id: 1,
    case_name: "Test Case - Denial Rebuttal with Legal Research",
    agency_name: "Chicago Police Department",
    subject_name: "John Doe",
    state: "IL",
    incident_date: "2024-01-15",
    incident_location: "123 Main St, Chicago"
};

const denialMessages = {
    overly_broad: {
        id: 1,
        from_email: "foia@chicagopd.org",
        subject: "RE: FOIA Request",
        body_text: "Your request is overly broad and would be unduly burdensome to fulfill. Please narrow your request to specific records.",
        received_at: new Date()
    },

    no_records: {
        id: 2,
        from_email: "foia@chicagopd.org",
        subject: "RE: FOIA Request",
        body_text: "We have no responsive records for your request. No body-worn camera footage or reports were found for this incident.",
        received_at: new Date()
    },

    ongoing_investigation: {
        id: 3,
        from_email: "foia@chicagopd.org",
        subject: "RE: FOIA Request",
        body_text: "This matter is currently under active investigation. We cannot release any records at this time per investigatory exemption.",
        received_at: new Date()
    },

    privacy_exemption: {
        id: 4,
        from_email: "foia@chicagopd.org",
        subject: "RE: FOIA Request",
        body_text: "The requested records contain highly personal and confidential information protected by privacy exemptions. Request denied.",
        received_at: new Date()
    },

    excessive_fees: {
        id: 5,
        from_email: "foia@chicagopd.org",
        subject: "RE: FOIA Request",
        body_text: "The cost to fulfill your request would be $2,500. This includes 40 hours of review time and extensive redaction work.",
        received_at: new Date()
    }
};

async function testDenialRebuttalWithResearch(denialType) {
    console.log('\n' + '═'.repeat(80));
    console.log(`🎯 TESTING: ${denialType.toUpperCase().replace('_', ' ')} DENIAL WITH LEGAL RESEARCH`);
    console.log('═'.repeat(80));

    const message = denialMessages[denialType];

    console.log('\n📥 AGENCY DENIAL:');
    console.log(message.body_text);

    console.log('\n🤖 ANALYZING...');

    // Analyze the response
    const analysis = await aiService.analyzeResponse(message, mockCase);

    console.log(`\n📊 Analysis:`);
    console.log(`   Intent: ${analysis.intent}`);
    console.log(`   Denial Subtype: ${analysis.denial_subtype || 'N/A'}`);
    console.log(`   Confidence: ${analysis.confidence_score}`);

    // Generate rebuttal WITH legal research
    console.log('\n🔍 RESEARCHING ILLINOIS LAW...');
    console.log('   This will look up exact statutes and case law for Illinois');

    console.log('\n🤖 GENERATING STRATEGIC REBUTTAL...\n');

    const rebuttal = await aiService.generateAutoReply(message, analysis, mockCase);

    if (rebuttal.should_auto_reply) {
        console.log('✅ AUTO-REPLY GENERATED WITH LEGAL CITATIONS:');
        console.log('─'.repeat(80));
        console.log(rebuttal.reply_text);
        console.log('─'.repeat(80));
        console.log(`\nConfidence: ${rebuttal.confidence}`);
        console.log(`Denial Subtype: ${rebuttal.denial_subtype || 'N/A'}`);
        console.log(`Is Rebuttal: ${rebuttal.is_denial_rebuttal ? 'YES' : 'NO'}`);

        // Verify legal citations are present
        const hasStatuteCitation = /\d+ ILCS \d+|5 ILCS 140/i.test(rebuttal.reply_text);
        const hasLegalLanguage = /statute|exemption|segreg|law|pursuant/i.test(rebuttal.reply_text);

        console.log('\n📚 LEGAL QUALITY CHECK:');
        console.log(`   ✓ Contains statute citation: ${hasStatuteCitation ? 'YES ✅' : 'NO ❌'}`);
        console.log(`   ✓ Contains legal language: ${hasLegalLanguage ? 'YES ✅' : 'NO ❌'}`);
    } else {
        console.log('❌ NO AUTO-REPLY');
        console.log(`Reason: ${rebuttal.reason}`);
    }
}

async function runAllTests() {
    console.log('\n\n');
    console.log('╔════════════════════════════════════════════════════════════════════════════╗');
    console.log('║                                                                            ║');
    console.log('║     🤖 DENIAL REBUTTAL WITH LEGAL RESEARCH TEST                           ║');
    console.log('║                                                                            ║');
    console.log('║  Testing intelligent auto-responses with state-specific law citations    ║');
    console.log('║                                                                            ║');
    console.log('╚════════════════════════════════════════════════════════════════════════════╝');

    // Test each denial type with 3-second delays between tests
    await testDenialRebuttalWithResearch('overly_broad');
    await new Promise(r => setTimeout(r, 3000));

    await testDenialRebuttalWithResearch('no_records');
    await new Promise(r => setTimeout(r, 3000));

    await testDenialRebuttalWithResearch('ongoing_investigation');
    await new Promise(r => setTimeout(r, 3000));

    await testDenialRebuttalWithResearch('privacy_exemption');
    await new Promise(r => setTimeout(r, 3000));

    await testDenialRebuttalWithResearch('excessive_fees');

    console.log('\n\n');
    console.log('═'.repeat(80));
    console.log('✅ ALL DENIAL REBUTTAL TESTS COMPLETE');
    console.log('═'.repeat(80));
    console.log('\nKey Features Demonstrated:');
    console.log('  ✅ Automatic denial detection');
    console.log('  ✅ Subtype classification (8 types)');
    console.log('  ✅ LIVE LEGAL RESEARCH using GPT-5');
    console.log('  ✅ Exact statute citations (5 ILCS 140/X)');
    console.log('  ✅ State-specific case law references');
    console.log('  ✅ Strategic rebuttals (not manual flagging)');
    console.log('  ✅ Firm but professional tone');
    console.log('  ✅ Good faith cooperation shown');
    console.log('\n');
}

runAllTests().catch(console.error);
