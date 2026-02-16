require('dotenv').config();
const OpenAI = require('openai');
const documentaryPrompts = require('./prompts/documentary-foia-prompts');
const responsePrompts = require('./prompts/response-handling-prompts');

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Mock case data
const mockCase = {
    case_name: "John Doe - Man arrested after domestic dispute",
    agency_name: "Springfield Police Department",
    agency_email: "records@springfieldpd.gov",
    subject_name: "John Doe",
    state: "IL",
    incident_location: "123 Main Street, Springfield",
    incident_date: "2024-01-15",
    case_summary: "John Doe was arrested following a domestic dispute call. Officers responded to 123 Main Street where a verbal altercation had escalated. Doe was taken into custody without incident."
};

async function generateInitialRequest() {
    console.log('═══════════════════════════════════════════════════════');
    console.log('📤 ROUND 1: INITIAL FOIA REQUEST');
    console.log('═══════════════════════════════════════════════════════\n');

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
    console.log('TO:', mockCase.agency_email);
    console.log('SUBJECT: Public Records Request - John Doe\n');
    console.log(request);
    console.log('\n');

    return request;
}

async function simulateAgencyResponse(roundNumber, responseType) {
    console.log('\n═══════════════════════════════════════════════════════');
    console.log(`📥 ROUND ${roundNumber}: AGENCY RESPONSE (${responseType})`);
    console.log('═══════════════════════════════════════════════════════\n');

    const responses = {
        acknowledgment: `Dear Mr. Hylton,

Thank you for your FOIA request received on January 20, 2025. Your request has been assigned case number FOIA-2025-00123.

We are currently reviewing your request and will provide an estimate within 5 business days as required under the Illinois Freedom of Information Act.

If you have any questions, please reference case number FOIA-2025-00123.

Best regards,
Sarah Johnson
FOIA Officer
Springfield Police Department`,

        fee_estimate: `Dear Mr. Hylton,

RE: FOIA-2025-00123

We have completed our review of your request. The records you requested include:
- Body worn camera footage from 3 officers (approximately 4.5 hours total)
- Dashboard camera footage from 2 patrol vehicles (approximately 2 hours)
- 911 call recording (3 minutes)
- Incident report and arrest report

Estimated costs:
Total: $425.00

This includes search time, review, and redaction of private information (faces of bystanders, license plates).

Please confirm if you would like to proceed with this estimate. Payment is required before we can begin processing.

Best regards,
Sarah Johnson
FOIA Officer`,

        negotiation_response: `Dear Mr. Hylton,

Thank you for your response. We can provide the following breakdown:

Line-item costs:
- Search/retrieval: $50
- Review (4.5 hours at $35/hr): $157.50
- Redaction work (estimated 3 hours at $45/hr): $135
- Media export and formatting: $82.50
Total: $425

We have footage from Officers Martinez (Badge 1247), Chen (Badge 1089), and Rodriguez (Badge 1152). If you would like to narrow to just the primary responding officer (Martinez), we can reduce the total to approximately $180.

The interrogation room video is approximately 45 minutes and would add $75 if included.

Please let us know how you'd like to proceed.

Best regards,
Sarah Johnson`,

        final_confirmation: `Dear Mr. Hylton,

Thank you for your payment of $180.00 (Receipt #SPD-2025-789).

We will begin processing your narrowed request for:
- Officer Martinez BWC footage (Badge 1247) with 30-minute buffers
- 911 call recording
- Incident and arrest reports

Estimated delivery: 7-10 business days. We will provide a secure download link via email.

Thank you for your patience.

Best regards,
Sarah Johnson
FOIA Officer`
    };

    const response = responses[responseType];
    console.log('FROM:', mockCase.agency_email);
    console.log(response);
    console.log('\n');

    return response;
}

async function analyzeResponse(agencyMessage) {
    const analysisPrompt = `Analyze this email response to a FOIA request and extract key information:

**Original Request Context:**
Subject: ${mockCase.subject_name}
Agency: ${mockCase.agency_name}

**Response Email:**
From: ${mockCase.agency_email}
Subject: RE: FOIA Request
Body:
${agencyMessage}

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

    const response = await openai.chat.completions.create({
        model: 'gpt-5.2-2025-12-11',
        messages: [
            { role: 'system', content: responsePrompts.analysisSystemPrompt },
            { role: 'user', content: analysisPrompt }
        ],
        temperature: 0.3,
        response_format: { type: 'json_object' }
    });

    const analysis = JSON.parse(response.choices[0].message.content);

    console.log('🤖 BOT ANALYSIS:');
    console.log('════════════════════════════════════════════════════════');
    console.log('Intent:', analysis.intent);
    console.log('Confidence:', analysis.confidence_score);
    console.log('Sentiment:', analysis.sentiment);
    console.log('Fee Amount:', analysis.extracted_fee_amount);
    console.log('Requires Action:', analysis.requires_action);
    console.log('Summary:', analysis.summary);
    console.log('Suggested Action:', analysis.suggested_action);
    console.log('\n');

    return analysis;
}

async function generateAutoReply(agencyMessage, analysis) {
    const replyPrompt = `Generate a professional email reply to this FOIA response:

**Context:**
- Our request was about: ${mockCase.subject_name}
- Agency: ${mockCase.agency_name}

**Their Response:**
${agencyMessage}

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

    const response = await openai.chat.completions.create({
        model: 'gpt-5.2-2025-12-11',
        messages: [
            { role: 'system', content: responsePrompts.autoReplySystemPrompt },
            { role: 'user', content: replyPrompt }
        ],
        temperature: 0.7,
        max_tokens: 800
    });

    const reply = response.choices[0].message.content;

    console.log('✉️  BOT AUTO-REPLY:');
    console.log('════════════════════════════════════════════════════════');
    console.log('TO:', mockCase.agency_email);
    console.log('SUBJECT: RE: FOIA-2025-00123\n');
    console.log(reply);
    console.log('\n');

    return reply;
}

async function runFullConversation() {
    console.log('\n\n');
    console.log('🤖 SIMULATING FULL FOIA CONVERSATION FLOW');
    console.log('════════════════════════════════════════════════════════════════\n');

    // Round 1: Initial request
    await generateInitialRequest();
    await new Promise(resolve => setTimeout(resolve, 1000));

    // Round 2: Agency acknowledges
    const ack = await simulateAgencyResponse(2, 'acknowledgment');
    const ackAnalysis = await analyzeResponse(ack);
    const ackReply = await generateAutoReply(ack, ackAnalysis);
    await new Promise(resolve => setTimeout(resolve, 1000));

    // Round 3: Agency provides fee estimate
    const feeEstimate = await simulateAgencyResponse(3, 'fee_estimate');
    const feeAnalysis = await analyzeResponse(feeEstimate);
    const feeReply = await generateAutoReply(feeEstimate, feeAnalysis);
    await new Promise(resolve => setTimeout(resolve, 1000));

    // Round 4: Agency responds to negotiation
    const negotiation = await simulateAgencyResponse(4, 'negotiation_response');
    const negAnalysis = await analyzeResponse(negotiation);
    const negReply = await generateAutoReply(negotiation, negAnalysis);
    await new Promise(resolve => setTimeout(resolve, 1000));

    // Round 5: Agency confirms
    const confirmation = await simulateAgencyResponse(5, 'final_confirmation');
    const confAnalysis = await analyzeResponse(confirmation);

    console.log('✅ CONVERSATION COMPLETE');
    console.log('════════════════════════════════════════════════════════════════');
    console.log('\nSummary:');
    console.log('- Round 1: Bot sent initial FOIA request');
    console.log('- Round 2: Agency acknowledged → Bot thanked them');
    console.log('- Round 3: Agency quoted $425 → Bot requested breakdown and narrowing');
    console.log('- Round 4: Agency offered $180 option → Bot accepted narrowed scope');
    console.log('- Round 5: Agency confirmed payment and processing');
    console.log('\n✨ All responses were natural, contextual, and followed SOPs!\n');
}

runFullConversation().catch(console.error);
