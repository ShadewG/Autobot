const crypto = require('crypto');
const db = require('../../services/database');
const actionValidator = require('../../services/action-validator');
const logger = require('../../services/logger');
const triggerDispatch = require('../../services/trigger-dispatch-service');
const { cleanEmailBody, htmlToPlainText } = require('../../lib/email-cleaner');
const { getCanonicalMessageText } = require('../../lib/message-normalization');
const { resolveReviewState } = require('../../lib/resolve-review-state');
const { normalizePortalUrl, isSupportedPortalUrl } = require('../../utils/portal-utils');
const {
    normalizePortalTimeoutSubstatus,
    deriveDisplayState,
    extractResearchSuggestedAgency,
    extractMetadataAgencyHint,
    isGenericAgencyLabel,
    isNotionReferenceList,
    isPlaceholderAgencyEmail,
} = require('../../utils/request-normalization');

function isSingleNotionReference(value = '') {
    const normalized = String(value || '').trim().replace(/-/g, '').toLowerCase();
    return /^[a-f0-9]{32}$/.test(normalized);
}

function resolveDisplayAgencyName(caseData) {
    const rawAgencyName = String(caseData.agency_name || '').trim();
    if (!rawAgencyName) return '—';

    const metadataAgencyHint = extractMetadataAgencyHint(caseData.additional_details);
    if (
        (isSingleNotionReference(rawAgencyName) || isNotionReferenceList(rawAgencyName) || isGenericAgencyLabel(rawAgencyName))
        && metadataAgencyHint?.name
    ) {
        return metadataAgencyHint.name;
    }

    return rawAgencyName;
}

function normalizeImportWarnings(importWarnings) {
    if (!Array.isArray(importWarnings)) return importWarnings || null;
    const filtered = importWarnings.filter((warning) => {
        const message = String(warning?.message || '');
        return !/placeholder\.invalid/i.test(message);
    });
    return filtered.length > 0 ? filtered : null;
}

function hasMissingImportDeliveryPath(caseData) {
    const importWarnings = Array.isArray(caseData?.import_warnings) ? caseData.import_warnings : [];
    const warningTypes = new Set(
        importWarnings
            .map((warning) => String(warning?.type || '').trim().toUpperCase())
            .filter(Boolean)
    );
    const agencyEmail = String(caseData?.agency_email || '').trim().toLowerCase();
    const portalUrl = normalizePortalUrl(caseData?.portal_url);

    return Boolean(
        !portalUrl &&
        (
            isPlaceholderAgencyEmail(agencyEmail) ||
            warningTypes.has('MISSING_DELIVERY_PATH') ||
            warningTypes.has('MISSING_EMAIL')
        )
    );
}

/**
 * Status mapping from database to API format (UPPER_SNAKE_CASE)
 */
const STATUS_MAP = {
    'draft': 'DRAFT',
    'ready_to_send': 'READY_TO_SEND',
    'sent': 'AWAITING_RESPONSE',
    'awaiting_response': 'AWAITING_RESPONSE',
    'responded': 'RECEIVED_RESPONSE',
    'completed': 'CLOSED',
    'error': 'NEEDS_HUMAN_REVIEW',
    'needs_human_review': 'NEEDS_HUMAN_REVIEW',
    'needs_contact_info': 'NEEDS_CONTACT_INFO',
    'needs_human_fee_approval': 'NEEDS_HUMAN_FEE_APPROVAL',
    'portal_in_progress': 'AWAITING_RESPONSE',
    'needs_phone_call': 'NEEDS_PHONE_CALL',
    'needs_rebuttal': 'NEEDS_REBUTTAL',
    'pending_fee_decision': 'PENDING_FEE_DECISION',
    'id_state': 'ID_STATE'
};

const REVIEW_DB_STATUSES = new Set([
    'needs_human_review',
    'needs_human_fee_approval',
    'needs_contact_info',
    'needs_phone_call',
    'needs_rebuttal',
    'pending_fee_decision',
]);

/**
 * Generate AI outcome summary when a case is closed.
 * Summarizes what happened, why it was closed, and the result.
 */
async function generateOutcomeSummary(caseId, caseData, closeInstruction) {
    try {
        const messages = await db.getMessagesByCaseId(caseId);
        const proposals = await db.getAllProposalsByCaseId(caseId);

        const inboundCount = messages.filter(m => m.direction === 'inbound').length;
        const outboundCount = messages.filter(m => m.direction === 'outbound').length;
        const lastInbound = messages.filter(m => m.direction === 'inbound').pop();

        // Build outcome context
        const parts = [];
        parts.push(`Agency: ${caseData.agency_name || 'Unknown'} (${caseData.state || '?'})`);
        parts.push(`Subject: ${caseData.subject_name || caseData.case_name || 'Unknown'}`);
        parts.push(`Records requested: ${Array.isArray(caseData.requested_records) ? caseData.requested_records.join(', ') : caseData.requested_records || 'Unknown'}`);
        parts.push(`Messages: ${outboundCount} sent, ${inboundCount} received`);

        if (caseData.outcome_type) {
            parts.push(`Outcome: ${caseData.outcome_type.replace(/_/g, ' ')}`);
        }

        if (caseData.fee_quote_jsonb?.amount) {
            parts.push(`Fee: $${caseData.fee_quote_jsonb.amount}`);
        }

        const lastInboundBody = getCanonicalMessageText(lastInbound);
        if (lastInboundBody) {
            const preview = lastInboundBody.substring(0, 300);
            parts.push(`Last agency response: ${preview}`);
        }

        if (closeInstruction) {
            parts.push(`Close reason: ${closeInstruction}`);
        }

        // Use OpenAI to generate a concise summary
        const OpenAI = require('openai');
        const openai = new OpenAI();
        const completion = await openai.chat.completions.create({
            model: 'gpt-4o-mini',
            messages: [{
                role: 'system',
                content: 'You summarize the outcome of FOIA/public records requests in 1-2 sentences. Be specific about what happened (records received, denied, fee quoted, no response, etc). Do not use generic language.'
            }, {
                role: 'user',
                content: parts.join('\n')
            }],
            max_tokens: 150,
        });

        const summary = completion.choices[0]?.message?.content?.trim();
        if (summary) {
            await db.updateCase(caseId, { outcome_summary: summary });

            // Sync summary to Notion
            try {
                const notionService = require('../../services/notion-service');
                await notionService.addAISummaryToNotion(caseId, summary);
            } catch (_) {}
        }
    } catch (err) {
        console.error(`Failed to generate outcome summary for case ${caseId}:`, err.message);
    }
}

/**
 * Derive cost_status from fee fields (supports both legacy columns and JSONB)
 */
function deriveCostStatus(caseData) {
    // Check JSONB first
    if (caseData.fee_quote_jsonb?.status) {
        return caseData.fee_quote_jsonb.status;
    }
    // Fall back to legacy columns
    if (!caseData.last_fee_quote_amount) return 'NONE';
    return 'QUOTED';
}

const STATE_RESPONSE_DAYS = {
    CA: 10, TX: 10, NY: 5, FL: 14, IL: 7, PA: 5, OH: 10, GA: 3, NC: 14, MI: 5,
    NJ: 7, VA: 5, WA: 5, AZ: 5, MA: 10, TN: 7, IN: 7, MO: 3, MD: 30, WI: 10,
    CO: 3, MN: 10, SC: 15, AL: 10, LA: 3, KY: 3, OR: 5, OK: 3, CT: 4, UT: 10,
    IA: 10, NV: 5, AR: 3, MS: 7, KS: 3, NM: 15, NE: 4, ID: 3, WV: 5, HI: 10,
    NH: 5, ME: 5, MT: 5, RI: 10, DE: 15, SD: 5, ND: 5, AK: 10, DC: 15, VT: 3,
    WY: 5,
    DEFAULT: 10,
};

/**
 * Build due_info object from case data.
 *
 * Dynamic statutory clock:
 * - Anchor is latest known correspondence baseline (last_response_date, else send_date)
 * - Statutory due is anchor + state response days
 * - Explicit workflow due dates (next_due_at from follow-up/snooze) take precedence
 */
function buildDueInfo(caseData) {
    const dueInfo = caseData.due_info_jsonb || {};

    const stateCode = String(caseData.state || '').toUpperCase();
    const statutoryDays = Number.isFinite(Number(dueInfo.statutory_days))
        ? Number(dueInfo.statutory_days)
        : (STATE_RESPONSE_DAYS[stateCode] || STATE_RESPONSE_DAYS.DEFAULT);

    const statutoryAnchor = caseData.last_response_date || caseData.send_date || null;
    let dynamicStatutoryDueAt = null;
    if (statutoryAnchor && statutoryDays) {
        const anchorDate = new Date(statutoryAnchor);
        if (!Number.isNaN(anchorDate.getTime())) {
            anchorDate.setDate(anchorDate.getDate() + statutoryDays);
            dynamicStatutoryDueAt = anchorDate.toISOString();
        }
    }

    const explicitNextDueAt = caseData.next_due_at || null;
    const fallbackStatutoryDueAt = dynamicStatutoryDueAt || dueInfo.statutory_due_at || caseData.deadline_date || null;
    const nextDueAt = explicitNextDueAt || fallbackStatutoryDueAt;

    const inferredDueType = dueInfo.due_type
        || (explicitNextDueAt ? 'FOLLOW_UP' : (fallbackStatutoryDueAt ? 'STATUTORY' : null));

    // Calculate overdue status
    let isOverdue = false;
    let overdueDays = null;
    if (nextDueAt) {
        const dueDate = new Date(nextDueAt);
        const now = new Date();
        if (!Number.isNaN(dueDate.getTime()) && dueDate < now) {
            isOverdue = true;
            overdueDays = Math.floor((now - dueDate) / (1000 * 60 * 60 * 24));
        }
    }

    return {
        next_due_at: nextDueAt,
        due_type: inferredDueType,
        statutory_days: statutoryDays || null,
        statutory_due_at: fallbackStatutoryDueAt,
        snoozed_until: dueInfo.snoozed_until || null,
        is_overdue: isOverdue,
        overdue_days: overdueDays
    };
}

/**
 * Parse scope items from JSONB or derive from requested_records
 * Normalizes format to use 'name' (frontend expects 'name', some backend uses 'item')
 */
function parseScopeItems(caseData) {
    // Use JSONB if available
    if (caseData.scope_items_jsonb && Array.isArray(caseData.scope_items_jsonb) && caseData.scope_items_jsonb.length > 0) {
        // Normalize: some sources use 'item', frontend expects 'name'
        return caseData.scope_items_jsonb.map(si => ({
            name: si.name || si.item || 'Unknown Item',
            status: si.status || 'REQUESTED',
            reason: si.reason || null,
            confidence: si.confidence
        }));
    }

    // Derive from requested_records array
    if (Array.isArray(caseData.requested_records)) {
        return caseData.requested_records.map(name => ({
            name,
            status: 'REQUESTED'
        }));
    }

    return [];
}

function safeJsonParse(value) {
    if (!value) return null;
    if (typeof value === 'object') return value;
    if (typeof value !== 'string') return null;
    try {
        return JSON.parse(value);
    } catch (_) {
        return null;
    }
}

function normalizeAgencyNameKey(agencyName = '') {
    return String(agencyName || '')
        .toLowerCase()
        .replace(/,\s*[a-z]{2}$/i, '')
        .replace(/,\s*(alabama|alaska|arizona|arkansas|california|colorado|connecticut|delaware|district of columbia|florida|georgia|hawaii|idaho|illinois|indiana|iowa|kansas|kentucky|louisiana|maine|maryland|massachusetts|michigan|minnesota|mississippi|missouri|montana|nebraska|nevada|new hampshire|new jersey|new mexico|new york|north carolina|north dakota|ohio|oklahoma|oregon|pennsylvania|rhode island|south carolina|south dakota|tennessee|texas|utah|vermont|virginia|washington|west virginia|wisconsin|wyoming)$/i, '')
        .replace(/[^a-z0-9\s]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function normalizeEmailKey(email = '') {
    const value = String(email || '').trim().toLowerCase().replace(/^mailto:/, '');
    return value || null;
}

function normalizePortalKey(portalUrl = '') {
    const normalized = normalizePortalUrl(portalUrl);
    return normalized && isSupportedPortalUrl(normalized) ? normalized.toLowerCase() : null;
}

function stripTrailingAgencyStateLabel(agencyName = '') {
    return String(agencyName || '')
        .replace(/,\s*[a-z]{2}$/i, '')
        .replace(/,\s*(alabama|alaska|arizona|arkansas|california|colorado|connecticut|delaware|district of columbia|florida|georgia|hawaii|idaho|illinois|indiana|iowa|kansas|kentucky|louisiana|maine|maryland|massachusetts|michigan|minnesota|mississippi|missouri|montana|nebraska|nevada|new hampshire|new jersey|new mexico|new york|north carolina|north dakota|ohio|oklahoma|oregon|pennsylvania|rhode island|south carolina|south dakota|tennessee|texas|utah|vermont|virginia|washington|west virginia|wisconsin|wyoming)$/i, '')
        .trim();
}

function dedupeCaseAgencies(caseAgencies = []) {
    const deduped = new Map();

    for (const agency of caseAgencies) {
        const nameKey = normalizeAgencyNameKey(agency?.agency_name);
        const emailKey = normalizeEmailKey(agency?.agency_email);
        const portalKey = normalizePortalKey(agency?.portal_url);
        const dedupeKey =
            [nameKey, emailKey, portalKey].filter(Boolean).join('|') ||
            `case-agency-${agency?.id ?? deduped.size + 1}`;

        const existing = deduped.get(dedupeKey);
        if (!existing) {
            deduped.set(dedupeKey, {
                ...agency,
                agency_email: emailKey ? String(agency.agency_email).trim() : agency.agency_email || null,
                portal_url: portalKey ? normalizePortalUrl(agency.portal_url) : null,
            });
            continue;
        }

        const existingUpdatedAt = new Date(existing.updated_at || existing.created_at || 0).getTime();
        const nextUpdatedAt = new Date(agency.updated_at || agency.created_at || 0).getTime();
        const preferred = nextUpdatedAt > existingUpdatedAt ? agency : existing;
        const fallback = preferred === agency ? existing : agency;

        deduped.set(dedupeKey, {
            ...preferred,
            is_primary: Boolean(existing.is_primary || agency.is_primary),
            is_active: existing.is_active !== false || agency.is_active !== false,
            agency_email: preferred.agency_email || fallback.agency_email || null,
            portal_url: normalizePortalUrl(preferred.portal_url || fallback.portal_url || null),
            portal_provider: preferred.portal_provider || fallback.portal_provider || null,
            notes: preferred.notes || fallback.notes || null,
            contact_research_notes: preferred.contact_research_notes || fallback.contact_research_notes || null,
        });
    }

    return Array.from(deduped.values());
}

function filterExistingAgencyCandidates(candidates = [], caseAgencies = [], requestContact = null) {
    const existingNames = new Set();
    const existingEmails = new Set();
    const existingPortals = new Set();

    for (const agency of caseAgencies) {
        const nameKey = normalizeAgencyNameKey(agency?.agency_name);
        const emailKey = normalizeEmailKey(agency?.agency_email);
        const portalKey = normalizePortalKey(agency?.portal_url);
        if (nameKey) existingNames.add(nameKey);
        if (emailKey) existingEmails.add(emailKey);
        if (portalKey) existingPortals.add(portalKey);
    }

    if (requestContact) {
        const requestNameKey = normalizeAgencyNameKey(requestContact.agency_name);
        const requestEmailKey = normalizeEmailKey(requestContact.agency_email);
        const requestPortalKey = normalizePortalKey(requestContact.portal_url);
        if (requestNameKey) existingNames.add(requestNameKey);
        if (requestEmailKey) existingEmails.add(requestEmailKey);
        if (requestPortalKey) existingPortals.add(requestPortalKey);
    }

    return candidates.filter((candidate) => {
        const candidateNameKey = normalizeAgencyNameKey(candidate?.name);
        const candidateEmailKey = normalizeEmailKey(candidate?.agency_email);
        const candidatePortalKey = normalizePortalKey(candidate?.portal_url);

        if (candidateEmailKey && existingEmails.has(candidateEmailKey)) return false;
        if (candidatePortalKey && existingPortals.has(candidatePortalKey)) return false;
        if (!candidateNameKey) return true;

        if (!existingNames.has(candidateNameKey)) {
            return true;
        }

        return Boolean(candidateEmailKey && !existingEmails.has(candidateEmailKey))
            || Boolean(candidatePortalKey && !existingPortals.has(candidatePortalKey));
    });
}

function extractLatestSupportedPortalUrl(activityRows = [], caseAgencies = [], ...rawValues) {
    const candidates = [];

    for (const row of activityRows) {
        if (!row) continue;
        const metadata = row.metadata && typeof row.metadata === 'object' ? row.metadata : row.meta_jsonb;
        if (metadata && typeof metadata === 'object' && metadata.portal_url) {
            candidates.push(metadata.portal_url);
        }
    }

    for (const agency of caseAgencies) {
        if (agency?.portal_url) {
            candidates.push(agency.portal_url);
        }
    }

    candidates.push(...rawValues);

    for (const rawValue of candidates) {
        const normalized = normalizePortalUrl(rawValue);
        if (normalized && isSupportedPortalUrl(normalized)) {
            return normalized;
        }
    }

    return null;
}

function normalizeThreadBody(text, caseData = null) {
    if (!text) return text || '';

    let normalized = String(text);
    const preferredPortalUrl = normalizePortalUrl(caseData?.portal_url || caseData?.last_portal_task_url || null);

    normalized = normalized.replace(
        /(Portal URL:\s*)(https?:\/\/\S+)/gi,
        (match, prefix, rawUrl) => {
            const supportedUrl = normalizePortalUrl(rawUrl);
            if (supportedUrl && isSupportedPortalUrl(supportedUrl)) {
                return `${prefix}${supportedUrl}`;
            }
            if (preferredPortalUrl) {
                return `${prefix}${preferredPortalUrl}`;
            }
            return `${prefix}[tracked portal link redacted]`;
        }
    );

    const canonicalAgencyName = stripTrailingAgencyStateLabel(caseData?.agency_name || '');
    if (
        canonicalAgencyName
        && !/stow police department/i.test(canonicalAgencyName)
        && /stow police department/i.test(normalized)
    ) {
        normalized = normalized.replace(/Stow Police Department/gi, canonicalAgencyName);
    }

    return normalized;
}

function extractAgencyCandidatesFromResearchNotes(contactResearchNotes) {
    const parsed = safeJsonParse(contactResearchNotes);
    if (!parsed || typeof parsed !== 'object') return [];

    const candidates = [];
    const brief = parsed.brief && typeof parsed.brief === 'object' ? parsed.brief : null;
    const contact = parsed.contactResult && typeof parsed.contactResult === 'object' ? parsed.contactResult : null;

    if (brief && Array.isArray(brief.suggested_agencies)) {
        for (const item of brief.suggested_agencies) {
            if (!item || typeof item !== 'object') continue;
            if (!item.name) continue;
            candidates.push({
                name: item.name,
                reason: item.reason || null,
                confidence: item.confidence ?? null,
                source: 'suggested_agency',
                agency_email: null,
                portal_url: null,
                contact_phone: null,
            });
        }
    }

    if (contact && (contact.contact_email || contact.portal_url || contact.notes)) {
        // Do not attach generic contact lookup output to the first suggested agency.
        // If the lookup did not include an explicit agency name, this will misbind
        // current-agency contact info (e.g. Milford) onto a different suggestion
        // (e.g. Dickinson County SO).
        const contactName =
            (typeof contact.agency_name === 'string' && contact.agency_name.trim())
            || (typeof contact.name === 'string' && contact.name.trim())
            || null;

        if (contactName) {
            candidates.push({
                name: contactName,
                reason: contact.notes || null,
                confidence: contact.confidence ?? null,
                source: contact.source || 'contact_research',
                agency_email: contact.contact_email || null,
                portal_url: contact.portal_url || null,
                contact_phone: contact.contact_phone || null,
            });
        }
    }

    const fallbackSuggestedAgency = extractResearchSuggestedAgency(contactResearchNotes);
    if (fallbackSuggestedAgency) {
        candidates.push({
            name: fallbackSuggestedAgency.name,
            reason: fallbackSuggestedAgency.reason || null,
            confidence: fallbackSuggestedAgency.confidence ?? null,
            source: fallbackSuggestedAgency.source || 'research_suggestion',
            agency_email: null,
            portal_url: null,
            contact_phone: null,
        });
    }

    const deduped = new Map();
    for (const c of candidates) {
        const key = String(c.name || '').trim().toLowerCase() || `candidate-${deduped.size + 1}`;
        const prev = deduped.get(key);
        if (!prev) {
            deduped.set(key, c);
            continue;
        }
        // Merge richer candidate details
        deduped.set(key, {
            ...prev,
            reason: prev.reason || c.reason,
            confidence: prev.confidence ?? c.confidence,
            source: prev.source || c.source,
            agency_email: prev.agency_email || c.agency_email,
            portal_url: prev.portal_url || c.portal_url,
            contact_phone: prev.contact_phone || c.contact_phone,
        });
    }

    return Array.from(deduped.values()).sort((a, b) => {
        const ac = typeof a.confidence === 'number' ? a.confidence : -1;
        const bc = typeof b.confidence === 'number' ? b.confidence : -1;
        return bc - ac;
    });
}

/**
 * Parse constraints from JSONB.
 * Normalizes both plain string constraints (legacy) and full objects
 * into { type, description, source, confidence, affected_items } shape.
 */
// Known constraint types with human-readable labels
const CONSTRAINT_LABELS = {
    FEE_REQUIRED: 'Fee payment required',
    PREPAYMENT_REQUIRED: 'Prepayment required before records are released',
    CASH_OR_CHECK_ONLY: 'Payment by cash or check only',
    CERTIFICATION_REQUIRED: 'Certification or notarized statement required',
    CERTIFICATION_NO_FINANCIAL_GAIN_REQUIRED: 'Must certify records are not for financial gain',
    NO_FINANCIAL_GAIN_CERT_REQUIRED: 'Must certify records are not for financial gain',
    CERTIFICATION_REQUIRED_NONCOMMERCIAL_USE: 'Must certify non-commercial use of records',
    EXEMPTION: 'Agency claimed an exemption',
    BWC_EXEMPT: 'Body-worn camera footage exempt',
    NOT_HELD: 'Agency states records are not held',
    RECORDS_NOT_HELD: 'Agency states records are not held',
    REDACTION_REQUIRED: 'Records require redaction before release',
    ID_REQUIRED: 'Photo ID or identity verification required',
    INVESTIGATION_ACTIVE: 'Active investigation — records may be delayed or withheld',
    PARTIAL_DENIAL: 'Some records denied, others may be available',
    DENIAL_RECEIVED: 'Agency denied the request',
    IN_PERSON_VIEWING_OPTION: 'In-person viewing/inspection available',
    IN_PERSON_INSPECTION_OPTION: 'In-person viewing/inspection available',
    VIEW_IN_PERSON_OPTION: 'In-person viewing/inspection available',
    SCOPE_NARROWING_SUGGESTED: 'Agency suggests narrowing scope',
    SCOPE_NARROW_SUGGESTED: 'Agency suggests narrowing scope',
    SCOPE_NARROWING_OPTION: 'Agency suggests narrowing scope',
    RESPONSE_DEADLINE: 'Response deadline applies',
    DEADLINE_10_BUSINESS_DAYS: 'Must respond within 10 business days',
    RESPONSE_DEADLINE_10_BUSINESS_DAYS: 'Must respond within 10 business days',
    WITHDRAWAL_IF_NO_RESPONSE_10_BUSINESS_DAYS: 'Auto-withdrawal after 10 business days without response',
    AUTO_WITHDRAW_10_BUSINESS_DAYS: 'Auto-withdrawal after 10 business days without response',
    FEE_ESTIMATE_PROVIDED: 'Fee estimate provided',
};

// Collapse duplicate/variant constraint types to a canonical form
const CONSTRAINT_CANONICAL = {
    RECORDS_NOT_HELD: 'NOT_HELD',
    NO_FINANCIAL_GAIN_CERT_REQUIRED: 'CERTIFICATION_NO_FINANCIAL_GAIN_REQUIRED',
    CERTIFICATION_REQUIRED_NONCOMMERCIAL_USE: 'CERTIFICATION_NO_FINANCIAL_GAIN_REQUIRED',
    IN_PERSON_INSPECTION_OPTION: 'IN_PERSON_VIEWING_OPTION',
    VIEW_IN_PERSON_OPTION: 'IN_PERSON_VIEWING_OPTION',
    SCOPE_NARROW_SUGGESTED: 'SCOPE_NARROWING_SUGGESTED',
    SCOPE_NARROWING_OPTION: 'SCOPE_NARROWING_SUGGESTED',
    DEADLINE_10_BUSINESS_DAYS: 'RESPONSE_DEADLINE_10_BUSINESS_DAYS',
    RESPONSE_DEADLINE: 'RESPONSE_DEADLINE_10_BUSINESS_DAYS',
    AUTO_WITHDRAW_10_BUSINESS_DAYS: 'WITHDRAWAL_IF_NO_RESPONSE_10_BUSINESS_DAYS',
    FEE_ESTIMATE_PROVIDED: 'FEE_REQUIRED', // redundant when FEE_REQUIRED is present
};

function parseConstraints(caseData) {
    if (!caseData.constraints_jsonb || !Array.isArray(caseData.constraints_jsonb)) {
        return [];
    }

    const seen = new Set();
    const results = [];

    for (const c of caseData.constraints_jsonb) {
        let constraint;
        if (c && typeof c === 'object' && c.type) {
            constraint = c;
        } else {
            const type = typeof c === 'string' ? c : 'UNKNOWN';
            constraint = {
                type,
                description: CONSTRAINT_LABELS[type] || type.replace(/_/g, ' ').toLowerCase(),
                source: 'Agency response',
                confidence: 1.0,
                affected_items: [],
            };
        }

        // Canonicalize to collapse duplicates
        const canonical = CONSTRAINT_CANONICAL[constraint.type] || constraint.type;
        if (seen.has(canonical)) continue;
        seen.add(canonical);

        // Use canonical type's label if available
        constraint.type = canonical;
        if (CONSTRAINT_LABELS[canonical]) {
            constraint.description = CONSTRAINT_LABELS[canonical];
        }

        results.push(constraint);
    }

    return results;
}

/**
 * Parse fee quote from JSONB or legacy columns
 */
function parseFeeQuote(caseData) {
    // Use JSONB if available
    if (caseData.fee_quote_jsonb && caseData.fee_quote_jsonb.amount) {
        return caseData.fee_quote_jsonb;
    }

    // Fall back to legacy columns
    if (caseData.last_fee_quote_amount) {
        return {
            amount: parseFloat(caseData.last_fee_quote_amount),
            currency: caseData.last_fee_quote_currency || 'USD',
            quoted_at: caseData.last_fee_quote_at,
            status: 'QUOTED'
        };
    }

    return null;
}

/**
 * Check if request is at risk (due within 48 hours)
 */
function isAtRisk(nextDueAt) {
    if (!nextDueAt) return false;
    const dueDate = new Date(nextDueAt);
    const now = new Date();
    const hoursUntilDue = (dueDate - now) / (1000 * 60 * 60);
    return hoursUntilDue <= 48 && hoursUntilDue > 0;
}

/**
 * Canonical case control state for UI.
 * Read-only derivation: no state mutations.
 */
function resolveControlState({ caseData, reviewState, pendingProposal, activeRun, activePortalTaskStatus }) {
    const caseStatus = String(caseData?.status || '').toLowerCase();
    const runStatus = String(activeRun?.status || '').toLowerCase();
    const hasActiveRun = ['created', 'queued', 'processing', 'running', 'waiting'].includes(runStatus);
    const portalStatus = String(activePortalTaskStatus || '').toUpperCase();
    const portalActive = portalStatus === 'PENDING' || portalStatus === 'IN_PROGRESS';
    const hasPendingProposal = Boolean(pendingProposal && ['PENDING_APPROVAL', 'BLOCKED', 'DECISION_RECEIVED', 'PENDING_PORTAL'].includes(String(pendingProposal.status || '').toUpperCase()));
    const pauseReason = String(caseData?.pause_reason || '').toUpperCase();
    const substatus = String(caseData?.substatus || '').trim();
    const isManualHandoffReview =
        caseStatus === 'needs_phone_call' ||
        caseStatus === 'needs_contact_info' ||
        pauseReason === 'RESEARCH_HANDOFF' ||
        pauseReason === 'AGENCY_RESEARCH_COMPLETE' ||
        pauseReason === 'AGENT_RUN_FAILED' ||
        pauseReason === 'IMPORT_REVIEW' ||
        /placeholder notion page|imported case/i.test(substatus) ||
        (
            caseStatus === 'needs_human_review' &&
            pauseReason === 'UNSPECIFIED' &&
            /ready to send via (portal|email)/i.test(substatus)
        );

    if (['completed', 'cancelled'].includes(caseStatus)) return 'DONE';

    const mismatches = [];
    if (reviewState === 'DECISION_REQUIRED' && hasActiveRun && runStatus !== 'waiting') {
        mismatches.push('decision_required_with_active_execution');
    }
    if ((reviewState === 'PROCESSING' || reviewState === 'DECISION_APPLYING') && Boolean(caseData?.requires_human)) {
        mismatches.push('processing_while_requires_human_true');
    }
    if (portalActive && !hasActiveRun) {
        mismatches.push('portal_active_without_active_run');
    }
    if (reviewState === 'DECISION_REQUIRED' && !hasPendingProposal && runStatus !== 'waiting' && !isManualHandoffReview) {
        mismatches.push('decision_required_without_pending_proposal');
    }
    if (mismatches.length > 0) return 'OUT_OF_SYNC';

    if (reviewState === 'DECISION_REQUIRED') return 'NEEDS_DECISION';
    if (reviewState === 'PROCESSING' || reviewState === 'DECISION_APPLYING' || hasActiveRun || portalActive) return 'WORKING';
    if (reviewState === 'WAITING_AGENCY' || ['sent', 'awaiting_response', 'responded'].includes(caseStatus)) return 'WAITING_AGENCY';
    if (caseStatus === 'error') return 'BLOCKED';
    return 'BLOCKED';
}

function detectControlMismatches({ caseData, reviewState, pendingProposal, activeRun, activePortalTaskStatus }) {
    const issues = [];
    const caseStatus = String(caseData?.status || '').toLowerCase();
    const runStatus = String(activeRun?.status || '').toLowerCase();
    const hasActiveRun = ['created', 'queued', 'processing', 'running', 'waiting'].includes(runStatus);
    const portalStatus = String(activePortalTaskStatus || '').toUpperCase();
    const portalActive = portalStatus === 'PENDING' || portalStatus === 'IN_PROGRESS';
    const hasPendingProposal = Boolean(pendingProposal && ['PENDING_APPROVAL', 'BLOCKED', 'DECISION_RECEIVED', 'PENDING_PORTAL'].includes(String(pendingProposal.status || '').toUpperCase()));
    const pauseReason = String(caseData?.pause_reason || '').toUpperCase();
    const substatus = String(caseData?.substatus || '').trim();
    const isManualHandoffReview =
        caseStatus === 'needs_phone_call' ||
        caseStatus === 'needs_contact_info' ||
        pauseReason === 'RESEARCH_HANDOFF' ||
        pauseReason === 'AGENCY_RESEARCH_COMPLETE' ||
        pauseReason === 'AGENT_RUN_FAILED' ||
        pauseReason === 'IMPORT_REVIEW' ||
        /placeholder notion page|imported case/i.test(substatus) ||
        (
            caseStatus === 'needs_human_review' &&
            pauseReason === 'UNSPECIFIED' &&
            /ready to send via (portal|email)/i.test(substatus)
        );

    if ((reviewState === 'PROCESSING' || reviewState === 'DECISION_APPLYING') && Boolean(caseData?.requires_human)) {
        issues.push({
            code: 'processing_while_requires_human_true',
            message: 'Case marked requires_human while processing',
            severity: 'warning',
        });
    }
    if (reviewState === 'DECISION_REQUIRED' && hasActiveRun && runStatus !== 'waiting') {
        issues.push({
            code: 'decision_required_with_active_execution',
            message: 'Decision required while an execution run is active',
            severity: 'warning',
        });
    }
    if (reviewState === 'DECISION_REQUIRED' && !hasPendingProposal && runStatus !== 'waiting' && !isManualHandoffReview) {
        issues.push({
            code: 'decision_required_without_pending_proposal',
            message: 'Decision required but no pending proposal found',
            severity: 'warning',
        });
    }
    if (portalActive && !hasActiveRun) {
        issues.push({
            code: 'portal_active_without_active_run',
            message: 'Portal task marked active with no active run',
            severity: 'warning',
        });
    }

    return issues;
}

/**
 * Transform case data to RequestListItem format
 */
function toRequestListItem(caseData) {
    const normalizedSubstatus = normalizePortalTimeoutSubstatus(caseData.substatus || null);
    const displayAgencyName = resolveDisplayAgencyName(caseData);
    const displayState = deriveDisplayState(caseData.state, displayAgencyName);
    const subject = caseData.subject_name
        ? `${caseData.subject_name}${caseData.requested_records?.length ? ` — ${Array.isArray(caseData.requested_records) ? caseData.requested_records.slice(0, 2).join(', ') : 'Records Request'}` : ''}`
        : caseData.case_name || 'Unknown Request';

    const dueInfo = buildDueInfo(caseData);
    const feeQuote = parseFeeQuote(caseData);

    // Derive review_state from available lateral join data
    let review_state = resolveReviewState({
        caseData,
        activeProposal: caseData.active_proposal_status
            ? { status: caseData.active_proposal_status }
            : null,
        activeRun: caseData.active_run_status
            ? { status: caseData.active_run_status }
            : null,
    });

    const activeRun = caseData.active_run_status
        ? { status: caseData.active_run_status }
        : null;
    const activeProposal = caseData.active_proposal_status
        ? { status: caseData.active_proposal_status }
        : null;

    let control_state = resolveControlState({
        caseData,
        reviewState: review_state,
        pendingProposal: activeProposal,
        activeRun,
        activePortalTaskStatus: caseData.active_portal_task_status || null,
    });
    let control_mismatches = detectControlMismatches({
        caseData,
        reviewState: review_state,
        pendingProposal: activeProposal,
        activeRun,
        activePortalTaskStatus: caseData.active_portal_task_status || null,
    });

    let effectiveDbStatus = String(caseData.status || '').toLowerCase();
    const missingImportDeliveryPath = hasMissingImportDeliveryPath(caseData) && !activeProposal && !activeRun;
    if (
        REVIEW_DB_STATUSES.has(effectiveDbStatus) &&
        !Boolean(caseData.requires_human) &&
        review_state !== 'DECISION_REQUIRED'
    ) {
        if (review_state === 'PROCESSING' || review_state === 'DECISION_APPLYING') {
            effectiveDbStatus = 'ready_to_send';
        } else {
            effectiveDbStatus = 'awaiting_response';
        }
    }
    if (missingImportDeliveryPath) {
        effectiveDbStatus = 'needs_human_review';
        review_state = 'IDLE';
        control_state = 'BLOCKED';
        control_mismatches = [];
    }
    // Use derived review/control state as the UI source of truth so stale
    // requires_human flags in DB don't hide blocked manual work.
    const effectiveRequiresHuman =
        review_state === 'DECISION_REQUIRED' ||
        (control_state === 'BLOCKED' && REVIEW_DB_STATUSES.has(effectiveDbStatus));
    const effectivePauseReason = effectiveRequiresHuman
        ? (caseData.pause_reason || null)
        : null;

    return {
        id: String(caseData.id),
        subject: subject,
        agency_name: displayAgencyName,
        state: displayState || '—',
        status: STATUS_MAP[effectiveDbStatus] || 'DRAFT',
        last_inbound_at: caseData.last_response_date || null,
        last_activity_at: caseData.updated_at || caseData.created_at,
        next_due_at: dueInfo.next_due_at,
        due_info: dueInfo,
        requires_human: effectiveRequiresHuman,
        pause_reason: effectivePauseReason,
        autopilot_mode: caseData.autopilot_mode || 'SUPERVISED',
        cost_status: deriveCostStatus(caseData),
        cost_amount: feeQuote?.amount || null,
        at_risk: isAtRisk(dueInfo.next_due_at),
        outcome_type: caseData.outcome_type || null,
        outcome_summary: caseData.outcome_summary || null,
        closed_at: caseData.closed_at || null,
        substatus: normalizedSubstatus,
        active_run_status: caseData.active_run_status || null,
        active_run_trigger_type: caseData.active_run_trigger_type || null,
        active_run_started_at: caseData.active_run_started_at || null,
        active_run_trigger_run_id: caseData.active_run_trigger_run_id || null,
        active_portal_task_status: caseData.active_portal_task_status || null,
        active_portal_task_type: caseData.active_portal_task_type || null,
        review_state,
        control_state,
        control_mismatches,
    };
}

async function attachActivePortalTask(caseData) {
    if (!caseData?.id) return caseData;
    const result = await db.query(
        `SELECT status, action_type
         FROM portal_tasks
         WHERE case_id = $1
           AND status IN ('PENDING', 'IN_PROGRESS')
         ORDER BY updated_at DESC, id DESC
         LIMIT 1`,
        [caseData.id]
    );
    const active = result.rows[0] || null;
    return {
        ...caseData,
        active_portal_task_status: active?.status || null,
        active_portal_task_type: active?.action_type || null,
    };
}

/**
 * Detect review reason from case data when requires_human is true.
 * Uses pause_reason first, then infers from substatus/status.
 */
function detectReviewReason(caseData) {
    // Map pause_reason directly if set
    const pauseReason = (caseData.pause_reason || '').toUpperCase();
    if (pauseReason === 'FEE_QUOTE') return 'FEE_QUOTE';
    if (pauseReason === 'DENIAL') return 'DENIAL';
    if (pauseReason.includes('PHONE') || pauseReason.includes('CALL')) return 'PHONE_CALL';

    const substatus = (caseData.substatus || '').toLowerCase();
    const status = (caseData.status || '').toLowerCase();

    // Portal stuck/timeout indicators (swept from portal_in_progress)
    if (substatus.includes('portal') && substatus.includes('timed out')) return 'PORTAL_STUCK';

    // Portal failure indicators
    if (substatus.includes('portal') && (substatus.includes('fail') || substatus.includes('error'))) return 'PORTAL_FAILED';
    if (status === 'error' && caseData.portal_url) return 'PORTAL_FAILED';

    // Fee quote indicators
    if (substatus.includes('fee') || substatus.includes('quote') || substatus.includes('cost')) return 'FEE_QUOTE';
    if (caseData.last_fee_quote_amount) return 'FEE_QUOTE';

    // Denial indicators
    if (substatus.includes('denial') || substatus.includes('denied') || substatus.includes('reject')) return 'DENIAL';

    // Missing info indicators
    if (substatus.includes('missing') || substatus.includes('contact') || substatus.includes('info')) return 'MISSING_INFO';
    if (status === 'needs_contact_info') return 'MISSING_INFO';
    if (status === 'needs_phone_call' || substatus.includes('phone') || substatus.includes('call')) return 'PHONE_CALL';

    return 'GENERAL';
}

/**
 * Extract phone call plan from contact_research_notes.
 * Mirrors the logic in routes/monitor/overview.js so the case detail page
 * can display the same phone-call context as the gated queue.
 */
function extractPhoneCallPlan(rawNotes, row = {}) {
    if (!rawNotes) return null;
    let parsed = rawNotes;
    if (typeof rawNotes === 'string') {
        try { parsed = JSON.parse(rawNotes); } catch (_) { return null; }
    }
    if (!parsed || typeof parsed !== 'object') return null;

    const brief = parsed.brief || {};
    const execution = parsed.execution || {};
    const contact = parsed.contactResult || {};
    const suggested = Array.isArray(brief.suggested_agencies) ? brief.suggested_agencies : [];
    const topSuggested = suggested[0] || {};
    const target = execution.phone_call_target || {};
    const fallbackSuggestedAgency = extractResearchSuggestedAgency(rawNotes);
    const preferSuggestedAgencyName = isPlaceholderAgencyEmail(row.agency_email) && fallbackSuggestedAgency?.name;

    const agency_name =
        String(target.agency_name || '').trim() ||
        (preferSuggestedAgencyName ? String(fallbackSuggestedAgency.name || '').trim() : String(row.agency_name || '').trim()) ||
        String(contact.agency_name || contact.name || '').trim() ||
        String(topSuggested.name || '').trim() ||
        String(fallbackSuggestedAgency?.name || '').trim() ||
        null;
    const agency_phone =
        String(target.agency_phone || '').trim() ||
        String(contact.contact_phone || contact.phone || '').trim() ||
        null;
    const agency_email =
        (isPlaceholderAgencyEmail(row.agency_email)
            ? null
            : String(row.agency_email || '').trim()) ||
        String(contact.contact_email || contact.email || '').trim() ||
        null;
    const portal_url =
        String(row.portal_url || contact.portal_url || '').trim() || null;
    const reason =
        String(target.reason || '').trim() ||
        (execution.outcome === 'phone_fallback_no_new_channel'
            ? 'No new channels beyond existing case contacts; use phone follow-up'
            : null);

    if (!agency_name && !agency_phone && !agency_email && !portal_url && !reason) return null;
    return {
        agency_name,
        agency_phone,
        agency_email,
        portal_url,
        reason,
        outcome: execution.outcome || null,
        suggested_agency: topSuggested?.name || null,
    };
}

/**
 * Transform case data to RequestDetail format
 */
function toRequestDetail(caseData) {
    const normalizedSubstatus = normalizePortalTimeoutSubstatus(caseData.substatus || null);
    const listItem = toRequestListItem({
        ...caseData,
        substatus: normalizedSubstatus,
    });
    const scopeItems = parseScopeItems(caseData);
    const constraints = parseConstraints(caseData);
    const feeQuote = parseFeeQuote(caseData);

    // Build Notion URL from page ID
    const notionUrl = caseData.notion_page_id
        ? `https://notion.so/${caseData.notion_page_id.replace(/-/g, '')}`
        : null;

    return {
        ...listItem,
        case_name: caseData.case_name,
        incident_date: caseData.incident_date || null,
        incident_location: caseData.incident_location || null,
        requested_records: Array.isArray(caseData.requested_records)
            ? caseData.requested_records.join(', ')
            : caseData.requested_records || '',
        additional_details: caseData.additional_details || null,
        scope_summary: Array.isArray(caseData.requested_records)
            ? caseData.requested_records.slice(0, 3).join(', ')
            : caseData.requested_records || 'General records request',
        scope_items: scopeItems,
        constraints: constraints,
        fee_quote: feeQuote,
        portal_url: caseData.portal_url || null,
        portal_provider: caseData.portal_provider || null,
        portal_request_number: caseData.portal_request_number || null,
        last_portal_task_url: caseData.last_portal_task_url || null,
        last_portal_status: caseData.last_portal_status || null,
        last_portal_screenshot_url: caseData.last_portal_screenshot_url || null,
        agency_email: caseData.agency_email || null,
        notion_url: notionUrl,
        submitted_at: caseData.send_date || null,
        statutory_due_at: listItem.due_info.statutory_due_at,
        attachments: [], // Will be populated from messages
        substatus: normalizedSubstatus,
        review_reason: (caseData.requires_human || REVIEW_DB_STATUSES.has(String(caseData.status || '').toLowerCase()))
            ? detectReviewReason(caseData)
            : undefined,
        phone_call_plan: extractPhoneCallPlan(caseData.contact_research_notes, caseData),
        import_warnings: normalizeImportWarnings(caseData.import_warnings),
        last_notion_synced_at: caseData.last_notion_synced_at || null,
        tags: Array.isArray(caseData.tags) ? caseData.tags : [],
        priority: caseData.priority ?? 0,
    };
}

/**
 * Transform message to ThreadMessage format
 * Includes cleaned body (boilerplate removed) and raw_body (original)
 */
function toThreadMessage(message, attachments = [], caseData = null) {
    const sourceBody = getCanonicalMessageText(message) || (message.body_html ? htmlToPlainText(message.body_html) : '');
    const rawBody = normalizeThreadBody(sourceBody, caseData);
    const cleanedBody = cleanEmailBody(rawBody);
    const timestamp = message.sent_at || message.received_at || message.created_at;

    const meta = message.metadata || {};
    const caseAgencyIdRaw = meta.case_agency_id;
    const caseAgencyId = Number.isFinite(Number(caseAgencyIdRaw)) ? Number(caseAgencyIdRaw) : null;

    const messageType = String(message.message_type || '').toLowerCase();
    const isCallMessage = messageType === 'phone_call' || messageType === 'call';
    const contactInfo = typeof meta.contact_info === 'string' ? meta.contact_info.trim() : null;
    const contactPhoneRaw =
        (typeof meta.contact_phone === 'string' && meta.contact_phone.trim())
        || (typeof meta.agency_phone === 'string' && meta.agency_phone.trim())
        || null;
    const extractedPhoneFromInfo = !contactPhoneRaw && contactInfo
        ? (contactInfo.match(/(\+?\d[\d\s().-]{6,}\d)/)?.[1] || null)
        : null;
    const callPhone = contactPhoneRaw || extractedPhoneFromInfo;

    return {
        id: message.id,  // Numeric ID for API calls
        direction: message.direction === 'outbound' ? 'OUTBOUND' : 'INBOUND',
        channel: message.portal_notification ? 'PORTAL' : (isCallMessage ? 'CALL' : 'EMAIL'),
        message_type: messageType || null,
        portal_notification_type: message.portal_notification_type || null,
        from_email: message.from_email || '—',
        to_email: message.to_email || '—',
        subject: message.subject || '(No subject)',
        body: cleanedBody,
        raw_body: rawBody !== cleanedBody ? rawBody : undefined,
        sent_at: timestamp,
        timestamp: timestamp,  // Alias for convenience
        processed_at: message.processed_at || null,  // When this message was processed by the agent
        case_agency_id: caseAgencyId,
        email_thread_id: Number.isFinite(Number(message.thread_id)) ? Number(message.thread_id) : null,
        summary: message.summary || null,
        call_contact_info: isCallMessage ? contactInfo : null,
        call_phone: isCallMessage ? callPhone : null,
        attachments: attachments
    };
}

/**
 * Map event types to categories
 */
const EVENT_CATEGORY_MAP = {
    // Message transport + ingest
    'email_sent': 'MESSAGE',
    'email_send_failed': 'MESSAGE',
    'email_received': 'MESSAGE',
    'email_ingested': 'MESSAGE',
    'correspondence_logged': 'MESSAGE',
    'webhook_received': 'MESSAGE',
    'webhook_unmatched': 'MESSAGE',
    'webhook_portal_retry_matched': 'MESSAGE',

    // Case status / lifecycle
    'case_created': 'STATUS',
    'case_status_changed': 'STATUS',
    'case_completed_by_ai': 'STATUS',
    'request_withdrawn': 'STATUS',
    'scope_updated': 'STATUS',
    'scope_item_updated': 'STATUS',
    'followup_scheduled': 'STATUS',
    'followup_queued': 'STATUS',
    'followup_status_fixed': 'STATUS',
    'followup_max_reached': 'STATUS',

    // Cost / fee
    'fee_quote_received': 'COST',
    'fee_quote_detected': 'COST',
    'fee_response_prepared': 'COST',
    'fee_response_regenerated': 'COST',
    'fee_response_sent': 'COST',
    'fee_response_failed': 'COST',

    // Research / discovery / enrichment
    'constraint_detected': 'RESEARCH',
    'constraint_added': 'RESEARCH',
    'constraint_removed': 'RESEARCH',
    'exemption_researched': 'RESEARCH',
    'contact_research_completed': 'RESEARCH',
    'pd_contact_lookup': 'RESEARCH',
    'portal_research_email_found': 'RESEARCH',
    'portal_research_redirect': 'RESEARCH',
    'portal_research_failed': 'RESEARCH',
    'research_followup_proposed': 'RESEARCH',
    'decision_spin_detected': 'RESEARCH',
    'loop_detected': 'RESEARCH',

    // Human review / gates / proposals
    'denial_received': 'GATE',
    'gate_triggered': 'GATE',
    'approval_required': 'GATE',
    'human_decision': 'GATE',
    'human_review_decision': 'GATE',
    'human_review_proposal_created': 'GATE',
    'proposal_dismissed': 'GATE',
    'proposal_withdrawn': 'GATE',
    'proposal_dispatch_failed': 'GATE',
    'proposal_guided_reprocess': 'GATE',
    'action_blocked': 'GATE',

    // Agent run + execution
    'portal_submission': 'AGENT',
    'portal_submission_blocked': 'AGENT',
    'portal_submission_failed': 'AGENT',
    'portal_task_started': 'AGENT',
    'portal_task_completed': 'AGENT',
    'portal_task_failed': 'AGENT',
    'portal_run_completed': 'AGENT',
    'portal_run_failed': 'AGENT',
    'portal_scout_started': 'AGENT',
    'portal_scout_completed': 'AGENT',
    'portal_scout_failed': 'AGENT',
    'portal_notification': 'AGENT',
    'portal_confirmation_link': 'AGENT',
    'portal_retry_requested': 'AGENT',
    'portal_link_added': 'AGENT',
    'monitor_portal_trigger': 'AGENT',
    'agent_action_executed': 'AGENT',
    'proposal_executed': 'AGENT',
    'dispatch_run_created': 'AGENT',
    'agent_run_step': 'AGENT',
    'agent_run_started': 'AGENT',
    'agent_run_completed': 'AGENT',
    'agent_run_failed': 'AGENT',
    'agent_run_replayed': 'AGENT'
};

function mapTimelineCategory(eventType, meta = {}) {
    if (meta.category) return meta.category;
    if (EVENT_CATEGORY_MAP[eventType]) return EVENT_CATEGORY_MAP[eventType];
    if (eventType.startsWith('phone_')) return 'STATUS';
    if (eventType.startsWith('portal_')) return 'AGENT';
    if (eventType.startsWith('proposal_')) return 'GATE';
    if (eventType.startsWith('agent_')) return 'AGENT';
    if (eventType.startsWith('fee_')) return 'COST';
    if (eventType.startsWith('webhook_') || eventType.includes('email')) return 'MESSAGE';
    return 'STATUS';
}

function mapTimelineType(eventType, meta = {}) {
    // Handle dynamic mappings that depend on meta before the static map
    if (eventType === 'correspondence_logged') {
        return (meta.direction || '').toUpperCase() === 'OUTBOUND' ? 'SENT' : 'RECEIVED';
    }

    const explicitMap = {
        // Message lifecycle
        'email_sent': 'SENT',
        'manual_reply_sent': 'SENT',
        'email_received': 'RECEIVED',
        'email_ingested': 'RECEIVED',
        'webhook_received': 'RECEIVED',
        'webhook_unmatched': 'RECEIVED',
        'webhook_portal_retry_matched': 'RECEIVED',
        // Case lifecycle
        'case_created': 'CREATED',
        'case_status_changed': 'STATUS_CHANGED',
        'case_completed_by_ai': 'CASE_CLOSED',
        'request_withdrawn': 'CASE_WITHDRAWN',
        // Follow-up
        'followup_scheduled': 'FOLLOWUP_SCHEDULED',
        'followup_queued': 'FOLLOWUP_TRIGGERED',
        // Cost
        'fee_quote_received': 'FEE_QUOTE',
        'fee_quote_detected': 'FEE_QUOTE',
        'fee_response_sent': 'FEE_ACCEPTED',
        'fee_response_regenerated': 'FEE_NEGOTIATED',
        // Gate/proposal
        'gate_triggered': 'GATE_TRIGGERED',
        'approval_required': 'RUN_GATED',
        'human_decision': 'HUMAN_DECISION',
        'human_review_decision': 'HUMAN_DECISION',
        'human_review_proposal_created': 'PROPOSAL_CREATED',
        'proposal_queued': 'PROPOSAL_QUEUED',
        'proposal_approved': 'PROPOSAL_APPROVED',
        'proposal_adjusted': 'PROPOSAL_ADJUSTED',
        'proposal_dismissed': 'PROPOSAL_DISMISSED',
        'proposal_withdrawn': 'PROPOSAL_DISMISSED',
        // Run state + execution
        'agent_run_step': 'RUN_STARTED',
        'agent_run_started': 'RUN_STARTED',
        'agent_run_completed': 'RUN_COMPLETED',
        'agent_run_failed': 'RUN_FAILED',
        'agent_run_replayed': 'RUN_STARTED',
        'agent_action_executed': 'ACTION_EXECUTED',
        'proposal_executed': 'ACTION_EXECUTED',
        'action_blocked': 'RUN_GATED',
        // Constraint/scope/research
        'constraint_detected': 'CONSTRAINT_DETECTED',
        'constraint_added': 'CONSTRAINT_DETECTED',
        'constraint_removed': 'CONSTRAINT_DETECTED',
        'scope_updated': 'SCOPE_UPDATED',
        'scope_item_updated': 'SCOPE_UPDATED',
        // Portal
        'portal_submission': 'PORTAL_TASK',
        'portal_submission_blocked': 'PORTAL_TASK',
        'portal_submission_failed': 'PORTAL_TASK',
        'portal_task_started': 'PORTAL_TASK_CREATED',
        'portal_task_completed': 'PORTAL_TASK_COMPLETED',
        'portal_task_failed': 'PORTAL_TASK',
        'portal_run_completed': 'PORTAL_TASK_COMPLETED',
        'portal_run_failed': 'PORTAL_TASK',
        'monitor_portal_trigger': 'PORTAL_TASK_CREATED'
    };

    const mapped = explicitMap[eventType];
    if (mapped) return mapped;
    if (eventType.startsWith('proposal_')) return 'PROPOSAL_CREATED';
    if (eventType.startsWith('portal_')) return 'PORTAL_TASK';
    if (eventType.startsWith('agent_')) return 'RUN_STARTED';
    if (eventType.startsWith('fee_')) return 'FEE_QUOTE';
    if (eventType.startsWith('webhook_') || eventType.includes('email')) return 'RECEIVED';
    return 'CREATED';
}

/**
 * Transform activity log to TimelineEvent format
 */
function toTimelineEvent(activity, analysisMap = {}, caseData = null) {
    // Extract meta from meta_jsonb if available
    const meta = activity.meta_jsonb || activity.metadata || {};
    const eventType = activity.event_type;
    const category = mapTimelineCategory(eventType, meta);
    let summary = activity.description || eventType;

    const normalizedSubjectName = typeof caseData?.subject_name === 'string'
        ? caseData.subject_name.trim()
        : '';
    const normalizedSubject = typeof caseData?.subject === 'string'
        ? caseData.subject.trim()
        : '';
    const caseLabel = normalizedSubjectName
        ? `${normalizedSubjectName}${caseData.requested_records?.length ? ` — ${Array.isArray(caseData.requested_records) ? caseData.requested_records.slice(0, 2).join(', ') : 'Records Request'}` : ''}`
        : normalizedSubject || `case #${activity.case_id || meta.case_id || caseData?.id || 'unknown'}`;

    if (eventType === 'portal_stuck_escalated') {
        const rawError = typeof meta.portal_error === 'string' ? meta.portal_error.trim() : '';
        const normalizedError = /^Status:\s*created$/i.test(rawError)
            ? 'No active submit-portal run'
            : rawError || 'No active submit-portal run';
        summary = `Portal task was auto-failed after being stuck in IN_PROGRESS for more than 30 minutes with no active run. ${normalizedError}.`;
    } else if ((eventType === 'portal_workflow_triggered' || eventType === 'portal_run_started') && caseData) {
        const prefix = eventType === 'portal_workflow_triggered'
            ? 'Skyvern workflow triggered for'
            : 'Skyvern portal automation started for';
        summary = `${prefix} ${caseLabel}.`;
    }

    const event = {
        id: String(activity.id),
        timestamp: activity.created_at,
        type: mapTimelineType(eventType, meta),
        summary,
        category,
        raw_content: meta.raw_content || activity.metadata?.raw_content || null,
        metadata: {
            event_type: eventType,
            category,
            ...(activity.message_id ? { message_id: activity.message_id } : {}),
            ...(meta && typeof meta === 'object' ? meta : {})
        }
    };

    // Add classification if present
    if (meta.classification) {
        event.classification = meta.classification;
    }

    // Add gate details if present
    if (meta.gate_details) {
        event.gate_details = meta.gate_details;
    }

    // Add AI audit from meta or from analysis
    if (meta.ai_audit) {
        event.ai_audit = meta.ai_audit;
    } else if (activity.message_id && analysisMap[activity.message_id]) {
        const analysis = analysisMap[activity.message_id];
        event.ai_audit = {
            summary: analysis.key_points || [],
            confidence: analysis.confidence_score ? parseFloat(analysis.confidence_score) : null,
            risk_flags: analysis.requires_action ? ['Requires Action'] : [],
            statute_matches: analysis.full_analysis_json?.statute_matches || null,
            citations: analysis.full_analysis_json?.citations || null
        };
    }

    return event;
}

function dedupeTimelineEvents(events = []) {
    if (!Array.isArray(events) || events.length === 0) return [];
    const deduped = [];
    let prev = null;
    for (const event of events) {
        if (prev) {
            const sameType = prev.type === event.type;
            const sameSummary = prev.summary === event.summary;
            const prevTs = new Date(prev.timestamp).getTime();
            const currTs = new Date(event.timestamp).getTime();
            const withinMinute = Number.isFinite(prevTs) && Number.isFinite(currTs) && Math.abs(prevTs - currTs) < 60_000;
            if (sameType && sameSummary && withinMinute) {
                prev.metadata = prev.metadata || {};
                prev.metadata.merged_count = (prev.metadata.merged_count || 1) + 1;
                continue;
            }
        }
        deduped.push(event);
        prev = event;
    }
    return deduped;
}

/**
 * Calculate business days between two dates
 */
function businessDaysDiff(startDate, endDate) {
    const start = new Date(startDate);
    const end = new Date(endDate);
    let count = 0;
    const current = new Date(start);

    while (current < end) {
        const dayOfWeek = current.getDay();
        if (dayOfWeek !== 0 && dayOfWeek !== 6) {
            count++;
        }
        current.setDate(current.getDate() + 1);
    }

    return count;
}

/**
 * Build deadline milestones for the timeline
 */
function buildDeadlineMilestones(caseData, timelineEvents, stateDeadline) {
    const milestones = [];

    // Submitted milestone
    if (caseData.send_date) {
        milestones.push({
            date: caseData.send_date,
            type: 'SUBMITTED',
            label: 'Submitted'
        });
    }

    // Acknowledgment milestone (from timeline events)
    const ackEvent = timelineEvents.find(e =>
        e.classification?.type === 'ACKNOWLEDGMENT' ||
        e.type === 'RECEIVED' && e.summary?.toLowerCase().includes('acknowledg')
    );
    if (ackEvent && caseData.send_date) {
        const days = businessDaysDiff(caseData.send_date, ackEvent.timestamp);
        milestones.push({
            date: ackEvent.timestamp,
            type: 'ACKNOWLEDGED',
            label: 'Acknowledged',
            days_from_prior: days,
            is_met: days <= 3, // Typical acknowledgment deadline
            statutory_limit: 3
        });
    }

    // Fee quote milestone
    if (caseData.fee_quote_jsonb?.quoted_at) {
        const priorDate = ackEvent?.timestamp || caseData.send_date;
        const days = priorDate ? businessDaysDiff(priorDate, caseData.fee_quote_jsonb.quoted_at) : null;
        milestones.push({
            date: caseData.fee_quote_jsonb.quoted_at,
            type: 'FEE_QUOTED',
            label: 'Fee Quote Received',
            days_from_prior: days
        });
    }

    // Statutory due date
    if (caseData.deadline_date) {
        milestones.push({
            date: caseData.deadline_date,
            type: 'STATUTORY_DUE',
            label: `Statutory Due (${stateDeadline?.response_days || '?'} days)`,
            citation: stateDeadline?.statute_citation,
            statutory_limit: stateDeadline?.response_days
        });
    }

    return milestones;
}

module.exports = {
    // Dependencies
    db, crypto, logger, actionValidator, triggerDispatch, cleanEmailBody, htmlToPlainText, resolveReviewState,
    // Constants
    STATUS_MAP, CONSTRAINT_LABELS, CONSTRAINT_CANONICAL, EVENT_CATEGORY_MAP,
    // Functions
    generateOutcomeSummary, deriveCostStatus, buildDueInfo, parseScopeItems, safeJsonParse,
    extractAgencyCandidatesFromResearchNotes, dedupeCaseAgencies, filterExistingAgencyCandidates,
    extractLatestSupportedPortalUrl, normalizeThreadBody, parseConstraints, parseFeeQuote, isAtRisk,
    resolveControlState, detectControlMismatches, toRequestListItem, attachActivePortalTask,
    detectReviewReason, toRequestDetail, toThreadMessage, mapTimelineCategory, mapTimelineType,
    toTimelineEvent, dedupeTimelineEvents, businessDaysDiff, buildDeadlineMilestones, hasMissingImportDeliveryPath
};
