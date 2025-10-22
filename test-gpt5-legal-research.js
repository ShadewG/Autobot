require('dotenv').config();
const OpenAI = require('openai');
const denialResponsePrompts = require('./prompts/denial-response-prompts');

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Test GPT-5 with web search for legal research
async function testGPT5LegalResearch(state, denialType) {
    console.log('\n' + '═'.repeat(80));
    console.log(`🔍 GPT-5 + WEB SEARCH: ${state} laws for ${denialType} denials`);
    console.log('═'.repeat(80));

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

    console.log(`\n⏱️  Research completed in ${duration} seconds`);
    console.log('\n📚 LEGAL RESEARCH RESULTS (with live web search):\n');
    console.log(response.output_text);

    return response.output_text;
}

async function testGPT5RebuttalGeneration(state, denialType, denialText, legalResearch) {
    console.log('\n' + '═'.repeat(80));
    console.log(`✍️  GPT-5 REBUTTAL: ${denialType}`);
    console.log('═'.repeat(80));

    const strategy = denialResponsePrompts.denialStrategies[denialType];

    const prompt = `You are an expert at fighting FOIA denials for Matcher, a documentary production company. Your job is to craft intelligent, legally-grounded rebuttals that cite specific statutes and case law.

CORE STRATEGY:
- Always cite the specific state's public records law
- Reference segregability requirements (agencies must release non-exempt portions)
- Provide proof of existence when possible
- Offer to narrow scope or accept redactions
- Be firm but professional - never hostile
- Quote exact statutory language when helpful

Generate a strategic FOIA denial rebuttal for this response:

**Denial Type:** ${strategy.name}
**Agency Response:** ${denialText}

**Case Context:**
- Subject: John Doe
- Agency: Chicago Police Department
- State: ${state}
- Incident Date: 2024-01-15
- Incident Location: 123 Main St, Chicago

**Strategy to Follow:**
${strategy.strategy}

**Legal Research for ${state}:**
${legalResearch}

USE THIS RESEARCH to cite EXACT statutes and case law. Quote specific statutory language where powerful.

**Additional Context:**
- Officer details (if known): Not specified
- Original records requested: Body-worn camera footage, dashcam, 911 calls, incident reports

Generate a STRONG, legally-grounded rebuttal that:
1. Cites specific ${state} public records law (use exact statute numbers from research)
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

    console.log(`\n⏱️  Rebuttal generated in ${duration} seconds`);
    console.log('\n📧 GENERATED REBUTTAL:\n');
    console.log('─'.repeat(80));
    console.log(rebuttal);
    console.log('─'.repeat(80));

    // Verify legal citations are present
    const hasStatuteCitation = /\d+ ILCS \d+|5 ILCS 140/i.test(rebuttal);
    const hasLegalLanguage = /statute|exemption|segreg|law|pursuant/i.test(rebuttal);

    console.log('\n📊 QUALITY CHECK:');
    console.log(`   ✓ Contains statute citation: ${hasStatuteCitation ? 'YES ✅' : 'NO ❌'}`);
    console.log(`   ✓ Contains legal language: ${hasLegalLanguage ? 'YES ✅' : 'NO ❌'}`);
    console.log(`   ✓ Word count: ${rebuttal.split(/\s+/).length} words`);

    return rebuttal;
}

async function runTests() {
    console.log('\n\n');
    console.log('╔════════════════════════════════════════════════════════════════════════════╗');
    console.log('║                                                                            ║');
    console.log('║            🚀 GPT-5 + WEB SEARCH LEGAL RESEARCH TEST                      ║');
    console.log('║                                                                            ║');
    console.log('║       Testing live web search + medium reasoning for legal rebuttals     ║');
    console.log('║                                                                            ║');
    console.log('╚════════════════════════════════════════════════════════════════════════════╝');

    const testCases = [
        {
            state: 'Illinois',
            denialType: 'overly_broad',
            denialText: 'Your request is overly broad and would be unduly burdensome to fulfill. Please narrow your request to specific records.'
        },
        {
            state: 'Illinois',
            denialType: 'no_records',
            denialText: 'We have no responsive records for your request. No body-worn camera footage or reports were found for this incident.'
        }
    ];

    for (const testCase of testCases) {
        // Step 1: Research the law with GPT-5 + web search
        const research = await testGPT5LegalResearch(testCase.state, testCase.denialType);

        await new Promise(r => setTimeout(r, 2000));

        // Step 2: Generate rebuttal using GPT-5 with the research
        await testGPT5RebuttalGeneration(
            testCase.state,
            testCase.denialType,
            testCase.denialText,
            research
        );

        await new Promise(r => setTimeout(r, 3000));
    }

    console.log('\n\n');
    console.log('═'.repeat(80));
    console.log('✅ ALL GPT-5 TESTS COMPLETE');
    console.log('═'.repeat(80));
    console.log('\nWhat This Demonstrates:');
    console.log('  ✅ GPT-5 with medium reasoning effort');
    console.log('  ✅ LIVE web search for most recent case law');
    console.log('  ✅ Exact statute citations from web search results');
    console.log('  ✅ Latest court decisions and statutory updates');
    console.log('  ✅ Strategic, legally-grounded rebuttals');
    console.log('  ✅ Firm but professional tone');
    console.log('  ✅ Complete automation from denial → research → rebuttal');
    console.log('\n');
}

runTests().catch(console.error);
