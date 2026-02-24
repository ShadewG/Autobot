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
     * Strip quoted reply history from email bodies
     */
    stripQuotedText(text) {
        if (!text) return text;
        const lines = text.split(/\r?\n/);
        let cutIndex = lines.length;

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i].trim();
            if (/^On .+ wrote:$/i.test(line)) {
                cutIndex = i;
                break;
            }
            if (/^From: /i.test(line)) {
                cutIndex = i;
                break;
            }
            if (/^-----Original Message-----$/i.test(line)) {
                cutIndex = i;
                break;
            }
            if (line.startsWith('>') && i > 0 && !lines[i - 1].trim()) {
                cutIndex = i;
                break;
            }
        }

        const trimmed = lines.slice(0, cutIndex).join('\n').trim();
        return trimmed.length >= 5 ? trimmed : text;
    }

    /**
     * Generate a FOIA request from case data
     */
    async generateFOIARequest(caseData) {
        try {
            console.log(`Generating FOIA request for case: ${caseData.case_name}`);

            // Load user signature if case is assigned
            let userSignature = null;
            if (caseData.user_id) {
                const user = await db.getUserById(caseData.user_id);
                if (user) {
                    userSignature = {
                        name: user.signature_name || user.name,
                        title: user.signature_title || 'Documentary Researcher, Dr Insanity',
                        organization: user.signature_organization || null,
                        phone: user.signature_phone || null
                    };
                }
            }

            // Get adaptive strategy based on learned patterns
            const strategy = await adaptiveLearning.generateStrategicVariation(caseData);
            console.log('Using strategy:', strategy);

            const systemPrompt = this.buildFOIASystemPrompt(caseData.state, strategy);
            const userPrompt = this.buildFOIAUserPrompt(caseData, strategy, userSignature);

            // Combine system and user prompts for GPT-5
            const fullPrompt = `${systemPrompt}\n\n${userPrompt}`;

            // Try GPT-5 first (latest and most capable for FOIA generation)
            try {
                const response = await this.openai.chat.completions.create({
                    model: process.env.OPENAI_MODEL || 'gpt-5.2-2025-12-11',
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
                const modelUsed = process.env.OPENAI_MODEL || 'gpt-5.2-2025-12-11';
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
                return await this.generateWithClaude(caseData, userSignature);
            }
        } catch (error) {
            console.error('Error generating FOIA request:', error);
            throw error;
        }
    }

    /**
     * Generate FOIA request using Claude (fallback)
     */
    async generateWithClaude(caseData, userSignature = null) {
        const systemPrompt = this.buildFOIASystemPrompt(caseData.state);
        const userPrompt = this.buildFOIAUserPrompt(caseData, null, userSignature);

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
    buildFOIAUserPrompt(caseData, strategy = null, userSignature = null) {
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

        // State-specific guidance removed - using simple documentary style

        // Build incident details WITHOUT case_name (it's just an internal reference, not for the actual request)
        let incidentDescription = '';
        if (caseData.subject_name && caseData.subject_name !== caseData.case_name) {
            incidentDescription += `Incident involving ${caseData.subject_name}`;
        } else {
            incidentDescription += 'Incident';
        }

        if (caseData.incident_date) {
            incidentDescription += ` on ${caseData.incident_date}`;
        }

        if (caseData.incident_location) {
            incidentDescription += ` at ${caseData.incident_location}`;
        }

        if (caseData.additional_details) {
            incidentDescription += `. ${caseData.additional_details}`;
        }

        // Get requester info from user signature, env, or defaults
        const requesterName = userSignature?.name || process.env.REQUESTER_NAME || 'Samuel Hylton';
        const requesterTitle = userSignature?.title || 'Documentary Researcher, Dr Insanity';
        const requesterPhone = userSignature?.phone || process.env.REQUESTER_PHONE || '';

        // Build signature block for the closing
        let signatureBlock = `   - Name: ${requesterName}\n   - Title: ${requesterTitle}`;
        if (requesterPhone) {
            signatureBlock += `\n   - Phone: ${requesterPhone}`;
        }

        return `Generate a professional FOIA/public records request following the structure in the system prompt.

1. BASIC INFO:
   - Jurisdiction: ${caseData.state}
   - Agency: ${caseData.agency_name}
   - Requester: ${requesterName}

2. INCIDENT DETAILS:
   ${incidentDescription}
   ${itemDescriptions}

3. DETAILED FOOTAGE REQUESTS:
   ${caseData.officer_details ? `- Officers involved: ${caseData.officer_details}` : '- Request footage from all responding officers'}
   ${caseData.incident_time ? `- Time range: ${caseData.incident_time}` : '- Include appropriate time buffers around incident'}
   ${caseData.incident_location ? `- Location: ${caseData.incident_location}` : ''}

4. LEGAL STYLE: ${styleInstruction}

5. STATE-SPECIFIC CONSIDERATIONS:
   Apply moderate enforcement approach - reference state deadlines and cite relevant cases

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

7. CLOSING SIGNATURE (use exactly this info):
${signatureBlock}

Generate ONLY the email body following the structure. Do NOT add a subject line.`;
    }

    /**
     * Analyze a response email from an agency
     * @param {Object} messageData - The inbound message to analyze
     * @param {Object} caseData - The case record
     * @param {Object} [options] - Optional settings
     * @param {Array}  [options.threadMessages] - Full message thread for context (oldest first)
     */
    async analyzeResponse(messageData, caseData, options = {}) {
        try {
            console.log(`Analyzing response for case: ${caseData.case_name}`);

            const cleanedBody = this.stripQuotedText(messageData.body_text || '');

            // Build prior correspondence context (exclude the current message)
            // Note: threadMessages may arrive in DESC order (from getMessagesByCaseId),
            // so sort by date ASC to display chronologically
            const threadMessages = (options.threadMessages || []).slice().sort((a, b) => {
                const da = new Date(a.received_at || a.sent_at || a.created_at);
                const db2 = new Date(b.received_at || b.sent_at || b.created_at);
                return da - db2;
            });
            let correspondenceContext = '';
            if (threadMessages.length > 0) {
                const priorMessages = threadMessages
                    .filter(m => m.id !== messageData.id)
                    .slice(-10); // Last 10 messages max to stay within token limits
                if (priorMessages.length > 0) {
                    correspondenceContext = `\n**Prior Correspondence (${priorMessages.length} messages, oldest first):**\n` +
                        priorMessages.map(m => {
                            const dir = m.direction === 'outbound' ? 'US →' : '← AGENCY';
                            const date = m.sent_at || m.received_at || m.created_at;
                            const dateStr = date ? new Date(date).toLocaleDateString() : 'unknown date';
                            const body = this.stripQuotedText(m.body_text || '').substring(0, 300);
                            return `[${dir} ${dateStr}] Subject: ${m.subject || '(none)'}\n${body}${body.length >= 300 ? '...' : ''}`;
                        }).join('\n---\n') + '\n';
                }
            }

            // Build requested records list for scope analysis
            // Prefer scope_items_jsonb (structured) over requested_records (legacy)
            const scopeItems = caseData.scope_items_jsonb || caseData.scope_items || [];
            const requestedRecords = Array.isArray(scopeItems) && scopeItems.length > 0
                ? scopeItems.map(item => item.name || item.description || item.item || JSON.stringify(item))
                : (Array.isArray(caseData.requested_records)
                    ? caseData.requested_records
                    : (caseData.requested_records ? [caseData.requested_records] : []));
            const recordsList = requestedRecords.length > 0
                ? requestedRecords.map((r, i) => `${i + 1}. ${r}`).join('\n')
                : 'Not specified';

            const prompt = `Analyze this email response to a FOIA request and extract key information.
${correspondenceContext ? 'IMPORTANT: Review the prior correspondence to understand the full context before classifying the new message. Consider whether earlier messages (e.g. unanswered agency questions) affect the appropriate response.' : ''}

**Original Request Context:**
Subject: ${caseData.subject_name}
Agency: ${caseData.agency_name}
State: ${caseData.state || 'Unknown'}

**Records We Requested:**
${recordsList}

**Current Case Status:**
Status: ${caseData.status}
${caseData.portal_url ? `Portal URL on file: ${caseData.portal_url}` : 'No portal URL on file'}
${caseData.send_date ? `Request already sent on: ${caseData.send_date}` : 'Request not yet sent'}
${correspondenceContext}
**New Response Email (analyze THIS message):**
From: ${messageData.from_email}
Subject: ${messageData.subject}
Body:
${cleanedBody}

Please analyze and provide a JSON response with:
1. intent: (portal_redirect | acknowledgment | records_ready | question | delivery | partial_delivery | denial | fee_request | more_info_needed)
   - portal_redirect: They want us to use their online portal (NextRequest, GovQA, etc.) - NOT a denial!
   - records_ready: Records available for download
   - acknowledgment: They received our request, processing
2. denial_subtype: if intent is "denial", specify subtype (no_records | ongoing_investigation | privacy_exemption | overly_broad | excessive_fees | wrong_agency | retention_expired | format_issue | null)
3. confidence_score: 0.0 to 1.0
4. sentiment: (positive | neutral | negative | hostile)
5. key_points: array of important points from the email
6. extracted_deadline: any deadline mentioned (YYYY-MM-DD format or null)
7. extracted_fee_amount: any fee amount mentioned (number or null)
8. portal_url: if they mention a portal, extract the URL (or null)
9. requires_response: boolean - do WE need to send an email reply? (Usually NO!)
   - NO for: portal_redirect, acknowledgment, records_ready, delivery, partial_delivery
   - MAYBE for: fee_request (only if negotiating), denial (only if worth challenging)
   - YES for: question, more_info_needed
10. suggested_action: what should we do next? (use_portal | wait | download | respond | challenge | pay_fee | etc.)
11. summary: brief 1-2 sentence summary
11. scope_updates: For EACH record we requested, analyze what the agency said about it. Return an array of objects with:
    - name: the record item name (exactly as listed above)
    - status: one of (CONFIRMED_AVAILABLE | NOT_DISCLOSABLE | NOT_HELD | PENDING | REQUESTED)
      - CONFIRMED_AVAILABLE: Agency confirms they have it and will provide
      - NOT_DISCLOSABLE: Agency claims exemption or refuses to provide
      - NOT_HELD: Agency says they don't have this record
      - PENDING: Agency is still searching/processing
      - REQUESTED: No mention of this item in the response
    - reason: brief explanation of what agency said about this item (or null if no mention)
    - confidence: 0.0 to 1.0 how confident you are in this status
12. constraints_to_add: array of constraint codes to add based on the response. Use these codes:
    - BWC_EXEMPT: Body camera footage claimed exempt
    - FEE_REQUIRED: Payment required before records released
    - ID_REQUIRED: Identity verification requested
    - INVESTIGATION_ACTIVE: Ongoing investigation cited
    - RECORDS_NOT_HELD: No responsive records exist
    - PARTIAL_DENIAL: Some items denied, others available
13. fee_breakdown: if fee_request intent, extract breakdown with:
    - hourly_rate: number or null
    - estimated_hours: number or null
    - items: array of { description, amount }
    - deposit_required: number or null
14. unanswered_agency_question: if the prior correspondence shows the agency asked us a question we never answered, describe it here (string or null). This is critical — an unanswered question may explain why the agency denied or closed the request.
15. reason_no_response: if requires_response is false, briefly explain why (string or null)

Return ONLY valid JSON, no other text.`;

            // Use GPT-5 with medium reasoning for analysis (better at understanding nuance)
            const response = await this.openai.responses.create({
                model: 'gpt-5.2-2025-12-11',
                reasoning: { effort: 'medium' },
                text: { verbosity: 'low' },  // Low verbosity for JSON output
                input: `${responseHandlingPrompts.analysisSystemPrompt}

${prompt}`
            });

            const analysis = JSON.parse(response.output_text);

            // Normalize: LLM sometimes returns requires_response instead of requires_action
            if (analysis.requires_response !== undefined && analysis.requires_action === undefined) {
                analysis.requires_action = analysis.requires_response;
            }

            // Store analysis in database
            // Sanitize values: convert string "null" to actual null
            const analysisRecord = await db.createResponseAnalysis({
                message_id: messageData.id,
                case_id: caseData.id,
                intent: analysis.intent,
                confidence_score: analysis.confidence_score,
                sentiment: analysis.sentiment,
                key_points: analysis.key_points,
                extracted_deadline: analysis.extracted_deadline === "null" || !analysis.extracted_deadline ? null : analysis.extracted_deadline,
                extracted_fee_amount: analysis.extracted_fee_amount === "null" || !analysis.extracted_fee_amount ? null : analysis.extracted_fee_amount,
                requires_action: analysis.requires_action,
                suggested_action: analysis.suggested_action,
                full_analysis_json: analysis
            });

            // Backfill message summary from analysis
            if (analysis.summary) {
                await db.query('UPDATE messages SET summary = $1 WHERE id = $2 AND summary IS NULL',
                    [analysis.summary, messageData.id]);
            }

            // Record outcome for adaptive learning
            await this.recordOutcomeForLearning(caseData, analysis, messageData);

            return analysis;
        } catch (error) {
            console.error('Error analyzing response:', error);
            throw error;
        }
    }

    /**
     * Generate a one-sentence summary for an outbound or unanalyzed message.
     */
    async generateMessageSummary(subject, bodyText) {
        const snippet = (bodyText || '').substring(0, 500);
        const response = await this.openai.responses.create({
            model: 'gpt-5.2-2025-12-11',
            input: `Summarize this email in ONE sentence (max 120 chars). Subject: ${subject}\n\n${snippet}`
        });
        return response.output_text.trim();
    }

    /**
     * Generate an auto-reply based on the analysis
     */
    async generateAutoReply(messageData, analysis, caseData) {
        try {
            console.log(`Generating auto-reply for case: ${caseData.case_name}, intent: ${analysis.intent}`);

            // FIRST: Check if response is even needed
            const noResponseIntents = ['portal_redirect', 'acknowledgment', 'records_ready', 'delivery', 'partial_delivery'];

            if (noResponseIntents.includes(analysis.intent)) {
                console.log(`No response needed for intent: ${analysis.intent}`);
                return {
                    should_auto_reply: false,
                    reason: `No email response needed for ${analysis.intent}`,
                    suggested_action: analysis.intent === 'portal_redirect' ? 'use_portal' :
                                     analysis.intent === 'records_ready' ? 'download' :
                                     analysis.intent === 'delivery' ? 'download' : 'wait',
                    portal_url: analysis.portal_url || null
                };
            }

            // Handle denials - but check if rebuttal makes sense first
            if (analysis.intent === 'denial') {
                // Don't rebuttal portal redirects misclassified as denials
                if (analysis.denial_subtype === 'format_issue' && analysis.portal_url) {
                    console.log('Portal redirect misclassified as denial - no response needed');
                    return {
                        should_auto_reply: false,
                        reason: 'Portal redirect - use portal instead of responding',
                        suggested_action: 'use_portal',
                        portal_url: analysis.portal_url
                    };
                }

                console.log(`Generating denial rebuttal for subtype: ${analysis.denial_subtype}`);
                return await this.generateDenialRebuttal(messageData, analysis, caseData);
            }

            // Only these intents should get responses
            const responseIntents = ['question', 'more_info_needed'];

            // Fee requests: only respond if over auto-approve threshold
            if (analysis.intent === 'fee_request') {
                const feeAmount = analysis.extracted_fee_amount || 0;
                const autoApproveMax = parseFloat(process.env.FEE_AUTO_APPROVE_MAX) || 100;

                if (feeAmount <= autoApproveMax) {
                    // Auto-approve small fees with brief acceptance
                    console.log(`Auto-approving fee of $${feeAmount}`);
                    return await this.generateFeeAcceptance(caseData, feeAmount);
                }
                // Larger fees need human review - don't auto-generate response
                return {
                    should_auto_reply: false,
                    reason: `Fee of $${feeAmount} exceeds auto-approve threshold - needs human review`,
                    requires_human_review: true
                };
            }

            if (!responseIntents.includes(analysis.intent)) {
                return {
                    should_auto_reply: false,
                    reason: 'Intent not suitable for auto-reply'
                };
            }

            const cleanedBody = this.stripQuotedText(messageData.body_text || '');

            const prompt = `Generate a professional email reply to this FOIA response:

**Context:**
- Our request was about: ${caseData.subject_name}
- Agency: ${caseData.agency_name}

**Their Response:**
${cleanedBody}

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
                model: 'gpt-5.2-2025-12-11',
                reasoning: { effort: 'medium' },  // Medium reasoning for all communication
                text: { verbosity: 'medium' },
                input: `${responseHandlingPrompts.autoReplySystemPrompt}

${prompt}`
            });

            let replyText = response.output_text;

            // Guardrail: if intent requires response but model says "no response needed", fallback
            if (responseIntents.includes(analysis.intent) && /no response needed|no reply needed/i.test(replyText || '')) {
                const scopeItems = caseData.scope_items_jsonb || caseData.scope_items || [];
                const requestedRecords = Array.isArray(scopeItems) && scopeItems.length > 0
                    ? scopeItems.map(item => item.name || item.description || item.item || JSON.stringify(item))
                    : (Array.isArray(caseData.requested_records)
                        ? caseData.requested_records
                        : (caseData.requested_records ? [caseData.requested_records] : []));

                const recordsList = requestedRecords.length > 0
                    ? requestedRecords.map(r => `- ${r}`).join('\n')
                    : '- All responsive records related to the incident';

                replyText = `Thanks for the response. We’re looking for the following materials:\n${recordsList}\n\nIf helpful, we can narrow by date/time or scope. Please let us know what additional details you need.`;
            }
            const confidenceThreshold = parseFloat(process.env.AUTO_REPLY_CONFIDENCE_THRESHOLD) || 0.8;

            // Normalize output format: always return { subject, body_text, body_html }
            return {
                subject: null,  // Auto-replies don't generate subjects
                body_text: replyText,
                body_html: null,
                // Metadata
                should_auto_reply: analysis.confidence_score >= confidenceThreshold,
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
                model: 'gpt-5.2-2025-12-11',
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
            console.warn('GPT-5 legal research failed, falling back to GPT-5-mini:', error.message);

            // Fallback to GPT-5-mini without web search
            try {
                const fallbackResponse = await this.openai.chat.completions.create({
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
                    max_completion_tokens: 1500  // gpt-5 models use max_completion_tokens
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
    async generateDenialRebuttal(messageData, analysis, caseData, options = {}) {
        try {
            console.log(`Evaluating denial rebuttal for case: ${caseData.case_name}, subtype: ${analysis.denial_subtype}`);
            const { adjustmentInstruction, lessonsContext } = options;

            const denialSubtype = analysis.denial_subtype || 'overly_broad';

            // CHECK: Should we even rebuttal this?
            // Some "denials" are just process redirects - don't fight them
            const noRebuttalSubtypes = {
                'wrong_agency': 'Get correct agency contact info instead of arguing',
                'format_issue': 'Request alternative delivery or use their portal'
            };

            // If they mentioned a portal, don't argue - just use it
            if (analysis.portal_url) {
                console.log('Portal URL found - no rebuttal needed, use portal instead');
                return {
                    should_auto_reply: false,
                    reason: 'Portal available - use portal instead of arguing via email',
                    suggested_action: 'use_portal',
                    portal_url: analysis.portal_url
                };
            }

            // For "overly_broad" - check if this is really a fight worth having
            if (denialSubtype === 'overly_broad') {
                // If they just asked us to narrow or use a portal, do that instead
                const bodyLower = (messageData.body_text || '').toLowerCase();
                if (bodyLower.includes('portal') || bodyLower.includes('nextrequest') || bodyLower.includes('govqa')) {
                    console.log('Agency suggested portal - use portal instead of arguing');
                    return {
                        should_auto_reply: false,
                        reason: 'Agency has portal - submit there instead of arguing',
                        suggested_action: 'use_portal'
                    };
                }
            }

            let strategy = denialResponsePrompts.denialStrategies[denialSubtype];

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
${lessonsContext || ''}${adjustmentInstruction ? `\nADDITIONAL INSTRUCTIONS: ${adjustmentInstruction}` : ''}
Return ONLY the email body text, no subject line.`;

            // Use GPT-5 with medium reasoning for strategic rebuttal generation
            const response = await this.openai.responses.create({
                model: 'gpt-5.2-2025-12-11',
                reasoning: { effort: 'medium' },  // Medium reasoning for strategic legal writing
                text: { verbosity: 'medium' },
                input: `${denialResponsePrompts.denialRebuttalSystemPrompt}

${prompt}`
            });

            const rebuttalText = response.output_text;

            console.log(`✅ Generated ${denialSubtype} rebuttal (${rebuttalText.length} chars) with GPT-5`);

            // Normalize output format: always return { subject, body_text, body_html }
            return {
                subject: null,  // Rebuttals don't generate subjects (use RE: pattern)
                body_text: rebuttalText,
                body_html: null,
                // Metadata
                should_auto_reply: true,
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
     * Research whether a better portal/contact exists before first follow-up
     */
    async researchAlternateContacts(caseData) {
        try {
            const prompt = `You are assisting with a public records (FOIA) automation system. Before sending the first follow-up, research whether there is a better official contact or online portal for this agency.

Agency name: ${caseData.agency_name}
Current email on file: ${caseData.agency_email}
Current portal URL (may be inaccurate): ${caseData.portal_url || 'none provided'}
Jurisdiction: ${caseData.state}
Incident or case title: ${caseData.case_name}

Your tasks:
1. Determine if there is an official FOIA/Public Records portal for this agency (GovQA, NextRequest, JustFOIA, or similar). Only provide links that allow online request submission.
2. If no reliable portal exists, identify the best direct records/email contact published by the agency.
3. Note any instructions or requirements (account creation, portal names, etc.).

Return a JSON object with:
{
  "portal_url": string | null,
  "portal_provider": string | null,
  "contact_email": string | null,
  "confidence": number between 0 and 1,
  "notes": string
}

If nothing better is found, set the relevant fields to null but explain in notes.
Respond with JSON ONLY.`;

            const response = await this.openai.responses.create({
                model: 'gpt-5.2-2025-12-11',
                reasoning: { effort: 'low' },
                text: { verbosity: 'low' },
                tools: [{ type: 'web_search' }],
                input: prompt
            });

            const raw = response.output_text?.trim();
            if (!raw) {
                return null;
            }

            try {
                return JSON.parse(raw);
            } catch (parseError) {
                console.error('Failed to parse alternate contact research JSON:', parseError.message, raw);
                return null;
            }
        } catch (error) {
            console.error('Error researching alternate contacts:', error);
            return null;
        }
    }

    /**
     * Generate a follow-up email
     */
    async generateFollowUp(caseData, followUpCount = 0, options = {}) {
        try {
            console.log(`Generating follow-up #${followUpCount + 1} for case: ${caseData.case_name}`);
            const { adjustmentInstruction, lessonsContext } = options;

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
${lessonsContext || ''}${adjustmentInstruction ? `\nADDITIONAL INSTRUCTIONS: ${adjustmentInstruction}` : ''}
Return ONLY the email body text.`;

            const response = await this.openai.chat.completions.create({
                model: 'gpt-5.2-2025-12-11',
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
                max_completion_tokens: 600  // gpt-5 models use max_completion_tokens
            });

            const bodyText = response.choices[0].message.content;

            // Normalize output format: always return { subject, body_text, body_html }
            return {
                subject: `Follow-up: Public Records Request - ${caseData.subject_name || 'Request'}`,
                body_text: bodyText,
                body_html: null
            };
        } catch (error) {
            console.error('Error generating follow-up:', error);
            throw error;
        }
    }

    /**
     * Get a short reference name for a case (for use in correspondence)
     * Prefers: explicit subject_name > extracted person name > agency-based reference
     */
    getShortCaseReference(caseData) {
        // If subject_name was explicitly set (different from case_name), use it
        if (caseData.subject_name && caseData.subject_name !== caseData.case_name) {
            // Truncate if still too long
            const name = caseData.subject_name.split(' - ')[0].split(',')[0].trim();
            return name.length > 50 ? name.substring(0, 50) + '...' : name;
        }

        // Try to extract a person name from additional_details
        const details = caseData.additional_details || '';
        // Look for common patterns: "Name, age," or "Name (age)"
        const nameMatch = details.match(/([A-Z][a-z]+ [A-Z][a-z]+)(?:,? \d{1,2}[,\)]|\s+was|\s+is)/);
        if (nameMatch) {
            return nameMatch[1];
        }

        // Fall back to agency-based reference
        const agency = (caseData.agency_name || 'Agency').replace(/,.*$/, '').trim();
        return `our ${agency} request`;
    }

    /**
     * Generate a draft response to a fee estimate that requires human approval
     */
    async generateFeeResponse(caseData, options = {}) {
        const {
            feeAmount,
            currency = 'USD',
            recommendedAction = 'negotiate', // accept | negotiate | decline
            instructions = null,
            lessonsContext = '',
            agencyMessage = null,
            agencyAnalysis = null
        } = options;

        if (!feeAmount) {
            throw new Error('feeAmount is required to generate a fee response');
        }

        // Get short reference for correspondence
        const shortReference = this.getShortCaseReference(caseData);

        const actionGuidance = {
            accept: 'Politely accept the cost, confirm willingness to pay, and request next steps for invoice/payment.',
            negotiate: 'Push back on the cost, request itemized breakdowns, cite state fee statutes, and offer a phased or narrowed request to reduce cost.',
            decline: 'Explain the fee exceeds budget, request fee waiver or narrowing help, and keep door open for partial fulfillment.',
            escalate: 'Flag that the fee far exceeds norms, request supervisor review, and cite public interest considerations.'
        };

        const actionInstruction = actionGuidance[recommendedAction] || actionGuidance.negotiate;
        const customInstruction = instructions
            ? `\nCUSTOM INSTRUCTIONS FROM HUMAN REVIEWER: ${instructions}\nFollow the human instructions exactly while keeping professional tone.`
            : '';

        const prompt = `You are the FOIA Negotiator Assistant for a documentary records team.

Case reference: ${shortReference}
Full case context: ${caseData.case_name}
Agency: ${caseData.agency_name}
Jurisdiction: ${caseData.state}
Requested records: ${Array.isArray(caseData.requested_records) ? caseData.requested_records.join(', ') : caseData.requested_records}
Quoted fee: ${currency} ${feeAmount.toFixed(2)}
Recommended action: ${recommendedAction.toUpperCase()}
${agencyMessage ? `\nAgency's full response:\n${this.stripQuotedText(agencyMessage.body_text || '').substring(0, 500)}` : ''}
${agencyAnalysis?.full_analysis_json?.key_points ? `\nKey points from agency response: ${agencyAnalysis.full_analysis_json.key_points.join('; ')}` : ''}

Goals:
${actionInstruction}
${agencyMessage ? `\nCRITICAL — RECORD DENIAL CHALLENGES:
If the agency denied or withheld ANY record types, you MUST aggressively challenge every denial in this same email. Do NOT just politely ask — fight for the records.
- Body camera (BWC) footage is the MOST IMPORTANT record in these cases. Without BWC, the case is essentially useless. If BWC is denied, this is the top priority to challenge.
- For EACH denied record type: cite the applicable state public records law, challenge the specific exemption claimed, argue why the exemption does not apply, demand release of segregable/redactable portions, and request the specific statutory basis for withholding.
- For BWC specifically: Note that BWC is routinely released in other jurisdictions, that the public interest in police accountability outweighs privacy concerns for on-duty conduct, and that redaction of sensitive portions (e.g. faces of bystanders) is the appropriate remedy — NOT blanket withholding.
- Be firm but professional. Make clear that withholding without proper legal basis will be appealed.` : ''}
${customInstruction}
${lessonsContext}
Email requirements:
1. Reference the request using the SHORT case reference ("${shortReference}") - NOT the full case name
2. Mention the quoted fee amount explicitly
3. Ask for itemized breakdowns or statutory authority where relevant
4. Keep tone professional, collaborative, and human-sounding
5. Keep under 200 words

Return ONLY the email body, no greetings beyond what belongs in the email.`;

        try {
            const response = await this.openai.responses.create({
                model: 'gpt-5.2-2025-12-11',
                reasoning: { effort: 'low' },
                text: { verbosity: 'medium' },
                input: `${responseHandlingPrompts.autoReplySystemPrompt}

${prompt}`
            });

            const bodyText = response.output_text?.trim();

            // Normalize output format: always return { subject, body_text, body_html }
            return {
                subject: `RE: Fee Response - ${shortReference}`,
                body_text: bodyText,
                body_html: null,
                // Metadata
                model: 'gpt-5.2-2025-12-11',
                recommended_action: recommendedAction
            };
        } catch (error) {
            console.error('Error generating fee response:', error);
            throw error;
        }
    }

    /**
     * Calculate cost for OpenAI API call
     */
    calculateCost(usage, model) {
        if (!usage) return 0;

        const prices = {
            'gpt-5.2-2025-12-11': {
                input: 0.00002,  // $0.02 per 1K input tokens
                output: 0.00008,  // $0.08 per 1K output tokens
                reasoning: 0.00008  // $0.08 per 1K reasoning tokens
            },
            'gpt-5.2-2025-12-11': {
                input: 0.000001,  // $0.001 per 1K tokens
                output: 0.000004,
                reasoning: 0.000004
            }
        };

        const modelPrices = prices[model] || prices['gpt-5.2-2025-12-11'];

        // GPT-5 and other reasoning models track reasoning tokens separately
        if (model.startsWith('gpt-5.2-2025-12-11')) {
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

    /**
     * Generate a phone call briefing for a phone queue task.
     * Produces a structured summary with talking points and key details.
     */
    async generatePhoneCallBriefing(phoneTask, caseData, messages = []) {
        const emailHistory = messages
            .slice(0, 10)
            .map(m => `[${m.direction}] ${m.subject || ''}: ${(m.body_text || '').substring(0, 300)}`)
            .join('\n\n');

        const prompt = `You are preparing a phone call briefing for a FOIA records request follow-up.

CASE INFO:
- Case Name: ${caseData.case_name || 'Unknown'}
- Agency: ${caseData.agency_name || phoneTask.agency_name || 'Unknown'}
- State: ${caseData.state || phoneTask.agency_state || 'Unknown'}
- Subject: ${caseData.subject_name || 'Unknown'}
- Sent Date: ${caseData.send_date || 'Unknown'}
- Records Requested: ${Array.isArray(caseData.requested_records) ? caseData.requested_records.join(', ') : (caseData.requested_records || 'Various records')}

ESCALATION CONTEXT:
- Reason: ${phoneTask.reason || 'no_email_response'}
- Days Since Sent: ${phoneTask.days_since_sent || 'Unknown'}
- Notes: ${phoneTask.notes || 'None'}

EMAIL HISTORY:
${emailHistory || 'No email history available'}

ADDITIONAL DETAILS:
${(caseData.additional_details || '').substring(0, 1000)}

Generate a phone call briefing as JSON:
{
  "case_summary": "Plain English paragraph summarizing the case, who the subject is, what happened, and what records were requested",
  "call_justification": "Why a phone call is needed now - what happened with emails, how long we've waited, etc.",
  "talking_points": ["Point 1 - what to say/ask", "Point 2", ...],
  "key_details": {
    "dates": { "incident_date": "...", "request_sent": "...", "days_waiting": ... },
    "records_requested": ["..."],
    "previous_responses": ["brief summary of any agency responses"],
    "amounts": null
  }
}

Return ONLY valid JSON.`;

        try {
            const response = await this.openai.responses.create({
                model: 'gpt-5.2-2025-12-11',
                reasoning: { effort: 'low' },
                input: prompt
            });

            const raw = response.output_text?.trim();
            const jsonMatch = raw.match(/\{[\s\S]*\}/);
            if (jsonMatch) {
                return JSON.parse(jsonMatch[0]);
            }
            throw new Error('Failed to parse briefing JSON');
        } catch (error) {
            console.error('Error generating phone call briefing:', error);
            throw error;
        }
    }

    /**
     * Triage a stuck case in needs_human_review.
     * Looks at case context, recent messages, and prior proposals to recommend the right action.
     */
    async triageStuckCase(caseData, messages = [], priorProposals = []) {
        const messagesSummary = messages.slice(0, 5).map(m => {
            const body = this.stripQuotedText(m.body_text || '');
            return `[${m.direction}] Subject: ${m.subject || 'N/A'}\n${body.substring(0, 400)}`;
        }).join('\n---\n') || 'No messages found.';

        const proposalsSummary = priorProposals.map(p =>
            `- ${p.action_type} (${p.status}): ${typeof p.reasoning === 'string' ? p.reasoning.substring(0, 150) : JSON.stringify(p.reasoning).substring(0, 150)}`
        ).join('\n') || 'No prior proposals.';

        // Query decision memory for relevant lessons
        let lessonsBlock = '';
        try {
            const decisionMemory = require('./decision-memory-service');
            const lessons = await decisionMemory.getRelevantLessons(caseData, { messages, priorProposals });
            lessonsBlock = decisionMemory.formatLessonsForPrompt(lessons);
        } catch (e) {
            console.warn('Decision memory unavailable:', e.message);
        }

        const prompt = `You are triaging a FOIA case stuck in human review. Analyze the case and recommend the best next action.

CASE INFO:
- Name: ${caseData.case_name}
- Agency: ${caseData.agency_name}
- State: ${caseData.state || 'Unknown'}
- Status: ${caseData.status}
- Portal URL: ${caseData.portal_url || 'None'}
- Send Date: ${caseData.send_date || 'Not sent'}
- Last Updated: ${caseData.updated_at}

RECENT MESSAGES (newest first):
${messagesSummary}

PRIOR PROPOSALS (newest first):
${proposalsSummary}
${lessonsBlock}
AVAILABLE ACTIONS:
- SUBMIT_PORTAL: Submit/resubmit via online portal (only if portal_url exists AND no prior portal failures)
- SEND_FOLLOWUP: Send a follow-up email to the agency
- SEND_REBUTTAL: Challenge a denial with legal arguments citing state open records law
- RESEARCH_AGENCY: Re-research the correct agency (use when "no records" or "wrong agency" — maybe we asked the wrong PD)
- REFORMULATE_REQUEST: Rewrite the request from a different angle or narrower scope (use when request was too broad or targeted wrong record types)
- ACCEPT_FEE: Accept a fee quote and proceed with payment
- NEGOTIATE_FEE: Push back on an excessive fee
- CLOSE_CASE: Case is resolved, no further action needed, or denial is final and not worth challenging
- ESCALATE: Needs human attention for a reason AI can't handle
- NONE: No action needed right now

Return a JSON object:
{
  "actionType": "one of the above action codes",
  "summary": "2-3 sentence plain English summary of the case situation",
  "recommendation": "1 sentence explaining why this action is appropriate",
  "confidence": 0.0 to 1.0
}

Rules:
- READ THE MESSAGES CAREFULLY. If the agency denied the request, recommend SEND_REBUTTAL or CLOSE_CASE — NOT SUBMIT_PORTAL.
- Only recommend SUBMIT_PORTAL if a portal_url exists AND the agency is asking for a portal submission (not a denial).
- Recommend CLOSE_CASE if agency already provided records or said no responsive records.
- Recommend SEND_REBUTTAL if there's a denial worth challenging (most denials are worth at least one rebuttal).
- Recommend ACCEPT_FEE or NEGOTIATE_FEE if there's an outstanding fee quote.
- Recommend ESCALATE if the situation is ambiguous or complex.
- NEVER repeat an action that was already dismissed in prior proposals.
- If a prior SUBMIT_PORTAL proposal was dismissed or portal submission failed, do NOT recommend SUBMIT_PORTAL again.
- Return ONLY valid JSON.`;

        try {
            const response = await this.openai.responses.create({
                model: process.env.OPENAI_MODEL || 'gpt-5.2-2025-12-11',
                reasoning: { effort: 'low' },
                input: `You are a FOIA case triage specialist. Analyze cases and recommend the most appropriate next action. Return only valid JSON.\n\n${prompt}`
            });

            const raw = response.output_text?.trim();
            const jsonMatch = raw.match(/\{[\s\S]*\}/);
            if (jsonMatch) {
                return JSON.parse(jsonMatch[0]);
            }
            throw new Error('Failed to parse triage JSON');
        } catch (error) {
            console.error('Error in triageStuckCase:', error.message);
            return {
                actionType: 'ESCALATE',
                summary: `AI triage failed: ${error.message}. Case needs manual review.`,
                recommendation: 'Review case manually — AI triage could not complete.',
                confidence: 0
            };
        }
    }

    async normalizeNotionCase(rawPayload) {
        try {
            if (!rawPayload) return {};

            const schema = `{
  "case_name": string,
  "agency_name": string,
  "state": string,
  "incident_date": string,
  "incident_location": string,
  "records_requested": array of short strings,
  "subject_name": string,
  "additional_details": string,
  "tags": array of 3-5 lowercase kebab-case tags describing the case (e.g. "police-records", "body-camera", "use-of-force", "state-level", "small-agency", "shooting", "traffic-stop", "misconduct", "in-custody-death", "federal")
}`;

            const systemPrompt = `You are a data extraction specialist. Extract ONLY information that is explicitly present in the provided Notion properties or page text. Parse and normalize the data you find. If a field is not present in the source data, leave it empty (null, empty string, or empty array). Never use your training data or world knowledge to fill in missing information. Only extract what you can directly see in the input.

CRITICAL: DO NOT extract URLs, email addresses, or contact information. These will be extracted separately from structured fields. Focus only on extracting text content like names, dates, locations, and descriptions.`;

            const promptParts = [];
            if (rawPayload.properties) {
                promptParts.push('PROPERTIES:\n' + JSON.stringify(rawPayload.properties, null, 2));
            }
            if (rawPayload.full_text) {
                promptParts.push('FULL_PAGE_TEXT:\n' + rawPayload.full_text);
            }
            const prompt = promptParts.join('\n\n');

            const response = await this.openai.responses.create({
                model: process.env.OPENAI_MODEL || 'gpt-5.2-2025-12-11',
                reasoning: { effort: 'low' },
                text: { verbosity: 'low' },
                input: `${systemPrompt}\n\nSchema:\n${schema}\n\n${prompt}`
            });

            const rawText = response.output_text?.trim();
            if (!rawText) return {};

            const jsonStart = rawText.indexOf('{');
            const jsonEnd = rawText.lastIndexOf('}');
            if (jsonStart === -1 || jsonEnd === -1) return {};

            const parsed = JSON.parse(rawText.slice(jsonStart, jsonEnd + 1));

            if (parsed.records_requested && !Array.isArray(parsed.records_requested)) {
                parsed.records_requested = [parsed.records_requested].filter(Boolean);
            }
            if (!Array.isArray(parsed.records_requested)) {
                parsed.records_requested = [];
            }

            // DO NOT extract portal_urls or contact_emails from AI - these come from direct Notion fields only
            delete parsed.portal_urls;
            delete parsed.contact_emails;

            // Ensure tags is always an array of strings
            if (parsed.tags && !Array.isArray(parsed.tags)) {
                parsed.tags = [parsed.tags].filter(Boolean);
            }
            if (!Array.isArray(parsed.tags)) {
                parsed.tags = [];
            }

            return parsed;
        } catch (error) {
            console.warn('normalizeNotionCase failed:', error.message);
            return {};
        }
    }

    /**
     * Generate clarification response for LangGraph
     * Used when agency requests more information
     */
    async generateClarificationResponse(message, analysis, caseData, options = {}) {
        const adjustmentInstruction = options.adjustmentInstruction || options.instruction || '';
        const lessonsContext = options.lessonsContext || '';

        const prompt = `You are responding to a public records request clarification from a government agency.

AGENCY MESSAGE:
${message.body_text || message.body || ''}

ORIGINAL REQUEST:
- Subject: ${caseData.subject_name || 'Unknown'}
- Agency: ${caseData.agency_name || 'Unknown'}
- Records Requested: ${Array.isArray(caseData.requested_records) ? caseData.requested_records.join(', ') : caseData.requested_records || 'Various records'}
- Incident Date: ${caseData.incident_date || 'Not specified'}
- Location: ${caseData.incident_location || 'Not specified'}

${adjustmentInstruction ? `USER ADJUSTMENT INSTRUCTION: ${adjustmentInstruction}` : ''}
${lessonsContext}
Generate a professional, helpful response that:
1. Directly addresses their specific questions or requests for clarification
2. Provides any additional details they need
3. Offers to narrow the scope if it would be helpful
4. Maintains a cooperative, professional tone
5. Keeps under 200 words

Return ONLY the email body text, no subject line or greetings beyond what belongs in the email.`;

        try {
            const response = await this.openai.responses.create({
                model: process.env.OPENAI_MODEL || 'gpt-5.2-2025-12-11',
                reasoning: { effort: 'low' },
                text: { verbosity: 'medium' },
                input: `${responseHandlingPrompts.autoReplySystemPrompt}\n\n${prompt}`
            });

            const bodyText = response.output_text?.trim() || '';
            const subject = `RE: ${message.subject || caseData.case_name || 'Public Records Request'}`;

            return {
                subject: subject,
                body_text: bodyText,
                body_html: `<p>${bodyText.replace(/\n\n/g, '</p><p>').replace(/\n/g, '<br>')}</p>`,
                model: process.env.OPENAI_MODEL || 'gpt-5.2-2025-12-11'
            };
        } catch (error) {
            console.error('Error generating clarification response:', error);
            throw error;
        }
    }

    /**
     * Generate fee acceptance response for LangGraph
     * Used when auto-approving or human-approving a fee quote
     */
    async generateFeeAcceptance(caseData, feeAmount, options = {}) {
        const adjustmentInstruction = options.adjustmentInstruction || options.instruction || '';
        const currency = options.currency || 'USD';

        const prompt = `Generate a professional response accepting a fee quote for a public records request.

CASE DETAILS:
- Subject: ${caseData.subject_name || 'Unknown'}
- Agency: ${caseData.agency_name || 'Unknown'}
- State: ${caseData.state || 'Unknown'}
- Fee Amount: $${typeof feeAmount === 'number' ? feeAmount.toFixed(2) : feeAmount}

${adjustmentInstruction ? `USER ADJUSTMENT INSTRUCTION: ${adjustmentInstruction}` : ''}

The response should:
1. Confirm acceptance of the quoted fee amount
2. Ask about payment method (check, money order, credit card, etc.)
3. Request an invoice or mailing address if payment by mail is required
4. Be brief and professional (under 150 words)
5. Express appreciation for their assistance

Return ONLY the email body text, no subject line or greetings beyond what belongs in the email.`;

        try {
            const response = await this.openai.responses.create({
                model: process.env.OPENAI_MODEL || 'gpt-5.2-2025-12-11',
                reasoning: { effort: 'low' },
                text: { verbosity: 'medium' },
                input: `${responseHandlingPrompts.autoReplySystemPrompt}\n\n${prompt}`
            });

            const bodyText = response.output_text?.trim() || '';
            const subject = `RE: Fee Acceptance - ${caseData.subject_name || caseData.case_name || 'Records Request'}`;

            return {
                subject: subject,
                body_text: bodyText,
                body_html: `<p>${bodyText.replace(/\n\n/g, '</p><p>').replace(/\n/g, '<br>')}</p>`,
                model: process.env.OPENAI_MODEL || 'gpt-5.2-2025-12-11'
            };
        } catch (error) {
            console.error('Error generating fee acceptance:', error);
            throw error;
        }
    }
    /**
     * Generate an agency research brief after a denial.
     * Analyzes which agency likely holds the records and suggests alternatives.
     */
    async generateAgencyResearchBrief(caseData) {
        const prompt = `You are a FOIA research specialist. A public records request was denied or returned "no responsive records."
Analyze which agency most likely holds these records and suggest alternatives.

CASE CONTEXT:
- Agency that denied: ${caseData.agency_name}
- State: ${caseData.state || 'Unknown'}
- Incident location: ${caseData.incident_location || 'Unknown'}
- Subject: ${caseData.subject_name || 'Unknown'}
- Records requested: ${Array.isArray(caseData.requested_records) ? caseData.requested_records.join(', ') : caseData.requested_records || 'Various records'}
- Incident date: ${caseData.incident_date || 'Unknown'}
- Additional details: ${(caseData.additional_details || '').substring(0, 500)}

ANALYSIS TASKS:
1. Why might this agency have said "no records"? (wrong jurisdiction, records held by different unit, etc.)
2. Which specific agencies likely hold these records? Consider: city vs county vs state, specialized units, multi-jurisdictional incidents
3. What search terms or record types might yield better results?

Return JSON:
{
  "summary": "Brief explanation of why the denial likely occurred and where records probably are",
  "suggested_agencies": [
    { "name": "Agency Name", "reason": "Why they might have it", "confidence": 0.0-1.0 }
  ],
  "research_notes": "Additional context about jurisdictional issues",
  "next_steps": "Recommended course of action"
}

Return ONLY valid JSON.`;

        try {
            const response = await this.openai.responses.create({
                model: process.env.OPENAI_MODEL || 'gpt-5.2-2025-12-11',
                reasoning: { effort: 'medium' },
                tools: [{ type: 'web_search' }],
                input: prompt
            });

            const raw = response.output_text?.trim();
            const jsonMatch = raw.match(/\{[\s\S]*\}/);
            if (jsonMatch) {
                return JSON.parse(jsonMatch[0]);
            }
            throw new Error('Failed to parse agency research JSON');
        } catch (error) {
            console.error('Error generating agency research brief:', error);
            return {
                summary: `Research failed: ${error.message}. Manual agency lookup needed.`,
                suggested_agencies: [],
                research_notes: null,
                next_steps: 'Manually research correct agency for this jurisdiction'
            };
        }
    }

    /**
     * Generate a reformulated FOIA request after a denial.
     * Creates a new request with different angle, narrower scope, or different record types.
     */
    async generateReformulatedRequest(caseData, denialAnalysis) {
        const denialContext = denialAnalysis?.full_analysis_json || denialAnalysis || {};
        const keyPoints = denialContext.key_points || [];

        const prompt = `You are a FOIA request strategist. A previous request was denied. Generate a NEW, reformulated FOIA request
that approaches the same records from a different angle or with narrower scope.

ORIGINAL REQUEST CONTEXT:
- Agency: ${caseData.agency_name}
- State: ${caseData.state || 'Unknown'}
- Subject: ${caseData.subject_name || 'Unknown'}
- Records originally requested: ${Array.isArray(caseData.requested_records) ? caseData.requested_records.join(', ') : caseData.requested_records || 'Various records'}
- Incident date: ${caseData.incident_date || 'Unknown'}
- Incident location: ${caseData.incident_location || 'Unknown'}

DENIAL DETAILS:
- Denial subtype: ${denialContext.denial_subtype || 'unknown'}
- Key points: ${keyPoints.join('; ')}
- Summary: ${denialContext.summary || 'No summary available'}

REFORMULATION STRATEGY:
- If "no CCTV/BWC records" → request incident/dispatch reports, CAD logs, or 911 calls instead
- If "overly broad" → narrow by specific dates, times, officers, or record types
- If "no records for that address" → try broader location description or different record category
- Use different terminology that may match agency filing systems
- Keep request specific enough to avoid "overly broad" but broad enough to capture relevant records
- Cite applicable state public records law

Return JSON:
{
  "subject": "New email subject line for the reformulated request",
  "body_text": "Full email body text of the new FOIA request",
  "body_html": null,
  "strategy_notes": "Brief explanation of how this differs from the original request"
}

Return ONLY valid JSON.`;

        try {
            const response = await this.openai.responses.create({
                model: process.env.OPENAI_MODEL || 'gpt-5.2-2025-12-11',
                reasoning: { effort: 'medium' },
                text: { verbosity: 'medium' },
                input: prompt
            });

            const raw = response.output_text?.trim();
            const jsonMatch = raw.match(/\{[\s\S]*\}/);
            if (jsonMatch) {
                return JSON.parse(jsonMatch[0]);
            }
            throw new Error('Failed to parse reformulated request JSON');
        } catch (error) {
            console.error('Error generating reformulated request:', error);
            throw error;
        }
    }
}

module.exports = new AIService();
