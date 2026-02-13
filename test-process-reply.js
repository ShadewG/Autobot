require('dotenv').config();
const aiService = require('./services/ai-service');

// Simulate what Railway webhook would receive
async function processReply() {
    console.log('🤖 Processing your reply locally...\n');

    // Your actual reply
    const mockReply = {
        id: 'test-message-' + Date.now(),
        from_email: 'shadewofficial@gmail.com',
        subject: 'RE: Test FOIA Request',
        body_text: `this is an ongoing case so we can't release anything`,
        received_at: new Date()
    };

    // Mock case data
    const mockCase = {
        id: 999,
        case_name: 'Test Case',
        agency_name: 'Test Police Department',
        subject_name: 'Test Subject',
        state: 'IL',
        incident_date: '2024-01-15',
        incident_location: '123 Main St'
    };

    console.log('📥 INCOMING EMAIL:');
    console.log(`   From: ${mockReply.from_email}`);
    console.log(`   Subject: ${mockReply.subject}`);
    console.log(`   Body: ${mockReply.body_text}`);
    console.log('');

    // Step 1: Analyze the response
    console.log('🔍 Step 1: Analyzing response with GPT-5...\n');

    const analysisPrompt = `Analyze this email response to a FOIA request and extract key information:

**Original Request Context:**
Subject: Test Subject
Agency: Test Police Department

**Response Email:**
From: ${mockReply.from_email}
Body:
${mockReply.body_text}

Please analyze and provide a JSON response with:
1. intent: (acknowledgment | question | delivery | denial | fee_request | more_info_needed)
2. denial_subtype: if intent is "denial", specify subtype (no_records | ongoing_investigation | privacy_exemption | overly_broad | excessive_fees | wrong_agency | retention_expired | format_issue | null)
3. confidence_score: 0.0 to 1.0
4. sentiment: (positive | neutral | negative | hostile)
5. summary: brief 1-2 sentence summary

Return ONLY valid JSON, no other text.`;

    const openai = require('openai');
    const client = new openai.OpenAI({ apiKey: process.env.OPENAI_API_KEY });

    try {
        const analysisResponse = await client.responses.create({
            model: 'gpt-5.2-2025-12-11',
            reasoning: { effort: 'medium' },
            text: { verbosity: 'low' },
            input: analysisPrompt
        });

        const analysis = JSON.parse(analysisResponse.output_text);

        console.log('📊 ANALYSIS RESULTS:');
        console.log(`   Intent: ${analysis.intent}`);
        console.log(`   Denial Subtype: ${analysis.denial_subtype || 'N/A'}`);
        console.log(`   Confidence: ${analysis.confidence_score}`);
        console.log(`   Sentiment: ${analysis.sentiment}`);
        console.log(`   Summary: ${analysis.summary}`);
        console.log('');

        // Step 2: Generate auto-reply
        console.log('🤖 Step 2: Generating auto-reply...\n');

        const autoReply = await aiService.generateAutoReply(mockReply, analysis, mockCase);

        if (autoReply.should_auto_reply) {
            console.log('✅ AUTO-REPLY GENERATED:\n');
            console.log('─'.repeat(80));
            console.log(autoReply.reply_text);
            console.log('─'.repeat(80));
            console.log('');
            console.log(`Confidence: ${autoReply.confidence}`);
            if (autoReply.is_denial_rebuttal) {
                console.log(`Denial Type: ${autoReply.denial_subtype}`);
                console.log('This was a strategic denial rebuttal with legal research!');
            }
            console.log('');
            console.log('📧 This reply would be sent back to: shadewofficial@gmail.com');
        } else {
            console.log('❌ NO AUTO-REPLY');
            console.log(`Reason: ${autoReply.reason}`);
        }

    } catch (error) {
        console.error('Error:', error);
    }
}

console.log('\n╔════════════════════════════════════════════════════════════════════════════╗');
console.log('║                                                                            ║');
console.log('║              🤖 LOCAL AUTO-REPLY PROCESSOR                                ║');
console.log('║                                                                            ║');
console.log('║  Simulating what Railway would do when it receives your reply             ║');
console.log('║                                                                            ║');
console.log('╚════════════════════════════════════════════════════════════════════════════╝\n');

processReply().catch(console.error);
