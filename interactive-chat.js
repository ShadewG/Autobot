require('dotenv').config();
const readline = require('readline');
const OpenAI = require('openai');
const documentaryPrompts = require('./prompts/documentary-foia-prompts');
const responsePrompts = require('./prompts/response-handling-prompts');

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Mock case data
const mockCase = {
    case_name: "Michael Rodriguez - Officer-involved shooting investigation",
    agency_name: "Chicago Police Department",
    agency_email: "foia@chicagopd.org",
    subject_name: "Michael Rodriguez",
    state: "IL",
    incident_location: "2400 W Madison St, Chicago",
    incident_date: "2024-02-10",
    case_summary: "Michael Rodriguez was involved in an officer-involved shooting incident. Officers responded to a report of an armed suspect. The incident resulted in Rodriguez being shot and transported to hospital. Investigation is ongoing."
};

const conversationHistory = [];
let initialRequestSent = false;

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

function print(text, color = '') {
    const colors = {
        green: '\x1b[32m',
        blue: '\x1b[34m',
        yellow: '\x1b[33m',
        cyan: '\x1b[36m',
        reset: '\x1b[0m',
        bold: '\x1b[1m'
    };

    const c = colors[color] || '';
    console.log(c + text + colors.reset);
}

async function generateInitialRequest() {
    print('\n🤖 BOT: Generating initial FOIA request...', 'cyan');

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

    const response = await openai.chat.completions.create({
        model: 'gpt-5.2-2025-12-11',
        messages: [
            { role: 'system', content: documentaryPrompts.systemPrompt },
            { role: 'user', content: userPrompt }
        ],
        temperature: 0.7,
        max_tokens: 1000
    });

    const request = response.choices[0].message.content;

    print('\n═══════════════════════════════════════════════════════', 'bold');
    print('📤 FROM: Samuel Hylton <samuel@matcher.com>', 'green');
    print('📧 TO: ' + mockCase.agency_email, 'green');
    print('📋 SUBJECT: Public Records Request - Michael Rodriguez', 'green');
    print('═══════════════════════════════════════════════════════', 'bold');
    print('\n' + request + '\n');

    conversationHistory.push({
        role: 'bot',
        content: request,
        type: 'initial_request'
    });

    initialRequestSent = true;
}

async function analyzeAndReply(yourMessage) {
    print('\n🤖 BOT: Analyzing your response...', 'cyan');

    // Analyze the response
    const analysisPrompt = `Analyze this email response to a FOIA request and extract key information:

**Original Request Context:**
Subject: ${mockCase.subject_name}
Agency: ${mockCase.agency_name}

**Response Email:**
From: ${mockCase.agency_email}
Body:
${yourMessage}

Please analyze and provide a JSON response with:
1. intent: (acknowledgment | question | delivery | denial | fee_request | more_info_needed)
2. denial_subtype: if intent is "denial", specify subtype (no_records | ongoing_investigation | privacy_exemption | overly_broad | excessive_fees | wrong_agency | retention_expired | format_issue | null)
3. confidence_score: 0.0 to 1.0
4. sentiment: (positive | neutral | negative | hostile)
5. key_points: array of important points from the email
6. extracted_deadline: any deadline mentioned (YYYY-MM-DD format or null)
7. extracted_fee_amount: any fee amount mentioned (number or null)
8. requires_action: boolean - does this require a response from us?
9. suggested_action: what should we do next?
10. summary: brief 1-2 sentence summary

Return ONLY valid JSON, no other text.`;

    const analysisResponse = await openai.chat.completions.create({
        model: 'gpt-5.2-2025-12-11',
        messages: [
            { role: 'system', content: responsePrompts.analysisSystemPrompt },
            { role: 'user', content: analysisPrompt }
        ],
        temperature: 0.3,
        response_format: { type: 'json_object' }
    });

    const analysis = JSON.parse(analysisResponse.choices[0].message.content);

    print('\n📊 Analysis:', 'yellow');
    print(`   Intent: ${analysis.intent}`, 'yellow');
    print(`   Confidence: ${analysis.confidence_score}`, 'yellow');
    print(`   Sentiment: ${analysis.sentiment}`, 'yellow');
    if (analysis.extracted_fee_amount) {
        print(`   Fee Amount: $${analysis.extracted_fee_amount}`, 'yellow');
    }
    print(`   Requires Action: ${analysis.requires_action}`, 'yellow');
    print(`   Summary: ${analysis.summary}`, 'yellow');

    // Check if we should auto-reply
    if (analysis.intent === 'denial') {
        print('\n⚠️  DENIAL DETECTED - Flagged for manual review (no auto-reply)', 'yellow');
        print(`   Denial Type: ${analysis.denial_subtype || 'general'}`, 'yellow');
        conversationHistory.push({
            role: 'agency',
            content: yourMessage,
            analysis: analysis
        });
        return;
    }

    const simpleIntents = ['acknowledgment', 'fee_request', 'more_info_needed'];
    if (!analysis.requires_action || !simpleIntents.includes(analysis.intent)) {
        print('\n⚠️  No auto-reply needed for this response type', 'yellow');
        conversationHistory.push({
            role: 'agency',
            content: yourMessage,
            analysis: analysis
        });
        return;
    }

    // Generate auto-reply
    print('\n🤖 BOT: Generating auto-reply...', 'cyan');

    const replyPrompt = `Generate a professional email reply to this FOIA response:

**Context:**
- Our request was about: ${mockCase.subject_name}
- Agency: ${mockCase.agency_name}

**Their Response:**
${yourMessage}

**Analysis:**
- Intent: ${analysis.intent}
- What they need: ${analysis.suggested_action}

Generate an appropriate reply that:
1. Is professional and courteous
2. Addresses their specific questions/needs
3. Provides any information they requested
4. Confirms our continued interest in receiving the records
5. Is concise and clear

Return ONLY the email body text, no subject line or metadata.`;

    const replyResponse = await openai.chat.completions.create({
        model: 'gpt-5.2-2025-12-11',
        messages: [
            { role: 'system', content: responsePrompts.autoReplySystemPrompt },
            { role: 'user', content: replyPrompt }
        ],
        temperature: 0.7,
        max_tokens: 800
    });

    const reply = replyResponse.choices[0].message.content;

    print('\n═══════════════════════════════════════════════════════', 'bold');
    print('📤 FROM: Samuel Hylton <samuel@matcher.com>', 'green');
    print('📧 TO: ' + mockCase.agency_email, 'green');
    print('📋 SUBJECT: RE: Public Records Request', 'green');
    print('═══════════════════════════════════════════════════════', 'bold');
    print('\n' + reply + '\n');

    conversationHistory.push({
        role: 'agency',
        content: yourMessage,
        analysis: analysis
    });
    conversationHistory.push({
        role: 'bot',
        content: reply,
        type: 'auto_reply'
    });
}

function showHelp() {
    print('\n📖 COMMANDS:', 'cyan');
    print('  start     - Bot sends initial FOIA request', 'cyan');
    print('  history   - Show conversation history', 'cyan');
    print('  help      - Show this help message', 'cyan');
    print('  exit/quit - Exit the chat', 'cyan');
    print('\n💬 Or just type your response as the police department!\n', 'cyan');
}

function showHistory() {
    print('\n📜 CONVERSATION HISTORY:', 'cyan');
    print('═══════════════════════════════════════════════════════', 'bold');

    conversationHistory.forEach((msg, i) => {
        if (msg.role === 'bot') {
            print(`\n[${i + 1}] BOT (${msg.type}):`, 'green');
            print(msg.content.substring(0, 200) + '...', 'green');
        } else {
            print(`\n[${i + 1}] YOU (as Police Dept):`, 'blue');
            print(msg.content.substring(0, 200) + '...', 'blue');
            if (msg.analysis) {
                print(`    → Intent: ${msg.analysis.intent}, Sentiment: ${msg.analysis.sentiment}`, 'yellow');
            }
        }
    });
    print('\n');
}

async function handleInput(input) {
    const trimmed = input.trim().toLowerCase();

    if (trimmed === 'exit' || trimmed === 'quit') {
        print('\n👋 Thanks for testing! Goodbye!\n', 'cyan');
        rl.close();
        process.exit(0);
    }

    if (trimmed === 'help') {
        showHelp();
        prompt();
        return;
    }

    if (trimmed === 'history') {
        showHistory();
        prompt();
        return;
    }

    if (trimmed === 'start') {
        if (initialRequestSent) {
            print('\n⚠️  Initial request already sent! Just respond as the PD.\n', 'yellow');
        } else {
            await generateInitialRequest();
        }
        prompt();
        return;
    }

    if (!initialRequestSent) {
        print('\n⚠️  Please type "start" first to have the bot send the initial request!\n', 'yellow');
        prompt();
        return;
    }

    // User is responding as the police department
    if (input.trim().length > 0) {
        await analyzeAndReply(input.trim());
    }

    prompt();
}

function prompt() {
    rl.question('\n👤 You (as PD): ', handleInput);
}

// Start the chat
print('\n╔════════════════════════════════════════════════════════╗', 'bold');
print('║                                                        ║', 'bold');
print('║        🤖 FOIA BOT INTERACTIVE CHAT                   ║', 'bold');
print('║                                                        ║', 'bold');
print('║  Roleplay as a Police Department responding to        ║', 'bold');
print('║  FOIA requests. The bot will analyze and reply!       ║', 'bold');
print('║                                                        ║', 'bold');
print('╚════════════════════════════════════════════════════════╝', 'bold');

print('\n📋 Case: Michael Rodriguez - Officer-involved shooting', 'cyan');
print('🏢 Agency: Chicago Police Department', 'cyan');
print('📅 Date: February 10, 2024\n', 'cyan');

showHelp();

print('Type "start" to have the bot send the initial FOIA request!\n', 'green');

prompt();
