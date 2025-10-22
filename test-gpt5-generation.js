require('dotenv').config();
const OpenAI = require('openai');

const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY
});

async function testGPT5() {
    console.log('Testing GPT-5 generation with LOW reasoning...\n');

    const systemPrompt = `You are a specialist in FOIA requests for documentary film production. Generate a professional FOIA request for video footage.`;

    const userPrompt = `Generate a FOIA request for:
Case: Paul A. Harris - Son sentenced to 55 years for murder of father
Agency: Test Police Department
State: CA
Need: Body camera footage, police reports`;

    try {
        console.log('Calling GPT-5...');
        const response = await openai.chat.completions.create({
            model: 'gpt-5',
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: userPrompt }
            ],
            reasoning_effort: 'low',
            verbosity: 'medium',
            max_completion_tokens: 4000
        });

        console.log('\n✅ Response received!');
        console.log('Content length:', response.choices?.[0]?.message?.content?.length);
        console.log('Reasoning tokens:', response.usage?.completion_tokens_details?.reasoning_tokens);
        console.log('Total completion tokens:', response.usage?.completion_tokens);
        console.log('\nFirst 300 chars:\n', response.choices?.[0]?.message?.content?.substring(0, 300));

    } catch (error) {
        console.error('\n❌ Error:', error.message);
    }
}

testGPT5();
