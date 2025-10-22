require('dotenv').config();
const { Client } = require('@notionhq/client');
const OpenAI = require('openai');
const documentaryPrompts = require('./prompts/documentary-foia-prompts');

const notion = new Client({ auth: process.env.NOTION_API_KEY });
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

async function testCase() {
    try {
        console.log('Fetching cases from Notion...\n');

        // Query for cases with non-null Police Department
        const response = await notion.databases.query({
            database_id: process.env.NOTION_CASES_DATABASE_ID,
            filter: {
                property: 'Police Department',
                relation: {
                    is_not_empty: true
                }
            },
            page_size: 1
        });

        if (response.results.length === 0) {
            console.log('No cases found with Police Department relation');
            return;
        }

        const page = response.results[0];
        const props = page.properties;

        // Get title
        const titleProp = Object.values(props).find(p => p.type === 'title');
        const caseName = titleProp?.title?.[0]?.plain_text || 'Untitled';

        // Get police department ID
        const policeDeptId = props['Police Department']?.relation?.[0]?.id;

        console.log('📋 CASE FOUND:');
        console.log('Case Name:', caseName);
        console.log('Police Dept ID:', policeDeptId);

        // Fetch police department
        const deptPage = await notion.pages.retrieve({ page_id: policeDeptId });
        const deptProps = deptPage.properties;

        // Get department title
        const deptTitleProp = Object.values(deptProps).find(p => p.type === 'title');
        const agencyName = deptTitleProp?.title?.[0]?.plain_text || 'Unknown PD';

        // Get email - try different field names
        let agencyEmail = deptProps['Email']?.email ||
                         deptProps['Email']?.rich_text?.[0]?.plain_text ||
                         deptProps['Agency Email']?.email ||
                         deptProps['Contact Email']?.email ||
                         'shadewofficial@gmail.com';

        console.log('\n📧 POLICE DEPARTMENT INFO:');
        console.log('Agency Name:', agencyName);
        console.log('Agency Email:', agencyEmail);

        // Get case details
        const suspect = props['Suspect']?.rich_text?.[0]?.plain_text || caseName;
        const state = props['State']?.select?.name || props['US State']?.select?.name || 'CA';
        const location = props['Location']?.rich_text?.[0]?.plain_text ||
                        props['City ']?.select?.name || '';
        const crimeDate = props['Crime Date']?.date?.start ||
                         props['Date of arrest']?.date?.start || '';
        const caseSummary = props['Case Summary']?.rich_text?.[0]?.plain_text || '';

        console.log('\n👤 CASE DETAILS:');
        console.log('Suspect:', suspect);
        console.log('State:', state);
        console.log('Location:', location);
        console.log('Crime Date:', crimeDate);
        console.log('Case Summary:', caseSummary?.substring(0, 150) + '...');

        // Build user prompt
        const userPrompt = `Generate a professional FOIA/public records request following the structure in the system prompt.

1. BASIC INFO:
   - Jurisdiction: ${state}
   - Agency: ${agencyName}
   - Requester: Samuel Hylton
   - Email: samuel@matcher.com
   - Address: 3021 21st Ave W, Apt 202, Seattle, WA 98199

2. INCIDENT DETAILS:
   ${caseSummary || `Investigation involving ${suspect}`}
   ${location ? `Location: ${location}` : ''}
   ${crimeDate ? `Date: ${crimeDate}` : ''}

3. DETAILED FOOTAGE REQUESTS:
   - Request footage from all responding officers
   - Include appropriate time buffers around incident

4. LEGAL STYLE: Keep it simple and professional

5. STATE-SPECIFIC CONSIDERATIONS:
   Apply moderate enforcement approach - reference state deadlines

6. DOCUMENTARY-FOCUSED INSTRUCTIONS:
   - Emphasize VIDEO FOOTAGE as primary need
   - Include officer names/badge numbers when provided
   - Use simple language, avoid "no responsive records" loopholes
   - Keep total request to 200-400 words

Generate ONLY the email body following the structure. Do NOT add a subject line.`;

        console.log('\n\n🤖 GENERATING FOIA REQUEST...\n');

        const completion = await openai.chat.completions.create({
            model: 'gpt-5',
            messages: [
                { role: 'system', content: documentaryPrompts.systemPrompt },
                { role: 'user', content: userPrompt }
            ],
            reasoning_effort: 'low',
            verbosity: 'medium',
            max_completion_tokens: 4000
        });

        const requestText = completion.choices[0].message.content;

        // Create subject
        const simpleName = suspect.split(' - ')[0].split('(')[0].trim();
        const subject = `Public Records Request - ${simpleName}`;

        console.log('📨 GENERATED EMAIL:');
        console.log('=====================================');
        console.log('TO:', agencyEmail);
        console.log('FROM:', process.env.SENDGRID_FROM_EMAIL);
        console.log('SUBJECT:', subject);
        console.log('\n📄 BODY:');
        console.log('=====================================');
        console.log(requestText);
        console.log('=====================================\n');

        console.log('✅ Test completed!');
        console.log('Reasoning tokens:', completion.usage?.completion_tokens_details?.reasoning_tokens);
        console.log('Total tokens:', completion.usage?.total_tokens);

    } catch (error) {
        console.error('❌ Error:', error.message);
        console.error(error.stack);
    }
}

testCase();
