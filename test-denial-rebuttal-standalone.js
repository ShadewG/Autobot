require('dotenv').config();
const OpenAI = require('openai');
const denialResponsePrompts = require('./prompts/denial-response-prompts');

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

async function testOngoingInvestigationRebuttal() {
    console.log('\n╔════════════════════════════════════════════════════════════════════════════╗');
    console.log('║                                                                            ║');
    console.log('║              🤖 ONGOING INVESTIGATION DENIAL REBUTTAL TEST                ║');
    console.log('║                                                                            ║');
    console.log('║  Testing GPT-5 auto-reply to: "this is an ongoing case so we can\'t       ║');
    console.log('║  release anything"                                                         ║');
    console.log('║                                                                            ║');
    console.log('╚════════════════════════════════════════════════════════════════════════════╝\n');

    const agencyResponse = "this is an ongoing case so we can't release anything";
    const denialSubtype = 'ongoing_investigation';

    const mockCase = {
        subject_name: 'Test Subject',
        agency_name: 'Test Police Department',
        state: 'IL',
        incident_date: '2024-01-15',
        incident_location: '123 Main St'
    };

    // Step 1: Research Illinois laws for ongoing investigation denials
    console.log('🔍 STEP 1: Researching Illinois laws for ongoing investigation denials...');
    console.log('           Using GPT-5 + Web Search (this will take ~5 minutes)...\n');

    const researchPrompt = `Research Illinois state public records laws and FOIA exemptions related to ongoing_investigation denials.

Find:
1. Exact statute citations for Illinois public records law
2. Specific exemption statutes that apply to ongoing_investigation
3. Segregability requirements (must release non-exempt portions)
4. Recent case law or precedents on ongoing_investigation denials (search for latest court decisions)
5. Response timelines and legal deadlines
6. Requirements agencies must meet to invoke this exemption

Focus on:
- Exact statutory language and citations (especially 5 ILCS 140)
- Court interpretations of narrow exemptions
- Requirements agencies must meet to deny requests
- Requester rights and agency obligations
- Segregability requirements (releasing non-investigative portions)
- Use web search to find the most recent case law and statutory updates

Return concise legal citations and key statutory language with sources.`;

    const startResearch = Date.now();

    const researchResponse = await openai.responses.create({
        model: 'gpt-5',
        reasoning: { effort: 'medium' },
        text: { verbosity: 'medium' },
        tools: [
            { type: 'web_search' }
        ],
        input: researchPrompt
    });

    const research = researchResponse.output_text;
    const researchDuration = ((Date.now() - startResearch) / 1000).toFixed(1);

    console.log(`✅ Research complete in ${researchDuration} seconds`);
    console.log(`   Found ${(research.match(/5 ILCS/g) || []).length} statute citations`);
    console.log(`   Research length: ${research.length} characters\n`);

    // Step 2: Generate strategic rebuttal using the research
    console.log('🤖 STEP 2: Generating strategic rebuttal using GPT-5...\n');

    const strategy = denialResponsePrompts.denialStrategies[denialSubtype];

    const rebuttalPrompt = `You are an expert at fighting FOIA denials for Matcher, a documentary production company. Your job is to craft intelligent, legally-grounded rebuttals that cite specific statutes and case law.

CORE STRATEGY:
- Always cite the specific state's public records law
- Reference segregability requirements (agencies must release non-exempt portions)
- Offer to narrow scope or accept redactions
- Be firm but professional - never hostile
- Quote exact statutory language when helpful

Generate a strategic FOIA denial rebuttal for this response:

**Denial Type:** ${strategy.name}
**Agency Response:** ${agencyResponse}

**Case Context:**
- Subject: ${mockCase.subject_name}
- Agency: ${mockCase.agency_name}
- State: Illinois
- Incident Date: ${mockCase.incident_date}
- Incident Location: ${mockCase.incident_location}

**Strategy to Follow:**
${strategy.strategy}

**Example Approach:**
${strategy.example}

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
7. Specifically addresses segregability - request non-investigative records that can be released
8. Is under 250 words

Return ONLY the email body text, no subject line.`;

    const startRebuttal = Date.now();

    const rebuttalResponse = await openai.responses.create({
        model: 'gpt-5',
        reasoning: { effort: 'medium' },
        text: { verbosity: 'medium' },
        input: rebuttalPrompt
    });

    const rebuttal = rebuttalResponse.output_text;
    const rebuttalDuration = ((Date.now() - startRebuttal) / 1000).toFixed(1);

    console.log(`⏱️  Generated in ${rebuttalDuration} seconds\n`);

    // Display the auto-reply
    console.log('═'.repeat(80));
    console.log('✅ AUTO-REPLY THAT WOULD BE SENT:');
    console.log('═'.repeat(80));
    console.log('');
    console.log('┌' + '─'.repeat(78) + '┐');
    console.log(`│ FROM: Samuel Hylton <samuel@matcher.com>                                  │`);
    console.log(`│ TO: shadewofficial@gmail.com                                              │`);
    console.log(`│ SUBJECT: RE: Test FOIA Request                                            │`);
    console.log('├' + '─'.repeat(78) + '┤');

    // Wrap body text
    const lines = rebuttal.split('\n');
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
    console.log('');

    // Quality check
    const hasStatuteCitation = /\d+ ILCS \d+|5 ILCS 140/i.test(rebuttal);
    const hasCaseLaw = /\d{4} IL App|v\./i.test(rebuttal);
    const hasSegregability = /segreg|separate|non-exempt|portions/i.test(rebuttal);
    const wordCount = rebuttal.split(/\s+/).length;

    console.log('📊 REBUTTAL QUALITY CHECK:');
    console.log(`   ✓ Contains statute citations: ${hasStatuteCitation ? 'YES ✅' : 'NO ❌'}`);
    console.log(`   ✓ Contains case law: ${hasCaseLaw ? 'YES ✅' : 'NO ❌'}`);
    console.log(`   ✓ Addresses segregability: ${hasSegregability ? 'YES ✅' : 'NO ❌'}`);
    console.log(`   ✓ Word count: ${wordCount} words`);
    console.log(`   ✓ Shows cooperation: ${/accept|willing|happy|open|narrow/i.test(rebuttal) ? 'YES ✅' : 'NO ❌'}`);
    console.log('');

    console.log('═'.repeat(80));
    console.log('🎯 SUMMARY:');
    console.log(`   • Total time: ${((Date.now() - startResearch) / 1000).toFixed(1)} seconds`);
    console.log(`   • Research: ${researchDuration}s (GPT-5 + web search)`);
    console.log(`   • Rebuttal: ${rebuttalDuration}s (GPT-5 medium reasoning)`);
    console.log(`   • Denial type detected: ongoing_investigation`);
    console.log(`   • Strategy: Request segregable non-investigative records`);
    console.log('═'.repeat(80));
    console.log('');
}

testOngoingInvestigationRebuttal().catch(console.error);
