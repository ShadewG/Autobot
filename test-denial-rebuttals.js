require('dotenv').config();
const aiService = require('./services/ai-service');

// Mock case and messages for testing denial rebuttals
const mockCase = {
    id: 1,
    case_name: "Test Case - Denial Rebuttal",
    agency_name: "Chicago Police Department",
    subject_name: "John Doe",
    state: "IL",
    incident_date: "2024-01-15",
    incident_location: "123 Main St, Chicago"
};

const denialMessages = {
    overly_broad: {
        from_email: "foia@chicagopd.org",
        subject: "RE: FOIA Request",
        body_text: "Your request is overly broad and would be unduly burdensome to fulfill. Please narrow your request to specific records."
    },

    no_records: {
        from_email: "foia@chicagopd.org",
        subject: "RE: FOIA Request",
        body_text: "We have no responsive records for your request. No body-worn camera footage or reports were found for this incident."
    },

    ongoing_investigation: {
        from_email: "foia@chicagopd.org",
        subject: "RE: FOIA Request",
        body_text: "This matter is currently under active investigation. We cannot release any records at this time per investigatory exemption."
    },

    privacy_exemption: {
        from_email: "foia@chicagopd.org",
        subject: "RE: FOIA Request",
        body_text: "The requested records contain highly personal and confidential information protected by privacy exemptions. Request denied."
    },

    excessive_fees: {
        from_email: "foia@chicagopd.org",
        subject: "RE: FOIA Request",
        body_text: "The cost to fulfill your request would be $2,500. This includes 40 hours of review time and extensive redaction work."
    }
};

async function testDenialRebuttal(denialType) {
    console.log('\n' + '═'.repeat(70));
    console.log(`🎯 TESTING: ${denialType.toUpperCase().replace('_', ' ')} DENIAL`);
    console.log('═'.repeat(70));

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

    // Generate rebuttal
    console.log('\n🤖 GENERATING REBUTTAL...\n');

    const rebuttal = await aiService.generateAutoReply(message, analysis, mockCase);

    if (rebuttal.should_auto_reply) {
        console.log('✅ AUTO-REPLY GENERATED:');
        console.log('─'.repeat(70));
        console.log(rebuttal.reply_text);
        console.log('─'.repeat(70));
        console.log(`\nConfidence: ${rebuttal.confidence}`);
        console.log(`Denial Subtype: ${rebuttal.denial_subtype || 'N/A'}`);
        console.log(`Is Rebuttal: ${rebuttal.is_denial_rebuttal ? 'YES' : 'NO'}`);
    } else {
        console.log('❌ NO AUTO-REPLY');
        console.log(`Reason: ${rebuttal.reason}`);
    }
}

async function runAllTests() {
    console.log('\n\n');
    console.log('╔══════════════════════════════════════════════════════════════════╗');
    console.log('║                                                                  ║');
    console.log('║           🤖 DENIAL REBUTTAL SYSTEM TEST                        ║');
    console.log('║                                                                  ║');
    console.log('║  Testing intelligent auto-responses to different denial types   ║');
    console.log('║                                                                  ║');
    console.log('╚══════════════════════════════════════════════════════════════════╝');

    // Test each denial type
    await testDenialRebuttal('overly_broad');
    await new Promise(r => setTimeout(r, 2000));

    await testDenialRebuttal('no_records');
    await new Promise(r => setTimeout(r, 2000));

    await testDenialRebuttal('ongoing_investigation');
    await new Promise(r => setTimeout(r, 2000));

    await testDenialRebuttal('privacy_exemption');
    await new Promise(r => setTimeout(r, 2000));

    await testDenialRebuttal('excessive_fees');

    console.log('\n\n');
    console.log('═'.repeat(70));
    console.log('✅ ALL DENIAL REBUTTAL TESTS COMPLETE');
    console.log('═'.repeat(70));
    console.log('\nKey Features Demonstrated:');
    console.log('  ✅ Automatic denial detection');
    console.log('  ✅ Subtype classification (8 types)');
    console.log('  ✅ State-specific legal citations');
    console.log('  ✅ Strategic rebuttals (not manual flagging)');
    console.log('  ✅ Firm but professional tone');
    console.log('  ✅ Good faith cooperation shown');
    console.log('\n');
}

runAllTests().catch(console.error);
