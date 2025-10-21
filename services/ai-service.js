const OpenAI = require('openai');
const Anthropic = require('@anthropic-ai/sdk');
const db = require('./database');

class AIService {
    constructor() {
        this.openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
        this.anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    }

    /**
     * Generate a FOIA request from case data
     */
    async generateFOIARequest(caseData) {
        try {
            console.log(`Generating FOIA request for case: ${caseData.case_name}`);

            const prompt = this.buildFOIARequestPrompt(caseData);

            // Try OpenAI first
            try {
                const response = await this.openai.chat.completions.create({
                    model: 'gpt-4o',
                    messages: [
                        {
                            role: 'system',
                            content: 'You are an expert at writing formal FOIA requests. Generate professional, legally sound requests that are clear, specific, and comply with relevant public records laws.'
                        },
                        {
                            role: 'user',
                            content: prompt
                        }
                    ],
                    temperature: 0.7,
                    max_tokens: 1500
                });

                const requestText = response.choices[0].message.content;

                // Store generated request
                await db.createGeneratedRequest({
                    case_id: caseData.id,
                    request_text: requestText,
                    ai_model: 'gpt-4o',
                    generation_metadata: {
                        tokens_used: response.usage.total_tokens,
                        cost: this.calculateCost(response.usage, 'gpt-4o')
                    },
                    status: 'approved'
                });

                return {
                    success: true,
                    request_text: requestText,
                    model: 'gpt-4o'
                };
            } catch (openaiError) {
                console.error('OpenAI failed, trying Claude:', openaiError.message);
                return await this.generateWithClaude(caseData, prompt);
            }
        } catch (error) {
            console.error('Error generating FOIA request:', error);
            throw error;
        }
    }

    /**
     * Generate FOIA request using Claude (fallback)
     */
    async generateWithClaude(caseData, prompt) {
        const response = await this.anthropic.messages.create({
            model: 'claude-3-5-sonnet-20241022',
            max_tokens: 1500,
            messages: [
                {
                    role: 'user',
                    content: prompt
                }
            ]
        });

        const requestText = response.content[0].text;

        await db.createGeneratedRequest({
            case_id: caseData.id,
            request_text: requestText,
            ai_model: 'claude-3-5-sonnet',
            generation_metadata: {
                tokens_used: response.usage.input_tokens + response.usage.output_tokens
            },
            status: 'approved'
        });

        return {
            success: true,
            request_text: requestText,
            model: 'claude-3-5-sonnet'
        };
    }

    /**
     * Build the prompt for FOIA request generation
     */
    buildFOIARequestPrompt(caseData) {
        const recordsList = Array.isArray(caseData.requested_records)
            ? caseData.requested_records.join(', ')
            : caseData.requested_records || 'police reports and related records';

        return `Generate a formal FOIA request letter with the following details:

**Case Information:**
- Subject: ${caseData.subject_name || 'Unknown'}
- Agency: ${caseData.agency_name}
- Incident Date: ${caseData.incident_date || 'Unknown'}
- Incident Location: ${caseData.incident_location || 'Unknown'}
- State: ${caseData.state}

**Requested Records:**
${recordsList}

**Additional Details:**
${caseData.additional_details || 'None provided'}

The request should:
1. Be professional and formal
2. Cite the appropriate state FOIA law (${caseData.state} public records act)
3. Be specific about what records are requested
4. Include time frame and location details
5. Request expedited processing if appropriate
6. Include a statement about fee waivers if applicable
7. Provide contact information placeholder
8. Be properly formatted as a letter

Please generate only the body of the letter, starting with a proper salutation and ending with a professional closing.`;
    }

    /**
     * Analyze a response email from an agency
     */
    async analyzeResponse(messageData, caseData) {
        try {
            console.log(`Analyzing response for case: ${caseData.case_name}`);

            const prompt = `Analyze this email response to a FOIA request and extract key information:

**Original Request Context:**
Subject: ${caseData.subject_name}
Agency: ${caseData.agency_name}

**Response Email:**
From: ${messageData.from_email}
Subject: ${messageData.subject}
Body:
${messageData.body_text}

Please analyze and provide a JSON response with:
1. intent: (acknowledgment | question | delivery | denial | fee_request | more_info_needed)
2. confidence_score: 0.0 to 1.0
3. sentiment: (positive | neutral | negative | hostile)
4. key_points: array of important points from the email
5. extracted_deadline: any deadline mentioned (YYYY-MM-DD format or null)
6. extracted_fee_amount: any fee amount mentioned (number or null)
7. requires_action: boolean - does this require a response from us?
8. suggested_action: what should we do next?
9. summary: brief 1-2 sentence summary

Return ONLY valid JSON, no other text.`;

            const response = await this.openai.chat.completions.create({
                model: 'gpt-4o-mini',
                messages: [
                    {
                        role: 'system',
                        content: 'You are an AI that analyzes FOIA response emails. Always return valid JSON.'
                    },
                    {
                        role: 'user',
                        content: prompt
                    }
                ],
                temperature: 0.3,
                response_format: { type: 'json_object' }
            });

            const analysis = JSON.parse(response.choices[0].message.content);

            // Store analysis in database
            const analysisRecord = await db.createResponseAnalysis({
                message_id: messageData.id,
                case_id: caseData.id,
                intent: analysis.intent,
                confidence_score: analysis.confidence_score,
                sentiment: analysis.sentiment,
                key_points: analysis.key_points,
                extracted_deadline: analysis.extracted_deadline,
                extracted_fee_amount: analysis.extracted_fee_amount,
                requires_action: analysis.requires_action,
                suggested_action: analysis.suggested_action,
                full_analysis_json: analysis
            });

            return analysis;
        } catch (error) {
            console.error('Error analyzing response:', error);
            throw error;
        }
    }

    /**
     * Generate an auto-reply based on the analysis
     */
    async generateAutoReply(messageData, analysis, caseData) {
        try {
            console.log(`Generating auto-reply for case: ${caseData.case_name}`);

            // Check if this is a simple case we can auto-reply to
            const simpleIntents = ['acknowledgment', 'fee_request', 'more_info_needed'];
            if (!simpleIntents.includes(analysis.intent)) {
                return {
                    should_auto_reply: false,
                    reason: 'Intent not suitable for auto-reply'
                };
            }

            const prompt = `Generate a professional email reply to this FOIA response:

**Context:**
- Our request was about: ${caseData.subject_name}
- Agency: ${caseData.agency_name}

**Their Response:**
${messageData.body_text}

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

            const response = await this.openai.chat.completions.create({
                model: 'gpt-4o-mini',
                messages: [
                    {
                        role: 'system',
                        content: 'You are an AI that writes professional FOIA correspondence. Be polite, clear, and efficient.'
                    },
                    {
                        role: 'user',
                        content: prompt
                    }
                ],
                temperature: 0.7,
                max_tokens: 800
            });

            const replyText = response.choices[0].message.content;
            const confidenceThreshold = parseFloat(process.env.AUTO_REPLY_CONFIDENCE_THRESHOLD) || 0.8;

            return {
                should_auto_reply: analysis.confidence_score >= confidenceThreshold,
                reply_text: replyText,
                confidence: analysis.confidence_score,
                requires_approval: analysis.confidence_score < confidenceThreshold
            };
        } catch (error) {
            console.error('Error generating auto-reply:', error);
            throw error;
        }
    }

    /**
     * Generate a follow-up email
     */
    async generateFollowUp(caseData, followUpCount = 0) {
        try {
            console.log(`Generating follow-up #${followUpCount + 1} for case: ${caseData.case_name}`);

            const tone = followUpCount === 0 ? 'polite and professional' : 'firm but professional';
            const stateDeadline = await db.getStateDeadline(caseData.state);
            const deadlineDays = stateDeadline?.response_days || 10;

            const prompt = `Generate a follow-up email for a FOIA request that hasn't received a response.

**Request Details:**
- Subject: ${caseData.subject_name}
- Agency: ${caseData.agency_name}
- Original sent: ${caseData.send_date}
- State: ${caseData.state}
- Legal deadline: ${deadlineDays} business days

**Follow-up Context:**
- This is follow-up #${followUpCount + 1}
- ${followUpCount === 0 ? 'First follow-up, be polite' : 'Subsequent follow-up, be firmer'}

The email should:
1. Reference the original request
2. Mention the state law deadline
3. Be ${tone}
4. Request a status update
5. Restate our interest in the records
${followUpCount > 0 ? '6. Note this is a follow-up and we\'re still awaiting response' : ''}

Return ONLY the email body text.`;

            const response = await this.openai.chat.completions.create({
                model: 'gpt-4o-mini',
                messages: [
                    {
                        role: 'system',
                        content: 'You are an AI that writes professional FOIA follow-up emails.'
                    },
                    {
                        role: 'user',
                        content: prompt
                    }
                ],
                temperature: 0.7,
                max_tokens: 600
            });

            return response.choices[0].message.content;
        } catch (error) {
            console.error('Error generating follow-up:', error);
            throw error;
        }
    }

    /**
     * Calculate cost for OpenAI API call
     */
    calculateCost(usage, model) {
        const prices = {
            'gpt-4o': {
                input: 0.00001,  // $0.01 per 1K tokens
                output: 0.00003  // $0.03 per 1K tokens
            },
            'gpt-4o-mini': {
                input: 0.00000015,
                output: 0.0000006
            }
        };

        const modelPrices = prices[model] || prices['gpt-4o-mini'];
        const inputCost = (usage.prompt_tokens / 1000) * modelPrices.input;
        const outputCost = (usage.completion_tokens / 1000) * modelPrices.output;

        return inputCost + outputCost;
    }
}

module.exports = new AIService();
