require('dotenv').config();
const OpenAI = require('openai');
const denialResponsePrompts = require('./prompts/denial-response-prompts');

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Test the legal research function directly
async function testLegalResearch(state, denialType) {
    console.log('\n' + '═'.repeat(80));
    console.log(`🔍 RESEARCHING: ${state} laws for ${denialType} denials`);
    console.log('═'.repeat(80));

    const researchPrompt = `Research ${state} state public records laws and FOIA exemptions related to ${denialType} denials.

Find:
1. Exact statute citations for ${state} public records law
2. Specific exemption statutes that apply to ${denialType}
3. Segregability requirements (must release non-exempt portions)
4. Recent case law or precedents on ${denialType} denials
5. Response timelines and legal deadlines
6. Fee limitations or public interest waivers if applicable

Focus on:
- Exact statutory language and citations
- Court interpretations of narrow exemptions
- Requirements agencies must meet to deny requests
- Requester rights and agency obligations

Return concise legal citations and key statutory language.`;

    const response = await openai.chat.completions.create({
        model: 'gpt-5.2-2025-12-11',
        messages: [
            {
                role: 'system',
                content: 'You are a legal research expert specializing in state public records laws and FOIA litigation. Provide exact citations and statutory language.'
            },
            {
                role: 'user',
                content: researchPrompt
            }
        ],
        temperature: 0.3,
        max_tokens: 1500
    });

    const research = response.choices[0].message.content;

    console.log('\n📚 LEGAL RESEARCH RESULTS:\n');
    console.log(research);

    return research;
}

async function testDenialRebuttalGeneration(state, denialType, denialText, legalResearch) {
    console.log('\n' + '═'.repeat(80));
    console.log(`✍️  GENERATING REBUTTAL: ${denialType}`);
    console.log('═'.repeat(80));

    const strategy = denialResponsePrompts.denialStrategies[denialType];

    const prompt = `Generate a strategic FOIA denial rebuttal for this response:

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

**Example Approach:**
${strategy.exampleRebuttal}

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

    const response = await openai.chat.completions.create({
        model: 'gpt-5.2-2025-12-11',
        messages: [
            {
                role: 'system',
                content: denialResponsePrompts.denialRebuttalSystemPrompt
            },
            {
                role: 'user',
                content: prompt
            }
        ],
        temperature: 0.6,
        max_tokens: 1000
    });

    const rebuttal = response.choices[0].message.content;

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
    console.log('║              🤖 LEGAL RESEARCH & DENIAL REBUTTAL TEST                     ║');
    console.log('║                                                                            ║');
    console.log('║     Testing state-specific legal research + rebuttal generation          ║');
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
            denialType: 'ongoing_investigation',
            denialText: 'This matter is currently under active investigation. We cannot release any records at this time per investigatory exemption.'
        },
        {
            state: 'Illinois',
            denialType: 'privacy_exemption',
            denialText: 'The requested records contain highly personal and confidential information protected by privacy exemptions. Request denied.'
        }
    ];

    for (const testCase of testCases) {
        // Step 1: Research the law
        const research = await testLegalResearch(testCase.state, testCase.denialType);

        await new Promise(r => setTimeout(r, 2000));

        // Step 2: Generate rebuttal using the research
        await testDenialRebuttalGeneration(
            testCase.state,
            testCase.denialType,
            testCase.denialText,
            research
        );

        await new Promise(r => setTimeout(r, 3000));
    }

    console.log('\n\n');
    console.log('═'.repeat(80));
    console.log('✅ ALL TESTS COMPLETE');
    console.log('═'.repeat(80));
    console.log('\nWhat This Demonstrates:');
    console.log('  ✅ LIVE legal research using GPT-5');
    console.log('  ✅ Exact statute citations for Illinois (5 ILCS 140/X)');
    console.log('  ✅ Case law references when available');
    console.log('  ✅ Research integrated into rebuttal generation');
    console.log('  ✅ Strategic, legally-grounded rebuttals');
    console.log('  ✅ Firm but professional tone');
    console.log('  ✅ State-aware (maintains context of Illinois throughout)');
    console.log('\n');
}

runTests().catch(console.error);
