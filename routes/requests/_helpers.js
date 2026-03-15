const crypto = require('crypto');
const db = require('../../services/database');
const actionValidator = require('../../services/action-validator');
const logger = require('../../services/logger');
const triggerDispatch = require('../../services/trigger-dispatch-service');
const { cleanEmailBody, htmlToPlainText } = require('../../lib/email-cleaner');
const { getCanonicalMessageText } = require('../../lib/message-normalization');
const { resolveReviewState } = require('../../lib/resolve-review-state');
const {
    normalizePortalUrl,
    isSupportedPortalUrl,
    detectPortalProviderByUrl,
    classifyRequestChannelUrl,
} = require('../../utils/portal-utils');
const {
    normalizePortalTimeoutSubstatus,
    deriveDisplayState,
    extractResearchSuggestedAgency,
    extractMetadataAgencyHint,
    isGenericAgencyLabel,
    isNotionReferenceList,
    isPlaceholderAgencyEmail,
} = require('../../utils/request-normalization');

const NO_CORRESPONDENCE_RECOVERY_STATUSES = new Set(['sent', 'awaiting_response', 'portal_in_progress', 'responded']);

function getCaseProgressEvidence(caseData = {}) {
    const messageCount = Number(caseData?.message_count || 0);
    const outboundCount = Number(caseData?.outbound_count || 0);
    const threadCount = Number(caseData?.thread_count || 0);
    const portalSubmissionCount = Number(caseData?.portal_submission_count || 0);
    const hasAnyCorrespondence = messageCount > 0 || threadCount > 0 || portalSubmissionCount > 0 || Boolean(caseData?.last_response_date);
    const hasDispatchEvidence = outboundCount > 0 || portalSubmissionCount > 0 || Boolean(caseData?.send_date) || Boolean(caseData?.last_response_date);

    return {
        messageCount,
        outboundCount,
        threadCount,
        portalSubmissionCount,
        hasAnyCorrespondence,
        hasDispatchEvidence,
    };
}

function isStaleWaitingRunWithoutProposal({ caseData, activeProposal, activeRun }) {
    const runStatus = String(activeRun?.status || '').toLowerCase();
    if (!activeRun || activeProposal) return false;
    if (!['waiting', 'paused', 'gated'].includes(runStatus)) return false;

    const progressEvidence = getCaseProgressEvidence(caseData);
    return !progressEvidence.hasAnyCorrespondence && !progressEvidence.hasDispatchEvidence;
}

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
    const portalProvider = caseData?.portal_provider || detectPortalProviderByUrl(portalUrl);
    const hasSupportedPortal = Boolean(
        portalUrl &&
        isSupportedPortalUrl(portalUrl) &&
        (!warningTypes.has('NO_MX_RECORD') || portalProvider)
    );
    const hasReachableEmail = Boolean(
        agencyEmail &&
        !isPlaceholderAgencyEmail(agencyEmail) &&
        !warningTypes.has('NO_MX_RECORD')
    );
    const hasAnyRealDeliveryPath = Boolean(hasSupportedPortal || hasReachableEmail);

    return Boolean(
        !hasAnyRealDeliveryPath &&
        (
            isPlaceholderAgencyEmail(agencyEmail) ||
            warningTypes.has('NO_MX_RECORD') ||
            warningTypes.has('AGENCY_NOT_IN_DIRECTORY') ||
            warningTypes.has('MISSING_DELIVERY_PATH') ||
            warningTypes.has('MISSING_EMAIL')
        )
    );
}

function hasRealDeliveryPath(caseData) {
    const importWarnings = Array.isArray(caseData?.import_warnings) ? caseData.import_warnings : [];
    const warningTypes = new Set(
        importWarnings
            .map((warning) => String(warning?.type || '').trim().toUpperCase())
            .filter(Boolean)
    );
    const agencyEmail = String(caseData?.agency_email || '').trim().toLowerCase();
    const portalUrl = normalizePortalUrl(caseData?.portal_url);
    const portalProvider = caseData?.portal_provider || detectPortalProviderByUrl(portalUrl);
    const hasSupportedPortal = Boolean(
        portalUrl &&
        isSupportedPortalUrl(portalUrl) &&
        (!warningTypes.has('NO_MX_RECORD') || portalProvider)
    );
    const hasReachableEmail = Boolean(
        agencyEmail &&
        !isPlaceholderAgencyEmail(agencyEmail) &&
        !warningTypes.has('NO_MX_RECORD')
    );

    return Boolean(hasSupportedPortal || hasReachableEmail);
}

function getNoCorrespondenceRecovery(caseData, { activeProposal = null, activeRun = null } = {}) {
    const caseStatus = String(caseData?.status || '').toLowerCase();
    const staleProposalPendingReviewStatus = (
        caseStatus === 'needs_human_review' &&
        !activeProposal &&
        /proposal #\d+ pending review/i.test(String(caseData?.substatus || ''))
    );
    if (!NO_CORRESPONDENCE_RECOVERY_STATUSES.has(caseStatus) && !staleProposalPendingReviewStatus) return null;
    const shouldIgnoreActiveRun = isStaleWaitingRunWithoutProposal({ caseData, activeProposal, activeRun });
    if (activeProposal || (activeRun && !shouldIgnoreActiveRun)) return null;

    const messageCount = Number(caseData?.message_count || 0);
    const outboundCount = Number(caseData?.outbound_count || 0);
    const threadCount = Number(caseData?.thread_count || 0);
    const portalSubmissionCount = Number(caseData?.portal_submission_count || 0);
    const hasAnyCorrespondence = messageCount > 0 || threadCount > 0 || portalSubmissionCount > 0 || Boolean(caseData?.last_response_date);
    const hasDispatchEvidence = outboundCount > 0 || portalSubmissionCount > 0 || Boolean(caseData?.send_date) || Boolean(caseData?.last_response_date);

    if (hasAnyCorrespondence || hasDispatchEvidence) return null;

    if (!hasRealDeliveryPath(caseData) || hasMissingImportDeliveryPath(caseData)) {
        return {
            mode: 'BLOCKED_IMPORT',
            substatus: 'No correspondence exists and the case is missing a real delivery path. Add the correct agency email or portal before sending.',
        };
    }

    return {
        mode: 'READY_TO_SEND',
        substatus: 'No correspondence exists yet. Ready to draft the initial request.',
    };
}

function shouldDisplayAsReadyToSendPendingReview(caseData, activeProposal = null) {
    if (!activeProposal) return false;

    const proposalStatus = String(activeProposal.status || '').toUpperCase();
    const actionType = String(activeProposal.action_type || '').toUpperCase();
    if (!PROPOSAL_PENDING_STATUSES.has(proposalStatus)) return false;
    if (actionType && !FIRST_SEND_PENDING_ACTIONS.has(actionType)) return false;

    const progressEvidence = getCaseProgressEvidence(caseData);
    if (progressEvidence.hasAnyCorrespondence || progressEvidence.hasDispatchEvidence) return false;
    if (hasMissingImportDeliveryPath(caseData)) return false;
    if (!hasRealDeliveryPath(caseData) && actionType !== 'SEND_CLARIFICATION') return false;

    return true;
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
    'id_state': 'ID_STATE',
    'bugged': 'BUGGED'
};

const REVIEW_DB_STATUSES = new Set([
    'needs_human_review',
    'needs_human_fee_approval',
    'needs_contact_info',
    'needs_phone_call',
    'needs_rebuttal',
    'pending_fee_decision',
]);
const PROPOSAL_PENDING_STATUSES = new Set(['PENDING_APPROVAL', 'BLOCKED', 'PENDING_PORTAL']);
const FIRST_SEND_PENDING_ACTIONS = new Set([
    'SEND_INITIAL_REQUEST',
    'SUBMIT_PORTAL',
    'SEND_PDF_EMAIL',
    'SEND_CLARIFICATION',
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
    if (!(normalized && isSupportedPortalUrl(normalized))) return null;

    try {
        const url = new URL(normalized);
        const host = url.hostname.toLowerCase();
        const provider = detectPortalProviderByUrl(normalized);
        if (provider?.name) return `${provider.name}:${host}`;
        return normalized.toLowerCase();
    } catch (error) {
        return normalized.toLowerCase();
    }
}

function stripTrailingAgencyStateLabel(agencyName = '') {
    return String(agencyName || '')
        .replace(/,\s*[a-z]{2}$/i, '')
        .replace(/,\s*(alabama|alaska|arizona|arkansas|california|colorado|connecticut|delaware|district of columbia|florida|georgia|hawaii|idaho|illinois|indiana|iowa|kansas|kentucky|louisiana|maine|maryland|massachusetts|michigan|minnesota|mississippi|missouri|montana|nebraska|nevada|new hampshire|new jersey|new mexico|new york|north carolina|north dakota|ohio|oklahoma|oregon|pennsylvania|rhode island|south carolina|south dakota|tennessee|texas|utah|vermont|virginia|washington|west virginia|wisconsin|wyoming)$/i, '')
        .trim();
}

function isCaseRowBackfillAgency(agency) {
    return ['case_row_backfill', 'case_row_fallback'].includes(String(agency?.added_source || ''));
}

function shouldCollapsePortalBackfillAgency(existing, agency) {
    const existingPortalKey = normalizePortalKey(existing?.portal_url);
    const nextPortalKey = normalizePortalKey(agency?.portal_url);
    if (!existingPortalKey || !nextPortalKey || existingPortalKey !== nextPortalKey) {
        return false;
    }

    const existingBackfill = isCaseRowBackfillAgency(existing);
    const nextBackfill = isCaseRowBackfillAgency(agency);
    if (existingBackfill === nextBackfill) {
        return false;
    }

    const canonicalAgency = existingBackfill ? agency : existing;
    if (!canonicalAgency?.agency_id && !normalizeEmailKey(canonicalAgency?.agency_email)) {
        return false;
    }

    return true;
}

function mergeCaseAgencyRows(existing, agency) {
    const existingUpdatedAt = new Date(existing.updated_at || existing.created_at || 0).getTime();
    const nextUpdatedAt = new Date(agency.updated_at || agency.created_at || 0).getTime();
    const preferred = nextUpdatedAt > existingUpdatedAt ? agency : existing;
    const fallback = preferred === agency ? existing : agency;

    return {
        ...preferred,
        is_primary: Boolean(existing.is_primary || agency.is_primary),
        is_active: existing.is_active !== false || agency.is_active !== false,
        agency_email: preferred.agency_email || fallback.agency_email || null,
        portal_url: normalizePortalUrl(preferred.portal_url || fallback.portal_url || null),
        portal_provider: preferred.portal_provider || fallback.portal_provider || null,
        notes: preferred.notes || fallback.notes || null,
        contact_research_notes: preferred.contact_research_notes || fallback.contact_research_notes || null,
    };
}

function dedupeCaseAgencies(caseAgencies = []) {
    const deduped = [];

    for (const agency of caseAgencies) {
        const nameKey = normalizeAgencyNameKey(agency?.agency_name);
        const emailKey = normalizeEmailKey(agency?.agency_email);
        const portalKey = normalizePortalKey(agency?.portal_url);
        const dedupeKey =
            [nameKey, emailKey, portalKey].filter(Boolean).join('|') ||
            `case-agency-${agency?.id ?? deduped.length + 1}`;

        const normalizedAgency = {
            ...agency,
            agency_email: emailKey ? String(agency.agency_email).trim() : agency.agency_email || null,
            portal_url: portalKey ? normalizePortalUrl(agency.portal_url) : null,
        };

        const existingIndex = deduped.findIndex((entry) => {
            const entryKey = [
                normalizeAgencyNameKey(entry?.agency_name),
                normalizeEmailKey(entry?.agency_email),
                normalizePortalKey(entry?.portal_url),
            ].filter(Boolean).join('|') || `case-agency-${entry?.id ?? 'existing'}`;
            return entryKey === dedupeKey || shouldCollapsePortalBackfillAgency(entry, normalizedAgency);
        });

        if (existingIndex === -1) {
            deduped.push(normalizedAgency);
            continue;
        }

        deduped[existingIndex] = mergeCaseAgencyRows(deduped[existingIndex], normalizedAgency);
    }

    return deduped;
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

function extractLatestRecoveredRequestChannels(activityRows = [], caseAgencies = [], caseData = {}) {
    const result = {
        portal_url: null,
        portal_provider: null,
        manual_request_url: null,
        pdf_form_url: null,
    };

    const candidates = [
        { url: caseData?.portal_url, provider: caseData?.portal_provider || null },
        { url: caseData?.manual_request_url, provider: null },
        { url: caseData?.pdf_form_url, provider: null },
    ];

    for (const row of activityRows) {
        if (!row) continue;
        const metadata = row.metadata && typeof row.metadata === 'object' ? row.metadata : row.meta_jsonb;
        if (!metadata || typeof metadata !== 'object') continue;
        if (metadata.portal_url) {
            candidates.push({ url: metadata.portal_url, provider: metadata.portal_provider || null });
        }
        if (metadata.manual_request_url) {
            candidates.push({ url: metadata.manual_request_url, provider: null });
        }
        if (metadata.pdf_form_url) {
            candidates.push({ url: metadata.pdf_form_url, provider: null });
        }
    }

    for (const agency of caseAgencies) {
        if (agency?.portal_url) {
            candidates.push({ url: agency.portal_url, provider: agency.portal_provider || null });
        }
        if (agency?.manual_request_url) {
            candidates.push({ url: agency.manual_request_url, provider: null });
        }
        if (agency?.pdf_form_url) {
            candidates.push({ url: agency.pdf_form_url, provider: null });
        }
    }

    for (const candidate of candidates) {
        if (!candidate?.url) continue;
        const classified = classifyRequestChannelUrl(candidate.url, candidate.provider, caseData?.last_portal_status || null);
        if (classified.kind === 'portal' && !result.portal_url) {
            result.portal_url = classified.normalizedUrl;
            result.portal_provider = classified.provider || detectPortalProviderByUrl(classified.normalizedUrl)?.name || null;
            continue;
        }
        if (classified.kind === 'manual_request' && !result.manual_request_url) {
            result.manual_request_url = classified.normalizedUrl;
            continue;
        }
        if (classified.kind === 'pdf_form' && !result.pdf_form_url) {
            result.pdf_form_url = classified.normalizedUrl;
        }
    }

    return result;
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
    const staleWaitingRunWithoutProposal = isStaleWaitingRunWithoutProposal({
        caseData,
        activeProposal: pendingProposal,
        activeRun,
    });
    const effectiveActiveRun = staleWaitingRunWithoutProposal ? null : activeRun;
    const runStatus = String(effectiveActiveRun?.status || '').toLowerCase();
    const hasActiveRun = ['created', 'queued', 'processing', 'running', 'waiting'].includes(runStatus);
    const portalStatus = String(activePortalTaskStatus || '').toUpperCase();
    const portalActive = portalStatus === 'PENDING' || portalStatus === 'IN_PROGRESS';
    const hasPendingProposal = Boolean(pendingProposal && ['PENDING_APPROVAL', 'BLOCKED', 'DECISION_RECEIVED', 'PENDING_PORTAL'].includes(String(pendingProposal.status || '').toUpperCase()));
    const hasProgressEvidence =
        Number(caseData?.outbound_count || 0) > 0 ||
        Number(caseData?.portal_submission_count || 0) > 0 ||
        Number(caseData?.message_count || 0) > 0 ||
        Number(caseData?.thread_count || 0) > 0 ||
        Boolean(caseData?.send_date) ||
        Boolean(caseData?.last_response_date);
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
    if (reviewState === 'WAITING_AGENCY' || (['sent', 'awaiting_response', 'responded'].includes(caseStatus) && hasProgressEvidence)) return 'WAITING_AGENCY';
    if (caseStatus === 'error') return 'BLOCKED';
    return 'BLOCKED';
}

function detectControlMismatches({ caseData, reviewState, pendingProposal, activeRun, activePortalTaskStatus }) {
    const issues = [];
    const caseStatus = String(caseData?.status || '').toLowerCase();
    const staleWaitingRunWithoutProposal = isStaleWaitingRunWithoutProposal({
        caseData,
        activeProposal: pendingProposal,
        activeRun,
    });
    const effectiveActiveRun = staleWaitingRunWithoutProposal ? null : activeRun;
    const runStatus = String(effectiveActiveRun?.status || '').toLowerCase();
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
    let normalizedSubstatus = normalizePortalTimeoutSubstatus(caseData.substatus || null);
    const displayAgencyName = resolveDisplayAgencyName(caseData);
    const displayState = deriveDisplayState(caseData.state, displayAgencyName);
    const subject = caseData.subject_name
        ? `${caseData.subject_name}${caseData.requested_records?.length ? ` — ${Array.isArray(caseData.requested_records) ? caseData.requested_records.slice(0, 2).join(', ') : 'Records Request'}` : ''}`
        : caseData.case_name || 'Unknown Request';

    const dueInfo = buildDueInfo(caseData);
    const feeQuote = parseFeeQuote(caseData);

    // Derive review_state from available lateral join data
    const rawActiveRun = caseData.active_run_status
        ? { status: caseData.active_run_status }
        : null;
    const activeProposal = caseData.active_proposal_status
        ? { status: caseData.active_proposal_status }
        : null;
    const activeRun = isStaleWaitingRunWithoutProposal({
        caseData,
        activeProposal,
        activeRun: rawActiveRun,
    })
        ? null
        : rawActiveRun;

    let review_state = resolveReviewState({
        caseData,
        activeProposal,
        activeRun,
    });

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
    const noCorrespondenceRecovery = getNoCorrespondenceRecovery(caseData, {
        activeProposal,
        activeRun,
    });
    const firstSendPendingReview = shouldDisplayAsReadyToSendPendingReview(caseData, activeProposal);

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
    if (noCorrespondenceRecovery?.mode === 'BLOCKED_IMPORT') {
        effectiveDbStatus = 'needs_human_review';
        normalizedSubstatus = noCorrespondenceRecovery.substatus;
        review_state = 'IDLE';
        control_state = 'BLOCKED';
        control_mismatches = [];
    } else if (noCorrespondenceRecovery?.mode === 'READY_TO_SEND') {
        effectiveDbStatus = 'ready_to_send';
        normalizedSubstatus = noCorrespondenceRecovery.substatus;
        review_state = 'IDLE';
        control_state = 'BLOCKED';
        control_mismatches = [];
    } else if (firstSendPendingReview) {
        effectiveDbStatus = 'ready_to_send';
    }
    // Use derived review/control state as the UI source of truth so stale
    // requires_human flags in DB don't hide blocked manual work.
    const effectiveRequiresHuman =
        review_state === 'DECISION_REQUIRED' ||
        (control_state === 'BLOCKED' && REVIEW_DB_STATUSES.has(effectiveDbStatus));
    const effectivePauseReason = effectiveRequiresHuman
        ? (caseData.pause_reason || null)
        : null;
    const reviewReason = (effectiveRequiresHuman || REVIEW_DB_STATUSES.has(effectiveDbStatus))
        ? detectReviewReason({
            ...caseData,
            pause_reason: effectivePauseReason,
            substatus: normalizedSubstatus,
            status: effectiveDbStatus,
        })
        : null;
    const reviewContext = buildReviewContext({
        ...caseData,
        pause_reason: effectivePauseReason,
        substatus: normalizedSubstatus,
        requires_human: effectiveRequiresHuman,
        status: effectiveDbStatus,
    }, {
        reviewState: review_state,
        controlState: control_state,
        controlMismatches: control_mismatches,
        pendingProposal: activeProposal,
        activeRun,
        activePortalTaskStatus: caseData.active_portal_task_status || null,
    });
    const operatorBrief = buildOperatorBrief({
        ...caseData,
        pause_reason: effectivePauseReason,
        substatus: normalizedSubstatus,
        requires_human: effectiveRequiresHuman,
        status: effectiveDbStatus,
    }, {
        reviewState: review_state,
        controlState: control_state,
        controlMismatches: control_mismatches,
        pendingProposal: activeProposal,
        activeRun,
        activePortalTaskStatus: caseData.active_portal_task_status || null,
    });

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
        review_reason: reviewReason,
        review_context: reviewContext,
        operator_brief: operatorBrief,
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

function summarizeSupportText(value, max = 180) {
    const text = String(value || '').replace(/\s+/g, ' ').trim();
    if (!text) return null;
    return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}

function buildReviewContext(caseData, {
    reviewState = null,
    controlState = null,
    controlMismatches = [],
    pendingProposal = null,
    activeRun = null,
    activePortalTaskStatus = null,
    latestTrackedError = null,
} = {}) {
    const normalizedReviewState = String(reviewState || caseData?.review_state || '').toUpperCase() || null;
    const normalizedControlState = String(controlState || caseData?.control_state || '').toUpperCase() || null;
    const mismatchList = Array.isArray(controlMismatches) ? controlMismatches : [];
    const reviewReason = detectReviewReason(caseData);
    const activeRunStatus = String(activeRun?.status || caseData?.active_run_status || '').toLowerCase() || null;
    const portalTaskStatus = String(activePortalTaskStatus || caseData?.active_portal_task_status || '').toUpperCase() || null;

    return {
        review_reason: reviewReason,
        pause_reason: caseData?.pause_reason || null,
        review_state: normalizedReviewState,
        control_state: normalizedControlState,
        mismatch_codes: mismatchList.map((issue) => issue?.code).filter(Boolean),
        has_pending_proposal: Boolean(pendingProposal || caseData?.active_proposal_status),
        active_run_status: activeRunStatus,
        active_portal_task_status: portalTaskStatus,
        latest_error_surface: latestTrackedError?.failure_surface || null,
        latest_error_at: latestTrackedError?.occurred_at || null,
        operator_gate: Boolean(
            caseData?.requires_human
            || normalizedReviewState === 'DECISION_REQUIRED'
            || normalizedControlState === 'NEEDS_DECISION'
            || normalizedControlState === 'BLOCKED'
        ),
    };
}

function buildOperatorBrief(caseData, {
    reviewState = null,
    controlState = null,
    controlMismatches = [],
    pendingProposal = null,
    activeRun = null,
    activePortalTaskStatus = null,
    latestTrackedError = null,
} = {}) {
    const normalizedReviewState = String(reviewState || caseData?.review_state || '').toUpperCase();
    const normalizedControlState = String(controlState || caseData?.control_state || '').toUpperCase();
    const mismatchList = Array.isArray(controlMismatches) ? controlMismatches : [];
    const pauseReason = String(caseData?.pause_reason || '').toUpperCase();
    const reviewReason = detectReviewReason(caseData);
    const activeRunStatus = String(activeRun?.status || caseData?.active_run_status || '').toLowerCase();
    const portalTaskStatus = String(activePortalTaskStatus || caseData?.active_portal_task_status || '').toUpperCase();
    const substatus = summarizeSupportText(caseData?.substatus, 220);
    const hasPendingProposal = Boolean(pendingProposal || caseData?.active_proposal_status);
    const base = {
        reason_code: reviewReason,
        status: normalizedControlState === 'NEEDS_DECISION' || normalizedReviewState === 'DECISION_REQUIRED'
            ? 'decision_required'
            : (caseData?.requires_human ? 'attention_required' : 'monitoring'),
        needs_operator_action: Boolean(
            caseData?.requires_human
            || normalizedReviewState === 'DECISION_REQUIRED'
            || normalizedControlState === 'NEEDS_DECISION'
            || normalizedControlState === 'BLOCKED'
        ),
        failure_surface: null,
        failure_summary: null,
    };

    if (mismatchList.length > 0) {
        return {
            ...base,
            reason_code: 'BACKEND_STATE_MISMATCH',
            status: 'blocked',
            headline: 'Case state is out of sync',
            summary: summarizeSupportText(mismatchList.map((issue) => issue?.message).filter(Boolean).join('; '), 240) || 'The case state does not match the active AI/proposal state.',
            recommended_action: 'Inspect the latest proposal, run, and portal task before approving or retrying anything.',
            failure_surface: 'backend_reliability',
            failure_summary: 'Backend state mismatch detected between review and execution state.',
            needs_operator_action: true,
        };
    }

    if (latestTrackedError) {
        const source = latestTrackedError.source_service || 'automation';
        return {
            ...base,
            reason_code: 'RECENT_EXECUTION_ERROR',
            status: 'blocked',
            headline: `Automation failed in ${source}`,
            summary: latestTrackedError.message || 'A recent tracked error blocked the case.',
            recommended_action: latestTrackedError.retryable
                ? 'Review the latest error and retry the run if the portal/session state still looks valid.'
                : 'Review the latest tracked error before retrying or taking over manually.',
            failure_surface: latestTrackedError.failure_surface || 'backend_reliability',
            failure_summary: latestTrackedError.message || 'Recent tracked error blocked execution.',
            needs_operator_action: true,
        };
    }

    if (pauseReason === 'MANUAL_PASTE_MISMATCH' || /pasted inbound sender/i.test(String(caseData?.substatus || ''))) {
        return {
            ...base,
            reason_code: 'MANUAL_PASTE_MISMATCH',
            status: 'blocked',
            headline: 'Verify the pasted inbound email',
            summary: substatus || 'The pasted inbound sender did not match the expected agency channel.',
            recommended_action: 'Confirm the correct agency inbox before using this inbound message to drive AI decisions.',
            failure_surface: 'ingestion',
            failure_summary: 'Manual paste sender mismatch needs review.',
            needs_operator_action: true,
        };
    }

    if (pauseReason === 'IMPORT_REVIEW') {
        return {
            ...base,
            reason_code: 'IMPORT_REVIEW',
            status: 'blocked',
            headline: 'Confirm the agency and delivery path',
            summary: substatus || 'The imported case does not yet have a trusted delivery path.',
            recommended_action: 'Confirm the correct agency email or portal before allowing AI to send anything.',
            failure_surface: 'ingestion',
            failure_summary: 'Imported case is blocked until the delivery path is verified.',
            needs_operator_action: true,
        };
    }

    if (normalizedReviewState === 'DECISION_REQUIRED' && hasPendingProposal) {
        return {
            ...base,
            reason_code: 'PENDING_PROPOSAL_REVIEW',
            status: 'decision_required',
            headline: 'Review the AI proposal',
            summary: substatus || 'AI prepared the next action and is waiting for a decision.',
            recommended_action: 'Approve, adjust, or dismiss the pending proposal.',
            needs_operator_action: true,
        };
    }

    if (reviewReason === 'PHONE_CALL') {
        return {
            ...base,
            headline: 'Call the agency',
            summary: substatus || 'The case needs a human phone call to move forward.',
            recommended_action: 'Use the phone plan or agency contact details, then log the result.',
            needs_operator_action: true,
        };
    }

    if (reviewReason === 'MISSING_INFO' || pauseReason === 'RESEARCH_HANDOFF' || pauseReason === 'AGENCY_RESEARCH_COMPLETE') {
        return {
            ...base,
            headline: 'Complete the contact or research handoff',
            summary: substatus || 'AI could not verify a safe contact channel on its own.',
            recommended_action: 'Confirm the correct agency, inbox, or portal and then resume the case.',
            needs_operator_action: true,
        };
    }

    if (portalTaskStatus === 'PENDING' || portalTaskStatus === 'IN_PROGRESS') {
        return {
            ...base,
            status: 'processing',
            reason_code: 'PORTAL_AUTOMATION_ACTIVE',
            headline: 'Portal automation is running',
            summary: substatus || 'The portal worker is still processing the submission.',
            recommended_action: 'Monitor the run and only intervene if it stalls or requests auth.',
            needs_operator_action: false,
        };
    }

    if (['created', 'queued', 'processing', 'running', 'waiting'].includes(activeRunStatus)) {
        return {
            ...base,
            status: 'processing',
            reason_code: 'AI_RUN_ACTIVE',
            headline: 'AI is working the case',
            summary: substatus || 'A live run is still processing this case.',
            recommended_action: activeRunStatus === 'waiting'
                ? 'Check whether the run is waiting on a human or external system.'
                : 'Monitor the run unless it stalls or produces a bad proposal.',
            needs_operator_action: activeRunStatus === 'waiting',
        };
    }

    if (normalizedReviewState === 'WAITING_AGENCY' || ['awaiting_response', 'sent', 'responded'].includes(String(caseData?.status || '').toLowerCase())) {
        return {
            ...base,
            status: 'monitoring',
            reason_code: 'WAITING_ON_AGENCY',
            headline: 'Waiting on the agency',
            summary: substatus || 'The request is out and the case is waiting for agency response.',
            recommended_action: 'No action is needed until the agency responds or the statutory deadline approaches.',
            needs_operator_action: false,
        };
    }

    return {
        ...base,
        headline: caseData?.requires_human ? 'Human review is required' : 'Case is ready for the next AI step',
        summary: substatus || 'No special blocker is currently attached to this case.',
        recommended_action: caseData?.requires_human
            ? 'Review the latest case state and decide the next step.'
            : 'Allow AI to continue or trigger the next run when appropriate.',
    };
}

/**
 * Extract phone call plan from contact_research_notes.
 * Mirrors the logic in routes/monitor/overview.js so the case detail page
 * can display the same phone-call context as the gated queue.
 */
function extractPhoneCallPlan(rawNotes, row = {}) {
    // When no contact research exists, build a minimal plan from agency directory data
    // so that needs_phone_call cases still show the phone UI
    if (!rawNotes) {
        const directoryPhone = String(row.canonical_phone || '').trim() || null;
        const agencyName = String(row.agency_name || '').trim() || null;
        const agencyEmail = (isPlaceholderAgencyEmail(row.agency_email) ? null : String(row.agency_email || '').trim()) || null;
        const portalUrl = String(row.portal_url || '').trim() || null;
        if (!directoryPhone && !agencyName) return null;
        return {
            agency_name: agencyName,
            agency_phone: directoryPhone,
            agency_email: agencyEmail,
            portal_url: portalUrl,
            reason: 'Deadline passed — phone follow-up needed',
            outcome: null,
            suggested_agency: null,
        };
    }
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
        manual_request_url: caseData.manual_request_url || null,
        pdf_form_url: caseData.pdf_form_url || null,
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
        metadata: meta && typeof meta === 'object' ? meta : null,
        attachments: attachments
    };
}

function humanizePortalSubmissionStatus(status) {
    return String(status || 'attempt')
        .replace(/[_-]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .replace(/\b\w/g, (char) => char.toUpperCase());
}

function guessPortalAttachmentName(url, fallback = 'Portal screenshot') {
    const pathname = String(url || '').split('?')[0];
    const lastSegment = pathname.split('/').filter(Boolean).pop() || '';
    if (lastSegment) {
        return decodeURIComponent(lastSegment);
    }
    return fallback;
}

function collectPortalScreenshots(activityRows = []) {
    const screenshotsByRunId = new Map();
    const taskUrlByRunId = new Map();

    for (const row of activityRows) {
        const metadata = row.metadata || {};
        const runId = metadata.run_id || metadata.runId || null;

        if (row.event_type === 'portal_workflow_triggered' && runId && metadata.task_url) {
            taskUrlByRunId.set(String(runId), metadata.task_url);
        }

        if (row.event_type !== 'portal_screenshot' || !runId) continue;

        const persistentUrl = metadata.persistent_url || metadata.url || null;
        if (!persistentUrl) continue;

        const normalizedRunId = String(runId);
        const existing = screenshotsByRunId.get(normalizedRunId) || [];
        existing.push({
            id: `portal-screenshot:${row.id}`,
            filename: guessPortalAttachmentName(persistentUrl, `portal-screenshot-${metadata.sequence_index ?? existing.length + 1}.png`),
            content_type: 'image/png',
            size_bytes: 0,
            url: persistentUrl,
            extracted_text: null,
            has_extracted_text: false,
            _created_at: row.created_at || null,
        });
        screenshotsByRunId.set(normalizedRunId, existing);
    }

    return { screenshotsByRunId, taskUrlByRunId };
}

function resolvePortalSubmissionAgency(portalUrl, caseAgencies = [], caseData = null) {
    const normalizedPortalUrl = normalizePortalUrl(portalUrl || caseData?.portal_url);
    if (normalizedPortalUrl) {
        const exactPortalAgency = caseAgencies.find((agency) => normalizePortalUrl(agency.portal_url) === normalizedPortalUrl);
        if (exactPortalAgency) return exactPortalAgency;
    }

    return caseAgencies.find((agency) => agency.is_primary)
        || caseAgencies[0]
        || null;
}

function buildPortalSubmissionThreadMessages({
    portalSubmissions = [],
    activityRows = [],
    caseData = null,
    caseAgencies = [],
} = {}) {
    if (!Array.isArray(portalSubmissions) || portalSubmissions.length === 0) return [];

    const { screenshotsByRunId, taskUrlByRunId } = collectPortalScreenshots(activityRows);

    return portalSubmissions
        .map((submission) => {
            const runId = submission.skyvern_task_id ? String(submission.skyvern_task_id) : null;
            const screenshotCandidates = [];

            if (submission.screenshot_url) {
                screenshotCandidates.push({
                    id: `portal-submission:${submission.id}:screenshot`,
                    filename: guessPortalAttachmentName(submission.screenshot_url),
                    content_type: 'image/png',
                    size_bytes: 0,
                    url: submission.screenshot_url,
                    extracted_text: null,
                    has_extracted_text: false,
                    _created_at: submission.completed_at || submission.started_at || null,
                });
            }

            if (runId && screenshotsByRunId.has(runId)) {
                screenshotCandidates.push(...screenshotsByRunId.get(runId));
            }

            const seenScreenshotUrls = new Set();
            const screenshotAttachments = screenshotCandidates
                .filter((attachment) => {
                    const key = String(attachment.url || '').trim();
                    if (!key || seenScreenshotUrls.has(key)) return false;
                    seenScreenshotUrls.add(key);
                    return true;
                })
                .sort((a, b) => new Date(a._created_at || 0).getTime() - new Date(b._created_at || 0).getTime())
                .slice(-4)
                .map(({ _created_at, ...attachment }) => attachment);

            const resolvedAgency = resolvePortalSubmissionAgency(submission.portal_url, caseAgencies, caseData);
            const portalUrl = normalizePortalUrl(submission.portal_url || caseData?.portal_url);
            const taskUrl = (runId && taskUrlByRunId.get(runId)) || caseData?.last_portal_task_url || null;
            const extracted = submission.extracted_data && typeof submission.extracted_data === 'object'
                ? submission.extracted_data
                : {};
            const confirmationNumber =
                extracted.confirmation_number ||
                extracted.confirmationNumber ||
                extracted.request_number ||
                extracted.requestNumber ||
                null;
            const requestNumber = confirmationNumber || caseData?.portal_request_number || null;
            const timestamp = submission.completed_at || submission.started_at || new Date().toISOString();
            const statusLabel = humanizePortalSubmissionStatus(submission.status);
            const engineLabel = submission.engine
                ? String(submission.engine).replace(/[_-]+/g, ' ')
                : (caseData?.portal_provider || 'portal automation');
            const bodyLines = [
                `Portal submission ${String(statusLabel).toLowerCase()} at ${timestamp}.`,
                engineLabel ? `Engine: ${engineLabel}.` : null,
                portalUrl ? `Portal URL: ${portalUrl}` : null,
                taskUrl ? `Automation run: ${taskUrl}` : null,
                submission.account_email ? `Account email: ${submission.account_email}` : null,
                requestNumber ? `Request number: ${requestNumber}` : null,
                submission.error_message ? `Error: ${submission.error_message}` : null,
                screenshotAttachments.length > 0 ? `Screenshots captured: ${screenshotAttachments.length}` : null,
            ].filter(Boolean);

            const syntheticMessage = {
                id: -(1000000 + Number(submission.id || 0)),
                thread_id: null,
                case_id: caseData?.id || null,
                direction: 'outbound',
                from_email: 'AUTOBOT Portal Automation',
                to_email: resolvedAgency?.agency_name || caseData?.agency_name || 'Agency Portal',
                subject: `Portal submission — ${statusLabel}`,
                body_text: bodyLines.join('\n\n'),
                body_html: null,
                message_type: 'portal_submission',
                portal_notification: true,
                portal_notification_type: 'status_update',
                sent_at: timestamp,
                received_at: null,
                processed_at: submission.completed_at || null,
                summary: submission.error_message
                    ? `Portal attempt failed: ${submission.error_message}`
                    : `Portal attempt ${String(statusLabel).toLowerCase()}`,
                metadata: {
                    source: 'portal_submissions',
                    portal_submission_id: submission.id,
                    case_agency_id: resolvedAgency?.id || null,
                    portal_url: portalUrl,
                    portal_task_url: taskUrl,
                    portal_request_number: requestNumber,
                    skyvern_task_id: submission.skyvern_task_id || null,
                    engine: submission.engine || null,
                    status: submission.status || null,
                    account_email: submission.account_email || null,
                    screenshot_url: submission.screenshot_url || null,
                    recording_url: submission.recording_url || null,
                    browser_backend: submission.browser_backend || null,
                    browser_session_id: submission.browser_session_id || null,
                    browser_session_url: submission.browser_session_url || null,
                    browser_debugger_url: submission.browser_debugger_url || null,
                    browser_debugger_fullscreen_url: submission.browser_debugger_fullscreen_url || null,
                    browser_region: submission.browser_region || null,
                    browser_status: submission.browser_status || null,
                    error_message: submission.error_message || null,
                    extracted_data: extracted,
                    started_at: submission.started_at || null,
                    completed_at: submission.completed_at || null,
                    screenshot_count: screenshotAttachments.length,
                },
            };

            return toThreadMessage(syntheticMessage, screenshotAttachments, caseData);
        })
        .sort((a, b) => new Date(a.sent_at || a.timestamp || 0).getTime() - new Date(b.sent_at || b.timestamp || 0).getTime());
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
    extractLatestRecoveredRequestChannels, normalizeThreadBody, parseConstraints, parseFeeQuote, isAtRisk,
    resolveControlState, detectControlMismatches, toRequestListItem, attachActivePortalTask,
    detectReviewReason, buildOperatorBrief, buildReviewContext, toRequestDetail, toThreadMessage, mapTimelineCategory, mapTimelineType,
    toTimelineEvent, dedupeTimelineEvents, businessDaysDiff, buildDeadlineMilestones, hasMissingImportDeliveryPath,
    getNoCorrespondenceRecovery, isStaleWaitingRunWithoutProposal, shouldDisplayAsReadyToSendPendingReview
};
module.exports.buildPortalSubmissionThreadMessages = buildPortalSubmissionThreadMessages;
