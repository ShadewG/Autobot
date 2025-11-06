require('dotenv').config();
const OpenAI = require('openai');
const documentaryPrompts = require('./prompts/documentary-foia-prompts');
const denialResponsePrompts = require('./prompts/denial-response-prompts');

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Mock case data
const mockCase = {
    case_name: "John Doe - Arrest following domestic dispute",
    agency_name: "Chicago Police Department",
    agency_email: "foia@chicagopd.org",
    subject_name: "John Doe",
    state: "IL",
    incident_location: "123 Main St, Chicago",
    incident_date: "2024-01-15",
    case_summary: "John Doe was arrested following a domestic dispute call. Officers responded to 123 Main Street where a verbal altercation had escalated. Doe was taken into custody."
};

function printHeader(title) {
    console.log('\n\n');
    console.log('═'.repeat(80));
    console.log(`  ${title}`);
    console.log('═'.repeat(80));
    console.log('');
}

function printEmail(from, to, subject, body, metadata = '') {
    console.log('┌' + '─'.repeat(78) + '┐');
    console.log(`│ FROM: ${from.padEnd(71)}│`);
    console.log(`│ TO: ${to.padEnd(73)}│`);
    console.log(`│ SUBJECT: ${subject.padEnd(67)}│`);
    if (metadata) {
        console.log(`│ ${metadata.padEnd(77)}│`);
    }
    console.log('├' + '─'.repeat(78) + '┤');

    // Wrap body text
    const lines = body.split('\n');
    lines.forEach(line => {
        if (line.length <= 76) {
            console.log(`│ ${line.padEnd(77)}│`);
        } else {
            // Simple word wrap
            const words = line.split(' ');
            let currentLine = '';
            words.forEach(word => {
                if ((currentLine + word).length <= 76) {
                    currentLine += (currentLine ? ' ' : '') + word;
                } else {
                    console.log(`│ ${currentLine.padEnd(77)}│`);
                    currentLine = word;
                }
            });
            if (currentLine) {
                console.log(`│ ${currentLine.padEnd(77)}│`);
            }
        }
    });

    console.log('└' + '─'.repeat(78) + '┘');
}

async function generateInitialRequest() {
    printHeader('📤 ROUND 1: BOT SENDS INITIAL FOIA REQUEST');

    console.log('🤖 Generating initial FOIA request using GPT-5...\n');

    const userPrompt = `Generate a professional FOIA/public records request following the structure in the system prompt.

1. BASIC INFO:
   - Jurisdiction: ${mockCase.state}
   - Agency: ${mockCase.agency_name}
   - Requester: Samuel Hylton
   - Email: samuel@matcher.com
   - Address: 3021 21st Ave W, Apt 202, Seattle, WA 98199

2. INCIDENT DETAILS:
   ${mockCase.case_summary}
   Location: ${mockCase.incident_location}
   Date: ${mockCase.incident_date}

3. DETAILED FOOTAGE REQUESTS:
   - Request footage from all responding officers
   - Include appropriate time buffers around incident

4. LEGAL STYLE: Keep it simple and professional

5. STATE-SPECIFIC CONSIDERATIONS:
   Apply moderate enforcement approach - reference state deadlines

6. DOCUMENTARY-FOCUSED INSTRUCTIONS:
   - Emphasize VIDEO FOOTAGE as primary need
   - Use simple language
   - Keep total request to 200-400 words

Generate ONLY the email body following the structure. Do NOT add a subject line.`;

    const startTime = Date.now();

    const response = await openai.responses.create({
        model: 'gpt-5',
        reasoning: { effort: 'low' },  // Low reasoning for initial request generation
        text: { verbosity: 'medium' },
        input: `${documentaryPrompts.systemPrompt}

${userPrompt}`
    });

    const duration = ((Date.now() - startTime) / 1000).toFixed(1);
    const request = response.output_text;

    console.log(`⏱️  Generated in ${duration} seconds\n`);

    printEmail(
        'Samuel Hylton <samuel@matcher.com>',
        mockCase.agency_email,
        `Public Records Request - ${mockCase.subject_name}`,
        request,
        `DATE: January 20, 2025`
    );

    return request;
}

async function simulateAgencyDenial() {
    printHeader('📥 ROUND 2: AGENCY SENDS DENIAL (Overly Broad)');

    const denialText = `Dear Mr. Hylton,

RE: FOIA Request - John Doe Incident

We have reviewed your public records request dated January 20, 2025, regarding the incident involving John Doe on January 15, 2024.

Your request is overly broad and would be unduly burdensome for our department to fulfill. You have requested "all responding officers" footage without specifying officers, badge numbers, or a precise time window. This would require us to review hundreds of hours of footage from multiple officers and vehicles.

We cannot process requests of this nature. Please submit a more specific, narrowed request if you wish to proceed.

Sincerely,
Sarah Johnson
FOIA Officer
Chicago Police Department`;

    printEmail(
        'Sarah Johnson <foia@chicagopd.org>',
        'samuel@matcher.com',
        'RE: Public Records Request',
        denialText,
        'DATE: January 27, 2025'
    );

    return denialText;
}

async function analyzeResponseWithAI(denialText) {
    printHeader('🤖 BOT ANALYZES AGENCY RESPONSE');

    console.log('Analyzing response intent and denial type...\n');

    const analysisPrompt = `Analyze this email response to a FOIA request and extract key information:

**Original Request Context:**
Subject: ${mockCase.subject_name}
Agency: ${mockCase.agency_name}

**Response Email:**
From: ${mockCase.agency_email}
Body:
${denialText}

Please analyze and provide a JSON response with:
1. intent: (acknowledgment | question | delivery | denial | fee_request | more_info_needed)
2. denial_subtype: if intent is "denial", specify subtype (no_records | ongoing_investigation | privacy_exemption | overly_broad | excessive_fees | wrong_agency | retention_expired | format_issue | null)
3. confidence_score: 0.0 to 1.0
4. sentiment: (positive | neutral | negative | hostile)
5. summary: brief 1-2 sentence summary

Return ONLY valid JSON, no other text.`;

    const response = await openai.chat.completions.create({
        model: 'gpt-5-mini',
        messages: [
            {
                role: 'system',
                content: 'You are an expert at analyzing FOIA response emails.'
            },
            {
                role: 'user',
                content: analysisPrompt
            }
        ],
        temperature: 0.3,
        response_format: { type: 'json_object' }
    });

    const analysis = JSON.parse(response.choices[0].message.content);

    console.log('📊 ANALYSIS RESULTS:');
    console.log(`   Intent: ${analysis.intent}`);
    console.log(`   Denial Subtype: ${analysis.denial_subtype}`);
    console.log(`   Confidence: ${analysis.confidence_score}`);
    console.log(`   Sentiment: ${analysis.sentiment}`);
    console.log(`   Summary: ${analysis.summary}`);

    return analysis;
}

async function researchLawsWithGPT5(state, denialType) {
    printHeader('🔍 BOT RESEARCHES STATE LAWS (GPT-5 + Web Search)');

    console.log(`Researching ${state} laws for ${denialType} denials...`);
    console.log('This will take ~5 minutes for comprehensive legal research...\n');

    const researchPrompt = `Research ${state} state public records laws and FOIA exemptions related to ${denialType} denials.

Find:
1. Exact statute citations for ${state} public records law
2. Specific exemption statutes that apply to ${denialType}
3. Segregability requirements (must release non-exempt portions)
4. Recent case law or precedents on ${denialType} denials (search for latest court decisions)
5. Response timelines and legal deadlines
6. Fee limitations or public interest waivers if applicable

Focus on:
- Exact statutory language and citations
- Court interpretations of narrow exemptions
- Requirements agencies must meet to deny requests
- Requester rights and agency obligations
- Use web search to find the most recent case law and statutory updates

Return concise legal citations and key statutory language with sources.`;

    const startTime = Date.now();

    const response = await openai.responses.create({
        model: 'gpt-5',
        reasoning: { effort: 'medium' },
        text: { verbosity: 'medium' },
        tools: [
            { type: 'web_search' }
        ],
        input: researchPrompt
    });

    const duration = ((Date.now() - startTime) / 1000).toFixed(1);
    const research = response.output_text;

    console.log(`✅ Research complete in ${duration} seconds`);
    console.log(`   Found ${(research.match(/5 ILCS/g) || []).length} statute citations`);
    console.log(`   Found ${(research.match(/\d{4} IL App/g) || []).length} case law references`);
    console.log(`   Research length: ${research.length} characters\n`);

    return research;
}

async function generateRebuttalWithGPT5(denialText, research) {
    printHeader('📤 ROUND 3: BOT SENDS STRATEGIC REBUTTAL');

    console.log('🤖 Generating legally-grounded rebuttal using GPT-5 + research...\n');

    const strategy = denialResponsePrompts.denialStrategies.overly_broad;

    const prompt = `You are an expert at fighting FOIA denials for Matcher, a documentary production company. Your job is to craft intelligent, legally-grounded rebuttals that cite specific statutes and case law.

CORE STRATEGY:
- Always cite the specific state's public records law
- Reference segregability requirements (agencies must release non-exempt portions)
- Offer to narrow scope or accept redactions
- Be firm but professional - never hostile
- Quote exact statutory language when helpful

Generate a strategic FOIA denial rebuttal for this response:

**Denial Type:** ${strategy.name}
**Agency Response:** ${denialText}

**Case Context:**
- Subject: ${mockCase.subject_name}
- Agency: ${mockCase.agency_name}
- State: Illinois
- Incident Date: ${mockCase.incident_date}
- Incident Location: ${mockCase.incident_location}

**Strategy to Follow:**
${strategy.strategy}

**Legal Research for Illinois:**
${research}

USE THIS RESEARCH to cite EXACT statutes and case law. Quote specific statutory language where powerful.

Generate a STRONG, legally-grounded rebuttal that:
1. Cites specific Illinois public records law (use exact statute numbers from research)
2. Uses the strategy outlined above
3. Is assertive but professional (firm, not hostile)
4. Quotes exact statutory language where helpful (from the research provided)
5. Shows good faith and willingness to cooperate
6. References relevant case law if provided in research
7. Is under 250 words

Return ONLY the email body text, no subject line.`;

    const startTime = Date.now();

    const response = await openai.responses.create({
        model: 'gpt-5',
        reasoning: { effort: 'medium' },
        text: { verbosity: 'medium' },
        input: prompt
    });

    const duration = ((Date.now() - startTime) / 1000).toFixed(1);
    const rebuttal = response.output_text;

    console.log(`⏱️  Generated in ${duration} seconds\n`);

    printEmail(
        'Samuel Hylton <samuel@matcher.com>',
        mockCase.agency_email,
        'RE: Public Records Request - Narrowed Scope',
        rebuttal,
        'DATE: January 28, 2025'
    );

    // Verify legal quality
    const hasStatuteCitation = /\d+ ILCS \d+|5 ILCS 140/i.test(rebuttal);
    const hasCaseLaw = /\d{4} IL App|v\./i.test(rebuttal);
    const wordCount = rebuttal.split(/\s+/).length;

    console.log('\n📊 REBUTTAL QUALITY CHECK:');
    console.log(`   ✓ Contains statute citations: ${hasStatuteCitation ? 'YES ✅' : 'NO ❌'}`);
    console.log(`   ✓ Contains case law: ${hasCaseLaw ? 'YES ✅' : 'NO ❌'}`);
    console.log(`   ✓ Word count: ${wordCount} words`);
    console.log(`   ✓ Offers to narrow: ${/narrow|specific|revised request/i.test(rebuttal) ? 'YES ✅' : 'NO ❌'}`);
    console.log(`   ✓ Shows cooperation: ${/accept|willing|happy|open/i.test(rebuttal) ? 'YES ✅' : 'NO ❌'}`);

    return rebuttal;
}

async function simulateFinalResponse() {
    printHeader('📥 ROUND 4: AGENCY ACCEPTS NARROWED REQUEST');

    const acceptanceText = `Dear Mr. Hylton,

RE: FOIA Request - John Doe Incident (Narrowed Scope)

Thank you for narrowing your request. We can now process the following:

- Body-worn camera footage from Officers Martinez (Badge 1247) and Chen (Badge 1089) for the time period 6:45 PM - 8:15 PM on January 15, 2024
- 911 call recording (3 minutes)
- Incident and arrest reports

Estimated cost: $180.00
- BWC footage review and redaction: $120.00
- 911 call: $15.00
- Reports (25 pages): $45.00

Please remit payment to proceed. Records will be delivered within 7-10 business days.

Sincerely,
Sarah Johnson
FOIA Officer
Chicago Police Department`;

    printEmail(
        'Sarah Johnson <foia@chicagopd.org>',
        'samuel@matcher.com',
        'RE: Public Records Request - Approved',
        acceptanceText,
        'DATE: January 30, 2025'
    );
}

async function runFullCorrespondence() {
    console.log('\n\n');
    console.log('╔════════════════════════════════════════════════════════════════════════════╗');
    console.log('║                                                                            ║');
    console.log('║              🤖 FULL GPT-5 FOIA CORRESPONDENCE SIMULATION                 ║');
    console.log('║                                                                            ║');
    console.log('║   Complete flow: Request → Denial → Research → Rebuttal → Acceptance     ║');
    console.log('║                                                                            ║');
    console.log('╚════════════════════════════════════════════════════════════════════════════╝');

    // Round 1: Bot sends initial request
    await generateInitialRequest();
    await new Promise(r => setTimeout(r, 2000));

    // Round 2: Agency denies as overly broad
    const denial = await simulateAgencyDenial();
    await new Promise(r => setTimeout(r, 2000));

    // Bot analyzes the denial
    const analysis = await analyzeResponseWithAI(denial);
    await new Promise(r => setTimeout(r, 2000));

    // Bot researches Illinois laws using GPT-5 + web search
    const research = await researchLawsWithGPT5('Illinois', analysis.denial_subtype);
    await new Promise(r => setTimeout(r, 2000));

    // Bot generates strategic rebuttal
    await generateRebuttalWithGPT5(denial, research);
    await new Promise(r => setTimeout(r, 2000));

    // Agency accepts the narrowed request
    await simulateFinalResponse();

    // Final summary
    printHeader('✅ CORRESPONDENCE COMPLETE');

    console.log('📈 SUMMARY OF AUTOMATED WORKFLOW:\n');
    console.log('  1. ✅ Bot generated professional FOIA request (GPT-5, low reasoning)');
    console.log('  2. ✅ Agency denied as "overly broad"');
    console.log('  3. ✅ Bot detected denial type automatically (GPT-5-mini analysis)');
    console.log('  4. ✅ Bot researched Illinois laws (GPT-5 + web search, ~5 min)');
    console.log('  5. ✅ Bot generated strategic rebuttal with exact statutes + case law');
    console.log('  6. ✅ Agency accepted narrowed scope → records approved');
    console.log('');
    console.log('💡 KEY FEATURES DEMONSTRATED:');
    console.log('  • GPT-5 with web search for live legal research');
    console.log('  • Exact statute citations (5 ILCS 140/3(g), 140/7(1), etc.)');
    console.log('  • Recent case law (2024-2025 decisions)');
    console.log('  • Strategic narrowing offers');
    console.log('  • Firm but professional tone');
    console.log('  • Complete automation from denial → acceptance');
    console.log('');
    console.log('🎯 RESULT: Bot successfully fought denial and obtained records!\n');
}

runFullCorrespondence().catch(console.error);
