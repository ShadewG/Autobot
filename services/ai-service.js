const OpenAI = require('openai');
const Anthropic = require('@anthropic-ai/sdk');
const db = require('./database');
const documentaryFOIAPrompts = require('../prompts/documentary-foia-prompts');
const responseHandlingPrompts = require('../prompts/response-handling-prompts');
const denialResponsePrompts = require('../prompts/denial-response-prompts');
const { buildModelMetadata } = require('../utils/ai-model-metadata');
const { getCanonicalMessageText, normalizeMessageBody } = require('../lib/message-normalization');
const {
    logExternalCallStarted,
    logExternalCallCompleted,
    logExternalCallFailed,
} = require('./agent-log-events');

const DEFAULT_REQUEST_STRATEGY = {
    tone: 'collaborative',
    emphasis: 'documentary',
    detail_level: 'moderate',
    legal_citations: 'moderate',
    fee_waiver_approach: 'brief',
    urgency_level: 'moderate'
};

function buildRequestStrategyInstructions(strategy = DEFAULT_REQUEST_STRATEGY) {
    const toneInstructions = {
        collaborative: 'Use a collaborative, cooperative tone that seeks to work with the agency.',
        assertive: 'Use an assertive, demanding tone that emphasizes legal rights and obligations.',
        formal: 'Use highly formal, traditional legal language with maximum respect.',
        urgent: 'Convey appropriate urgency while maintaining professionalism.'
    };
    const emphasisInstructions = {
        legal_pressure: 'Emphasize legal obligations, statutory deadlines, and potential consequences.',
        public_interest: 'Emphasize public interest, transparency, and civic importance.',
        documentary: 'Emphasize documentary production and educational purposes.',
        transparency: 'Emphasize government transparency and accountability.'
    };
    const detailInstructions = {
        minimal: 'Keep the request concise and to the point.',
        moderate: 'Provide moderate detail with clear specifications.',
        comprehensive: 'Provide comprehensive detail, covering all bases.'
    };
    const legalInstructions = {
        few: 'Include only essential legal citations.',
        moderate: 'Include moderate legal citations and case law.',
        extensive: 'Include extensive legal citations, case law, and statutory references.'
    };
    const feeInstructions = {
        none: 'Do not include fee waiver language.',
        brief: 'Include brief fee waiver request.',
        detailed: 'Include detailed fee waiver justification with legal basis.'
    };
    const urgencyInstructions = {
        none: 'Standard processing timeframe is acceptable.',
        moderate: 'Request timely response within statutory deadlines.',
        high: 'Request expedited processing with urgency justification.'
    };

    return `\n\nSTRATEGIC APPROACH FOR THIS REQUEST:\n- Tone: ${toneInstructions[strategy.tone] || toneInstructions.collaborative}\n- Emphasis: ${emphasisInstructions[strategy.emphasis] || emphasisInstructions.documentary}\n- Detail Level: ${detailInstructions[strategy.detail_level] || detailInstructions.moderate}\n- Legal Citations: ${legalInstructions[strategy.legal_citations] || legalInstructions.moderate}\n- Fee Waiver: ${feeInstructions[strategy.fee_waiver_approach] || feeInstructions.brief}\n- Urgency: ${urgencyInstructions[strategy.urgency_level] || urgencyInstructions.moderate}`;
}

class AIService {
    constructor() {
        // Do not crash module import when a provider key is missing.
        // Tasks can still run with whichever provider is configured.
        this.openai = process.env.OPENAI_API_KEY
            ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY, timeout: 60_000 })
            : null;
        this.anthropic = process.env.ANTHROPIC_API_KEY
            ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
            : null;
    }

    _buildTraceContext(traceContext = {}, defaults = {}) {
        const context = {
            provider: defaults.provider || traceContext.provider || null,
            operation: defaults.operation || traceContext.operation || null,
            sourceService: traceContext.sourceService || traceContext.source_service || defaults.sourceService || defaults.source_service || 'ai_service',
            caseId: traceContext.caseId ?? traceContext.case_id ?? defaults.caseId ?? defaults.case_id ?? null,
            messageId: traceContext.messageId ?? traceContext.message_id ?? defaults.messageId ?? defaults.message_id ?? null,
            proposalId: traceContext.proposalId ?? traceContext.proposal_id ?? defaults.proposalId ?? defaults.proposal_id ?? null,
            runId: traceContext.runId ?? traceContext.run_id ?? defaults.runId ?? defaults.run_id ?? null,
            actorId: traceContext.actorId ?? traceContext.actor_id ?? defaults.actorId ?? defaults.actor_id ?? null,
            endpoint: traceContext.endpoint || defaults.endpoint || null,
            method: traceContext.method || defaults.method || null,
            model: traceContext.model || defaults.model || null,
            requestSummary: traceContext.requestSummary || defaults.requestSummary || null,
            metadata: {
                ...(defaults.metadata || {}),
                ...(traceContext.metadata || {}),
            },
        };

        if (!context.metadata || Object.keys(context.metadata).length === 0) {
            delete context.metadata;
        }

        return context;
    }

    async _withExternalCallTrace(baseContext, fn) {
        const startedAt = Date.now();
        await logExternalCallStarted(db, baseContext);
        try {
            const result = await fn();
            await logExternalCallCompleted(db, {
                ...baseContext,
                durationMs: Date.now() - startedAt,
                responseSummary: result?.responseSummary || result?.response || null,
                statusCode: result?.statusCode ?? null,
                model: result?.model || baseContext.model || null,
                metadata: {
                    ...(baseContext.metadata || {}),
                    ...(result?.metadata || {}),
                },
            });
            return result?.value !== undefined ? result.value : result;
        } catch (error) {
            await logExternalCallFailed(db, {
                ...baseContext,
                durationMs: Date.now() - startedAt,
                error: error?.message || String(error),
                metadata: {
                    ...(baseContext.metadata || {}),
                    error_name: error?.name || null,
                    error_code: error?.code || null,
                },
            });
            throw error;
        }
    }

    /**
     * Call OpenAI Responses API with Anthropic fallback.
     * Returns the output text string.
     */
    async callAI(input, { effort = 'medium', maxTokens = 4000, includeMetadata = false, traceContext = {} } = {}) {
        try {
            if (!this.openai) throw new Error('OPENAI_API_KEY not configured');
            const model = process.env.OPENAI_MODEL || 'gpt-5.2-2025-12-11';
            const context = this._buildTraceContext(traceContext, {
                provider: 'openai',
                operation: 'responses.create',
                endpoint: 'responses.create',
                method: 'sdk',
                model,
                requestSummary: {
                    model,
                    effort,
                    max_tokens: maxTokens,
                },
            });

            const { response, startedAt } = await this._withExternalCallTrace(context, async () => {
                const startedAt = Date.now();
                const response = await this.openai.responses.create({
                    model,
                    reasoning: { effort },
                    text: { verbosity: 'medium' },
                    input,
                });
                return {
                    value: { response, startedAt },
                    responseSummary: {
                        id: response.id,
                        model: response.model,
                        status: response.status,
                    },
                    model,
                    metadata: {
                        prompt_tokens: response.usage?.input_tokens || response.usage?.prompt_tokens || null,
                        completion_tokens: response.usage?.output_tokens || response.usage?.completion_tokens || null,
                    },
                };
            });

            const text = response.output_text?.trim() || '';
            if (!includeMetadata) {
                return text;
            }
            return {
                text,
                modelMetadata: buildModelMetadata({
                    response,
                    usage: response.usage,
                    startedAt,
                }),
            };
        } catch (openaiError) {
            console.error('OpenAI failed, falling back to Anthropic:', openaiError.message);
            if (!this.anthropic) throw openaiError;
            const model = process.env.CLAUDE_MODEL || 'claude-sonnet-4-6';
            const context = this._buildTraceContext(traceContext, {
                provider: 'anthropic',
                operation: 'messages.create',
                endpoint: 'messages.create',
                method: 'sdk',
                model,
                requestSummary: {
                    model,
                    max_tokens: maxTokens,
                },
            });

            const { response, startedAt } = await this._withExternalCallTrace(context, async () => {
                const startedAt = Date.now();
                const response = await this.anthropic.messages.create({
                    model,
                    max_tokens: maxTokens,
                    messages: [{ role: 'user', content: input }],
                });
                return {
                    value: { response, startedAt },
                    responseSummary: {
                        id: response.id,
                        model,
                        stop_reason: response.stop_reason,
                    },
                    model,
                    metadata: {
                        prompt_tokens: response.usage?.input_tokens || null,
                        completion_tokens: response.usage?.output_tokens || null,
                    },
                };
            });

            const text = response.content[0].text?.trim() || '';
            if (!includeMetadata) {
                return text;
            }
            return {
                text,
                modelMetadata: buildModelMetadata({
                    response,
                    usage: response.usage,
                    startedAt,
                }),
            };
        }
    }

    async getUserSignatureForCase(caseData) {
        let user = null;
        if (caseData?.user_id) {
            user = await db.getUserById(caseData.user_id);
        }

        const name = user?.signature_name || user?.name || process.env.REQUESTER_NAME || 'Requester';
        const title = user?.signature_title || process.env.REQUESTER_TITLE || '';
        const organization = user?.signature_organization || '';
        const phone = user?.signature_phone || process.env.REQUESTER_PHONE || '';
        const email = user?.email || process.env.REQUESTER_EMAIL || process.env.SENDGRID_FROM_EMAIL || '';

        const addressParts = [
            user?.address_street,
            user?.address_street2,
            [user?.address_city, user?.address_state].filter(Boolean).join(', '),
            user?.address_zip
        ].filter(Boolean);

        return {
            name,
            title,
            organization,
            phone,
            email,
            address: addressParts.join('\n')
        };
    }

    buildCanonicalSignatureLines(userSignature, { includeEmail = false, includeAddress = false, includePhone = true } = {}) {
        const lines = [];
        if (userSignature?.name) lines.push(userSignature.name);
        if (userSignature?.title) lines.push(userSignature.title);
        if (userSignature?.organization) lines.push(userSignature.organization);
        if (includePhone && userSignature?.phone) lines.push(userSignature.phone);
        if (includeEmail && userSignature?.email) lines.push(userSignature.email);
        if (includeAddress && userSignature?.address) lines.push(userSignature.address);
        return lines;
    }

    formatInlineMailingAddress(address) {
        if (!address) return '';
        const parts = String(address).split(/\r?\n/).map(line => line.trim()).filter(Boolean);
        if (parts.length >= 2 && /^\d{5}(?:-\d{4})?$/.test(parts[parts.length - 1])) {
            const zip = parts.pop();
            parts[parts.length - 1] = `${parts[parts.length - 1]} ${zip}`;
        }
        return parts.join(', ');
    }

    sanitizeLegacyIdentityMentions(text, userSignature) {
        if (!text) return text;
        const allowedIdentity = [
            userSignature?.name || '',
            userSignature?.title || '',
            userSignature?.organization || ''
        ].join(' ').toLowerCase();
        const allowsLegacyBrand = /dr\s+insanity/.test(allowedIdentity);
        if (allowsLegacyBrand) return text;

        let result = text;
        // Strip legacy hardcoded org references that should come only from user settings.
        result = result.replace(/\bDr\s+Insanity(?:\s+Media)?\b/gi, '');
        result = result.replace(/\bDR\s+INSANITY(?:\s+LEGAL\s+DEPARTMENT)?\b/gi, '');
        // Clean up common remnants like "on behalf of".
        result = result.replace(/\bon behalf of\s*[,\-:]?\s*(?:the requester)?\s*(?=[\.\,\;\n]|$)/gi, '');
        // Normalize spacing after removals.
        result = result.replace(/[ \t]{2,}/g, ' ');
        result = result.replace(/\n{3,}/g, '\n\n');
        return result.trim();
    }

    normalizeGeneratedDraftSignature(text, userSignature, { includeEmail = false, includeAddress = false, includePhone = true } = {}) {
        const cleaned = this.sanitizeLegacyIdentityMentions(
            this.sanitizeSignaturePlaceholders(text, userSignature),
            userSignature
        );
        if (!cleaned) return cleaned;

        const signatureLines = this.buildCanonicalSignatureLines(userSignature, { includeEmail, includeAddress, includePhone });
        if (signatureLines.length === 0) return cleaned;

        const lines = cleaned.replace(/\r\n/g, '\n').split('\n');
        const closingRegex = /^\s*(thank you(?:\b.*)?|sincerely|best regards|warm regards|kind regards|regards|respectfully)\s*[,.!]*\s*$/i;
        const closingMatches = [];
        for (let i = 0; i < lines.length; i++) {
            if (closingRegex.test(lines[i])) {
                closingMatches.push(i);
            }
        }
        // Keep the earliest detected closing and rebuild a single canonical signature block.
        const closingIdx = closingMatches.length > 0 ? closingMatches[0] : -1;

        const rebuilt = closingIdx >= 0
            ? [...lines.slice(0, closingIdx + 1), '', ...signatureLines]
            : [...lines, '', 'Thank you,', '', ...signatureLines];

        return rebuilt.join('\n').replace(/\n{3,}/g, '\n\n').trim();
    }

    sanitizeStatusInquiryDraft(text) {
        if (!text) return text;

        let result = String(text);

        // JustFOIA/GovQA status inquiries should not echo back portal security keys.
        result = result.replace(/\bsecurity key\b[^.\n]*[.\n]?/gi, '');
        result = result.replace(/please have (?:both )?reference numbers? available[^.\n]*[.\n]?/gi, '');
        result = result.replace(/please have this security key and reference number available[^.\n]*[.\n]?/gi, '');

        // Remove duplicated closings that often appear in follow-up generations.
        result = result.replace(/(?:\n\s*thank you,\s*){2,}/gi, '\nThank you,\n');

        return result
            .replace(/[ \t]{2,}/g, ' ')
            .replace(/\n{3,}/g, '\n\n')
            .trim();
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

    extractVisibleTextFromHtml(html) {
        return normalizeMessageBody({ body_html: html }).normalized_body_text;
        return String(html)
            .replace(/<style[\s\S]*?<\/style>/gi, ' ')
            .replace(/<script[\s\S]*?<\/script>/gi, ' ')
            .replace(/<br\s*\/?>/gi, '\n')
            .replace(/<\/(p|div|li|tr|h[1-6])>/gi, '\n')
            .replace(/<[^>]+>/g, ' ')
            .replace(/&nbsp;|&#160;/gi, ' ')
            .replace(/&amp;/gi, '&')
            .replace(/&quot;/gi, '"')
            .replace(/&#39;|&apos;/gi, "'")
            .replace(/&lt;/gi, '<')
            .replace(/&gt;/gi, '>')
            .replace(/\r/g, '')
            .replace(/[ \t]+\n/g, '\n')
            .replace(/\n{3,}/g, '\n\n')
            .replace(/[ \t]{2,}/g, ' ')
            .trim();
    }

    getMessageBodyForPrompt(messageData) {
        return this.stripQuotedText(getCanonicalMessageText(messageData)).trim();
    }

    inferDenialSubtype(messageData, analysis = {}) {
        if (analysis.denial_subtype) return analysis.denial_subtype;

        const combinedText = [
            this.getMessageBodyForPrompt(messageData),
            ...(Array.isArray(analysis.key_points) ? analysis.key_points : []),
            ...(Array.isArray(analysis.detected_exemption_citations) ? analysis.detected_exemption_citations : []),
            ...(Array.isArray(analysis.decision_evidence_quotes) ? analysis.decision_evidence_quotes : []),
        ].join(' ').toLowerCase();

        if (!combinedText) return 'overly_broad';
        if (/wrong agency|not the custodian|not our records|contact .* instead|maintained by another agency/.test(combinedText)) return 'wrong_agency';
        if (/no responsive records|no records exist|no records were found/.test(combinedText)) return 'no_records';
        if (/not sufficiently clear|specify an identifiable record|reasonably describe(?:s)? an identifiable record|focused and effective request/.test(combinedText)) return 'not_reasonably_described';
        if (/do not require .*create documents|no duty to create|not a public records request|not require departments .* create documents/.test(combinedText)) return 'no_duty_to_create';
        if (/ongoing investigation|active investigation|open investigation|pending prosecution|criminal investigative information/.test(combinedText)) return 'ongoing_investigation';
        if (/too broad|overly broad|undue burden|voluminous|narrow your request|narrow the request/.test(combinedText)) return 'overly_broad';
        if (/fee|invoice|estimate|deposit|cost to fulfill/.test(combinedText)) return 'excessive_fees';
        if (/surveillance techniques|surveillance procedures|surveillance personnel|privacy|personnel record|medical record|personally identifiable|juvenile|redaction|redact|exempt from.*119\.07|s\.\s*119\.07|24\(a\)/.test(combinedText)) return 'privacy_exemption';
        if (/retention|destroyed|purged|deleted pursuant to retention/.test(combinedText)) return 'retention_expired';
        if (/expired link|broken link|portal issue|format unavailable/.test(combinedText)) return 'format_issue';
        return 'overly_broad';
    }

    extractMessageReference(messageData) {
        const combined = [
            messageData?.subject || '',
            messageData?.normalized_body_text || '',
            messageData?.body_text || '',
            messageData?.body_html || '',
        ].join('\n');

        const refMatch = combined.match(/reference\s*#:\s*([A-Z0-9-]+)/i)
            || combined.match(/\bref\.?\s*([A-Z0-9-]{6,})/i)
            || combined.match(/\brequest\s*#\s*([A-Z0-9-]+)/i);

        return refMatch?.[1] || null;
    }

    shouldUsePrivacyExemptionTemplateFallback(text) {
        const normalized = String(text || '').toLowerCase();
        if (!normalized) return true;

        const hasSegregabilityAsk = /segregable|redacted copy|release the remainder|release .*portion|partial release|redaction/i.test(normalized);
        const acceptsRedactions = /redaction|redacted|blurring|muting|bleeping/i.test(normalized);
        const badNarrowing = /happy to narrow|proceed in phases|phase 1|phase 2|narrow the request/i.test(normalized);

        return badNarrowing || !hasSegregabilityAsk || !acceptsRedactions || normalized.length < 420;
    }

    buildPrivacyExemptionTemplate(messageData, caseData, userSignature) {
        const requesterName = userSignature?.name || process.env.REQUESTER_NAME || 'Requester';
        const requesterTitle = userSignature?.title || process.env.REQUESTER_TITLE || '';
        const phone = userSignature?.phone || process.env.REQUESTER_PHONE || '';
        const reference = this.extractMessageReference(messageData);
        const recordsSummary = Array.isArray(caseData?.requested_records)
            ? caseData.requested_records.filter(Boolean).join(', ')
            : (caseData?.requested_records || 'the requested records');

        const lines = [
            'Dear Records Custodian,',
            '',
            `Thank you for your response regarding my public records request${reference ? ` (Ref. ${reference})` : ''}. I understand your concern that portions of the responsive material may reveal surveillance techniques, procedures, personnel, or other exempt information, and I am fully agreeable to comprehensive redactions of any legitimately exempt content.`,
            '',
            `That said, your response indicates that responsive records exist. Please release all reasonably segregable non-exempt portions of ${recordsSummary}, including any redacted copy, excerpt, or limited segment that can be produced without revealing exempt surveillance details.`,
            '',
            'If you contend that no segregable portion can be released, please identify the specific records or portions being withheld, the exact exemption(s) relied upon, and explain why redaction, blurring, muting, or partial release would be insufficient.',
            '',
            'I remain willing to accept comprehensive redactions of surveillance techniques, personnel identities, private personal information, and any other legitimately exempt details so that the non-exempt remainder can be released.',
            '',
            requesterName,
            ...(requesterTitle ? [requesterTitle] : []),
            ...(phone ? [phone] : []),
        ];

        return lines.join('\n');
    }

    /**
     * Replace common AI placeholder patterns with actual requester info.
     * Some models output [Your Name], [Your Phone], etc. despite being told
     * the real values — this catches and fixes those.
     */
    sanitizeSignaturePlaceholders(text, userSignature) {
        if (!text) return text;
        const name = userSignature?.name || process.env.REQUESTER_NAME || 'Requester';
        const title = userSignature?.title || process.env.REQUESTER_TITLE || '';
        const phone = userSignature?.phone || process.env.REQUESTER_PHONE || '';
        const mailingAddress = this.formatInlineMailingAddress(userSignature?.address);

        let result = text;
        // Replace common placeholder variants (with or without brackets/markdown)
        // Name/title placeholders are replaced with real values.
        result = result.replace(/(?:\*\*)?\[?\s*your\s+(?:full\s+)?name\s*\]?(?:\*\*)?/gi, name);
        result = result.replace(/(?:\*\*)?\[?\s*your\s+(?:title|organization)\s*\]?(?:\*\*)?/gi, title);

        // Phone placeholder: use configured phone if available, otherwise remove placeholder token.
        result = result.replace(/(?:\*\*)?\[?\s*your\s+phone(?:\s+number)?\s*\]?(?:\*\*)?/gi, phone || '');
        result = result.replace(/\[\s*INSERT\s+REQUESTER\s+MAILING\s+ADDRESS\s*\]/gi, mailingAddress || '');
        result = result.replace(/\[\s*REQUESTER\s+MAILING\s+ADDRESS\s*\]/gi, mailingAddress || '');

        // Remove full lines that still contain contact placeholders we never want in output.
        // Handles variants like "[Your Address/City, State]" and markdown bullet/label wrappers.
        result = result.replace(
            /^.*(?:\*\*)?\[?\s*your\s+(?:email|e-?mail(?:\s+address)?|mailing\s+address|address(?:\s*\/\s*city,\s*state)?)\s*(?:\(optional\))?\]?(?:\*\*)?.*$/gmi,
            ''
        );

        // Remove now-empty label lines left by token replacement, e.g. "Phone:".
        result = result.replace(/^\s*(?:[-*]\s*)?(?:phone|telephone)\s*:\s*$/gmi, '');
        // Clean up any trailing blank lines left by removals
        result = result.replace(/\n{3,}/g, '\n\n');
        return result.trim();
    }

    sanitizeClarificationDraft(text, userSignature) {
        if (!text) return text;

        const mailingAddress = this.formatInlineMailingAddress(userSignature?.address);

        let result = text.replace(/\r\n/g, '\n');

        if (mailingAddress) {
            result = result.replace(
                /^(\s*(?:mailing\s+address|physical\s+mailing\s+address)\s*(?:\(.*?\))?\s*:\s*)(.+)$/gmi,
                (full, prefix, value) => (
                    /\[.*\]|\binsert\b|\btbd\b|\bto follow\b|\bplaceholder\b/i.test(value)
                        ? `${prefix}${mailingAddress}`
                        : full
                )
            );
        } else {
            result = result.replace(
                /^\s*(?:mailing\s+address|physical\s+mailing\s+address)\s*(?:\(.*?\))?\s*:\s*(?:\[.*\]|\binsert\b.*)?$/gmi,
                ''
            );
            result = result.replace(/^.*mailing address included.*$/gmi, '');
        }

        // Clarification replies on this path do not send attachments or forms.
        // Remove claims that a request form has already been completed or will be sent.
        result = result.replace(
            /^.*\b(?:i['’]?ve|i have)\s+completed\b.*\b(?:apra\/foia request form|foia request form|request form)\b.*$/gmi,
            ''
        );
        result = result.replace(
            /^.*\b(?:will send|am sending|sending|have sent|sent)\b.*\b(?:apra\/foia request form|foia request form|request form)\b.*$/gmi,
            ''
        );
        result = result.replace(/^.*\b(?:attached|enclosed|included with this email)\b.*\b(?:form)\b.*$/gmi, '');

        result = result.replace(/\n{3,}/g, '\n\n');
        return result.trim();
    }

    stripDraftMetaPreamble(text) {
        const lines = String(text || '')
            .replace(/\r\n/g, '\n')
            .split('\n');

        const metaLinePatterns = [
            /^\s*is a response needed\??\s*(yes|no)?\.?\s*$/i,
            /^\s*is a response needed\??\s*yes\b.*$/i,
            /^\s*(analysis|reasoning|recommended action|suggested action|draft note)\s*:\s*.*$/i,
            /^\s*response needed\??\s*(yes|no)?\.?\s*$/i,
            /^\s*can draft\??\s*(yes|no)?\.?\s*$/i,
        ];

        const cleaned = lines.filter((line) => !metaLinePatterns.some((pattern) => pattern.test(line.trim())));
        return cleaned.join('\n').replace(/\n{3,}/g, '\n\n').trim();
    }

    isSyntheticRequestedRecordLine(value) {
        const text = String(value || '').trim();
        if (!text) return true;
        const metadataLinePatterns = [
            /^(city|state|county|agency|agencies|police department|police departments involved|agencies involved|incident date|incident location|subject name|subject|request type|request strategy|status)\s*:\s*.+$/i,
            /^---\s*notion fields\s*---$/i,
        ];
        return /\b(e2e|synthetic|scenario|localhost qa)\b/i.test(text)
            || /^various records$/i.test(text)
            || metadataLinePatterns.some((pattern) => pattern.test(text));
    }

    buildRequestedRecordSummary(caseData) {
        const requested = Array.isArray(caseData?.requested_records)
            ? caseData.requested_records.filter((item) => !this.isSyntheticRequestedRecordLine(item))
            : [];

        if (requested.length > 0) {
            const firstThree = requested.slice(0, 3);
            return firstThree.join('; ');
        }

        if (caseData?.subject_name) {
            return `records concerning ${caseData.subject_name}`;
        }

        return 'the responsive public records described in my request';
    }

    buildReasonablyDescribedClarificationTemplate(messageData, caseData, userSignature) {
        const requesterName = userSignature?.name || process.env.REQUESTER_NAME || 'Requester';
        const requesterTitle = userSignature?.title || process.env.REQUESTER_TITLE || '';
        const phone = userSignature?.phone || process.env.REQUESTER_PHONE || '';
        const reference = this.extractMessageReference(messageData);
        const recordSummary = this.buildRequestedRecordSummary(caseData);
        const incidentDate = caseData?.incident_date
            ? new Date(caseData.incident_date).toISOString().split('T')[0]
            : null;
        const lines = [
            'Hello Records Custodian,',
            '',
            `Thank you for the notice regarding my public records request${reference ? ` (#${reference})` : ''}. To clarify, I am seeking ${recordSummary}.`,
        ];

        const details = [];
        if (caseData?.subject_name) details.push(`Subject/person: ${caseData.subject_name}`);
        if (incidentDate) details.push(`Incident date: ${incidentDate}`);
        if (caseData?.incident_location) details.push(`Location: ${caseData.incident_location}`);
        if (Array.isArray(caseData?.requested_records)) {
            const requested = caseData.requested_records.filter((item) => !this.isSyntheticRequestedRecordLine(item));
            if (requested.length > 0) {
                details.push(`Requested record types: ${requested.slice(0, 4).join('; ')}`);
            }
        }

        if (details.length > 0) {
            lines.push('', 'Helpful identifying details:');
            for (const detail of details) {
                lines.push(`- ${detail}`);
            }
        }

        lines.push(
            '',
            'If this request can be reopened with the clarification above, please do so. If your office instead requires a new portal submission, please let me know and I will resubmit it there.',
            'If a case number or another identifier would help you locate the records more efficiently, please tell me what would be most useful and I will provide it if available.',
            '',
            requesterName,
        );

        if (requesterTitle) lines.push(requesterTitle);
        if (phone) lines.push(phone);

        return lines.join('\n').trim();
    }

    shouldUseClarificationTemplateFallback(text, messageData, caseData) {
        const cleaned = this.stripDraftMetaPreamble(this.sanitizeClarificationDraft(text, null));
        const messageText = this.getMessageBodyForPrompt(messageData).toLowerCase();
        const constraints = Array.isArray(caseData?.constraints_jsonb)
            ? caseData.constraints_jsonb.filter((item) => typeof item === 'string')
            : [];
        const hasReasonablyDescribedClosure = /not sufficiently clear|specify an identifiable record|reasonably describe(?:s)? an identifiable record|making a focused and effective request/i.test(messageText)
            || constraints.includes('REQUEST_NOT_REASONABLY_DESCRIBED');

        if (!hasReasonablyDescribedClosure) return false;
        if (!cleaned) return true;
        if (/^hello\s+mr\./i.test(cleaned) && /is a response needed\?/i.test(String(text || ''))) return true;
        if (cleaned.length < 220) return true;
        if (!/reopen|resubmit|clarify|identifier|incident date|requested record/i.test(cleaned)) return true;
        return false;
    }

    buildCertificationBarrierRebuttalTemplate(messageData, caseData, userSignature) {
        const requesterName = userSignature?.name || process.env.REQUESTER_NAME || 'Requester';
        const requesterTitle = userSignature?.title || process.env.REQUESTER_TITLE || '';
        const phone = userSignature?.phone || process.env.REQUESTER_PHONE || '';
        const reference = this.extractMessageReference(messageData);
        const recordSummary = this.buildRequestedRecordSummary(caseData);
        const lines = [
            'Dear Records Custodian,',
            '',
            `Thank you for your response regarding my public records request${reference ? ` (Ref. ${reference})` : ''}. I want to proceed with this request, but I need the exact steps and legal basis for the conditions you described.`,
            '',
            'If Wisconsin law requires a written certification for any requested audio or video records under Wis. Stat. § 19.35(3)(h)3.a, please send the exact certification form or language your office requires.',
            'Please also provide an itemized written estimate for any redaction or production fees before closing the request.',
            `To the extent any responsive non-video records or other segregable portions of ${recordSummary} are not subject to that certification requirement, please process and release those records now.`,
            'If any requested records are being withheld or delayed, please identify the specific legal basis for each withheld category and explain what additional information you need from me to proceed.',
            '',
            requesterName,
        ];

        if (requesterTitle) lines.push(requesterTitle);
        if (phone) lines.push(phone);

        return lines.join('\n').trim();
    }

    buildNoContactClosureRebuttalTemplate(messageData, caseData, userSignature) {
        const requesterName = userSignature?.name || process.env.REQUESTER_NAME || 'Requester';
        const requesterTitle = userSignature?.title || process.env.REQUESTER_TITLE || '';
        const phone = userSignature?.phone || process.env.REQUESTER_PHONE || '';
        const reference = this.extractMessageReference(messageData);
        const recordSummary = this.buildRequestedRecordSummary(caseData);
        const incidentDate = caseData?.incident_date
            ? new Date(caseData.incident_date).toISOString().split('T')[0]
            : null;
        const lines = [
            'Dear Records Custodian,',
            '',
            `Thank you for the closure notice regarding my public records request${reference ? ` (Ref. ${reference})` : ''}. I want to continue pursuing this request and am providing a clearer description so the request can be reopened and processed.`,
            '',
            `This request seeks ${recordSummary}.`,
        ];

        if (caseData?.subject_name || incidentDate || caseData?.incident_location) {
            lines.push('', 'Helpful identifying details:');
            if (caseData?.subject_name) lines.push(`- Subject/person: ${caseData.subject_name}`);
            if (incidentDate) lines.push(`- Incident date: ${incidentDate}`);
            if (caseData?.incident_location) lines.push(`- Location: ${caseData.incident_location}`);
        }

        lines.push(
            '',
            'Please reopen the request and process it using the clarification above. If a case number or another specific identifier is required before you can search for responsive records, please tell me exactly what information would be most useful and I will provide it if available.',
            '',
            requesterName,
        );

        if (requesterTitle) lines.push(requesterTitle);
        if (phone) lines.push(phone);

        return lines.join('\n').trim();
    }

    shouldUseNoContactClosureTemplate(messageText, denialSubtype, generatedText) {
        if (denialSubtype !== 'not_reasonably_described') return false;
        const normalizedMessage = String(messageText || '').toLowerCase();
        if (!/unable to contact|not sufficiently clear|reasonably describe(?:s)? an identifiable record|focused and effective request/i.test(normalizedMessage)) {
            return false;
        }
        const normalizedGenerated = String(generatedText || '').trim().toLowerCase();
        if (!normalizedGenerated) return true;
        if (normalizedGenerated.length < 260) return true;
        if (!/reopen|process it|case number|identifier/i.test(normalizedGenerated)) return true;
        return false;
    }

    shouldUseCertificationBarrierTemplate(messageText, generatedText) {
        const normalizedMessage = String(messageText || '').toLowerCase();
        if (!/certification|19\.35\(3\)\(h\)3a|correlation to the videos|for financial gain/i.test(normalizedMessage)) {
            return false;
        }
        const normalizedGenerated = String(generatedText || '').trim().toLowerCase();
        if (!normalizedGenerated) return true;
        if (normalizedGenerated.length < 240) return true;
        if (!/certification|itemized|estimate|legal basis/i.test(normalizedGenerated)) return true;
        return false;
    }

    /**
     * Generate a FOIA request from case data
     */
    async generateFOIARequest(caseData, options = {}) {
        try {
            console.log(`Generating FOIA request for case: ${caseData.case_name}`);
            const examplesContext = options.examplesContext || '';

            // Load user signature if case is assigned
            const userSignature = await this.getUserSignatureForCase(caseData);

            // Keep initial requests deterministic. The older adaptive strategy
            // path produced random exploration more often than useful learned guidance.
            const strategy = DEFAULT_REQUEST_STRATEGY;
            console.log('Using default request strategy:', strategy);

            const systemPrompt = this.buildFOIASystemPrompt(caseData.state, strategy);
            const userPrompt = this.buildFOIAUserPrompt(caseData, strategy, userSignature, examplesContext);

            // Combine system and user prompts for GPT-5
            const fullPrompt = `${systemPrompt}\n\n${userPrompt}`;

            // Try GPT-5 first (latest and most capable for FOIA generation)
            try {
                const model = process.env.OPENAI_MODEL || 'gpt-5.2-2025-12-11';
                const { response, startedAt } = await this._withExternalCallTrace(
                    this._buildTraceContext({ caseId: caseData?.id }, {
                        provider: 'openai',
                        operation: 'chat.completions.create',
                        endpoint: 'chat.completions.create',
                        method: 'sdk',
                        model,
                        requestSummary: {
                            model,
                            subject_name: caseData?.subject_name || null,
                            agency_name: caseData?.agency_name || null,
                        },
                    }),
                    async () => {
                        const startedAt = Date.now();
                        const response = await this.openai.chat.completions.create({
                            model,
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
                            reasoning_effort: 'medium',
                            verbosity: 'medium',
                            max_completion_tokens: 4000
                        });
                        return {
                            value: { response, startedAt },
                            responseSummary: {
                                id: response.id,
                                model,
                            },
                            model,
                            metadata: {
                                prompt_tokens: response.usage?.prompt_tokens || null,
                                completion_tokens: response.usage?.completion_tokens || null,
                            },
                        };
                    }
                );

                let requestText = response.choices[0].message.content;

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

                // Fix AI placeholder patterns ([Your Name], etc.)
                requestText = this.normalizeGeneratedDraftSignature(requestText, userSignature, { includeEmail: false, includeAddress: false });

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

                return {
                    success: true,
                    request_text: requestText,
                    model: modelUsed,
                    modelMetadata: buildModelMetadata({
                        response,
                        usage: response.usage,
                        startedAt,
                    }),
                };
            } catch (openaiError) {
                console.error('OpenAI failed, trying Claude:', openaiError.message);
                return await this.generateWithClaude(caseData, userSignature, { examplesContext });
            }
        } catch (error) {
            console.error('Error generating FOIA request:', error);
            throw error;
        }
    }

    /**
     * Generate FOIA request using Claude (fallback)
     */
    async generateWithClaude(caseData, userSignature = null, options = {}) {
        if (!this.anthropic) {
            throw new Error('ANTHROPIC_API_KEY not configured for Claude fallback');
        }
        const systemPrompt = this.buildFOIASystemPrompt(caseData.state);
        const userPrompt = this.buildFOIAUserPrompt(caseData, null, userSignature, options.examplesContext || '');

        const modelUsed = process.env.CLAUDE_MODEL || 'claude-3-7-sonnet-20250219';
        const { response, startedAt } = await this._withExternalCallTrace(
            this._buildTraceContext({ caseId: caseData?.id }, {
                provider: 'anthropic',
                operation: 'messages.create',
                endpoint: 'messages.create',
                method: 'sdk',
                model: modelUsed,
                requestSummary: {
                    model: modelUsed,
                    subject_name: caseData?.subject_name || null,
                    agency_name: caseData?.agency_name || null,
                },
            }),
            async () => {
                const startedAt = Date.now();
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
                return {
                    value: { response, startedAt },
                    responseSummary: {
                        id: response.id,
                        model: modelUsed,
                        stop_reason: response.stop_reason,
                    },
                    model: modelUsed,
                    metadata: {
                        prompt_tokens: response.usage?.input_tokens || null,
                        completion_tokens: response.usage?.output_tokens || null,
                    },
                };
            }
        );

        const requestText = this.normalizeGeneratedDraftSignature(
            response.content[0].text, userSignature, { includeEmail: false, includeAddress: false }
        );

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
            model: modelUsed,
            modelMetadata: buildModelMetadata({
                response,
                usage: response.usage,
                startedAt,
            }),
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

        const strategyInstructions = buildRequestStrategyInstructions(strategy || DEFAULT_REQUEST_STRATEGY);

        return basePrompt + jurisdictionGuidance + strategyInstructions;
    }

    extractPromptCaseSummary(additionalDetails) {
        const raw = String(additionalDetails || '').replace(/\r/g, '').trim();
        if (!raw) return '';

        const strippedMetadata = raw.split('--- Notion Fields ---')[0].trim();
        const normalized = strippedMetadata
            .replace(/\n{2,}/g, '\n')
            .replace(/[ \t]+/g, ' ')
            .trim();

        if (!normalized) return '';
        return normalized.length > 700 ? `${normalized.slice(0, 697).trim()}...` : normalized;
    }

    shouldIncludeIncidentLocationInInitialPrompt(caseData = {}) {
        const location = String(caseData.incident_location || '').trim();
        const agencyName = String(caseData.agency_name || '').trim().toLowerCase();
        if (!location) return false;
        if (!agencyName) return true;

        const locationHead = location.split(',')[0].trim().toLowerCase();
        if (!locationHead || locationHead.length < 4) return false;
        return agencyName.includes(locationHead);
    }

    /**
     * Build the user prompt for FOIA request generation (documentary-focused)
     */
    buildFOIAUserPrompt(caseData, strategy = null, userSignature = null, examplesContext = '') {
        const legalStyle = strategy?.tone || caseData.legal_style || 'standard';
        const legalStyleInstructions = {
            'standard': 'Use standard professional legal language with polite but firm tone.',
            'formal': 'Use highly formal, traditional legal language with maximum respect and deference.',
            'assertive': 'Use assertive, demanding tone that emphasizes legal rights and obligations.',
            'collaborative': 'Use collaborative, cooperative tone that seeks to work with the agency.'
        };

        const styleInstruction = legalStyleInstructions[legalStyle] || legalStyleInstructions['standard'];

        // Build emphasis items — these get extra weight but we ALWAYS request the full set
        let emphasisNote = '';
        if (caseData.requested_records) {
            const records = Array.isArray(caseData.requested_records)
                ? caseData.requested_records
                : [caseData.requested_records];
            if (records.length > 0) {
                emphasisNote = `\n\n   SPECIAL EMPHASIS: This case has particularly important ${records.join(', ')} — highlight these in the request. But ALWAYS request the full standard set of records (body cams, dash cams, CCTV, 911 audio, interviews, reports, photos).`;
            }
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

        const shouldIncludeIncidentLocation = this.shouldIncludeIncidentLocationInInitialPrompt(caseData);
        if (caseData.incident_location && shouldIncludeIncidentLocation) {
            incidentDescription += ` at ${caseData.incident_location}`;
        }

        const promptCaseSummary = this.extractPromptCaseSummary(caseData.additional_details);
        if (promptCaseSummary) {
            incidentDescription += `. ${promptCaseSummary}`;
        }

        // Get requester info from user signature, env, or defaults
        const requesterName = userSignature?.name || process.env.REQUESTER_NAME || 'Requester';
        const requesterTitle = userSignature?.title || process.env.REQUESTER_TITLE || '';
        const requesterPhone = userSignature?.phone || process.env.REQUESTER_PHONE || '';

        // Build signature block for the closing
        let signatureBlock = `   - Name: ${requesterName}`;
        if (requesterTitle) {
            signatureBlock += `\n   - Title: ${requesterTitle}`;
        }
        if (requesterPhone) {
            signatureBlock += `\n   - Phone: ${requesterPhone}`;
        }

        return `Generate a professional FOIA/public records request following the structure in the system prompt.

1. BASIC INFO:
   - Jurisdiction: ${caseData.state}
   - Agency: ${caseData.agency_name}
   - Requester: ${requesterName}

2. INCIDENT DETAILS:
   ${incidentDescription}${emphasisNote}

2b. TARGETING RULES:
   - The authoritative target agency for this request is: ${caseData.agency_name}
   - Do NOT switch to a different agency name just because the narrative mentions another city, department, arrest location, or assisting agency.
   - Only request records likely held, received, retained, or generated by ${caseData.agency_name}.
   - If other agencies are mentioned in the background facts, treat them as context only unless ${caseData.agency_name} itself would have those records or communications.

3. RECORDS TO REQUEST (ALWAYS request ALL of these — this is the default for every case):
   Priority 1 — Video/audio evidence (native digital format with original audio and metadata/timestamps):
   a) Body-worn camera from ALL responding/assisting officers (30-min buffer before and after)
   b) Dash/in-car camera from ALL responding vehicles (30-min buffer before and after)
   c) Surveillance/CCTV collected from the scene and nearby locations
   d) 911 call recordings and CAD/dispatch audio
   e) Interview/interrogation room video and audio
   ${caseData.officer_details ? `- Officers involved: ${caseData.officer_details}` : ''}
   ${caseData.incident_time ? `- Time range: ${caseData.incident_time}` : ''}
   ${caseData.incident_location && shouldIncludeIncidentLocation ? `- Location: ${caseData.incident_location}` : ''}

   Priority 2 — Supporting documents:
   f) Primary incident/offense report and arrest report
   g) Scene/evidence photographs

4. LEGAL STYLE: ${styleInstruction}

5. STATE-SPECIFIC CONSIDERATIONS:
   Apply moderate enforcement approach - reference state deadlines and cite relevant cases

6. DOCUMENTARY-FOCUSED INSTRUCTIONS:
   - VIDEO FOOTAGE is always the #1 priority — request ALL types listed above
   - Request native digital format with original audio
   - Use simple language, avoid "no responsive records" loopholes
   - Cite relevant state law and retention schedules briefly
   - Mention non-commercial/documentary purpose and reasonable cost agreement
   - Request preservation of footage
   - Keep total request to 200-400 words

${examplesContext || ''}

7. CLOSING SIGNATURE — use EXACTLY these values, do NOT use placeholders like [Your Name]:
${signatureBlock}

DO NOT include email addresses or mailing addresses in the closing.
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

            const cleanedBody = this.getMessageBodyForPrompt(messageData);

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
                            const body = this.stripQuotedText(getCanonicalMessageText(m)).substring(0, 300);
                            return `[${dir} ${dateStr}] Subject: ${m.subject || '(none)'}\n${body}${body.length >= 300 ? '...' : ''}`;
                        }).join('\n---\n') + '\n';
                }
            }

            // Build requested records list for scope analysis
            // Prefer scope_items_jsonb (structured) over requested_records (legacy)
            const scopeItems = caseData.scope_items_jsonb || [];
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
            const model = 'gpt-5.2-2025-12-11';
            const { response, startedAt } = await this._withExternalCallTrace(
                this._buildTraceContext({
                    caseId: caseData?.id,
                    messageId: messageData?.id,
                }, {
                    provider: 'openai',
                    operation: 'analyze_response',
                    endpoint: 'responses.create',
                    method: 'sdk',
                    model,
                    requestSummary: {
                        model,
                        agency_name: caseData?.agency_name || null,
                        message_subject: messageData?.subject || null,
                    },
                }),
                async () => {
                    const startedAt = Date.now();
                    const response = await this.openai.responses.create({
                        model,
                        reasoning: { effort: 'medium' },
                        text: { verbosity: 'low' },
                        input: `${responseHandlingPrompts.analysisSystemPrompt}

${prompt}`
                    });
                    return {
                        value: { response, startedAt },
                        responseSummary: {
                            id: response.id,
                            model,
                            status: response.status,
                        },
                        model,
                        metadata: {
                            prompt_tokens: response.usage?.input_tokens || response.usage?.prompt_tokens || null,
                            completion_tokens: response.usage?.output_tokens || response.usage?.completion_tokens || null,
                        },
                    };
                }
            );
            const modelMetadata = buildModelMetadata({
                response,
                usage: response.usage,
                startedAt,
            });

            const analysis = JSON.parse(response.output_text);

            // Normalize: LLM sometimes returns requires_response instead of requires_action
            if (analysis.requires_response !== undefined && analysis.requires_action === undefined) {
                analysis.requires_action = analysis.requires_response;
            }

            // Store analysis in database (skip when running with synthetic/test fixtures)
            let analysisRecord = null;
            if (!options.skipDbWrite) {
                // Sanitize values: convert string "null" to actual null
                analysisRecord = await db.createResponseAnalysis({
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
                    full_analysis_json: analysis,
                    model_id: modelMetadata.modelId,
                    prompt_tokens: modelMetadata.promptTokens,
                    completion_tokens: modelMetadata.completionTokens,
                    latency_ms: modelMetadata.latencyMs,
                });

                // Backfill message summary from analysis
                if (analysis.summary) {
                    await db.query('UPDATE messages SET summary = $1 WHERE id = $2 AND summary IS NULL',
                        [analysis.summary, messageData.id]);
                }
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
        const model = 'gpt-5.2-2025-12-11';
        const response = await this._withExternalCallTrace(
            this._buildTraceContext({}, {
                provider: 'openai',
                operation: 'generate_message_summary',
                endpoint: 'responses.create',
                method: 'sdk',
                model,
                requestSummary: {
                    model,
                    subject,
                },
            }),
            async () => {
                const response = await this.openai.responses.create({
                    model,
                    input: `Summarize this email in ONE sentence (max 120 chars). Subject: ${subject}\n\n${snippet}`
                });
                return {
                    value: response,
                    responseSummary: {
                        id: response.id,
                        model,
                        status: response.status,
                    },
                    model,
                };
            }
        );
        return response.output_text.trim();
    }

    /**
     * Generate an auto-reply based on the analysis
     */
    async generateAutoReply(messageData, analysis, caseData) {
        try {
            const rawIntent = String(analysis?.intent || '').trim();
            const normalizedIntent = rawIntent.toLowerCase() === 'clarification_request'
                ? 'more_info_needed'
                : rawIntent.toLowerCase();

            console.log(`Generating auto-reply for case: ${caseData.case_name}, intent: ${rawIntent || normalizedIntent}`);

            // FIRST: Check if response is even needed
            const noResponseIntents = ['portal_redirect', 'acknowledgment', 'records_ready', 'delivery', 'partial_delivery'];

            if (noResponseIntents.includes(normalizedIntent)) {
                console.log(`No response needed for intent: ${normalizedIntent}`);
                return {
                    should_auto_reply: false,
                    reason: `No email response needed for ${normalizedIntent}`,
                    suggested_action: normalizedIntent === 'portal_redirect' ? 'use_portal' :
                                     normalizedIntent === 'records_ready' ? 'download' :
                                     normalizedIntent === 'delivery' ? 'download' : 'wait',
                    portal_url: analysis.portal_url || null
                };
            }

            // Handle denials - but check if rebuttal makes sense first
            if (normalizedIntent === 'denial') {
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
            if (normalizedIntent === 'fee_request') {
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

            if (!responseIntents.includes(normalizedIntent)) {
                return {
                    should_auto_reply: false,
                    reason: 'Intent not suitable for auto-reply'
                };
            }

            const cleanedBody = this.getMessageBodyForPrompt(messageData);

            const prompt = `Generate a professional email reply to this FOIA response:

**Context:**
- Our request was about: ${caseData.subject_name}
- Agency: ${caseData.agency_name}

**Their Response:**
${cleanedBody}

**Analysis:**
- Intent: ${rawIntent || normalizedIntent}
- What they need: ${analysis.suggested_action}

Generate an appropriate reply that:
1. Is professional and courteous
2. Addresses their specific questions/needs
3. Provides any information they requested
4. Confirms our continued interest in receiving the records
5. Is concise and clear

Return ONLY the email body text, no subject line or metadata.`;

            let replyText = await this.callAI(
                `${responseHandlingPrompts.autoReplySystemPrompt}\n\n${prompt}`,
                { effort: 'medium' }
            );
            const userSignature = await this.getUserSignatureForCase(caseData);
            replyText = this.normalizeGeneratedDraftSignature(replyText, userSignature, { includeEmail: false, includeAddress: false });

            // Guardrail: if intent requires response but model says "no response needed", fallback
            if (responseIntents.includes(normalizedIntent) && /no response needed|no reply needed/i.test(replyText || '')) {
                const scopeItems = caseData.scope_items_jsonb || [];
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

        // Use Parallel search + Anthropic synthesis
        let searchResults = [];
        const parallelApiKey = process.env.PARALLEL_API_KEY;

        if (parallelApiKey) {
            try {
                console.log(`🔍 Researching ${state} public records laws for ${denialType} denials using Parallel search...`);
                const searchQueries = [
                    `${state} public records law FOIA statute ${denialType} exemption`,
                    `${state} open records act ${denialType} denial case law precedent`,
                    `${state} FOIA segregability requirements response timeline fee waiver`,
                ];

                const parallelRes = await fetch('https://api.parallel.ai/v1beta/search', {
                    method: 'POST',
                    headers: {
                        'x-api-key': parallelApiKey,
                        'Content-Type': 'application/json',
                        'parallel-beta': 'search-extract-2025-10-10',
                    },
                    body: JSON.stringify({
                        objective: `Find ${state} state public records law statutes, exemptions related to "${denialType}", segregability requirements, recent case law, response deadlines, and fee waiver provisions.`,
                        search_queries: searchQueries,
                        max_results: 10,
                        excerpts: { max_chars_per_result: 3000 },
                    }),
                    signal: AbortSignal.timeout(45_000),
                });

                if (parallelRes.ok) {
                    const parallelData = await parallelRes.json();
                    const results = parallelData?.search?.results || parallelData?.results || [];
                    searchResults = results.map(r => `[${r.title || 'No title'}] ${r.url || ''}\n${r.excerpt || r.snippets?.join('\n') || ''}`);
                    console.log(`Parallel search returned ${searchResults.length} results for ${state} ${denialType} law`);
                } else {
                    console.warn(`Parallel search failed (${parallelRes.status}):`, await parallelRes.text().catch(() => ''));
                }
            } catch (parallelErr) {
                console.warn('Parallel search error:', parallelErr.message);
            }
        }

        // Synthesize with Anthropic
        const searchContext = searchResults.length > 0
            ? `\n\nWEB SEARCH RESULTS:\n${searchResults.slice(0, 8).join('\n---\n')}`
            : '\n\n(No web search results available — use your training knowledge of state public records laws.)';

        try {
            if (!this.anthropic) {
                console.warn('Anthropic unavailable: ANTHROPIC_API_KEY not configured');
                return null;
            }
            const response = await this.anthropic.messages.create({
                model: process.env.CLAUDE_MODEL || 'claude-sonnet-4-6',
                max_tokens: 1500,
                messages: [{
                    role: 'user',
                    content: `You are a legal research expert specializing in state public records laws and FOIA litigation.${searchContext}\n\n${researchPrompt}`
                }],
            });
            const research = response.content[0].text?.trim() || '';
            console.log(`✅ Legal research complete via Parallel+Anthropic (${research.length} chars, ${searchResults.length} search results)`);
            return research;
        } catch (fallbackError) {
            console.error('Anthropic research synthesis failed:', fallbackError.message);
            return null;
        }
    }

    /**
     * Generate strategic denial rebuttal based on denial subtype
     */
    async generateDenialRebuttal(messageData, analysis, caseData, options = {}) {
        try {
            const agencyResponseText = this.getMessageBodyForPrompt(messageData);
            const denialSubtype = this.inferDenialSubtype(messageData, analysis);
            console.log(`Evaluating denial rebuttal for case: ${caseData.case_name}, subtype: ${denialSubtype}`);
            const { adjustmentInstruction, lessonsContext, examplesContext, correspondenceContext, legalResearchOverride, rebuttalSupportPoints, forceDraft = false } = options;
            const userSignature = await this.getUserSignatureForCase(caseData);
            const requesterName = userSignature?.name || process.env.REQUESTER_NAME || 'Requester';
            const requesterTitle = userSignature?.title || process.env.REQUESTER_TITLE || '';
            const correspondenceSection = correspondenceContext
                ? `\n\n## Full Correspondence Thread (most recent last)\n${correspondenceContext}\n\nIMPORTANT: Your response MUST be consistent with the thread above. Acknowledge any prior replies and do NOT contradict what has already been communicated.`
                : '';

            // CHECK: Should we even rebuttal this?
            // Some "denials" are just process redirects - don't fight them
            const noRebuttalSubtypes = {
                'wrong_agency': 'Get correct agency contact info instead of arguing',
                'format_issue': 'Request alternative delivery or use their portal'
            };

            // Only suppress rebuttal drafting on portal routes when this helper is being
            // used to decide whether we should reply at all. Once the pipeline has already
            // chosen SEND_REBUTTAL, we must generate the actual draft instead of returning
            // a no-reply sentinel that later becomes a fallback shell proposal.
            if (!forceDraft && analysis.portal_url) {
                console.log('Portal URL found - no rebuttal needed, use portal instead');
                return {
                    should_auto_reply: false,
                    reason: 'Portal available - use portal instead of arguing via email',
                    suggested_action: 'use_portal',
                    portal_url: analysis.portal_url
                };
            }

            // For "overly_broad" - check if this is really a fight worth having
            if (!forceDraft && denialSubtype === 'overly_broad') {
                // If they just asked us to narrow or use a portal, do that instead
                const bodyLower = agencyResponseText.toLowerCase();
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

            // Use pre-researched legal data if available, otherwise do fresh research
            const legalResearch = legalResearchOverride || await this.researchStateLaws(stateName, denialSubtype);
            const subtypeSpecificInstruction = denialSubtype === 'privacy_exemption'
                ? `**Privacy-Exemption Hard Requirements:**\n- Do NOT offer to narrow or phase the request unless the agency explicitly asked for narrowing.\n- Do NOT use phrases like "happy to narrow" or "proceed in phases."\n- You MUST ask for segregable non-exempt portions or a redacted copy.\n- You MUST say that comprehensive redactions are acceptable.\n- You MUST challenge any blanket withholding by requesting the specific exempt portions and an explanation of why segregation/redaction would be insufficient.`
                : denialSubtype === 'overly_broad'
                    ? `**Overbreadth Hard Requirements:**\n- You SHOULD offer a concrete narrowing or phased-production proposal.\n- Keep the narrowing specific enough that the agency can act on it immediately.\n- Do not fight about exemptions unless the agency refuses a reasonable narrowed request.`
                    : '';

            const prompt = `Generate a strategic FOIA denial rebuttal for this response:

**Denial Type:** ${strategy.name}
**Agency Response:** ${agencyResponseText}

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

${subtypeSpecificInstruction ? `${subtypeSpecificInstruction}

` : ''}${legalResearch ? `**Legal Research for ${stateName}:**
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
7. Is under 250 words (body content, not counting greeting/sign-off)

EMAIL FORMAT (required):
- Start with a greeting addressing the person who responded (use their name if available from the correspondence, otherwise "Records Custodian")
- Include a brief intro sentence referencing our original request and their response/denial
- Then the rebuttal content
- End with sign-off using requester settings:
  - Name: ${requesterName}
  - Title: ${requesterTitle || '(none)'}
  - Do NOT invent or hardcode company/person names
${rebuttalSupportPoints && rebuttalSupportPoints.length > 0 ? `\n**Pre-Researched Support Points (use these):**\n${rebuttalSupportPoints.map((p, i) => `${i + 1}. ${p}`).join('\n')}` : ''}
${lessonsContext || ''}${examplesContext || ''}${adjustmentInstruction ? `\nADDITIONAL INSTRUCTIONS: ${adjustmentInstruction}` : ''}${correspondenceSection}
Return ONLY the email body text, no subject line.`;

            const rebuttalResult = await this.callAI(
                `${denialResponsePrompts.denialRebuttalSystemPrompt}\n\n${prompt}`,
                { effort: 'medium', includeMetadata: true }
            );
            const rebuttalText = rebuttalResult.text;
            let normalizedRebuttalText = this.normalizeGeneratedDraftSignature(rebuttalText, userSignature, { includeEmail: false, includeAddress: false });

            if (this.shouldUseNoContactClosureTemplate(agencyResponseText, denialSubtype, normalizedRebuttalText)) {
                normalizedRebuttalText = this.buildNoContactClosureRebuttalTemplate(messageData, caseData, userSignature);
            }

            if (this.shouldUseCertificationBarrierTemplate(agencyResponseText, normalizedRebuttalText)) {
                normalizedRebuttalText = this.buildCertificationBarrierRebuttalTemplate(messageData, caseData, userSignature);
            }

            if (denialSubtype === 'privacy_exemption' && this.shouldUsePrivacyExemptionTemplateFallback(normalizedRebuttalText)) {
                normalizedRebuttalText = this.buildPrivacyExemptionTemplate(messageData, caseData, userSignature);
            }

            console.log(`✅ Generated ${denialSubtype} rebuttal (${normalizedRebuttalText.length} chars) with GPT-5`);

            const shortReference = this.getShortCaseReference(caseData);

            // Normalize output format: always return { subject, body_text, body_html }
            return {
                subject: `RE: Public Records Request - ${shortReference}`,
                body_text: normalizedRebuttalText,
                body_html: null,
                // Metadata
                should_auto_reply: true,
                confidence: 0.85, // High confidence for strategic rebuttals
                denial_subtype: denialSubtype,
                is_denial_rebuttal: true,
                modelMetadata: rebuttalResult.modelMetadata,
            };
        } catch (error) {
            console.error('Error generating denial rebuttal:', error);
            throw error;
        }
    }

    /**
     * Research whether a better portal/contact exists before first follow-up
     */
    async researchAlternateContacts(caseData, inboundMessageBody = null) {
        try {
            const inboundContext = inboundMessageBody
                ? `\n\n## Recent Agency Response (may contain referral information)\n${inboundMessageBody}\n\nIMPORTANT: If the agency response above contains a referral to another agency with specific contact info (email, phone, URL), prioritize that information. The agency is telling us exactly who to contact.\n`
                : '';

            const prompt = `You are assisting with a public records (FOIA) automation system. Before sending the first follow-up, research whether there is a better official contact or online portal for this agency.

Agency name: ${caseData.agency_name}
Current email on file: ${caseData.agency_email}
Current portal URL (may be inaccurate): ${caseData.portal_url || 'none provided'}
Jurisdiction: ${caseData.state}
Incident or case title: ${caseData.case_name}
${inboundContext}
Your tasks:
1. Determine if there is an official FOIA/Public Records portal for this agency (GovQA, NextRequest, JustFOIA, or similar). Only provide links that allow online request submission.
2. If no reliable portal exists, identify the best direct records/email contact published by the agency.
3. Note any instructions or requirements (account creation, portal names, etc.).

Return a JSON object with:
{
  "portal_url": string | null,
  "portal_provider": string | null,
  "contact_email": string | null,
  "contact_phone": string | null,
  "confidence": number between 0 and 1,
  "notes": string
}

If nothing better is found, set the relevant fields to null but explain in notes.
Respond with JSON ONLY.`;

            // Use Firecrawl search + Anthropic synthesis
            let searchContext = '';
            const firecrawlApiKey = process.env.FIRECRAWL_API_KEY;

            if (firecrawlApiKey) {
                try {
                    const query = `${caseData.agency_name} ${caseData.state} public records FOIA portal contact email phone`;
                    const firecrawlRes = await fetch('https://api.firecrawl.dev/v1/search', {
                        method: 'POST',
                        headers: {
                            'Authorization': `Bearer ${firecrawlApiKey}`,
                            'Content-Type': 'application/json',
                        },
                        body: JSON.stringify({ query, limit: 6 }),
                        signal: AbortSignal.timeout(30_000),
                    });
                    if (firecrawlRes.ok) {
                        const firecrawlData = await firecrawlRes.json();
                        const results = firecrawlData?.data || [];
                        if (results.length > 0) {
                            const formatted = results.map(r => `[${r.title || r.metadata?.title || 'No title'}] ${r.url || ''}\n${r.description || r.markdown?.substring(0, 2000) || ''}`);
                            searchContext = `\n\nWEB SEARCH RESULTS:\n${formatted.join('\n---\n')}`;
                            console.log(`Firecrawl returned ${results.length} results for alternate contacts of "${caseData.agency_name}"`);
                        }
                    } else {
                        console.warn(`Firecrawl alternate contacts search failed (${firecrawlRes.status})`);
                    }
                } catch (fcErr) {
                    console.warn('Firecrawl alternate contacts error:', fcErr.message);
                }
            }

            if (!this.anthropic) {
                console.warn('Anthropic unavailable for alternate contacts');
                return null;
            }

            let raw;
            try {
                const response = await this.anthropic.messages.create({
                    model: process.env.CLAUDE_MODEL || 'claude-sonnet-4-6',
                    max_tokens: 800,
                    messages: [{ role: 'user', content: prompt + searchContext }],
                });
                raw = response.content[0].text?.trim();
            } catch (anthropicError) {
                console.warn('Anthropic alternate contacts failed:', anthropicError.message);
                return null;
            }

            if (!raw) {
                return null;
            }

            try {
                return JSON.parse(raw);
            } catch (parseError) {
                // Try extracting JSON from markdown code blocks
                const jsonMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
                if (jsonMatch) {
                    try { return JSON.parse(jsonMatch[1].trim()); } catch {}
                }
                console.error('Failed to parse alternate contact research JSON:', parseError.message, raw.substring(0, 200));
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
            const {
                adjustmentInstruction,
                lessonsContext,
                examplesContext,
                correspondenceContext,
                statusInquiry = false,
            } = options;

            const tone = followUpCount === 0 ? 'polite and professional' : 'firm but professional';
            const stateDeadline = await db.getStateDeadline(caseData.state);
            const deadlineDays = stateDeadline?.response_days || 10;

            const correspondenceSection = correspondenceContext
                ? `\n\n## Full Correspondence Thread (most recent last)\n${correspondenceContext}\n\nIMPORTANT: Your response MUST be consistent with the thread above. If the agency has already responded, do NOT claim they haven't responded. Acknowledge any prior replies.`
                : '';

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
${correspondenceSection}

The email should:
1. Reference the original request
2. Mention the state law deadline
3. Be ${tone}
4. Request a status update
5. Restate our interest in the records
${followUpCount > 0 ? '6. Note this is a follow-up and we\'re still awaiting response' : ''}
${lessonsContext || ''}${examplesContext || ''}${adjustmentInstruction ? `\nADDITIONAL INSTRUCTIONS: ${adjustmentInstruction}` : ''}
Return ONLY the email body text.`;

            const followupResult = await this.callAI(
                `${responseHandlingPrompts.followUpSystemPrompt}\n\n${prompt}`,
                { effort: 'medium', includeMetadata: true }
            );
            const bodyText = statusInquiry
                ? this.sanitizeStatusInquiryDraft(followupResult.text)
                : followupResult.text;
            const userSignature = await this.getUserSignatureForCase(caseData);
            const normalizedBodyText = this.normalizeGeneratedDraftSignature(bodyText, userSignature, {
                includeEmail: false,
                includeAddress: false,
                includePhone: !statusInquiry,
            });

            // Normalize output format: always return { subject, body_text, body_html }
            return {
                subject: `Follow-up: Public Records Request - ${caseData.subject_name || 'Request'}`,
                body_text: normalizedBodyText,
                body_html: null,
                modelMetadata: followupResult.modelMetadata,
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
            recommendedAction = 'negotiate', // accept | negotiate | decline | waiver
            instructions = null,
            lessonsContext = '',
            examplesContext = '',
            correspondenceContext = '',
            agencyMessage = null,
            agencyAnalysis = null
        } = options;
        const correspondenceSection = correspondenceContext
            ? `\n\n## Full Correspondence Thread (most recent last)\n${correspondenceContext}\n\nIMPORTANT: Your response MUST be consistent with the thread above. Acknowledge any prior replies and do NOT contradict what has already been communicated.`
            : '';

        // feeAmount may be unknown when agency asks "do you want to proceed?"
        // without quoting a specific dollar figure. Allow all actions to proceed.

        // Get short reference for correspondence
        const shortReference = this.getShortCaseReference(caseData);

        const actionGuidance = {
            accept: 'Politely accept the cost, confirm willingness to pay, and request next steps for invoice/payment.',
            negotiate: 'Propose narrowing the scope to reduce the number of videos and cost. Focus on: (1) limiting to the primary responding officer(s) and arresting officer(s) only, (2) proposing a tighter time window around the incident, (3) asking what the agency needs to identify the most critical footage — such as whether a police report or incident number can help narrow it. If the agency already provided an itemized fee breakdown, do NOT re-ask for it — acknowledge their breakdown and use it to propose a specific narrowed scope. Also request a public/media interest fee waiver citing state statute. Do NOT suggest in-person viewing or inspection — we are a remote team and cannot visit in person.',
            decline: 'Explain the fee exceeds budget, request fee waiver or narrowing help, and keep door open for partial fulfillment.',
            escalate: 'Flag that the fee far exceeds norms, request supervisor review, and cite public interest considerations.',
            waiver: 'Request a full fee waiver citing documentary journalism public interest. Cite state statute requiring fee waivers for public interest requests. Note that this request is for documentary production investigating police accountability, which primarily benefits the general public. If a waiver is not granted, request the statutory basis for denial of the waiver.'
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
Quoted fee: ${feeAmount ? `${currency} ${typeof feeAmount === 'number' ? feeAmount.toFixed(2) : feeAmount}` : 'No specific amount quoted by agency'}
Recommended action: ${recommendedAction.toUpperCase()}
${agencyMessage ? `\nAgency's full response:\n${this.stripQuotedText(getCanonicalMessageText(agencyMessage)).substring(0, 500)}` : ''}
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
${lessonsContext}${examplesContext}${correspondenceSection}
Email requirements:
1. Reference the request using the SHORT case reference ("${shortReference}") - NOT the full case name
2. If a fee amount was quoted, mention it explicitly. If no specific amount was quoted, acknowledge the agency's fee terms without inventing a number
3. Do NOT re-ask for an itemized breakdown if the agency already provided one — acknowledge it and use it
4. Do NOT suggest in-person viewing or in-office inspection — we are a remote team
5. Keep tone professional, collaborative, and human-sounding
6. Keep under 200 words

Return ONLY the email body, no greetings beyond what belongs in the email.`;

        try {
            if (recommendedAction === 'accept') {
                const userSignature = await this.getUserSignatureForCase(caseData);
                const feeLabel = feeAmount
                    ? `${currency} ${typeof feeAmount === 'number' ? feeAmount.toFixed(2) : feeAmount}`
                    : 'the quoted fee';
                const deterministicBody = [
                    `To ${caseData.agency_name || 'Records Unit'},`,
                    '',
                    `I received your fee estimate of ${feeLabel}. Please proceed with processing this request up to ${feeLabel}.`,
                    `If the total cost will exceed ${feeLabel}, please let me know before incurring any additional charges.`,
                    '',
                    'Thank you,',
                    userSignature?.name || 'Requester',
                ].join('\n');
                const normalizedBodyText = this.normalizeGeneratedDraftSignature(
                    deterministicBody,
                    userSignature,
                    { includeEmail: false, includeAddress: false, includePhone: false }
                );
                return {
                    subject: 'RE: Fee Authorization',
                    body_text: normalizedBodyText,
                    body_html: null,
                    model: 'deterministic-fee-accept-template',
                    recommended_action: recommendedAction,
                    modelMetadata: {
                        modelId: 'deterministic-fee-accept-template',
                        promptTokens: 0,
                        completionTokens: 0,
                        latencyMs: 0,
                    },
                };
            }
            const feeResult = await this.callAI(
                `${responseHandlingPrompts.autoReplySystemPrompt}\n\n${prompt}`,
                { effort: 'medium', includeMetadata: true }
            );
            const bodyText = feeResult.text;
            const userSignature = await this.getUserSignatureForCase(caseData);
            const normalizedBodyText = this.normalizeGeneratedDraftSignature(bodyText, userSignature, { includeEmail: false, includeAddress: false, includePhone: false });

            // Normalize output format: always return { subject, body_text, body_html }
            return {
                subject: `RE: Fee Response - ${shortReference}`,
                body_text: normalizedBodyText,
                body_html: null,
                // Metadata
                model: 'gpt-5.2-2025-12-11',
                recommended_action: recommendedAction,
                modelMetadata: feeResult.modelMetadata,
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
     * Legacy adaptive-learning outcomes are disabled.
     * We keep the method as a no-op until the old service is fully archived.
     */
    async recordOutcomeForLearning(caseData, analysis, messageData) {
        return;
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
            const model = 'gpt-5.2-2025-12-11';
            const response = await this._withExternalCallTrace(
                this._buildTraceContext({ caseId: caseData?.id }, {
                    provider: 'openai',
                    operation: 'generate_phone_call_briefing',
                    endpoint: 'responses.create',
                    method: 'sdk',
                    model,
                    requestSummary: {
                        model,
                        agency_name: caseData?.agency_name || phoneTask?.agency_name || null,
                        case_name: caseData?.case_name || null,
                    },
                }),
                async () => {
                    const response = await this.openai.responses.create({
                        model,
                        reasoning: { effort: 'medium' },
                        input: prompt
                    });
                    return {
                        value: response,
                        responseSummary: {
                            id: response.id,
                            model,
                            status: response.status,
                        },
                        model,
                    };
                }
            );

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
     * Suggest next step after a phone call based on outcome and notes.
     */
    async suggestNextStepAfterCall({ outcome, notes, checked_points, case_name, agency_name, case_status }) {
        try {
            const prompt = `You are helping manage a FOIA case after a phone call. Based on the call outcome and notes, suggest the single best next step.

Case: ${case_name || 'Unknown'} (agency: ${agency_name || 'Unknown'}, current status: ${case_status || 'unknown'})
Call outcome: ${outcome}
Call notes: ${notes || 'No notes'}
${checked_points?.length ? `Talking points covered: ${checked_points.join(', ')}` : ''}

Respond with JSON:
{
  "next_action": "one of: SEND_FOLLOWUP_EMAIL, SEND_CLARIFICATION, WAIT_FOR_RESPONSE, ACCEPT_FEE, NEGOTIATE_FEE, CLOSE_CASE, ESCALATE, SEND_APPEAL, NARROW_SCOPE, RESUBMIT, CALL_AGAIN, NO_ACTION",
  "explanation": "brief explanation of why this is the right next step",
  "draft_notes": "if email action, brief outline of what the email should say based on the call"
}`;

            const model = 'gpt-4o-mini';
            const response = await this._withExternalCallTrace(
                this._buildTraceContext({}, {
                    provider: 'openai',
                    operation: 'suggest_next_step_after_call',
                    endpoint: 'responses.create',
                    method: 'sdk',
                    model,
                    requestSummary: {
                        model,
                        case_name,
                        agency_name,
                        outcome,
                    },
                }),
                async () => {
                    const response = await this.openai.responses.create({
                        model,
                        input: [{ role: 'user', content: prompt }],
                        text: { format: { type: 'json_object' } },
                    });
                    return {
                        value: response,
                        responseSummary: {
                            id: response.id,
                            model,
                            status: response.status,
                        },
                        model,
                    };
                }
            );

            const raw = response.output_text?.trim();
            const jsonMatch = raw.match(/\{[\s\S]*\}/);
            if (jsonMatch) {
                return JSON.parse(jsonMatch[0]);
            }
            return null;
        } catch (error) {
            console.warn('Error suggesting next step after call:', error.message);
            return null;
        }
    }

    /**
     * Summarize a phone call outcome into a concise conversation entry.
     * This is used to append call context into the case message thread.
     */
    async summarizePhoneCallForConversation({ outcome, notes, checked_points, case_name, agency_name }) {
        try {
            const prompt = `Summarize this FOIA phone call update for the case conversation log.

Case: ${case_name || 'Unknown'}
Agency: ${agency_name || 'Unknown'}
Outcome: ${outcome || 'unknown'}
Operator notes: ${notes || 'none'}
${checked_points?.length ? `Talking points covered: ${checked_points.join(', ')}` : ''}

Return JSON only:
{
  "summary": "2-4 sentence factual summary of what happened and what it means for the case",
  "key_points": ["short bullet", "short bullet"],
  "recommended_follow_up": "single sentence next step"
}`;

            const model = 'gpt-4o-mini';
            const response = await this._withExternalCallTrace(
                this._buildTraceContext({}, {
                    provider: 'openai',
                    operation: 'summarize_phone_call_for_conversation',
                    endpoint: 'responses.create',
                    method: 'sdk',
                    model,
                    requestSummary: {
                        model,
                        case_name,
                        agency_name,
                        outcome,
                    },
                }),
                async () => {
                    const response = await this.openai.responses.create({
                        model,
                        input: [{ role: 'user', content: prompt }],
                        text: { format: { type: 'json_object' } },
                    });
                    return {
                        value: response,
                        responseSummary: {
                            id: response.id,
                            model,
                            status: response.status,
                        },
                        model,
                    };
                }
            );

            const raw = response.output_text?.trim();
            const jsonMatch = raw?.match(/\{[\s\S]*\}/);
            if (jsonMatch) return JSON.parse(jsonMatch[0]);
            return null;
        } catch (error) {
            console.warn('Error summarizing phone call for conversation:', error.message);
            return null;
        }
    }

    /**
     * Triage a stuck case in needs_human_review.
     * Looks at case context, recent messages, and prior proposals to recommend the right action.
     */
    async triageStuckCase(caseData, messages = [], priorProposals = []) {
        const messagesSummary = messages.slice(0, 5).map(m => {
            const body = this.stripQuotedText(getCanonicalMessageText(m));
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
            const model = process.env.OPENAI_MODEL || 'gpt-5.2-2025-12-11';
            const response = await this._withExternalCallTrace(
                this._buildTraceContext({ caseId: caseData?.id }, {
                    provider: 'openai',
                    operation: 'triage_stuck_case',
                    endpoint: 'responses.create',
                    method: 'sdk',
                    model,
                    requestSummary: {
                        model,
                        agency_name: caseData?.agency_name || null,
                        case_name: caseData?.case_name || null,
                    },
                }),
                async () => {
                    const response = await this.openai.responses.create({
                        model,
                        reasoning: { effort: 'low' },
                        input: `You are a FOIA case triage specialist. Analyze cases and recommend the most appropriate next action. Return only valid JSON.\n\n${prompt}`
                    });
                    return {
                        value: response,
                        responseSummary: {
                            id: response.id,
                            model,
                            status: response.status,
                        },
                        model,
                    };
                }
            );

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

            const model = process.env.OPENAI_MODEL || 'gpt-5.2-2025-12-11';
            const response = await this._withExternalCallTrace(
                this._buildTraceContext({}, {
                    provider: 'openai',
                    operation: 'normalize_notion_case',
                    endpoint: 'responses.create',
                    method: 'sdk',
                    model,
                    requestSummary: {
                        model,
                        has_properties: Boolean(rawPayload?.properties),
                        has_full_text: Boolean(rawPayload?.full_text),
                    },
                }),
                async () => {
                    const response = await this.openai.responses.create({
                        model,
                        reasoning: { effort: 'low' },
                        text: { verbosity: 'low' },
                        input: `${systemPrompt}\n\nSchema:\n${schema}\n\n${prompt}`
                    });
                    return {
                        value: response,
                        responseSummary: {
                            id: response.id,
                            model,
                            status: response.status,
                        },
                        model,
                    };
                }
            );

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
     * Single cheap AI call that merges PD normalization + contact extraction.
     * Replaces the sequential normalizeNotionCase → extractContactsWithAI calls
     * inside processSinglePage() for faster imports.
     *
     * @param {Object} casePageProps - Prepared (plain-value) case page properties
     * @param {string} casePageContent - Plain text body from case page blocks
     * @param {Object} pdPageProps - Prepared (plain-value) PD page properties
     * @param {string} pdPageText - Plain text from PD page blocks
     * @returns {{ case_name, agency_name, state, incident_date, incident_location,
     *             records_requested, subject_name, additional_details, tags,
     *             portal_url, agency_email, records_officer, phone }}
     */
    async normalizeAndExtractContacts(casePageProps, casePageContent, pdPageProps, pdPageText) {
        try {
            if (!this.openai) throw new Error('OPENAI_API_KEY not configured');

            const systemPrompt = `You are a data extraction specialist. You will receive two Notion pages:
1. A CASE page (contains incident info: suspect name, date, location, records requested)
2. A POLICE DEPARTMENT page (contains agency contact info: emails, portal URLs, phone numbers, officers)

Extract ALL information that is explicitly present. Never fabricate data.

For contact info (portal_url, agency_email, phone, records_officer): extract ONLY from the POLICE DEPARTMENT page fields.
For case metadata (case_name, subject_name, incident_date, etc.): extract from BOTH pages but prefer the CASE page.

Return valid JSON matching the schema below. Use null for missing fields, [] for missing arrays.`;

            const schema = `{
  "case_name": string | null,
  "agency_name": string | null,
  "state": string | null,
  "incident_date": string | null,
  "incident_location": string | null,
  "records_requested": string[] (short descriptions),
  "subject_name": string | null,
  "additional_details": string | null,
  "tags": string[] (3-5 lowercase kebab-case tags e.g. "police-records", "body-camera"),
  "portal_url": string | null (FOIA portal URL from PD fields - govqa, nextrequest, mycusthelp, etc.),
  "agency_email": string | null (best email for records requests from PD fields),
  "records_officer": string | null,
  "phone": string | null
}`;

            const parts = [];
            if (casePageProps) {
                parts.push('=== CASE PAGE PROPERTIES ===\n' + JSON.stringify(casePageProps, null, 2));
            }
            if (casePageContent) {
                parts.push('=== CASE PAGE CONTENT ===\n' + casePageContent.substring(0, 3000));
            }
            if (pdPageProps) {
                parts.push('=== POLICE DEPARTMENT PAGE PROPERTIES ===\n' + JSON.stringify(pdPageProps, null, 2));
            }
            if (pdPageText) {
                parts.push('=== POLICE DEPARTMENT PAGE TEXT ===\n' + pdPageText.substring(0, 2000));
            }

            const prompt = parts.join('\n\n');

            const model = 'gpt-4o-mini';
            const response = await this._withExternalCallTrace(
                this._buildTraceContext({}, {
                    provider: 'openai',
                    operation: 'normalize_and_extract_contacts',
                    endpoint: 'chat.completions.create',
                    method: 'sdk',
                    model,
                    requestSummary: {
                        model,
                        has_case_page_props: Boolean(casePageProps),
                        has_case_page_content: Boolean(casePageContent),
                        has_pd_page_props: Boolean(pdPageProps),
                        has_pd_page_text: Boolean(pdPageText),
                    },
                }),
                async () => {
                    const response = await this.openai.chat.completions.create({
                        model,
                        messages: [
                            { role: 'system', content: systemPrompt },
                            { role: 'user', content: `Schema:\n${schema}\n\n${prompt}` }
                        ],
                        response_format: { type: 'json_object' },
                        temperature: 0
                    });
                    return {
                        value: response,
                        responseSummary: {
                            id: response.id,
                            model,
                        },
                        model,
                    };
                }
            );

            const rawText = response.choices?.[0]?.message?.content?.trim();
            if (!rawText) return null;

            let parsed;
            try {
                parsed = JSON.parse(rawText);
            } catch (parseErr) {
                console.warn('normalizeAndExtractContacts: JSON parse failed, returning null');
                return null;
            }

            // Validate essential structure
            if (typeof parsed !== 'object' || parsed === null) return null;

            // Normalize arrays
            if (parsed.records_requested && !Array.isArray(parsed.records_requested)) {
                parsed.records_requested = [parsed.records_requested].filter(Boolean);
            }
            if (!Array.isArray(parsed.records_requested)) parsed.records_requested = [];

            if (parsed.tags && !Array.isArray(parsed.tags)) {
                parsed.tags = [parsed.tags].filter(Boolean);
            }
            if (!Array.isArray(parsed.tags)) parsed.tags = [];

            return parsed;
        } catch (error) {
            console.warn('normalizeAndExtractContacts failed:', error.message);
            return null;
        }
    }

    /**
     * Generate clarification response for LangGraph
     * Used when agency requests more information
     */
    async generateClarificationResponse(message, analysis, caseData, options = {}) {
        const adjustmentInstruction = options.adjustmentInstruction || options.instruction || '';
        const lessonsContext = options.lessonsContext || '';
        const examplesContext = options.examplesContext || '';
        const clarificationResearch = options.clarificationResearch || '';
        const correspondenceContext = options.correspondenceContext || '';
        const userSignature = await this.getUserSignatureForCase(caseData);
        const requesterMailingAddress = this.formatInlineMailingAddress(userSignature?.address);
        const correspondenceSection = correspondenceContext
            ? `\n\n## Full Correspondence Thread (most recent last)\n${correspondenceContext}\n\nIMPORTANT: Your response MUST be consistent with the thread above. Acknowledge any prior replies and do NOT contradict what has already been communicated.`
            : '';

        const prompt = `You are responding to a public records request clarification from a government agency.

AGENCY MESSAGE:
${getCanonicalMessageText(message) || message.body || ''}

ORIGINAL REQUEST:
- Subject: ${caseData.subject_name || 'Unknown'}
- Agency: ${caseData.agency_name || 'Unknown'}
- Records Requested: ${Array.isArray(caseData.requested_records) ? caseData.requested_records.join(', ') : caseData.requested_records || 'Various records'}
- Incident Date: ${caseData.incident_date || 'Not specified'}
- Location: ${caseData.incident_location || 'Not specified'}
- Requester mailing address on file: ${requesterMailingAddress || 'NOT AVAILABLE'}
- Requester phone on file: ${userSignature?.phone || 'Not available'}

${clarificationResearch ? `PRE-RESEARCHED CONTEXT (use this to answer their question):\n${clarificationResearch}\n` : ''}
${adjustmentInstruction ? `USER ADJUSTMENT INSTRUCTION: ${adjustmentInstruction}` : ''}
${lessonsContext}${examplesContext}${correspondenceSection}
Generate a professional, helpful response that:
1. Directly addresses their specific questions or requests for clarification
2. Provides any additional details they need
3. Offers to narrow the scope if it would be helpful
4. Maintains a cooperative, professional tone
5. Keeps under 200 words
6. Do NOT claim any attachment is included unless attachments are explicitly being sent with this reply (avoid phrases like "attached", "enclosed", "included with this email").
7. Do NOT use placeholders like "[INSERT REQUESTER MAILING ADDRESS]" or "[Your Address]".
8. If a mailing address is requested and one is on file, include the exact mailing address from above. If none is on file, do not invent one and do not leave a placeholder.
9. Do NOT say a request form has already been completed, attached, or sent unless this reply is actually sending that form.
10. Do NOT include analysis/meta text like "Is a response needed?", "Suggested action", or any explanation to the operator. Output only the sendable email.

Return ONLY the email body text, no subject line or greetings beyond what belongs in the email.`;

        try {
            const clarificationResult = await this.callAI(
                `${responseHandlingPrompts.autoReplySystemPrompt}\n\n${prompt}`,
                { effort: 'medium', includeMetadata: true }
            );
            const bodyText = clarificationResult.text;
            let normalizedBodyText = this.normalizeGeneratedDraftSignature(bodyText, userSignature, { includeEmail: false, includeAddress: false });
            normalizedBodyText = this.sanitizeClarificationDraft(normalizedBodyText, userSignature);
            normalizedBodyText = this.stripDraftMetaPreamble(normalizedBodyText);
            if (this.shouldUseClarificationTemplateFallback(normalizedBodyText, message, caseData)) {
                normalizedBodyText = this.buildReasonablyDescribedClarificationTemplate(message, caseData, userSignature);
            }
            const subject = `RE: ${message.subject || caseData.case_name || 'Public Records Request'}`;

            return {
                subject: subject,
                body_text: normalizedBodyText,
                body_html: `<p>${normalizedBodyText.replace(/\n\n/g, '</p><p>').replace(/\n/g, '<br>')}</p>`,
                model: process.env.OPENAI_MODEL || 'gpt-5.2-2025-12-11',
                modelMetadata: clarificationResult.modelMetadata,
            };
        } catch (error) {
            console.error('Error generating clarification response:', error);
            throw error;
        }
    }

    /**
     * Generate a formal administrative appeal letter for a denial.
     * Used when the denial type warrants a formal appeal (Glomar, privilege, etc.)
     */
    async generateAppealLetter(messageData, analysis, caseData, options = {}) {
        try {
            const { adjustmentInstruction, lessonsContext, examplesContext, correspondenceContext, legalResearchOverride, rebuttalSupportPoints } = options;
            const correspondenceSection = correspondenceContext
                ? `\n\n## Full Correspondence Thread (most recent last)\n${correspondenceContext}\n\nIMPORTANT: Your appeal MUST be consistent with the thread above. Reference specific prior correspondence where relevant.`
                : '';
            const denialSubtype = analysis?.denial_subtype || 'general';
            const stateDeadline = await db.getStateDeadline(caseData.state);
            const stateName = stateDeadline?.state_name || caseData.state;
            const legalResearch = legalResearchOverride || await this.researchStateLaws(stateName, denialSubtype);

            const prompt = `Generate a formal administrative appeal of a FOIA/public records denial.

**This is a FORMAL APPEAL, not a casual rebuttal.** It should:
- Reference the original request and denial
- Cite the specific appeal procedures and deadlines for ${stateName}
- Identify the appeal authority (supervisor, AG, public access counselor, etc.)
- Present legal arguments for why the denial was improper
- Request a Vaughn index or privilege log if applicable
- Be firm, professional, and legally precise

**Denial Details:**
- Denial type: ${denialSubtype}
- Agency: ${caseData.agency_name}
- State: ${stateName}
- Agency response: ${this.getMessageBodyForPrompt(messageData).substring(0, 500)}

${legalResearch ? `**Legal Research for ${stateName}:**\n${legalResearch}` : ''}
${rebuttalSupportPoints && rebuttalSupportPoints.length > 0 ? `\n**Support Points:**\n${rebuttalSupportPoints.map((p, i) => `${i + 1}. ${p}`).join('\n')}` : ''}

**Case Context:**
- Subject: ${caseData.subject_name}
- Records requested: ${Array.isArray(caseData.requested_records) ? caseData.requested_records.join(', ') : caseData.requested_records}
- Incident date: ${caseData.incident_date || 'Unknown'}

${lessonsContext || ''}${examplesContext || ''}${adjustmentInstruction ? `\nADDITIONAL INSTRUCTIONS: ${adjustmentInstruction}` : ''}${correspondenceSection}

Generate a formal appeal letter under 300 words. Return ONLY the letter body, no subject line.`;

            const appealResult = await this.callAI(
                `${denialResponsePrompts.denialRebuttalSystemPrompt}\n\n${prompt}`,
                { effort: 'medium', includeMetadata: true }
            );
            const bodyText = appealResult.text;
            const userSignature = await this.getUserSignatureForCase(caseData);
            const normalizedBodyText = this.normalizeGeneratedDraftSignature(bodyText, userSignature, { includeEmail: false, includeAddress: false });

            return {
                subject: `Administrative Appeal - ${caseData.subject_name || caseData.case_name || 'Records Request'}`,
                body_text: normalizedBodyText,
                body_html: null,
                is_appeal: true,
                denial_subtype: denialSubtype,
                modelMetadata: appealResult.modelMetadata,
            };
        } catch (error) {
            console.error('Error generating appeal letter:', error);
            throw error;
        }
    }

    /**
     * Generate fee acceptance response for LangGraph
     * Used when auto-approving or human-approving a fee quote
     */
    async generateFeeAcceptance(caseData, feeAmount, options = {}) {
        const adjustmentInstruction = options.adjustmentInstruction || options.instruction || '';
        const examplesContext = options.examplesContext || '';
        const currency = options.currency || 'USD';

        const prompt = `Generate a professional response accepting a fee quote for a public records request.

CASE DETAILS:
- Subject: ${caseData.subject_name || 'Unknown'}
- Agency: ${caseData.agency_name || 'Unknown'}
- State: ${caseData.state || 'Unknown'}
- Fee Amount: $${typeof feeAmount === 'number' ? feeAmount.toFixed(2) : feeAmount}

${adjustmentInstruction ? `USER ADJUSTMENT INSTRUCTION: ${adjustmentInstruction}` : ''}
${examplesContext}

The response should:
1. Confirm acceptance of the quoted fee amount
2. Ask about payment method (check, money order, credit card, etc.)
3. Request an invoice or mailing address if payment by mail is required
4. Be brief and professional (under 150 words)
5. Express appreciation for their assistance

Return ONLY the email body text, no subject line or greetings beyond what belongs in the email.`;

        try {
            const bodyText = await this.callAI(
                `${responseHandlingPrompts.autoReplySystemPrompt}\n\n${prompt}`,
                { effort: 'medium' }
            );
            const userSignature = await this.getUserSignatureForCase(caseData);
            const normalizedBodyText = this.normalizeGeneratedDraftSignature(bodyText, userSignature, { includeEmail: false, includeAddress: false });
            const subject = `RE: Fee Acceptance - ${caseData.subject_name || caseData.case_name || 'Records Request'}`;

            return {
                subject: subject,
                body_text: normalizedBodyText,
                body_html: `<p>${normalizedBodyText.replace(/\n\n/g, '</p><p>').replace(/\n/g, '<br>')}</p>`,
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
        const agencyName = caseData.agency_name || 'Unknown agency';
        const state = caseData.state || 'Unknown';
        const location = caseData.incident_location || 'Unknown';
        const records = Array.isArray(caseData.requested_records) ? caseData.requested_records.join(', ') : caseData.requested_records || 'Various records';

        const parallelApiKey = process.env.PARALLEL_API_KEY;
        const firecrawlApiKey = process.env.FIRECRAWL_API_KEY;

        // Strategy: Use Parallel search for web research, then have AI synthesize.
        // Firecrawl handles contact lookup separately in pd-contact-service.
        try {
            let searchResults = [];

            // --- Parallel Search ---
            if (parallelApiKey) {
                try {
                    const searchObjective = `Find the correct government agency that handles public records requests (FOIA/open records) for: ${records}. Location: ${location}, ${state}. The agency "${agencyName}" denied or had no responsive records. Find alternative agencies in the same jurisdiction that likely hold these records. Include agency names, email addresses, phone numbers, and any online records request portals.`;
                    const searchQueries = [
                        `${location} ${state} public records request ${records} agency`,
                        `${agencyName} ${state} FOIA records custodian contact email`,
                        `${state} ${location} police records open records request portal`,
                    ];

                    const parallelRes = await fetch('https://api.parallel.ai/v1beta/search', {
                        method: 'POST',
                        headers: {
                            'x-api-key': parallelApiKey,
                            'Content-Type': 'application/json',
                            'parallel-beta': 'search-extract-2025-10-10',
                        },
                        body: JSON.stringify({
                            objective: searchObjective,
                            search_queries: searchQueries,
                            max_results: 10,
                            excerpts: { max_chars_per_result: 3000 },
                        }),
                        signal: AbortSignal.timeout(30_000),
                    });

                    if (parallelRes.ok) {
                        const parallelData = await parallelRes.json();
                        const results = parallelData?.search?.results || parallelData?.results || [];
                        searchResults = results.map(r => `[${r.title || 'No title'}] ${r.url || ''}\n${r.excerpt || r.snippets?.join('\n') || ''}`);
                        console.log(`Parallel search returned ${searchResults.length} results for "${agencyName}"`);
                    } else {
                        console.warn(`Parallel search failed (${parallelRes.status}):`, await parallelRes.text().catch(() => ''));
                    }
                } catch (parallelErr) {
                    console.warn('Parallel search error:', parallelErr.message);
                }
            }

            // --- Firecrawl agent fallback if Parallel returned nothing ---
            if (searchResults.length === 0 && firecrawlApiKey) {
                try {
                    const firecrawlRes = await fetch('https://api.firecrawl.dev/v1/search', {
                        method: 'POST',
                        headers: {
                            'Authorization': `Bearer ${firecrawlApiKey}`,
                            'Content-Type': 'application/json',
                        },
                        body: JSON.stringify({
                            query: `${location} ${state} ${records} public records FOIA request agency contact email portal`,
                            limit: 8,
                        }),
                        signal: AbortSignal.timeout(30_000),
                    });
                    if (firecrawlRes.ok) {
                        const firecrawlData = await firecrawlRes.json();
                        const results = firecrawlData?.data || [];
                        searchResults = results.map(r => `[${r.title || r.metadata?.title || 'No title'}] ${r.url || ''}\n${r.description || r.markdown?.substring(0, 2000) || ''}`);
                        console.log(`Firecrawl search returned ${searchResults.length} results for "${agencyName}"`);
                    } else {
                        console.warn(`Firecrawl search failed (${firecrawlRes.status})`);
                    }
                } catch (fcErr) {
                    console.warn('Firecrawl search error:', fcErr.message);
                }
            }

            // --- Synthesize with AI ---
            const searchContext = searchResults.length > 0
                ? `\n\nWEB SEARCH RESULTS:\n${searchResults.slice(0, 8).join('\n---\n')}`
                : '\n\n(No web search results available — use your knowledge of government agency structures.)';

            const synthesisPrompt = `You are a FOIA research specialist. A public records request was denied or returned "no responsive records."
Analyze which agency most likely holds these records and suggest alternatives.

CASE CONTEXT:
- Agency that denied: ${agencyName}
- State: ${state}
- Incident location: ${location}
- Subject: ${caseData.subject_name || 'Unknown'}
- Records requested: ${records}
- Incident date: ${caseData.incident_date || 'Unknown'}
- Additional details: ${(caseData.additional_details || '').substring(0, 500)}
${searchContext}

Based on the case context${searchResults.length > 0 ? ' and web search results' : ''}, determine:
1. Why this agency likely had no records (wrong jurisdiction, records held by different unit, etc.)
2. Which specific agencies likely hold these records
3. Contact information found (emails, portals, phone numbers)

Return JSON:
{
  "summary": "Brief explanation of why the denial occurred and where records probably are",
  "suggested_agencies": [
    { "name": "Agency Name", "reason": "Why they might have it", "confidence": 0.0-1.0 }
  ],
  "research_notes": "Additional context about jurisdictional issues",
  "next_steps": "Recommended course of action"
}

Return ONLY valid JSON.`;

            let raw;
            if (this.anthropic) {
                const response = await this.anthropic.messages.create({
                    model: process.env.CLAUDE_MODEL || 'claude-sonnet-4-6',
                    max_tokens: 1500,
                    messages: [{ role: 'user', content: synthesisPrompt }],
                });
                raw = response.content[0].text?.trim();
            } else {
                const response = await this.openai.responses.create({
                    model: process.env.OPENAI_MODEL || 'gpt-5.2-2025-12-11',
                    reasoning: { effort: 'medium' },
                    input: synthesisPrompt,
                }, { signal: AbortSignal.timeout(45_000) });
                raw = response.output_text?.trim();
            }

            const jsonMatch = raw.match(/\{[\s\S]*\}/);
            if (jsonMatch) {
                return JSON.parse(jsonMatch[0]);
            }
            throw new Error('Failed to parse agency research JSON');
        } catch (error) {
            console.error('Error generating agency research brief:', error);
            return {
                researchFailed: true,
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
    async generateReformulatedRequest(caseData, denialAnalysis, options = {}) {
        const denialContext = denialAnalysis?.full_analysis_json || denialAnalysis || {};
        const keyPoints = denialContext.key_points || [];
        const examplesContext = options.examplesContext || '';

        // Load requester info for signature
        const userSignature = await this.getUserSignatureForCase(caseData);
        const requesterName = userSignature?.name || process.env.REQUESTER_NAME || 'Requester';
        const requesterTitle = userSignature?.title || process.env.REQUESTER_TITLE || '';
        const requesterEmail = userSignature?.email || process.env.SENDGRID_FROM_EMAIL || '';

        const prompt = `You are a FOIA request strategist. A previous request was denied or had an excessive fee. Generate a NEW, reformulated FOIA request
that approaches the same records from a different angle or with narrower scope.

ORIGINAL REQUEST CONTEXT:
- Agency: ${caseData.agency_name}
- State: ${caseData.state || 'Unknown'}
- Subject: ${caseData.subject_name || 'Unknown'}
- Records originally requested: ${Array.isArray(caseData.requested_records) ? caseData.requested_records.join(', ') : caseData.requested_records || 'Various records'}
- Incident date: ${caseData.incident_date || 'Unknown'}
- Incident location: ${caseData.incident_location || 'Unknown'}

DENIAL/FEE DETAILS:
- Denial subtype: ${denialContext.denial_subtype || 'unknown'}
- Key points: ${keyPoints.join('; ')}
- Summary: ${denialContext.summary || 'No summary available'}

REQUESTER INFO (use these exact details — do NOT use placeholders):
- Name: ${requesterName}
- Title: ${requesterTitle}
- Email: ${requesterEmail}

REFORMULATION STRATEGY:
- If "no CCTV/BWC records" → request incident/dispatch reports, CAD logs, or 911 calls instead
- If "overly broad" or fee too high → narrow by specific dates, times, officers, or record types
- If "no records for that address" → try broader location description or different record category
- Use different terminology that may match agency filing systems
- Keep request specific enough to avoid "overly broad" but broad enough to capture relevant records
- Cite applicable state public records law
- Sign with the requester's real name and title above — NEVER use [Your Name] or similar placeholders
${examplesContext}

Return JSON:
{
  "subject": "New email subject line for the reformulated request",
  "body_text": "Full email body text of the new FOIA request",
  "body_html": null,
  "strategy_notes": "Brief explanation of how this differs from the original request"
}

Return ONLY valid JSON.`;

        try {
            const model = process.env.OPENAI_MODEL || 'gpt-5.2-2025-12-11';
            const { response, startedAt } = await this._withExternalCallTrace(
                this._buildTraceContext({ caseId: caseData?.id }, {
                    provider: 'openai',
                    operation: 'generate_reformulated_request',
                    endpoint: 'responses.create',
                    method: 'sdk',
                    model,
                    requestSummary: {
                        model,
                        agency_name: caseData?.agency_name || null,
                        subject_name: caseData?.subject_name || null,
                    },
                }),
                async () => {
                    const startedAt = Date.now();
                    const response = await this.openai.responses.create({
                        model,
                        reasoning: { effort: 'medium' },
                        text: { verbosity: 'medium' },
                        input: prompt
                    });
                    return {
                        value: { response, startedAt },
                        responseSummary: {
                            id: response.id,
                            model,
                            status: response.status,
                        },
                        model,
                        metadata: {
                            prompt_tokens: response.usage?.input_tokens || response.usage?.prompt_tokens || null,
                            completion_tokens: response.usage?.output_tokens || response.usage?.completion_tokens || null,
                        },
                    };
                }
            );

            const raw = response.output_text?.trim();
            const jsonMatch = raw.match(/\{[\s\S]*\}/);
            if (jsonMatch) {
                const result = JSON.parse(jsonMatch[0]);
                // Catch any remaining placeholder patterns
                if (result.body_text) {
                    result.body_text = this.normalizeGeneratedDraftSignature(result.body_text, userSignature, { includeEmail: true, includeAddress: false });
                }
                result.modelMetadata = buildModelMetadata({
                    response,
                    usage: response.usage,
                    startedAt,
                });
                return result;
            }
            throw new Error('Failed to parse reformulated request JSON');
        } catch (error) {
            console.error('Error generating reformulated request:', error);
            throw error;
        }
    }
}

module.exports = new AIService();
