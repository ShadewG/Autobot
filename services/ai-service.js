const OpenAI = require('openai');
const Anthropic = require('@anthropic-ai/sdk');
const db = require('./database');
const documentaryFOIAPrompts = require('../prompts/documentary-foia-prompts');
const responseHandlingPrompts = require('../prompts/response-handling-prompts');
const denialResponsePrompts = require('../prompts/denial-response-prompts');
const adaptiveLearning = require('./adaptive-learning-service');

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

            // Get adaptive strategy based on learned patterns
            const strategy = await adaptiveLearning.generateStrategicVariation(caseData);
            console.log('Using strategy:', strategy);

            const systemPrompt = this.buildFOIASystemPrompt(caseData.state, strategy);
            const userPrompt = this.buildFOIAUserPrompt(caseData, strategy);

            // Combine system and user prompts for GPT-5
            const fullPrompt = `${systemPrompt}\n\n${userPrompt}`;

            // Try GPT-5 first (latest and most capable for FOIA generation)
            try {
                const response = await this.openai.chat.completions.create({
                    model: process.env.OPENAI_MODEL || 'gpt-5',
                    messages: [
                        {
                            role: 'system',
                            content: systemPrompt
                        },
                        {
                            role: 'user',
                            content: userPrompt
                        }
                    ],
                    reasoning_effort: 'low',  // Low reasoning to save tokens for actual content
                    verbosity: 'medium',
                    max_completion_tokens: 4000  // Increased to ensure we get content after reasoning
                });

                const requestText = response.choices[0].message.content;

                // Log for debugging
                console.log('GPT-5 response:', {
                    hasChoices: !!response.choices,
                    choicesLength: response.choices?.length,
                    hasContent: !!requestText,
                    contentLength: requestText?.length,
                    firstChars: requestText?.substring(0, 100)
                });

                if (!requestText || requestText.trim().length === 0) {
                    throw new Error('GPT-5 returned empty content');
                }

                // Store generated request with strategy info
                const modelUsed = process.env.OPENAI_MODEL || 'gpt-5';
                await db.createGeneratedRequest({
                    case_id: caseData.id,
                    request_text: requestText,
                    ai_model: modelUsed,
                    generation_metadata: {
                        tokens_used: response.usage?.total_tokens || 0,
                        prompt_tokens: response.usage?.prompt_tokens || 0,
                        completion_tokens: response.usage?.completion_tokens || 0,
                        reasoning_tokens: response.usage?.reasoning_tokens || 0,
                        cost: this.calculateCost(response.usage, modelUsed),
                        strategy_used: strategy
                    },
                    status: 'approved'
                });

                // Store strategy in case record for later learning
                await db.query(
                    'UPDATE cases SET strategy_used = $1 WHERE id = $2',
                    [JSON.stringify(strategy), caseData.id]
                );

                return {
                    success: true,
                    request_text: requestText,
                    model: modelUsed
                };
            } catch (openaiError) {
                console.error('OpenAI failed, trying Claude:', openaiError.message);
                return await this.generateWithClaude(caseData);
            }
        } catch (error) {
            console.error('Error generating FOIA request:', error);
            throw error;
        }
    }

    /**
     * Generate FOIA request using Claude (fallback)
     */
    async generateWithClaude(caseData) {
        const systemPrompt = this.buildFOIASystemPrompt(caseData.state);
        const userPrompt = this.buildFOIAUserPrompt(caseData);

        const modelUsed = process.env.CLAUDE_MODEL || 'claude-3-7-sonnet-20250219';
        const response = await this.anthropic.messages.create({
            model: modelUsed,
            max_tokens: 2000,
            system: systemPrompt,
            messages: [
                {
                    role: 'user',
                    content: userPrompt
                }
            ]
        });

        const requestText = response.content[0].text;

        await db.createGeneratedRequest({
            case_id: caseData.id,
            request_text: requestText,
            ai_model: modelUsed,
            generation_metadata: {
                tokens_used: response.usage.input_tokens + response.usage.output_tokens
            },
            status: 'approved'
        });

        return {
            success: true,
            request_text: requestText,
            model: modelUsed
        };
    }

    /**
     * Build the system prompt for FOIA request generation (documentary-focused)
     */
    buildFOIASystemPrompt(jurisdiction, strategy = null) {
        const basePrompt = documentaryFOIAPrompts.systemPrompt;
        const jurisdictionGuidance = `

JURISDICTION-SPECIFIC GUIDANCE FOR ${jurisdiction}:
- Apply the specific laws and requirements for ${jurisdiction}
- Use appropriate legal citations for this jurisdiction
- Consider local retention schedules and deadlines
- Apply state-specific strategies based on enforcement strength`;

        // Enhancement prompt removed - using simple documentary style

        // Add strategy-specific instructions if provided
        let strategyInstructions = '';
        if (strategy) {
            const modifications = adaptiveLearning.buildPromptModifications(strategy);
            strategyInstructions = `\n\nSTRATEGIC APPROACH FOR THIS REQUEST:
- Tone: ${modifications.tone_instruction}
- Emphasis: ${modifications.emphasis_instruction}
- Detail Level: ${modifications.detail_instruction}
- Legal Citations: ${modifications.legal_instruction}
- Fee Waiver: ${modifications.fee_instruction}
- Urgency: ${modifications.urgency_instruction}`;
        }

        return basePrompt + jurisdictionGuidance + strategyInstructions;
    }

    /**
     * Build the user prompt for FOIA request generation (documentary-focused)
     */
    buildFOIAUserPrompt(caseData, strategy = null) {
        const legalStyle = strategy?.tone || caseData.legal_style || 'standard';
        const legalStyleInstructions = {
            'standard': 'Use standard professional legal language with polite but firm tone.',
            'formal': 'Use highly formal, traditional legal language with maximum respect and deference.',
            'assertive': 'Use assertive, demanding tone that emphasizes legal rights and obligations.',
            'collaborative': 'Use collaborative, cooperative tone that seeks to work with the agency.'
        };

        const styleInstruction = legalStyleInstructions[legalStyle] || legalStyleInstructions['standard'];

        // Build detailed item descriptions
        let itemDescriptions = '';
        if (caseData.requested_records) {
            itemDescriptions = '\n\nDETAILED FOOTAGE REQUESTS:\n';
            const records = Array.isArray(caseData.requested_records)
                ? caseData.requested_records
                : [caseData.requested_records];

            records.forEach((item, index) => {
                itemDescriptions += `\n${index + 1}. ${item}`;
            });
        }

        // Get state-specific enforcement guidance (default to moderate)
        const enforcementStrength = 'moderate'; // Could be enhanced with actual state data lookup
        const stateGuidance = documentaryFOIAPrompts.stateSpecificGuidance[enforcementStrength] || '';

        // Build incident details
        const incidentDetails = `${caseData.case_name || 'Incident'} involving ${caseData.subject_name || 'subject'} on ${caseData.incident_date || 'unknown date'} at ${caseData.incident_location || 'unknown location'}. ${caseData.additional_details || ''}`;

        // Get requester info from env or use defaults
        const requesterName = process.env.REQUESTER_NAME || 'Samuel Hylton';
        const requesterEmail = process.env.REQUESTER_EMAIL || 'shadewofficial@gmail.com';

        return `Generate a professional FOIA/public records request following the structure in the system prompt.

1. BASIC INFO:
   - Jurisdiction: ${caseData.state}
   - Agency: ${caseData.agency_name}
   - Requester: ${requesterName}
   - Email: ${requesterEmail}
   - Address: 3021 21st Ave W, Apt 202, Seattle, WA 98199

2. INCIDENT DETAILS:
   ${incidentDetails}
   ${itemDescriptions}

3. DETAILED FOOTAGE REQUESTS:
   ${caseData.officer_details ? `- Officers involved: ${caseData.officer_details}` : '- Request footage from all responding officers'}
   ${caseData.incident_time ? `- Time range: ${caseData.incident_time}` : '- Include appropriate time buffers around incident'}
   ${caseData.incident_location ? `- Location: ${caseData.incident_location}` : ''}

4. LEGAL STYLE: ${styleInstruction}

5. STATE-SPECIFIC CONSIDERATIONS:
   ${stateGuidance || 'Apply moderate enforcement approach - reference state deadlines and cite relevant cases'}

6. DOCUMENTARY-FOCUSED INSTRUCTIONS:
   - Emphasize VIDEO FOOTAGE as primary need
   - Include officer names/badge numbers when provided
   - Specify exact time ranges and camera angles
   - Request native digital format with original audio
   - Include only essential supporting documents (police report)
   - Use simple language, avoid "no responsive records" loopholes
   - Cite relevant state law and retention schedules briefly
   - Mention non-commercial/public interest purpose
   - Request preservation of footage
   - Avoid requesting unnecessary administrative documents
   - Keep total request to 200-400 words

Generate ONLY the email body following the structure. Do NOT add a subject line.`;
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

            // Use GPT-5 with medium reasoning for analysis (better at understanding nuance)
            const response = await this.openai.responses.create({
                model: 'gpt-5',
                reasoning: { effort: 'medium' },
                text: { verbosity: 'low' },  // Low verbosity for JSON output
                input: `${responseHandlingPrompts.analysisSystemPrompt}

${prompt}`
            });

            const analysis = JSON.parse(response.output_text);

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

            // Record outcome for adaptive learning
            await this.recordOutcomeForLearning(caseData, analysis, messageData);

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

            // Handle denials with strategic rebuttals (not manual review)
            if (analysis.intent === 'denial') {
                console.log(`Generating denial rebuttal for subtype: ${analysis.denial_subtype}`);
                return await this.generateDenialRebuttal(messageData, analysis, caseData);
            }

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

            // Use GPT-5 with medium reasoning for normal replies
            const response = await this.openai.responses.create({
                model: 'gpt-5',
                reasoning: { effort: 'medium' },  // Medium reasoning for all communication
                text: { verbosity: 'medium' },
                input: `${responseHandlingPrompts.autoReplySystemPrompt}

${prompt}`
            });

            const replyText = response.output_text;
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
     * Research state-specific FOIA laws using GPT-5 with web search
     */
    async researchStateLaws(state, denialType) {
        try {
            console.log(`🔍 Researching ${state} public records laws for ${denialType} denials using GPT-5 + web search...`);

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

            const response = await this.openai.responses.create({
                model: 'gpt-5',
                reasoning: { effort: 'medium' },  // Medium reasoning for legal analysis
                text: { verbosity: 'medium' },
                tools: [
                    { type: 'web_search' }  // Enable web search for live legal research
                ],
                input: researchPrompt
            });

            const research = response.output_text;
            console.log(`✅ Legal research complete (${research.length} chars) with live web search`);

            return research;
        } catch (error) {
            console.warn('GPT-5 legal research failed, falling back to GPT-4o:', error.message);

            // Fallback to GPT-4o without web search
            try {
                const fallbackResponse = await this.openai.chat.completions.create({
                    model: 'gpt-4o',
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

                return fallbackResponse.choices[0].message.content;
            } catch (fallbackError) {
                console.error('Fallback research also failed:', fallbackError.message);
                return null;
            }
        }
    }

    /**
     * Generate strategic denial rebuttal based on denial subtype
     */
    async generateDenialRebuttal(messageData, analysis, caseData) {
        try {
            console.log(`Generating denial rebuttal for case: ${caseData.case_name}, subtype: ${analysis.denial_subtype}`);

            const denialSubtype = analysis.denial_subtype || 'overly_broad';
            const strategy = denialResponsePrompts.denialStrategies[denialSubtype];

            if (!strategy) {
                console.warn(`Unknown denial subtype: ${denialSubtype}, using overly_broad strategy`);
                strategy = denialResponsePrompts.denialStrategies.overly_broad;
            }

            // Get state info for law citations
            const stateDeadline = await db.getStateDeadline(caseData.state);
            const stateName = stateDeadline?.state_name || caseData.state;

            // Research state-specific laws
            const legalResearch = await this.researchStateLaws(stateName, denialSubtype);

            const prompt = `Generate a strategic FOIA denial rebuttal for this response:

**Denial Type:** ${strategy.name}
**Agency Response:** ${messageData.body_text}

**Case Context:**
- Subject: ${caseData.subject_name}
- Agency: ${caseData.agency_name}
- State: ${stateName}
- Incident Date: ${caseData.incident_date || 'Unknown'}
- Incident Location: ${caseData.incident_location || 'Unknown'}

**Strategy to Follow:**
${strategy.strategy}

**Example Approach:**
${strategy.exampleRebuttal}

${legalResearch ? `**Legal Research for ${stateName}:**
${legalResearch}

USE THIS RESEARCH to cite EXACT statutes and case law. Quote specific statutory language where powerful.` : ''}

**Additional Context:**
- Officer details (if known): ${caseData.officer_details || 'Not specified'}
- Original records requested: Body-worn camera footage, dashcam, 911 calls, incident reports

Generate a STRONG, legally-grounded rebuttal that:
1. Cites specific ${stateName} public records law (use exact statute numbers from research)
2. Uses the strategy outlined above
3. Is assertive but professional (firm, not hostile)
4. Quotes exact statutory language where helpful (from the research provided)
5. Shows good faith and willingness to cooperate
6. References relevant case law if provided in research
7. Is under 250 words

Return ONLY the email body text, no subject line.`;

            // Use GPT-5 with medium reasoning for strategic rebuttal generation
            const response = await this.openai.responses.create({
                model: 'gpt-5',
                reasoning: { effort: 'medium' },  // Medium reasoning for strategic legal writing
                text: { verbosity: 'medium' },
                input: `${denialResponsePrompts.denialRebuttalSystemPrompt}

${prompt}`
            });

            const rebuttalText = response.output_text;

            console.log(`✅ Generated ${denialSubtype} rebuttal (${rebuttalText.length} chars) with GPT-5`);

            return {
                should_auto_reply: true,
                reply_text: rebuttalText,
                confidence: 0.85, // High confidence for strategic rebuttals
                denial_subtype: denialSubtype,
                is_denial_rebuttal: true
            };
        } catch (error) {
            console.error('Error generating denial rebuttal:', error);
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
                        content: responseHandlingPrompts.followUpSystemPrompt
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
        if (!usage) return 0;

        const prices = {
            'gpt-5': {
                input: 0.00002,  // $0.02 per 1K input tokens
                output: 0.00008,  // $0.08 per 1K output tokens
                reasoning: 0.00008  // $0.08 per 1K reasoning tokens
            },
            'gpt-5-mini': {
                input: 0.000001,  // $0.001 per 1K tokens
                output: 0.000004,
                reasoning: 0.000004
            },
            'gpt-4o': {
                input: 0.00001,
                output: 0.00003
            },
            'gpt-4o-mini': {
                input: 0.00000015,
                output: 0.0000006
            }
        };

        const modelPrices = prices[model] || prices['gpt-4o-mini'];

        // GPT-5 and other reasoning models track reasoning tokens separately
        if (model.startsWith('gpt-5')) {
            const inputCost = ((usage.prompt_tokens || 0) / 1000) * modelPrices.input;
            const outputCost = ((usage.completion_tokens || 0) / 1000) * modelPrices.output;
            const reasoningCost = ((usage.reasoning_tokens || 0) / 1000) * (modelPrices.reasoning || 0);
            return inputCost + outputCost + reasoningCost;
        } else {
            // Standard models
            const inputCost = ((usage.prompt_tokens || 0) / 1000) * modelPrices.input;
            const outputCost = ((usage.completion_tokens || 0) / 1000) * modelPrices.output;
            return inputCost + outputCost;
        }
    }

    /**
     * Record outcome for adaptive learning
     */
    async recordOutcomeForLearning(caseData, analysis, messageData) {
        try {
            // Check if outcome already recorded
            if (caseData.outcome_recorded) {
                return;
            }

            // Map AI analysis to outcome type
            let outcomeType = 'no_response';
            let feeWaived = false;

            switch (analysis.intent) {
                case 'delivery':
                    outcomeType = 'full_approval';
                    break;
                case 'denial':
                    outcomeType = 'denial';
                    break;
                case 'fee_request':
                    outcomeType = 'partial_approval';
                    feeWaived = false;
                    break;
                case 'acknowledgment':
                    outcomeType = 'partial_approval';
                    break;
                default:
                    outcomeType = 'partial_approval';
            }

            // Check if fee was waived
            if (analysis.extracted_fee_amount === 0 ||
                (analysis.key_points && analysis.key_points.some(p =>
                    p.toLowerCase().includes('waived') || p.toLowerCase().includes('no fee')
                ))) {
                feeWaived = true;
            }

            // Calculate response time
            const responseTimeDays = caseData.send_date ?
                Math.floor((new Date(messageData.received_at) - new Date(caseData.send_date)) / (1000 * 60 * 60 * 24)) :
                null;

            // Get the strategy that was used
            const strategy = caseData.strategy_used || {};

            // Record the outcome
            await adaptiveLearning.recordOutcome(caseData.id, strategy, {
                type: outcomeType,
                response_time_days: responseTimeDays,
                fee_waived: feeWaived
            });

            // Mark outcome as recorded
            await db.query(
                'UPDATE cases SET outcome_recorded = TRUE, outcome_type = $1 WHERE id = $2',
                [outcomeType, caseData.id]
            );

            console.log(`Recorded learning outcome for case ${caseData.id}: ${outcomeType}`);
        } catch (error) {
            console.error('Error recording outcome for learning:', error);
        }
    }
}

module.exports = new AIService();
