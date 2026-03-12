const express = require('express');
const router = express.Router();
const { db, logger, toRequestListItem, toRequestDetail, toThreadMessage, toTimelineEvent, dedupeTimelineEvents, buildDeadlineMilestones, attachActivePortalTask, parseScopeItems, parseConstraints, parseFeeQuote, safeJsonParse, extractAgencyCandidatesFromResearchNotes, dedupeCaseAgencies, filterExistingAgencyCandidates, extractLatestSupportedPortalUrl, normalizeThreadBody, resolveReviewState, resolveControlState, detectControlMismatches, STATUS_MAP, buildDueInfo, detectReviewReason, businessDaysDiff, hasMissingImportDeliveryPath, getNoCorrespondenceRecovery, shouldDisplayAsReadyToSendPendingReview } = require('./_helpers');
const reviewStateLib = require('../../lib/resolve-review-state');
const isStaleWaitingRunWithoutProposal = typeof reviewStateLib.isStaleWaitingRunWithoutProposal === 'function'
    ? reviewStateLib.isStaleWaitingRunWithoutProposal
    : () => false;
const { buildPortalSubmissionThreadMessages } = require('./_helpers');
const { ACTIVE_PROPOSAL_STATUSES_SQL } = require('../../lib/case-truth');
const { normalizePortalUrl, detectPortalProviderByUrl } = require('../../utils/portal-utils');
const { normalizeAgencyEmailHint, isTestAgencyEmail, findCanonicalAgency } = require('../../services/canonical-agency');
const { buildRealCaseWhereClause } = require('../../utils/analytics-test-filter');
const {
    deriveDisplayState,
    detectCaseMetadataAgencyMismatch,
    extractAgencyNameFromAdditionalDetails,
    extractMetadataAgencyHint,
    extractResearchSuggestedAgency,
    isGenericAgencyLabel,
    isNotionReferenceList,
    isPlaceholderAgencyEmail,
    evaluateImportAutoDispatchSafety,
    shouldSuppressPlaceholderAgencyDisplay,
    sanitizeStaleResearchHandoffDraft,
    sanitizeStaleResearchHandoffReasoning,
    filterStaleImportWarnings,
} = require('../../utils/request-normalization');
const { shouldEscalateManualPasteMismatch } = require('../../trigger/lib/manual-paste-guard.ts');

function shouldPreferResearchAgencyDisplay({ researchSuggestedAgency, agencyEmail, portalUrl, addedSource }) {
    return Boolean(
        researchSuggestedAgency
        && isPlaceholderAgencyEmail(agencyEmail)
        && !normalizePortalUrl(portalUrl)
    );
}

function hasSyntheticPlaceholderBackfill({ agencyEmail, portalUrl, addedSource }) {
    return Boolean(
        ['case_row_backfill', 'case_row_fallback'].includes(String(addedSource || ''))
        && isPlaceholderAgencyEmail(agencyEmail)
        && !normalizePortalUrl(portalUrl)
    );
}

function shouldForceCorrectedAgencyDisplay({
    currentAgencyName,
    caseAgencyName,
    additionalDetails,
    researchSuggestedAgency,
    currentAgencyEmail,
    currentPortalUrl,
    metadataAgencyMismatch = null,
}) {
    const mismatch = metadataAgencyMismatch || detectCaseMetadataAgencyMismatch({
        currentAgencyName,
        additionalDetails,
    });
    if (!mismatch) return false;

    const correctedAgencyName = String(
        researchSuggestedAgency?.name ||
        mismatch.expectedAgencyName ||
        caseAgencyName ||
        ''
    ).trim();
    if (!correctedAgencyName) return false;

    const normalizedCurrentName = String(currentAgencyName || '').trim().toLowerCase();
    if (normalizedCurrentName && normalizedCurrentName === correctedAgencyName.toLowerCase()) {
        return false;
    }

    return Boolean(
        normalizeAgencyEmailHint(currentAgencyEmail) ||
        normalizePortalUrl(currentPortalUrl)
    );
}

function buildCorrectedAgencyDisplay({
    researchCanonical,
    researchSuggestedAgency,
    metadataAgencyMismatch,
    caseAgencyName,
    caseState,
}) {
    const name =
        researchCanonical?.name ||
        researchSuggestedAgency?.name ||
        metadataAgencyMismatch?.expectedAgencyName ||
        caseAgencyName ||
        null;
    const email = normalizeAgencyEmailHint(
        researchCanonical?.email_foia ||
        researchCanonical?.email_main ||
        null
    );
    const portalUrl = normalizePortalUrl(
        researchCanonical?.portal_url ||
        researchCanonical?.portal_url_alt ||
        null
    );

    return {
        id: researchCanonical?.id || null,
        name,
        email: email || null,
        portalUrl,
        portalProvider: researchCanonical?.portal_provider || detectPortalProviderByUrl(portalUrl)?.name || null,
        state: deriveDisplayState(
            researchCanonical?.state || metadataAgencyMismatch?.expectedState || caseState,
            name
        ),
    };
}

function shouldOverrideStaleExistingChannelDisplay({
    contactResearchNotes,
    currentAgencyName,
    researchSuggestedAgency,
    currentAgencyEmail,
    currentPortalUrl,
}) {
    const parsedNotes = safeJsonParse(contactResearchNotes);
    const outcome = String(parsedNotes?.execution?.outcome || '').trim().toLowerCase();
    if (outcome !== 'research_complete_existing_channels') return false;

    const normalizedCurrentName = String(currentAgencyName || '').trim().toLowerCase();
    const normalizedSuggestedName = String(researchSuggestedAgency?.name || '').trim().toLowerCase();
    if (!normalizedCurrentName || !normalizedSuggestedName || normalizedCurrentName === normalizedSuggestedName) {
        return false;
    }

    return Boolean(
        normalizeAgencyEmailHint(currentAgencyEmail) ||
        normalizePortalUrl(currentPortalUrl)
    );
}

function normalizeNotionReferenceId(value = '') {
    const normalized = String(value || '').trim().replace(/-/g, '').toLowerCase();
    return /^[a-f0-9]{32}$/.test(normalized) ? normalized : null;
}

async function lookupAgencyByNotionReference(rawValue) {
    const notionId = normalizeNotionReferenceId(rawValue);
    if (!notionId) return null;

    const result = await db.query(
        `SELECT id, name, state, email_foia, email_main, portal_url, portal_url_alt, portal_provider
         FROM agencies
         WHERE LOWER(REPLACE(COALESCE(notion_page_id, ''), '-', '')) = $1
         LIMIT 1`,
        [notionId]
    );

    return result.rows[0] || null;
}

function deriveDefaultGateOptions(actionType, draftBodyText = '') {
    const normalizedAction = String(actionType || '').trim().toUpperCase();
    const draftText = String(draftBodyText || '');

    if (!normalizedAction) return null;

    if (normalizedAction === 'RESEARCH_AGENCY') {
        return ['RETRY_RESEARCH', 'ADJUST', 'DISMISS'];
    }

    if (normalizedAction === 'ESCALATE') {
        if (/manual submit helper|portal submission manually|portal submission manual|open portal/i.test(draftText)) {
            return ['ADJUST', 'DISMISS'];
        }
        return ['APPROVE', 'ADJUST', 'DISMISS', 'WITHDRAW'];
    }

    if ([
        'SEND_INITIAL_REQUEST',
        'SEND_CLARIFICATION',
        'SEND_PDF_EMAIL',
        'REFORMULATE_REQUEST',
        'SUBMIT_PORTAL',
    ].includes(normalizedAction)) {
        return ['APPROVE', 'ADJUST', 'DISMISS', 'WITHDRAW'];
    }

    return null;
}

const CONTRADICTORY_NO_RESPONSE_ACTIONS = new Set([
    'SEND_INITIAL_REQUEST',
    'SEND_FOLLOWUP',
    'SEND_REBUTTAL',
    'SEND_CLARIFICATION',
    'SEND_PDF_EMAIL',
    'ACCEPT_FEE',
    'NEGOTIATE_FEE',
    'DECLINE_FEE',
    'RESPOND_PARTIAL_APPROVAL',
]);

function proposalSignalsNoResponseDraft(draftBodyText) {
    const text = String(draftBodyText || '').trim();
    return /^(no response needed|no reply needed)\b/i.test(text);
}

function isContradictoryNoResponseProposal(proposal) {
    if (!proposal) return false;
    const actionType = String(proposal.action_type || '').toUpperCase();
    return CONTRADICTORY_NO_RESPONSE_ACTIONS.has(actionType)
        && proposalSignalsNoResponseDraft(proposal.draft_body_text);
}

function pickAgencyDisplayName(...candidates) {
    let fallback = null;

    for (const rawCandidate of candidates) {
        const candidate = String(rawCandidate || '').trim();
        if (!candidate) continue;
        if (!fallback) fallback = candidate;
        if (!normalizeNotionReferenceId(candidate) && !isNotionReferenceList(candidate)) {
            return candidate;
        }
    }

    return fallback;
}

function buildManualPasteMismatchSubstatus(result) {
    if (!result?.mismatch) return null;
    const sender = result.senderEmail || 'unknown sender';
    const expected = Array.isArray(result.expectedEmails) && result.expectedEmails.length > 0
        ? result.expectedEmails.join(', ')
        : 'known agency channels';
    return `Manual review required: pasted inbound sender ${sender} does not match expected agency channel(s): ${expected}`;
}

function hasImportReviewSignals({ importWarnings, agencies = [], casePauseReason, caseSubstatus }) {
    const hasWarnings = Array.isArray(importWarnings) && importWarnings.length > 0;
    const hasImportAgency = Array.isArray(agencies) && agencies.some((agency) =>
        ['notion_import', 'notion_relation', 'import_review_mask'].includes(String(agency?.added_source || ''))
    );
    const pauseReason = String(casePauseReason || '').trim().toUpperCase();
    const substatus = String(caseSubstatus || '').trim();

    return Boolean(
        hasWarnings ||
        hasImportAgency ||
        pauseReason === 'IMPORT_REVIEW' ||
        /imported case/i.test(substatus)
    );
}

function hasImportSafetyContext({ notionPageId, importWarnings, agencies = [], casePauseReason, caseSubstatus }) {
    return Boolean(
        notionPageId ||
        hasImportReviewSignals({ importWarnings, agencies, casePauseReason, caseSubstatus })
    );
}

function hasImportSafetyBlock(importSafety, importSafetyContext) {
    return Boolean(importSafety?.shouldBlockAutoDispatch && importSafetyContext);
}

function stripTrailingStateLabel(name, state) {
    const value = String(name || '').trim();
    if (!value) return null;
    const normalizedState = deriveDisplayState(state, state);
    if (!normalizedState) return value;

    const stateSuffixes = {
        AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California', CO: 'Colorado', CT: 'Connecticut', DE: 'Delaware', DC: 'District of Columbia',
        FL: 'Florida', GA: 'Georgia', HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois', IN: 'Indiana', IA: 'Iowa', KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana',
        ME: 'Maine', MD: 'Maryland', MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota', MS: 'Mississippi', MO: 'Missouri', MT: 'Montana', NE: 'Nebraska',
        NV: 'Nevada', NH: 'New Hampshire', NJ: 'New Jersey', NM: 'New Mexico', NY: 'New York', NC: 'North Carolina', ND: 'North Dakota', OH: 'Ohio', OK: 'Oklahoma',
        OR: 'Oregon', PA: 'Pennsylvania', RI: 'Rhode Island', SC: 'South Carolina', SD: 'South Dakota', TN: 'Tennessee', TX: 'Texas', UT: 'Utah', VT: 'Vermont',
        VA: 'Virginia', WA: 'Washington', WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming',
    };
    const fullName = stateSuffixes[normalizedState];
    if (!fullName) return value;

    return value.replace(new RegExp(`,\\s*${fullName}$`, 'i'), '').trim();
}

function buildImportBlockedAgencyDisplay({ metadataAgencyHint, narrativeAgencyName, caseState }) {
    const agencyName = stripTrailingStateLabel(
        metadataAgencyHint?.name || narrativeAgencyName || 'Unknown agency',
        caseState
    ) || 'Unknown agency';
    return {
        agency_id: null,
        agency_name: agencyName,
        agency_email: null,
        portal_url: null,
        portal_provider: null,
        state: deriveDisplayState(caseState, agencyName) || caseState || null,
    };
}

async function detectLatestInboundManualPasteMismatch(caseId) {
    try {
        if (!Number.isInteger(Number(caseId)) || Number(caseId) <= 0) return null;

        let threads = [];
        if (typeof db.getThreadsByCaseId === 'function') {
            threads = await db.getThreadsByCaseId(Number(caseId));
        } else if (typeof db.getThreadByCaseId === 'function') {
            const singleThread = await db.getThreadByCaseId(Number(caseId));
            threads = singleThread ? [singleThread] : [];
        }
        if (!threads.length || typeof db.getMessagesByThreadId !== 'function') return null;

        const messagesByThread = await Promise.all(
            threads.map(async (thread) => {
                const messages = await db.getMessagesByThreadId(thread.id);
                return Array.isArray(messages)
                    ? messages.map((message) => ({ ...message, __thread: thread }))
                    : [];
            })
        );

        const latestInboundPair = messagesByThread
            .flat()
            .filter((message) => String(message.direction || '').toUpperCase() === 'INBOUND')
            .sort((a, b) => {
                const aTime = new Date(a.created_at || a.received_at || 0).getTime();
                const bTime = new Date(b.created_at || b.received_at || 0).getTime();
                return bTime - aTime;
            })[0];

        if (!latestInboundPair) return null;

        const { __thread, ...latestInbound } = latestInboundPair;
        return shouldEscalateManualPasteMismatch(latestInbound, __thread || null, null);
    } catch (error) {
        logger.warn('[requests] skipped manual paste mismatch check', {
            case_id: caseId,
            error: error.message,
        });
        return null;
    }
}

function applyManualPasteMismatchListOverride(listItem, mismatch) {
    if (!mismatch?.mismatch) return listItem;

    return {
        ...listItem,
        status: 'NEEDS_HUMAN_REVIEW',
        requires_human: true,
        pause_reason: 'MANUAL_PASTE_MISMATCH',
        substatus: buildManualPasteMismatchSubstatus(mismatch),
        review_state: 'IDLE',
        control_state: 'BLOCKED',
        control_mismatches: [],
    };
}

/**
 * GET /api/requests
 * List requests with filters
 */
router.get('/', async (req, res) => {
    try {
        const { requires_human, status, agency_id, q } = req.query;
        const userIdParam = req.query.user_id;
        const userId = userIdParam && userIdParam !== 'unowned' ? parseInt(userIdParam, 10) || null : null;
        const unownedOnly = userIdParam === 'unowned';

        const includeCompleted = req.query.include_completed === 'true';

        let query = `
            SELECT
                c.*,
                ar.status AS active_run_status,
                ar.trigger_type AS active_run_trigger_type,
                ar.started_at AS active_run_started_at,
                ar.trigger_run_id AS active_run_trigger_run_id,
                pt.status AS active_portal_task_status,
                pt.action_type AS active_portal_task_type,
                pp.status AS active_proposal_status,
                mc.message_count,
                mc.outbound_count,
                tc.thread_count,
                psc.portal_submission_count
            FROM cases c
            LEFT JOIN LATERAL (
                SELECT
                    status,
                    trigger_type,
                    started_at,
                    COALESCE(metadata->>'triggerRunId', metadata->>'trigger_run_id') AS trigger_run_id
                FROM agent_runs
                WHERE case_id = c.id
                  AND status IN ('created', 'queued', 'processing', 'waiting', 'running')
                ORDER BY started_at DESC NULLS LAST, id DESC
                LIMIT 1
            ) ar ON TRUE
            LEFT JOIN LATERAL (
                SELECT status, action_type
                FROM portal_tasks
                WHERE case_id = c.id
                  AND status IN ('PENDING', 'IN_PROGRESS')
                ORDER BY updated_at DESC NULLS LAST, id DESC
                LIMIT 1
            ) pt ON TRUE
            LEFT JOIN LATERAL (
                SELECT status
                FROM proposals
                WHERE case_id = c.id
                  AND status IN (${ACTIVE_PROPOSAL_STATUSES_SQL})
                ORDER BY created_at DESC
                LIMIT 1
            ) pp ON TRUE
            LEFT JOIN LATERAL (
                SELECT
                    COUNT(*)::int AS message_count,
                    COUNT(*) FILTER (WHERE direction = 'outbound')::int AS outbound_count
                FROM messages
                WHERE case_id = c.id
            ) mc ON TRUE
            LEFT JOIN LATERAL (
                SELECT COUNT(*)::int AS thread_count
                FROM email_threads
                WHERE case_id = c.id
            ) tc ON TRUE
            LEFT JOIN LATERAL (
                SELECT COUNT(*)::int AS portal_submission_count
                FROM portal_submissions
                WHERE case_id = c.id
            ) psc ON TRUE
            WHERE ${buildRealCaseWhereClause('c', 'm_filter')}
        `;
        const params = [];

        // User ownership filter (must match queue/monitor semantics)
        if (userId) {
            params.push(userId);
            query += ` AND c.user_id = $${params.length}`;
        } else if (unownedOnly) {
            query += ` AND c.user_id IS NULL`;
        }

        // Exclude bugged cases from the normal operator list unless explicitly requested.
        // Completed/cancelled stay optional behind include_completed.
        if (!status) {
            query += ` AND c.status != 'bugged'`;
        }

        if (!includeCompleted && !status) {
            query += ` AND c.status NOT IN ('completed', 'cancelled')`;
        }

        // Filter by requires_human
        if (requires_human === 'true') {
            params.push(true);
            query += ` AND c.requires_human = $${params.length}`;
        } else if (requires_human === 'false') {
            params.push(false);
            query += ` AND (c.requires_human = $${params.length} OR c.requires_human IS NULL)`;
        }

        // Filter by status (map from API format to DB format)
        if (status) {
            const dbStatuses = Object.entries(STATUS_MAP)
                .filter(([_, v]) => v === status)
                .map(([k]) => k);
            if (dbStatuses.length > 0) {
                params.push(dbStatuses);
                query += ` AND c.status = ANY($${params.length})`;
            }
        }

        // Full-text search across case fields + email content
        if (q) {
            params.push(`%${q}%`);
            const p = params.length;
            query += ` AND (c.subject_name ILIKE $${p} OR c.agency_name ILIKE $${p} OR c.case_name ILIKE $${p} OR CAST(c.id AS TEXT) LIKE $${p} OR EXISTS (SELECT 1 FROM messages m WHERE m.case_id = c.id AND (m.subject ILIKE $${p} OR COALESCE(m.normalized_body_text, m.body_text) ILIKE $${p} OR m.from_email ILIKE $${p})))`;
        }

        // Sort: requires_human first (by next_due_at), then by last_activity
        query += `
            ORDER BY
                c.requires_human DESC NULLS LAST,
                CASE WHEN c.requires_human = true THEN c.next_due_at END ASC NULLS LAST,
                c.updated_at DESC
            LIMIT 500
        `;

        const result = await db.query(query, params);
        const caseIds = result.rows
            .map((row) => Number(row.id))
            .filter((id) => Number.isInteger(id) && id > 0);

        const listAgencyOverrides = new Map();
        if (caseIds.length > 0) {
            const caseAgencyResult = await db.query(
                `SELECT DISTINCT ON (ca.case_id)
                    ca.case_id,
                    ca.agency_id,
                    ca.agency_name,
                    ca.agency_email,
                    ca.portal_url,
                    ca.portal_provider,
                    ca.added_source,
                    a.name AS canonical_agency_name,
                    a.state AS canonical_state,
                    a.email_main AS canonical_email_main,
                    a.email_foia AS canonical_email_foia,
                    a.portal_url AS canonical_portal_url,
                    a.portal_url_alt AS canonical_portal_url_alt,
                    a.portal_provider AS canonical_portal_provider
                 FROM case_agencies ca
                 LEFT JOIN agencies a ON a.id = ca.agency_id
                 WHERE ca.case_id = ANY($1::int[])
                 ORDER BY
                    ca.case_id,
                    ca.is_primary DESC,
                    COALESCE(ca.is_active, true) DESC,
                    CASE
                        WHEN LOWER(COALESCE(ca.status, 'active')) = 'active' THEN 0
                        WHEN LOWER(COALESCE(ca.status, '')) = 'pending' THEN 1
                        ELSE 2
                    END,
                    ca.updated_at DESC NULLS LAST,
                    ca.id DESC`,
                [caseIds]
            );

            for (const row of caseAgencyResult.rows) {
                listAgencyOverrides.set(Number(row.case_id), row);
            }
        }

        const requests = await Promise.all(result.rows.map(async (row) => {
            const manualPasteMismatch = (
                row.active_proposal_status ||
                String(row.active_run_trigger_type || '').toLowerCase() === 'inbound_message'
            )
                ? await detectLatestInboundManualPasteMismatch(Number(row.id))
                : null;
            const normalizedRowState = row.state === '{}' ? null : row.state;
            const override = listAgencyOverrides.get(Number(row.id));
            const ignoreOverrideForDisplay = override?.added_source === 'wrong_agency_referral';
            const researchSuggestedAgency = extractResearchSuggestedAgency(row.contact_research_notes);
            const researchCanonical = researchSuggestedAgency
                ? await findCanonicalAgency(db, {
                    portalUrl: null,
                    portalMailbox: null,
                    agencyEmail: null,
                    agencyName: researchSuggestedAgency.name,
                    stateHint: normalizedRowState,
                })
                : null;

            if (!override || ignoreOverrideForDisplay) {
                const displayRow = ignoreOverrideForDisplay
                    ? {
                        ...row,
                        agency_id: row.agency_id || null,
                        agency_email: row.agency_email || override.agency_email || null,
                        portal_url: row.portal_url || override.portal_url || null,
                        portal_provider: row.portal_provider || override.portal_provider || null,
                    }
                    : row;
                const metadataAgencyHint = extractMetadataAgencyHint(row.additional_details);
                const importSafety = evaluateImportAutoDispatchSafety({
                    caseName: row.case_name,
                    subjectName: row.subject_name,
                    agencyName: displayRow.agency_name,
                    state: normalizedRowState,
                    additionalDetails: row.additional_details,
                    importWarnings: row.import_warnings,
                    agencyEmail: displayRow.agency_email,
                    portalUrl: displayRow.portal_url,
                });
                const importSafetyReasonDetail = importSafety.metadataMismatch?.expectedAgencyName
                    ? `Imported case agency does not match case details (${importSafety.metadataMismatch.expectedAgencyName})`
                    : importSafety.agencyStateMismatch
                        ? `Imported case state (${importSafety.agencyStateMismatch.caseState}) does not match routed agency state (${importSafety.agencyStateMismatch.agencyState})`
                        : importSafety.agencyCityMismatch
                            ? `Imported case city (${importSafety.agencyCityMismatch.expectedCity}) does not match routed agency (${importSafety.agencyCityMismatch.currentAgencyName})`
                            : importSafety.reasonCode === 'PLACEHOLDER_TITLE'
                                ? 'Imported case title/subject is still placeholder text'
                                : 'Imported case needs human review before sending';
                const canForceCorrectedAgencyDisplay = !override || ['case_row_backfill', 'case_row_fallback'].includes(String(override.added_source || ''));
                const metadataAgencyMismatch = detectCaseMetadataAgencyMismatch({
                    currentAgencyName: displayRow.agency_name,
                    additionalDetails: row.additional_details,
                });
                const syntheticPlaceholderDisplay = hasSyntheticPlaceholderBackfill({
                    agencyEmail: displayRow.agency_email,
                    portalUrl: displayRow.portal_url,
                    addedSource: ignoreOverrideForDisplay ? override.added_source : 'case_row_backfill',
                });
                const preferResearchDisplay = shouldPreferResearchAgencyDisplay({
                    researchSuggestedAgency,
                    agencyEmail: displayRow.agency_email,
                    portalUrl: displayRow.portal_url,
                    addedSource: ignoreOverrideForDisplay ? override.added_source : 'case_row_backfill',
                });
                const suppressPlaceholderDisplay = shouldSuppressPlaceholderAgencyDisplay({
                    contactResearchNotes: displayRow.contact_research_notes,
                    agencyEmail: displayRow.agency_email,
                    portalUrl: displayRow.portal_url,
                    addedSource: ignoreOverrideForDisplay ? override.added_source : 'case_row_backfill',
                }) || (syntheticPlaceholderDisplay && !researchSuggestedAgency);
                const forceCorrectedAgencyDisplay = (canForceCorrectedAgencyDisplay && shouldForceCorrectedAgencyDisplay({
                    currentAgencyName: displayRow.agency_name,
                    caseAgencyName: row.agency_name,
                    additionalDetails: row.additional_details,
                    researchSuggestedAgency,
                    currentAgencyEmail: displayRow.agency_email,
                    currentPortalUrl: displayRow.portal_url,
                    metadataAgencyMismatch,
                })) || shouldOverrideStaleExistingChannelDisplay({
                    contactResearchNotes: row.contact_research_notes,
                    currentAgencyName: displayRow.agency_name,
                    researchSuggestedAgency,
                    currentAgencyEmail: displayRow.agency_email,
                    currentPortalUrl: displayRow.portal_url,
                });
                const correctedAgencyDisplay = buildCorrectedAgencyDisplay({
                    researchCanonical,
                    researchSuggestedAgency,
                    metadataAgencyMismatch,
                    caseAgencyName: row.agency_name,
                    caseState: normalizedRowState,
                });
                const narrativeAgencyName = (
                    normalizeNotionReferenceId(displayRow.agency_name || row.agency_name)
                    || isNotionReferenceList(displayRow.agency_name || row.agency_name)
                    || isGenericAgencyLabel(displayRow.agency_name || row.agency_name)
                )
                    ? (metadataAgencyHint?.name || extractAgencyNameFromAdditionalDetails(row.additional_details))
                    : null;
                const importSafetyContext = hasImportSafetyContext({
                    notionPageId: row.notion_page_id,
                    importWarnings: row.import_warnings,
                    agencies: [displayRow],
                    casePauseReason: row.pause_reason,
                    caseSubstatus: row.substatus,
                });
                const importSafetyBlocked = hasImportSafetyBlock(importSafety, importSafetyContext);
                const suppressImportBlockedAgencyDisplay = importSafetyBlocked && (hasImportReviewSignals({
                    importWarnings: row.import_warnings,
                    agencies: [displayRow],
                    casePauseReason: row.pause_reason,
                    caseSubstatus: row.substatus,
                }) || !displayRow.active_proposal_status);
                const importBlockedAgencyDisplay = buildImportBlockedAgencyDisplay({
                    metadataAgencyHint,
                    narrativeAgencyName,
                    caseState: normalizedRowState,
                });
                const notionAgencyOverride = (!suppressImportBlockedAgencyDisplay && !suppressPlaceholderDisplay && !preferResearchDisplay && !forceCorrectedAgencyDisplay)
                    ? await lookupAgencyByNotionReference(displayRow.agency_name || row.agency_name)
                    : null;
                const resolvedDisplayName = pickAgencyDisplayName(
                    suppressImportBlockedAgencyDisplay
                        ? importBlockedAgencyDisplay.agency_name
                        : forceCorrectedAgencyDisplay
                        ? correctedAgencyDisplay.name
                        : preferResearchDisplay
                        ? (researchCanonical?.name || researchSuggestedAgency.name)
                        : (
                            suppressPlaceholderDisplay
                                ? (metadataAgencyHint?.name || narrativeAgencyName || 'Unknown agency')
                                : notionAgencyOverride?.name
                        ),
                    narrativeAgencyName,
                    displayRow.agency_name,
                    row.agency_name
                );
                return applyManualPasteMismatchListOverride(toRequestListItem({
                    ...displayRow,
                    ...(importSafetyBlocked
                        ? {
                            status: 'needs_human_review',
                            pause_reason: 'IMPORT_REVIEW',
                            substatus: importSafetyReasonDetail,
                            requires_human: true,
                        }
                        : {}),
                    agency_id: suppressImportBlockedAgencyDisplay
                        ? null
                        : suppressPlaceholderDisplay
                        ? null
                        : forceCorrectedAgencyDisplay
                        ? correctedAgencyDisplay.id
                        : preferResearchDisplay
                        ? (researchCanonical?.id || displayRow.agency_id || null)
                        : (notionAgencyOverride?.id || displayRow.agency_id || null),
                    agency_name: resolvedDisplayName,
                    agency_email: suppressImportBlockedAgencyDisplay
                        ? null
                        : forceCorrectedAgencyDisplay
                        ? correctedAgencyDisplay.email
                        : preferResearchDisplay
                        ? (normalizeAgencyEmailHint(researchCanonical?.email_foia || researchCanonical?.email_main) || null)
                        : (suppressPlaceholderDisplay ? null : (normalizeAgencyEmailHint(notionAgencyOverride?.email_foia || notionAgencyOverride?.email_main) || displayRow.agency_email)),
                    state: suppressImportBlockedAgencyDisplay
                        ? importBlockedAgencyDisplay.state
                        : forceCorrectedAgencyDisplay
                        ? correctedAgencyDisplay.state
                        : preferResearchDisplay
                        ? deriveDisplayState(researchCanonical?.state || normalizedRowState, researchCanonical?.name || researchSuggestedAgency?.name)
                        : deriveDisplayState(notionAgencyOverride?.state || normalizedRowState, notionAgencyOverride?.name || displayRow.agency_name),
                    portal_url: suppressImportBlockedAgencyDisplay
                        ? null
                        : forceCorrectedAgencyDisplay
                        ? correctedAgencyDisplay.portalUrl
                        : preferResearchDisplay
                        ? normalizePortalUrl(researchCanonical?.portal_url || researchCanonical?.portal_url_alt || null)
                        : (suppressPlaceholderDisplay ? null : (normalizePortalUrl(notionAgencyOverride?.portal_url || notionAgencyOverride?.portal_url_alt || null) || displayRow.portal_url)),
                    portal_provider: suppressImportBlockedAgencyDisplay
                        ? null
                        : forceCorrectedAgencyDisplay
                        ? correctedAgencyDisplay.portalProvider
                        : preferResearchDisplay
                        ? (researchCanonical?.portal_provider || null)
                        : (suppressPlaceholderDisplay ? null : (notionAgencyOverride?.portal_provider || displayRow.portal_provider)),
                }), manualPasteMismatch);
            }

            const canonicalOverride = await findCanonicalAgency(db, {
                portalUrl: override.portal_url,
                portalMailbox: override.agency_email,
                agencyEmail: override.agency_email,
                agencyName: override.agency_name,
                stateHint: override.canonical_state === '{}' ? normalizedRowState : (override.canonical_state || normalizedRowState),
            });
            const normalizedCanonicalState = override.canonical_state === '{}' ? null : override.canonical_state;
            const canonicalOverrideState = canonicalOverride?.state === '{}' ? null : canonicalOverride?.state;
            const canForceCorrectedAgencyDisplay = ['case_row_backfill', 'case_row_fallback'].includes(String(override.added_source || ''));
            const metadataAgencyMismatch = detectCaseMetadataAgencyMismatch({
                currentAgencyName: canonicalOverride?.name || override.canonical_agency_name || override.agency_name || row.agency_name,
                additionalDetails: row.additional_details,
            });
            const preferResearchDisplay = shouldPreferResearchAgencyDisplay({
                researchSuggestedAgency,
                agencyEmail: override.agency_email || row.agency_email,
                portalUrl: override.portal_url || row.portal_url,
                addedSource: override.added_source,
            });
            const syntheticPlaceholderDisplay = hasSyntheticPlaceholderBackfill({
                agencyEmail: override.agency_email || row.agency_email,
                portalUrl: override.portal_url || row.portal_url,
                addedSource: override.added_source,
            });
            const suppressPlaceholderDisplay = shouldSuppressPlaceholderAgencyDisplay({
                contactResearchNotes: row.contact_research_notes,
                agencyEmail: override.agency_email || row.agency_email,
                portalUrl: override.portal_url || row.portal_url,
                addedSource: override.added_source,
            }) || (syntheticPlaceholderDisplay && !researchSuggestedAgency);
            const forceCorrectedAgencyDisplay = (canForceCorrectedAgencyDisplay && shouldForceCorrectedAgencyDisplay({
                currentAgencyName: canonicalOverride?.name || override.canonical_agency_name || override.agency_name || row.agency_name,
                caseAgencyName: row.agency_name,
                additionalDetails: row.additional_details,
                researchSuggestedAgency,
                currentAgencyEmail: override.agency_email || row.agency_email,
                currentPortalUrl: override.portal_url || row.portal_url,
                metadataAgencyMismatch,
            })) || shouldOverrideStaleExistingChannelDisplay({
                contactResearchNotes: row.contact_research_notes,
                currentAgencyName: canonicalOverride?.name || override.canonical_agency_name || override.agency_name || row.agency_name,
                researchSuggestedAgency,
                currentAgencyEmail: override.agency_email || row.agency_email,
                currentPortalUrl: override.portal_url || row.portal_url,
            });
            const correctedAgencyDisplay = buildCorrectedAgencyDisplay({
                researchCanonical,
                researchSuggestedAgency,
                metadataAgencyMismatch,
                caseAgencyName: row.agency_name,
                caseState: normalizedRowState,
            });
            const metadataAgencyHint = extractMetadataAgencyHint(row.additional_details);
            const narrativeAgencyName = (
                normalizeNotionReferenceId(override.agency_name || row.agency_name)
                || isNotionReferenceList(override.agency_name || row.agency_name)
                || isGenericAgencyLabel(override.agency_name || row.agency_name)
            )
                ? (metadataAgencyHint?.name || extractAgencyNameFromAdditionalDetails(row.additional_details))
                : null;
            const importSafety = evaluateImportAutoDispatchSafety({
                caseName: row.case_name,
                subjectName: row.subject_name,
                agencyName: canonicalOverride?.name || override.canonical_agency_name || override.agency_name || row.agency_name,
                state: normalizedRowState,
                additionalDetails: row.additional_details,
                importWarnings: row.import_warnings,
                agencyEmail: override.agency_email || row.agency_email,
                portalUrl: override.portal_url || row.portal_url,
            });
            const importSafetyBlocked = hasImportSafetyBlock(importSafety, hasImportReviewSignals({
                importWarnings: row.import_warnings,
                agencies: [override],
                casePauseReason: row.pause_reason,
                caseSubstatus: row.substatus,
            }));
            const suppressImportBlockedAgencyDisplay = importSafetyBlocked;
            const importBlockedAgencyDisplay = buildImportBlockedAgencyDisplay({
                metadataAgencyHint,
                narrativeAgencyName,
                caseState: normalizedRowState,
            });
            const notionAgencyOverride = (!suppressImportBlockedAgencyDisplay && !suppressPlaceholderDisplay && !preferResearchDisplay && !forceCorrectedAgencyDisplay)
                ? await lookupAgencyByNotionReference(override.agency_name || row.agency_name)
                : null;

            const resolvedAgencyName = pickAgencyDisplayName(
                suppressImportBlockedAgencyDisplay
                    ? importBlockedAgencyDisplay.agency_name
                    : suppressPlaceholderDisplay
                    ? (metadataAgencyHint?.name || narrativeAgencyName || 'Unknown agency')
                    : forceCorrectedAgencyDisplay
                    ? correctedAgencyDisplay.name
                    : preferResearchDisplay
                    ? (researchCanonical?.name || researchSuggestedAgency?.name || null)
                    : notionAgencyOverride?.name,
                narrativeAgencyName,
                canonicalOverride?.name,
                override.canonical_agency_name,
                override.agency_name,
                row.agency_name
            );
            const resolvedAgencyEmail = normalizeAgencyEmailHint(
                suppressImportBlockedAgencyDisplay
                    ? null
                    : suppressPlaceholderDisplay
                    ? null
                    : forceCorrectedAgencyDisplay
                    ? correctedAgencyDisplay.email
                    : preferResearchDisplay
                    ? (researchCanonical?.email_foia || researchCanonical?.email_main || null)
                    : (
                        override.agency_email ||
                        notionAgencyOverride?.email_foia ||
                        notionAgencyOverride?.email_main ||
                        canonicalOverride?.email_foia ||
                        canonicalOverride?.email_main ||
                        override.canonical_email_foia ||
                        override.canonical_email_main ||
                        row.agency_email
                    )
            );
            const resolvedPortalUrl = [
                suppressImportBlockedAgencyDisplay ? null : (forceCorrectedAgencyDisplay ? correctedAgencyDisplay.portalUrl : null),
                (suppressImportBlockedAgencyDisplay || preferResearchDisplay || suppressPlaceholderDisplay) ? null : override.portal_url,
                (suppressImportBlockedAgencyDisplay || preferResearchDisplay || suppressPlaceholderDisplay) ? null : notionAgencyOverride?.portal_url,
                (suppressImportBlockedAgencyDisplay || preferResearchDisplay || suppressPlaceholderDisplay) ? null : notionAgencyOverride?.portal_url_alt,
                suppressImportBlockedAgencyDisplay ? null : (preferResearchDisplay ? researchCanonical?.portal_url : canonicalOverride?.portal_url),
                suppressImportBlockedAgencyDisplay ? null : (preferResearchDisplay ? researchCanonical?.portal_url_alt : canonicalOverride?.portal_url_alt),
                (suppressImportBlockedAgencyDisplay || preferResearchDisplay || suppressPlaceholderDisplay) ? null : override.canonical_portal_url,
                (suppressImportBlockedAgencyDisplay || preferResearchDisplay || suppressPlaceholderDisplay) ? null : override.canonical_portal_url_alt,
                (suppressImportBlockedAgencyDisplay || preferResearchDisplay || suppressPlaceholderDisplay) ? null : row.portal_url,
            ].map((value) => normalizePortalUrl(value)).find(Boolean) || null;
            const resolvedPortalProvider =
                (suppressImportBlockedAgencyDisplay
                    ? null
                    : (suppressPlaceholderDisplay
                    ? null
                    : forceCorrectedAgencyDisplay
                    ? correctedAgencyDisplay.portalProvider
                    : (preferResearchDisplay
                    ? researchCanonical?.portal_provider
                    : (
                        notionAgencyOverride?.portal_provider ||
                        override.portal_provider ||
                        canonicalOverride?.portal_provider ||
                        override.canonical_portal_provider
                    )))) ||
                detectPortalProviderByUrl(resolvedPortalUrl)?.name ||
                ((suppressImportBlockedAgencyDisplay || preferResearchDisplay || suppressPlaceholderDisplay) ? null : row.portal_provider) ||
                null;

            return applyManualPasteMismatchListOverride(toRequestListItem({
                ...row,
                agency_id: suppressImportBlockedAgencyDisplay
                    ? null
                    : suppressPlaceholderDisplay
                    ? null
                    : preferResearchDisplay
                    ? (researchCanonical?.id || override.agency_id || row.agency_id || null)
                    : (notionAgencyOverride?.id || canonicalOverride?.id || override.agency_id || row.agency_id || null),
                agency_name: resolvedAgencyName,
                agency_email: suppressImportBlockedAgencyDisplay
                    ? null
                    : preferResearchDisplay
                    ? (resolvedAgencyEmail || null)
                    : (forceCorrectedAgencyDisplay ? (resolvedAgencyEmail || null) : (resolvedAgencyEmail || row.agency_email || null)),
                state: suppressImportBlockedAgencyDisplay
                    ? importBlockedAgencyDisplay.state
                    : deriveDisplayState(
                        forceCorrectedAgencyDisplay
                            ? correctedAgencyDisplay.state
                            : preferResearchDisplay
                            ? (researchCanonical?.state || normalizedRowState)
                            : (notionAgencyOverride?.state || canonicalOverrideState || normalizedCanonicalState || normalizedRowState || null),
                        resolvedAgencyName
                    ),
                portal_url: suppressImportBlockedAgencyDisplay
                    ? null
                    : preferResearchDisplay
                    ? (resolvedPortalUrl || null)
                    : (forceCorrectedAgencyDisplay ? (resolvedPortalUrl || null) : (resolvedPortalUrl || row.portal_url || null)),
                portal_provider: suppressImportBlockedAgencyDisplay ? null : resolvedPortalProvider,
            }), manualPasteMismatch);
        }));

        // Fetch completed cases separately (most recent 50)
        const completedResult = await db.query(`
            SELECT c.* FROM cases c
            WHERE c.status IN ('completed', 'cancelled')
            ${userId ? `AND c.user_id = ${userId}` : ''}
            ${unownedOnly ? 'AND c.user_id IS NULL' : ''}
            ORDER BY c.closed_at DESC NULLS LAST, c.updated_at DESC
            LIMIT 50
        `);
        const completed = completedResult.rows.map((row) => toRequestListItem({
            ...row,
            state: row.state === '{}' ? null : row.state,
        }));

        // Separate into paused and ongoing for client convenience
        const paused = requests.filter(r => r.requires_human);
        const ongoing = requests.filter(r => !r.requires_human);

        res.json({
            success: true,
            count: requests.length,
            paused_count: paused.length,
            ongoing_count: ongoing.length,
            completed_count: completed.length,
            requests,
            completed
        });
    } catch (error) {
        console.error('Error fetching requests:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

/**
 * GET /api/requests/:id
 * Get single request details
 */
router.get('/:id', async (req, res) => {
    try {
        const requestId = parseInt(req.params.id);
        const rawCaseData = await db.getCaseById(requestId);
        let caseData = await attachActivePortalTask(rawCaseData);

        if (!caseData) {
            return res.status(404).json({
                success: false,
                error: 'Request not found'
            });
        }

        // Keep detail endpoint state in sync with workspace/queue by attaching
        // active proposal/run truth before deriving review/control state.
        const [activeRunResult, activeProposalResult] = await Promise.all([
            db.query(
                `SELECT
                    status,
                    trigger_type,
                    started_at,
                    COALESCE(metadata->>'triggerRunId', metadata->>'trigger_run_id') AS trigger_run_id
                 FROM agent_runs
                 WHERE case_id = $1
                   AND status IN ('created', 'queued', 'processing', 'waiting', 'running')
                 ORDER BY started_at DESC NULLS LAST, id DESC
                 LIMIT 1`,
                [requestId]
            ),
            db.query(
                `SELECT status
                 FROM proposals
                 WHERE case_id = $1
                   AND status IN (${ACTIVE_PROPOSAL_STATUSES_SQL})
                 ORDER BY created_at DESC
                 LIMIT 1`,
                [requestId]
            ),
        ]);

        caseData = {
            ...caseData,
            active_run_status: activeRunResult.rows[0]?.status || null,
            active_run_trigger_type: activeRunResult.rows[0]?.trigger_type || null,
            active_run_started_at: activeRunResult.rows[0]?.started_at || null,
            active_run_trigger_run_id: activeRunResult.rows[0]?.trigger_run_id || null,
            active_proposal_status: activeProposalResult.rows[0]?.status || null,
        };

        res.json({
            success: true,
            request: toRequestDetail(caseData)
        });
    } catch (error) {
        console.error('Error fetching request:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

/**
 * GET /api/requests/:id/workspace
 * Get combined detail for request workspace (single fetch)
 */
router.get('/:id/workspace', async (req, res) => {
    try {
        const requestId = parseInt(req.params.id);

        // Fetch case data
        const rawCaseData = await db.getCaseById(requestId);
        let caseData = await attachActivePortalTask(rawCaseData);
        if (!caseData) {
            return res.status(404).json({
                success: false,
                error: 'Request not found'
            });
        }

        // Fetch threads and messages (compat: older runtime may only expose getThreadByCaseId)
        let threads = [];
        if (typeof db.getThreadsByCaseId === 'function') {
            threads = await db.getThreadsByCaseId(requestId);
        } else {
            const singleThread = await db.getThreadByCaseId(requestId);
            threads = singleThread ? [singleThread] : [];
        }
        const latestThread = threads.length > 0 ? threads[threads.length - 1] : null;
        let threadMessages = [];
        let analysisMap = {};
        let latestInboundMessageForGuard = null;
        let latestInboundThreadForGuard = null;
        const caseAttachments = await db.getAttachmentsByCaseId(requestId);

        if (threads.length > 0) {
            const threadMessagesByThread = await Promise.all(
                threads.map(async (thread) => {
                    const messages = await db.getMessagesByThreadId(thread.id);
                    return messages;
                })
            );
            const messagesWithThread = threadMessagesByThread
                .flatMap((messagesForThread, index) => {
                    const thread = threads[index];
                    return messagesForThread.map((message) => ({
                        ...message,
                        __thread: thread,
                    }));
                })
                .sort((a, b) => {
                    const aTime = new Date(a.sent_at || a.received_at || a.created_at || 0).getTime();
                    const bTime = new Date(b.sent_at || b.received_at || b.created_at || 0).getTime();
                    if (aTime !== bTime) return aTime - bTime;
                    return Number(a.id || 0) - Number(b.id || 0);
                });
            const messages = messagesWithThread.map(({ __thread, ...message }) => message);
            const latestInboundPair = [...messagesWithThread]
                .reverse()
                .find((message) => message.direction === 'inbound');
            latestInboundMessageForGuard = latestInboundPair
                ? Object.fromEntries(Object.entries(latestInboundPair).filter(([key]) => key !== '__thread'))
                : null;
            latestInboundThreadForGuard = latestInboundPair?.__thread || latestThread || null;

            // Fetch analysis for all inbound messages first
            for (const msg of messages.filter(m => m.direction === 'inbound')) {
                const analysis = await db.getAnalysisByMessageId(msg.id);
                if (analysis) {
                    analysisMap[msg.id] = analysis;
                }
            }

            // Group attachments by message_id (caseAttachments fetched above)
            const attachmentsByMessageId = {};
            for (const att of caseAttachments) {
                if (!attachmentsByMessageId[att.message_id]) {
                    attachmentsByMessageId[att.message_id] = [];
                }
                attachmentsByMessageId[att.message_id].push({
                    id: att.id,
                    filename: att.filename,
                    content_type: att.content_type,
                    size_bytes: att.size_bytes,
                    url: att.storage_url || null,
                });
            }

            // Build thread messages with analysis data attached
            threadMessages = messages.map(msg => {
                const tm = toThreadMessage(msg, attachmentsByMessageId[msg.id] || [], caseData);
                const analysis = analysisMap[msg.id];
                if (analysis) {
                    tm.classification = analysis.intent || null;
                    tm.summary = Array.isArray(analysis.key_points)
                        ? analysis.key_points.join('; ')
                        : (analysis.key_points || null);
                    tm.sentiment = analysis.sentiment || null;
                }
                return tm;
            });
        }
        let portalSubmissionCount = 0;
        try {
            const portalSubmissionCountResult = await db.query(
                `SELECT COUNT(*)::int AS count
                 FROM portal_submissions
                 WHERE case_id = $1`,
                [requestId]
            );
            portalSubmissionCount = Number(portalSubmissionCountResult.rows[0]?.count || 0);
        } catch (error) {
            logger.warn('[workspace] failed to load portal submission count', {
                case_id: requestId,
                error: error.message,
            });
        }
        caseData = {
            ...caseData,
            message_count: threadMessages.length,
            outbound_count: threadMessages.filter((message) => message.direction === 'OUTBOUND').length,
            thread_count: threads.length,
            portal_submission_count: portalSubmissionCount,
        };

        // Fetch activity log for timeline events
        const [activityResult, constraintHistoryResult, portalSubmissionRows] = await Promise.all([
            db.query(
                `SELECT * FROM activity_log
                 WHERE case_id = $1
                 ORDER BY created_at DESC
                 LIMIT 50`,
                [requestId]
            ),
            // Dedicated constraint history query (not subject to timeline LIMIT)
            db.query(
                `SELECT id, event_type, description, meta_jsonb, created_at,
                        COALESCE(meta_jsonb->>'actor_type', 'system') AS actor_type,
                        meta_jsonb->>'source_service' AS source_service
                 FROM activity_log
                 WHERE case_id = $1
                   AND event_type IN ('constraint_detected', 'constraint_added', 'constraint_removed')
                 ORDER BY created_at ASC`,
                [requestId]
            ),
            db.getPortalSubmissions(requestId, { limit: 20 }).catch((error) => {
                logger.warn('[workspace] failed to load portal submissions', {
                    case_id: requestId,
                    error: error.message,
                });
                return [];
            }),
        ]);
        const activityRows = activityResult.rows || [];
        const portalSubmissions = Array.isArray(portalSubmissionRows) ? portalSubmissionRows : [];
        const timelineEvents = dedupeTimelineEvents(activityRows.map(a => toTimelineEvent(a, analysisMap, caseData)));

        // Build constraint history from dedicated query
        const constraintHistory = (constraintHistoryResult.rows || []).map(row => ({
            id: row.id,
            event: row.event_type,
            description: row.description,
            constraint: row.meta_jsonb?.constraint || row.meta_jsonb?.constraint_type || null,
            actor: row.actor_type,
            source: row.source_service || null,
            timestamp: row.created_at,
        }));

        // Build next action proposal from latest pending reply
        let nextActionProposal = null;
        const latestPendingReply = await db.query(
            `SELECT * FROM auto_reply_queue
             WHERE case_id = $1 AND status = 'pending'
             ORDER BY created_at DESC
             LIMIT 1`,
            [requestId]
        );

        if (latestPendingReply.rows.length > 0) {
            const reply = latestPendingReply.rows[0];

            // Parse JSONB fields with fallbacks
            const reasoning = reply.reasoning_jsonb || ['AI-generated response to agency message'];
            const warnings = reply.warnings_jsonb || [];
            const constraintsApplied = reply.constraints_applied_jsonb || [];

            nextActionProposal = {
                id: String(reply.id),
                action_type: reply.action_type || 'SEND_EMAIL',
                proposal: reply.proposal_short || `Send ${reply.response_type || 'auto'} reply`,
                proposal_short: reply.proposal_short,
                reasoning: Array.isArray(reasoning) ? reasoning : [reasoning],
                confidence: reply.confidence_score ? parseFloat(reply.confidence_score) : 0.8,
                risk_flags: reply.requires_approval ? ['Requires Approval'] : [],
                warnings: Array.isArray(warnings) ? warnings : [],
                can_auto_execute: !reply.requires_approval,
                blocked_reason: reply.blocked_reason || (reply.requires_approval ? 'Requires human approval' : null),
                draft_content: reply.generated_reply,
                draft_preview: reply.generated_reply ? reply.generated_reply.substring(0, 200) : null,
                constraints_applied: Array.isArray(constraintsApplied) ? constraintsApplied : []
            };
        }

        // Build agency summary with rules
        // Note: In a full implementation, these rules would come from an agencies table
        // For now, we derive some from case context or use defaults
        const feeQuote = parseFeeQuote(caseData);
        const constraints = parseConstraints(caseData);

        const caseAgencies = await db.getCaseAgencies(requestId, false);
        const normalizedCaseAgencies = dedupeCaseAgencies(caseAgencies.map((agency) => ({
            ...agency,
            portal_url: normalizePortalUrl(agency.portal_url) || null,
        })));
        const primaryCaseAgency =
            normalizedCaseAgencies.find((agency) => agency.is_primary) ||
            normalizedCaseAgencies[0] ||
            null;
        const primaryCaseAgencyIsSynthetic = Boolean(
            primaryCaseAgency &&
            ['case_row_backfill', 'case_row_fallback'].includes(primaryCaseAgency.added_source)
        );
        const preferredCaseAgency = primaryCaseAgency && !primaryCaseAgencyIsSynthetic
            ? primaryCaseAgency
            : null;
        const researchSuggestedAgency = extractResearchSuggestedAgency(caseData.contact_research_notes);
        const recoveredPortalUrl = extractLatestSupportedPortalUrl(activityRows, caseAgencies, caseData.portal_url);
        if (recoveredPortalUrl && recoveredPortalUrl !== caseData.portal_url) {
            caseData = {
                ...caseData,
                portal_url: recoveredPortalUrl,
                portal_provider: caseData.portal_provider || detectPortalProviderByUrl(recoveredPortalUrl)?.name || null,
            };
        } else if (!normalizePortalUrl(caseData.portal_url) && caseData.portal_url) {
            caseData = {
                ...caseData,
                portal_url: null,
            };
        }

        const latestInboundPortalMessage = [...threadMessages]
            .reverse()
            .find((message) =>
                message.direction === 'INBOUND' &&
                /@(govqa\.us|custhelp\.com|mycusthelp\.com|mycusthelp\.net|nextrequest\.com|request\.justfoia\.com|civicplus\.com)$/i.test(String(message.from_email || '').trim())
            );

        const canonicalAgency = await findCanonicalAgency(db, {
            portalUrl: caseData.portal_url,
            portalMailbox: latestInboundPortalMessage?.from_email || latestThread?.agency_email || null,
            agencyEmail: caseData.agency_email,
            agencyName: caseData.agency_name,
            stateHint: caseData.state,
        });
        const researchCanonicalAgency = researchSuggestedAgency
            ? await findCanonicalAgency(db, {
                portalUrl: null,
                portalMailbox: null,
                agencyEmail: null,
                agencyName: researchSuggestedAgency.name,
                stateHint: caseData.state,
            })
            : null;
        const metadataAgencyMismatch = detectCaseMetadataAgencyMismatch({
            currentAgencyName: canonicalAgency?.name || preferredCaseAgency?.agency_name || caseData.agency_name,
            additionalDetails: caseData.additional_details,
        });
        const metadataAgencyHint = extractMetadataAgencyHint(caseData.additional_details);
        const canForceCorrectedAgencyDisplay = !preferredCaseAgency || primaryCaseAgencyIsSynthetic;
        const useResearchSuggestedDisplay = shouldPreferResearchAgencyDisplay({
            researchSuggestedAgency,
            agencyEmail: primaryCaseAgency?.agency_email || caseData.agency_email,
            portalUrl: primaryCaseAgency?.portal_url || caseData.portal_url,
            addedSource: primaryCaseAgency?.added_source || (primaryCaseAgencyIsSynthetic ? 'case_row_backfill' : null),
        });
        const syntheticPlaceholderAgencyDisplay = hasSyntheticPlaceholderBackfill({
            agencyEmail: primaryCaseAgency?.agency_email || caseData.agency_email,
            portalUrl: primaryCaseAgency?.portal_url || caseData.portal_url,
            addedSource: primaryCaseAgency?.added_source || (primaryCaseAgencyIsSynthetic ? 'case_row_backfill' : null),
        });
        const suppressPlaceholderAgencyDisplay = shouldSuppressPlaceholderAgencyDisplay({
            contactResearchNotes: caseData.contact_research_notes,
            agencyEmail: primaryCaseAgency?.agency_email || caseData.agency_email,
            portalUrl: primaryCaseAgency?.portal_url || caseData.portal_url,
            addedSource: primaryCaseAgency?.added_source || (primaryCaseAgencyIsSynthetic ? 'case_row_backfill' : null),
        }) || (syntheticPlaceholderAgencyDisplay && !researchSuggestedAgency);
        const forceCorrectedAgencyDisplay = (canForceCorrectedAgencyDisplay && shouldForceCorrectedAgencyDisplay({
            currentAgencyName: canonicalAgency?.name || preferredCaseAgency?.agency_name || caseData.agency_name,
            caseAgencyName: caseData.agency_name,
            additionalDetails: caseData.additional_details,
            researchSuggestedAgency,
            currentAgencyEmail: primaryCaseAgency?.agency_email || caseData.agency_email,
            currentPortalUrl: primaryCaseAgency?.portal_url || caseData.portal_url,
            metadataAgencyMismatch,
        })) || shouldOverrideStaleExistingChannelDisplay({
            contactResearchNotes: caseData.contact_research_notes,
            currentAgencyName: canonicalAgency?.name || preferredCaseAgency?.agency_name || caseData.agency_name,
            researchSuggestedAgency,
            currentAgencyEmail: primaryCaseAgency?.agency_email || caseData.agency_email,
            currentPortalUrl: primaryCaseAgency?.portal_url || caseData.portal_url,
        });
        const correctedAgencyDisplay = buildCorrectedAgencyDisplay({
            researchCanonical: researchCanonicalAgency,
            researchSuggestedAgency,
            metadataAgencyMismatch,
            caseAgencyName: caseData.agency_name,
            caseState: caseData.state,
        });
        const narrativeAgencyName = (
            normalizeNotionReferenceId(preferredCaseAgency?.agency_name || caseData.agency_name)
            || isNotionReferenceList(preferredCaseAgency?.agency_name || caseData.agency_name)
            || isGenericAgencyLabel(preferredCaseAgency?.agency_name || caseData.agency_name)
        )
            ? (metadataAgencyHint?.name || extractAgencyNameFromAdditionalDetails(caseData.additional_details))
            : null;

        // Resolve canonical agency id for deep-linking to /agencies/detail.
        // Never use case id as an agency id.
        const useCanonicalDisplay = Boolean(
            !suppressPlaceholderAgencyDisplay &&
            !useResearchSuggestedDisplay
            && !forceCorrectedAgencyDisplay
            && canonicalAgency
            && (!preferredCaseAgency || primaryCaseAgencyIsSynthetic)
        );
        let resolvedAgencyId = useCanonicalDisplay
            ? canonicalAgency.id
            : (
                suppressPlaceholderAgencyDisplay
                    ? null
                    : forceCorrectedAgencyDisplay
                    ? correctedAgencyDisplay.id
                    : useResearchSuggestedDisplay
                    ? (researchCanonicalAgency?.id || preferredCaseAgency?.agency_id || caseData.agency_id || null)
                    : (preferredCaseAgency?.agency_id || caseData.agency_id || null)
            );
        let resolvedAgencyName = useCanonicalDisplay
            ? canonicalAgency.name
            : (
                suppressPlaceholderAgencyDisplay
                    ? (metadataAgencyHint?.name || narrativeAgencyName || 'Unknown agency')
                    : forceCorrectedAgencyDisplay
                    ? correctedAgencyDisplay.name
                    : useResearchSuggestedDisplay
                    ? (researchCanonicalAgency?.name || researchSuggestedAgency?.name || preferredCaseAgency?.agency_name || null)
                    : (preferredCaseAgency?.agency_name || narrativeAgencyName || null)
            );
        let resolvedAgencyEmail = normalizeAgencyEmailHint(
            suppressPlaceholderAgencyDisplay
                ? null
                : forceCorrectedAgencyDisplay
                ? correctedAgencyDisplay.email
                : useCanonicalDisplay
                ? (canonicalAgency?.email_foia || canonicalAgency?.email_main || caseData.agency_email)
                : (
                    useResearchSuggestedDisplay
                        ? (researchCanonicalAgency?.email_foia || researchCanonicalAgency?.email_main || null)
                        : (preferredCaseAgency?.agency_email || caseData.agency_email)
                )
        );
        let resolvedPortalUrl = normalizePortalUrl(
            suppressPlaceholderAgencyDisplay
                ? null
                : forceCorrectedAgencyDisplay
                ? correctedAgencyDisplay.portalUrl
                : useCanonicalDisplay
                ? (canonicalAgency?.portal_url || canonicalAgency?.portal_url_alt || caseData.portal_url)
                : (
                    useResearchSuggestedDisplay
                        ? (researchCanonicalAgency?.portal_url || researchCanonicalAgency?.portal_url_alt || null)
                        : (preferredCaseAgency?.portal_url || caseData.portal_url)
                )
        );
        let resolvedPortalProvider =
            (suppressPlaceholderAgencyDisplay
                ? null
                : forceCorrectedAgencyDisplay
                ? correctedAgencyDisplay.portalProvider
                : useCanonicalDisplay
                ? (canonicalAgency?.portal_provider || caseData.portal_provider)
                : (
                    useResearchSuggestedDisplay
                        ? (researchCanonicalAgency?.portal_provider || null)
                        : (preferredCaseAgency?.portal_provider || caseData.portal_provider)
                )) ||
            detectPortalProviderByUrl(resolvedPortalUrl)?.name ||
            null;
        const notionAgencyOverride = (!suppressPlaceholderAgencyDisplay && !useResearchSuggestedDisplay && !forceCorrectedAgencyDisplay)
            ? await lookupAgencyByNotionReference(resolvedAgencyName || caseData.agency_name)
            : null;
        if (notionAgencyOverride) {
            resolvedAgencyId = notionAgencyOverride.id || resolvedAgencyId;
            resolvedAgencyName = notionAgencyOverride.name || resolvedAgencyName;
            resolvedAgencyEmail = normalizeAgencyEmailHint(
                notionAgencyOverride.email_foia ||
                notionAgencyOverride.email_main ||
                resolvedAgencyEmail
            );
            resolvedPortalUrl = normalizePortalUrl(
                notionAgencyOverride.portal_url ||
                notionAgencyOverride.portal_url_alt ||
                resolvedPortalUrl
            );
            resolvedPortalProvider =
                notionAgencyOverride.portal_provider ||
                detectPortalProviderByUrl(resolvedPortalUrl)?.name ||
                resolvedPortalProvider ||
                null;
        }
        resolvedAgencyName = pickAgencyDisplayName(
            resolvedAgencyName,
            notionAgencyOverride?.name,
            narrativeAgencyName,
            canonicalAgency?.name,
            preferredCaseAgency?.agency_name,
            caseData.agency_name
        );
        const hasVerifiedResearchAgencyMatch = Boolean(
            useResearchSuggestedDisplay &&
            (
                researchCanonicalAgency?.id ||
                resolvedAgencyEmail ||
                resolvedPortalUrl
            )
        );
        if (useResearchSuggestedDisplay && !hasVerifiedResearchAgencyMatch) {
            resolvedAgencyId = null;
        }

        if (!resolvedAgencyId && !useResearchSuggestedDisplay && (resolvedAgencyName || caseData.agency_name)) {
            const agencyLookup = await db.query(
                `SELECT id
                 FROM agencies
                 WHERE name = $1
                    OR LOWER(name) = LOWER($1)
                    OR name ILIKE $2
                 ORDER BY
                    CASE WHEN name = $1 THEN 0
                         WHEN LOWER(name) = LOWER($1) THEN 1
                         ELSE 2
                    END
                 LIMIT 1`,
                [resolvedAgencyName || caseData.agency_name, `%${resolvedAgencyName || caseData.agency_name}%`]
            );
            resolvedAgencyId = agencyLookup.rows[0]?.id || null;
        }
        if (!resolvedAgencyId && !useResearchSuggestedDisplay && resolvedPortalUrl) {
            const agencyLookupByPortal = await db.query(
                `SELECT id
                 FROM agencies
                 WHERE portal_url = $1 OR portal_url_alt = $1
                 LIMIT 1`,
                [resolvedPortalUrl]
            );
            resolvedAgencyId = agencyLookupByPortal.rows[0]?.id || null;
        }
        if (!resolvedAgencyId && !useResearchSuggestedDisplay && resolvedAgencyEmail && !isTestAgencyEmail(resolvedAgencyEmail)) {
            const agencyLookupByEmail = await db.query(
                `SELECT id
                 FROM agencies
                 WHERE LOWER(email_main) = LOWER($1)
                    OR LOWER(email_foia) = LOWER($1)
                 LIMIT 1`,
                [resolvedAgencyEmail]
            );
            resolvedAgencyId = agencyLookupByEmail.rows[0]?.id || null;
        }
        if (resolvedAgencyId) {
            const canonicalAgencyName = await db.query(
                `SELECT name
                 FROM agencies
                 WHERE id = $1
                 LIMIT 1`,
                [resolvedAgencyId]
            );
            resolvedAgencyName = resolvedAgencyName || canonicalAgencyName.rows[0]?.name || null;
        }

        const agencySummary = {
            id: resolvedAgencyId != null ? String(resolvedAgencyId) : '',
            name: resolvedAgencyName || caseData.agency_name || '—',
            state: deriveDisplayState(caseData.state, resolvedAgencyName || caseData.agency_name) || '—',
            submission_method: resolvedPortalUrl
                ? 'PORTAL'
                : resolvedAgencyEmail
                ? 'EMAIL'
                : 'UNKNOWN',
            portal_url: resolvedPortalUrl || undefined,
            default_autopilot_mode: caseData.autopilot_mode || 'SUPERVISED',
            notes: caseData.contact_research_notes || undefined,
            // Agency rules (derived or default - in full implementation these would be stored)
            rules: {
                fee_auto_approve_threshold: 50.00, // Default threshold
                always_human_gates: ['DENIAL', 'SENSITIVE'], // Default gates requiring human
                known_exemptions: constraints
                    .filter(c => c.type === 'EXEMPTION')
                    .map(c => c.description),
                typical_response_days: null // Would come from agency stats
            }
        };

        let sortedCaseAgencies = normalizedCaseAgencies.map((agency) => {
            const isBackfilledAgency =
                agency.added_source === 'case_row_backfill' ||
                agency.added_source === 'case_row_fallback';
            if (useResearchSuggestedDisplay && isBackfilledAgency) {
                const researchPortalUrl = normalizePortalUrl(
                    researchCanonicalAgency?.portal_url ||
                    researchCanonicalAgency?.portal_url_alt ||
                    null
                );
                return {
                    ...agency,
                    agency_id: researchCanonicalAgency?.id || null,
                    agency_name: researchCanonicalAgency?.name || researchSuggestedAgency?.name || agency.agency_name,
                    agency_email: normalizeAgencyEmailHint(
                        researchCanonicalAgency?.email_foia ||
                        researchCanonicalAgency?.email_main ||
                        null
                    ) || null,
                    portal_url: researchPortalUrl,
                    portal_provider: researchCanonicalAgency?.portal_provider || detectPortalProviderByUrl(researchPortalUrl)?.name || null,
                    notes: agency.notes || researchSuggestedAgency?.reason || null,
                };
            }
            if (forceCorrectedAgencyDisplay && isBackfilledAgency) {
                return {
                    ...agency,
                    agency_id: correctedAgencyDisplay.id,
                    agency_name: correctedAgencyDisplay.name || agency.agency_name,
                    agency_email: correctedAgencyDisplay.email,
                    portal_url: correctedAgencyDisplay.portalUrl,
                    portal_provider: correctedAgencyDisplay.portalProvider,
                    notes: agency.notes || researchSuggestedAgency?.reason || 'Display corrected from stale case-row channels.',
                };
            }
            if (suppressPlaceholderAgencyDisplay && isBackfilledAgency) {
                return {
                    ...agency,
                    agency_id: null,
                    agency_name: 'Unknown agency',
                    agency_email: null,
                    portal_url: null,
                    portal_provider: null,
                    notes: agency.notes || 'Research did not confirm the correct agency yet.',
                };
            }
            if (!canonicalAgency || !isBackfilledAgency) {
                return agency;
            }

            const canonicalPortalUrl = normalizePortalUrl(
                agency.portal_url ||
                canonicalAgency.portal_url ||
                canonicalAgency.portal_url_alt ||
                caseData.portal_url
            );
            const canonicalEmail =
                normalizeAgencyEmailHint(agency.agency_email) ||
                normalizeAgencyEmailHint(caseData.agency_email) ||
                normalizeAgencyEmailHint(canonicalAgency.email_foia) ||
                normalizeAgencyEmailHint(canonicalAgency.email_main) ||
                null;

            return {
                ...agency,
                agency_id: canonicalAgency.id,
                agency_name: canonicalAgency.name,
                agency_email: canonicalEmail,
                portal_url: canonicalPortalUrl,
                portal_provider: agency.portal_provider || canonicalAgency.portal_provider || detectPortalProviderByUrl(canonicalPortalUrl)?.name || null,
            };
        }).sort((a, b) => {
            if (a.is_primary !== b.is_primary) return a.is_primary ? -1 : 1;
            const aStatus = String(a.status || 'pending').toLowerCase();
            const bStatus = String(b.status || 'pending').toLowerCase();
            const rank = { active: 0, pending: 1, researching: 2, inactive: 3 };
            const ar = rank[aStatus] ?? 9;
            const br = rank[bStatus] ?? 9;
            if (ar !== br) return ar - br;
            return new Date(b.updated_at || b.created_at || 0).getTime() - new Date(a.updated_at || a.created_at || 0).getTime();
        });
        // Backfill: create a real case_agencies row from the case record so buttons work.
        // Skip this when the case row only has placeholder contact data and research
        // has already suggested a better target agency for display.
        if (
            sortedCaseAgencies.length === 0
            && !suppressPlaceholderAgencyDisplay
            && !useResearchSuggestedDisplay
            && !forceCorrectedAgencyDisplay
            && (caseData.agency_name || caseData.agency_email || caseData.portal_url)
        ) {
            try {
                const backfilled = await db.addCaseAgency(requestId, {
                    agency_id: resolvedAgencyId || null,
                    agency_name: resolvedAgencyName || caseData.agency_name || '—',
                    agency_email: caseData.agency_email || null,
                    portal_url: caseData.portal_url || null,
                    portal_provider: caseData.portal_provider || null,
                    is_primary: true,
                    added_source: 'case_row_backfill',
                    status: 'active',
                });
                sortedCaseAgencies = [backfilled];
            } catch (backfillErr) {
                console.warn(`[workspace] Failed to backfill case_agencies for case ${requestId}:`, backfillErr.message);
                // Fall back to synthetic entry so the UI still renders
                sortedCaseAgencies = [{
                    id: -requestId,
                    case_id: requestId,
                    agency_id: resolvedAgencyId || null,
                    agency_name: resolvedAgencyName || caseData.agency_name || '—',
                    agency_email: caseData.agency_email || null,
                    portal_url: caseData.portal_url || null,
                    portal_provider: caseData.portal_provider || null,
                    is_primary: true,
                    is_active: true,
                    added_source: 'case_row_fallback',
                    status: 'active',
                    created_at: caseData.created_at,
                    updated_at: caseData.updated_at,
                }];
            }
        }
        try {
            sortedCaseAgencies = await db.enrichCaseAgenciesWithPortalAutomationPolicies(sortedCaseAgencies);
        } catch (error) {
            logger.warn('[workspace] failed to enrich case agencies with portal automation policies', {
                case_id: requestId,
                error: error.message,
            });
        }
        const portalThreadMessages = buildPortalSubmissionThreadMessages({
            portalSubmissions,
            activityRows,
            caseData,
            caseAgencies: sortedCaseAgencies,
        });
        if (portalThreadMessages.length > 0) {
            const existingIds = new Set(threadMessages.map((message) => Number(message.id)));
            const freshPortalMessages = portalThreadMessages.filter((message) => {
                if (existingIds.has(Number(message.id))) return false;
                const body = String(message.body || '');
                const subject = String(message.subject || '').toLowerCase();
                const runMatch = body.match(/Automation run:\s*(\S+)/);
                const runUrl = runMatch?.[1] || null;
                const existingPortalMessage = threadMessages.some((existing) => {
                    if (String(existing.message_type || '').toLowerCase() !== 'portal_submission') return false;
                    const existingBody = String(existing.body || '');
                    const existingSubject = String(existing.subject || '').toLowerCase();
                    return (
                        (subject.includes('completed') && existingSubject.includes('completed'))
                        || (runUrl && existingBody.includes(runUrl))
                    );
                });
                return !existingPortalMessage;
            });
            if (freshPortalMessages.length > 0) {
                threadMessages = [...threadMessages, ...freshPortalMessages].sort((a, b) => {
                    const aTime = new Date(a.sent_at || a.timestamp || 0).getTime();
                    const bTime = new Date(b.sent_at || b.timestamp || 0).getTime();
                    if (aTime !== bTime) return aTime - bTime;
                    return Number(a.id || 0) - Number(b.id || 0);
                });
            }
        }
        if (threadMessages.length > 0) {
            const threadNormalizationContext = {
                agency_name: resolvedAgencyName || caseData.agency_name || null,
                portal_url: resolvedPortalUrl || caseData.portal_url || null,
                last_portal_task_url: caseData.last_portal_task_url || null,
            };
            threadMessages = threadMessages.map((message) => ({
                ...message,
                body: normalizeThreadBody(message.body, threadNormalizationContext),
                raw_body: message.raw_body
                    ? normalizeThreadBody(message.raw_body, threadNormalizationContext)
                    : message.raw_body,
            }));
        }
        const agencyCandidates = filterExistingAgencyCandidates(
            extractAgencyCandidatesFromResearchNotes(caseData.contact_research_notes),
            sortedCaseAgencies,
            {
                agency_name: resolvedAgencyName || caseData.agency_name,
                agency_email: caseData.agency_email,
                portal_url: caseData.portal_url,
            }
        );

        // Build state deadline info (static data - would come from state_deadlines table)
        const STATE_DEADLINES = {
            SC: { state_code: 'SC', response_days: 10, statute_citation: 'SC Code § 30-4-30(c): 10 business days' },
            NC: { state_code: 'NC', response_days: 10, statute_citation: 'NC G.S. § 132-6(a): 10 working days' },
            GA: { state_code: 'GA', response_days: 3, statute_citation: 'O.C.G.A. § 50-18-71(b)(1)(A): 3 business days' },
            FL: { state_code: 'FL', response_days: 5, statute_citation: 'Fla. Stat. § 119.07(1)(c): Prompt response' },
            TX: { state_code: 'TX', response_days: 10, statute_citation: 'Tex. Gov\'t Code § 552.221(a): 10 business days' },
            VA: { state_code: 'VA', response_days: 5, statute_citation: 'Va. Code § 2.2-3704(B): 5 working days' },
            OK: { state_code: 'OK', response_days: 3, statute_citation: '51 O.S. § 24A.5(5): Prompt response' },
            TN: { state_code: 'TN', response_days: 7, statute_citation: 'Tenn. Code § 10-7-503(a)(2)(B): 7 business days' },
            AL: { state_code: 'AL', response_days: 5, statute_citation: 'No statutory deadline - reasonable time' },
            MS: { state_code: 'MS', response_days: 7, statute_citation: 'Miss. Code § 25-61-5: 7 working days' },
        };

        const stateDeadline = STATE_DEADLINES[caseData.state?.toUpperCase()] || null;
        const deadlineMilestones = buildDeadlineMilestones(caseData, timelineEvents, stateDeadline);

        // Fetch active proposals (includes DECISION_RECEIVED for review_state)
        let pendingProposals = await db.getPendingProposalsByCaseId(requestId);
        pendingProposals = pendingProposals.map((proposal) => {
            const enrichedProposal = {
                ...proposal,
                gate_options: Array.isArray(proposal.gate_options)
                    && proposal.gate_options.length > 0
                    ? proposal.gate_options
                    : deriveDefaultGateOptions(
                        proposal.action_type,
                        proposal.draft_body_text
                    ),
            };
            if (String(enrichedProposal.action_type || '').toUpperCase() === 'ESCALATE') {
                return {
                    ...enrichedProposal,
                    draft_body_text: sanitizeStaleResearchHandoffDraft(enrichedProposal.draft_body_text),
                    reasoning: sanitizeStaleResearchHandoffReasoning(enrichedProposal.reasoning),
                };
            }
            return enrichedProposal;
        });
        const contradictoryNoResponseCount = pendingProposals.filter(isContradictoryNoResponseProposal).length;
        pendingProposals = pendingProposals.filter((proposal) => !isContradictoryNoResponseProposal(proposal));
        let pendingProposal = pendingProposals[0] || null;
        const contradictoryNoResponseProposal = contradictoryNoResponseCount > 0 && pendingProposals.length === 0;
        if (!nextActionProposal && pendingProposal) {
            nextActionProposal = {
                id: String(pendingProposal.id),
                action_type: pendingProposal.action_type,
                proposal: pendingProposal.draft_subject || pendingProposal.action_type,
                proposal_short: pendingProposal.draft_subject || pendingProposal.action_type,
                reasoning: Array.isArray(pendingProposal.reasoning)
                    ? pendingProposal.reasoning
                    : (pendingProposal.reasoning ? [pendingProposal.reasoning] : []),
                confidence: pendingProposal.confidence ? parseFloat(pendingProposal.confidence) : 0.8,
                risk_flags: [],
                warnings: [],
                can_auto_execute: false,
                blocked_reason: null,
                draft_content: pendingProposal.draft_body_text || null,
                draft_preview: pendingProposal.draft_body_text ? pendingProposal.draft_body_text.substring(0, 200) : null,
                gate_options: Array.isArray(pendingProposal.gate_options) ? pendingProposal.gate_options : null,
                status: pendingProposal.status || null,
            };
        }
        if (contradictoryNoResponseProposal) {
            nextActionProposal = null;
            pendingProposal = null;
            pendingProposals = [];
        }
        const manualPasteMismatch = shouldEscalateManualPasteMismatch(
            latestInboundMessageForGuard,
            latestInboundThreadForGuard,
            caseData
        );
        if (manualPasteMismatch.mismatch) {
            nextActionProposal = null;
            pendingProposal = null;
            pendingProposals = [];
            caseData = {
                ...caseData,
                requires_human: true,
                substatus: buildManualPasteMismatchSubstatus(manualPasteMismatch),
            };
        }
        const importSafety = evaluateImportAutoDispatchSafety({
            caseName: caseData.case_name,
            subjectName: caseData.subject_name,
            agencyName: caseData.agency_name,
            state: caseData.state,
            additionalDetails: caseData.additional_details,
            importWarnings: caseData.import_warnings,
            agencyEmail: primaryCaseAgency?.agency_email || caseData.agency_email,
            portalUrl: primaryCaseAgency?.portal_url || caseData.portal_url,
        });
        const activeRunResult = await db.query(`
            SELECT
                id,
                status,
                trigger_type,
                started_at,
                metadata->>'triggerRunId' AS trigger_run_id,
                metadata->>'trigger_run_id' AS trigger_run_id_legacy,
                metadata->>'current_node' AS current_node,
                COALESCE(
                    metadata->>'skyvern_task_url',
                    metadata->>'skyvernTaskUrl',
                    metadata->>'portal_task_url',
                    metadata->>'portalTaskUrl'
                ) AS skyvern_task_url
            FROM agent_runs
            WHERE case_id = $1 AND status IN ('created', 'queued', 'processing', 'waiting', 'running')
            ORDER BY started_at DESC NULLS LAST
            LIMIT 1
        `, [requestId]);
        const activeRun = activeRunResult.rows[0]
            ? {
                ...activeRunResult.rows[0],
                trigger_run_id: activeRunResult.rows[0].trigger_run_id || activeRunResult.rows[0].trigger_run_id_legacy || null
            }
            : null;
        const staleWaitingRunWithoutProposal = isStaleWaitingRunWithoutProposal({
            caseData,
            activeProposal: pendingProposal,
            activeRun,
        });
        const effectiveActiveRun = staleWaitingRunWithoutProposal ? null : activeRun;
        const importSafetyReasonDetail = importSafety.metadataMismatch?.expectedAgencyName
            ? `Imported case agency does not match case details (${importSafety.metadataMismatch.expectedAgencyName})`
            : importSafety.agencyStateMismatch
                ? `Imported case state (${importSafety.agencyStateMismatch.caseState}) does not match routed agency state (${importSafety.agencyStateMismatch.agencyState})`
                : importSafety.agencyCityMismatch
                    ? `Imported case city (${importSafety.agencyCityMismatch.expectedCity}) does not match routed agency (${importSafety.agencyCityMismatch.currentAgencyName})`
                    : importSafety.reasonCode === 'PLACEHOLDER_TITLE'
                        ? 'Imported case title/subject is still placeholder text'
                        : 'Imported case needs human review before sending';
        const importSafetyContext = hasImportSafetyContext({
            notionPageId: caseData.notion_page_id,
            importWarnings: caseData.import_warnings,
            agencies: sortedCaseAgencies,
            casePauseReason: caseData.pause_reason,
            caseSubstatus: caseData.substatus,
        });
        const importSafetyBlocked = hasImportSafetyBlock(importSafety, importSafetyContext);
        const importSafetyBlockedProposal = Boolean(
            importSafetyBlocked &&
            pendingProposal &&
            ['SEND_INITIAL_REQUEST', 'SUBMIT_PORTAL', 'SEND_CLARIFICATION'].includes(String(pendingProposal.action_type || '').toUpperCase())
        );
        const importSafetyBlockedCase = Boolean(
            importSafetyBlocked &&
            !pendingProposal &&
            !activeRun
        );
        const suppressImportBlockedAgencyDisplay = importSafetyBlocked && (hasImportReviewSignals({
            importWarnings: caseData.import_warnings,
            agencies: sortedCaseAgencies,
            casePauseReason: caseData.pause_reason,
            caseSubstatus: caseData.substatus,
        }) || importSafetyBlockedCase);
        const importBlockedAgencyDisplay = suppressImportBlockedAgencyDisplay
            ? buildImportBlockedAgencyDisplay({
                metadataAgencyHint,
                narrativeAgencyName,
                caseState: caseData.state,
            })
            : null;
        const blockedImportReview = importSafetyBlockedProposal || importSafetyBlockedCase;
        if (blockedImportReview) {
            nextActionProposal = null;
            pendingProposal = null;
            pendingProposals = [];
            caseData = {
                ...caseData,
                requires_human: true,
                status: 'needs_human_review',
                substatus: importSafetyReasonDetail,
                pause_reason: 'IMPORT_REVIEW',
            };
        }
        if (importBlockedAgencyDisplay) {
            resolvedAgencyId = null;
            resolvedAgencyName = importBlockedAgencyDisplay.agency_name;
            resolvedAgencyEmail = null;
            resolvedPortalUrl = null;
            resolvedPortalProvider = null;
            agencySummary.id = '';
            agencySummary.name = importBlockedAgencyDisplay.agency_name || 'Unknown agency';
            agencySummary.state = importBlockedAgencyDisplay.state || caseData.state || '—';
            agencySummary.submission_method = 'UNKNOWN';
            agencySummary.portal_url = undefined;
            sortedCaseAgencies = dedupeCaseAgencies((sortedCaseAgencies.length > 0
                ? sortedCaseAgencies
                : [{
                    id: -requestId,
                    case_id: requestId,
                    agency_id: null,
                    agency_name: importBlockedAgencyDisplay.agency_name,
                    agency_email: null,
                    portal_url: null,
                    portal_provider: null,
                    is_primary: true,
                    is_active: true,
                    added_source: 'import_review_mask',
                    status: 'pending',
                    created_at: caseData.created_at,
                    updated_at: caseData.updated_at,
                }]).map((agency) => ({
                ...agency,
                agency_id: null,
                agency_name: importBlockedAgencyDisplay.agency_name,
                agency_email: null,
                portal_url: null,
                portal_provider: null,
                notes: agency.notes || 'Imported case is blocked until the correct agency is confirmed.',
            })));
        }

        // Build portal_helper for portal execution proposals and manual portal fallback handoffs.
        let portalHelper = null;
        const proposalDraftText = String(pendingProposal?.draft_body_text || '');
        const proposalNeedsManualPortalHelper = pendingProposal?.action_type === 'SUBMIT_PORTAL'
            || (
                pendingProposal?.action_type === 'ESCALATE'
                && /manual submit helper|portal submission manually|portal submission manual|open portal/i.test(proposalDraftText)
                && Boolean(agencySummary?.portal_url || caseData.portal_url)
            );
        if (proposalNeedsManualPortalHelper) {
            const caseOwner = caseData.user_id ? await db.getUserById(caseData.user_id) : null;
            const ownerName = caseOwner?.name || process.env.REQUESTER_NAME || 'Requester';
            const ownerEmail = caseOwner?.email || process.env.REQUESTER_EMAIL || process.env.REQUESTS_INBOX || 'requests@foib-request.com';
            const ownerPhone = caseOwner?.signature_phone || process.env.REQUESTER_PHONE || '209-800-7702';
            const ownerOrg = caseOwner
                ? (caseOwner.signature_organization ?? '')
                : (process.env.REQUESTER_ORG || '');
            const ownerTitle = caseOwner?.signature_title || process.env.REQUESTER_TITLE || '';

            const rawRecords = caseData.requested_records;
            let recordsList = [];
            if (Array.isArray(rawRecords)) {
                recordsList = rawRecords;
            } else if (typeof rawRecords === 'string') {
                try { recordsList = JSON.parse(rawRecords); } catch { recordsList = [rawRecords]; }
            }

            portalHelper = {
                portal_url: agencySummary?.portal_url || caseData.portal_url || null,
                agency_name: resolvedAgencyName || caseData.agency_name || null,
                requester: {
                    name: ownerName,
                    email: ownerEmail,
                    phone: ownerPhone,
                    organization: ownerOrg,
                    title: ownerTitle,
                },
                address: {
                    line1: caseOwner?.address_street || process.env.REQUESTER_ADDRESS || '',
                    line2: caseOwner?.address_street2 || process.env.REQUESTER_ADDRESS_LINE2 || '',
                    city: caseOwner?.address_city || process.env.REQUESTER_CITY || '',
                    state: caseOwner?.address_state || process.env.REQUESTER_STATE || '',
                    zip: caseOwner?.address_zip || process.env.REQUESTER_ZIP || '',
                },
                case_info: {
                    subject_name: caseData.subject_name || caseData.case_name || null,
                    incident_date: caseData.incident_date || null,
                    incident_location: caseData.incident_location || null,
                    requested_records: recordsList,
                    additional_details: caseData.additional_details || null,
                },
                fee_waiver_reason: 'Non-commercial documentary / public interest',
                preferred_delivery: 'electronic',
            };
        }

        const agentDecisionsResult = await db.query(
            `SELECT id, reasoning, action_taken, confidence, trigger_type, outcome, created_at
             FROM agent_decisions
             WHERE case_id = $1
             ORDER BY created_at DESC
             LIMIT 100`,
            [requestId]
        );
        const agentDecisions = agentDecisionsResult.rows;

        // Compute derived review_state
        const reviewStateCaseData = contradictoryNoResponseProposal
            ? {
                ...rawCaseData,
                status: 'awaiting_response',
                requires_human: false,
                pause_reason: null,
            }
            : rawCaseData;
        let review_state = resolveReviewState({
            caseData: reviewStateCaseData,
            activeProposal: pendingProposal,
            activeRun: effectiveActiveRun,
        });
        let control_mismatches = detectControlMismatches({
            caseData: reviewStateCaseData,
            reviewState: review_state,
            pendingProposal,
            activeRun: effectiveActiveRun,
            activePortalTaskStatus: caseData.active_portal_task_status || null,
        });
        let control_state = resolveControlState({
            caseData: reviewStateCaseData,
            reviewState: review_state,
            pendingProposal,
            activeRun: effectiveActiveRun,
            activePortalTaskStatus: caseData.active_portal_task_status || null,
        });
        if (manualPasteMismatch.mismatch) {
            review_state = 'IDLE';
            control_state = 'BLOCKED';
            control_mismatches = [];
        }
        if (importSafetyBlockedProposal) {
            review_state = 'IDLE';
            control_state = 'BLOCKED';
            control_mismatches = [];
        }
        if (contradictoryNoResponseProposal) {
            review_state = 'WAITING_AGENCY';
            control_state = 'BLOCKED';
            control_mismatches = [];
        }
        if (control_mismatches.length > 0) {
            logger.warn('[control-state-mismatch]', {
                case_id: requestId,
                review_state,
                control_state,
                mismatch_codes: control_mismatches.map((m) => m.code),
                active_run_status: activeRun?.status || null,
                active_portal_task_status: caseData.active_portal_task_status || null,
                requires_human: Boolean(rawCaseData?.requires_human),
            });
        }

        const requestDetail = toRequestDetail(caseData);
        const resolvedRequestState = deriveDisplayState(
            forceCorrectedAgencyDisplay
                ? correctedAgencyDisplay.state
                : caseData.state,
            resolvedAgencyName || requestDetail.agency_name
        );
        // Delivery fallback for UI: when case.agency_email is missing, surface
        // thread/inbound sender so destination displays correctly.
        if (!requestDetail.agency_email) {
            const latestInbound = threadMessages.find((m) => m.direction === 'INBOUND');
            const fallbackEmailRaw = (latestThread?.agency_email || latestInbound?.from_email || '').trim().toLowerCase();
            if (fallbackEmailRaw.includes('@') && !fallbackEmailRaw.endsWith('@foib-request.com')) {
                requestDetail.agency_email = fallbackEmailRaw;
            }
        }
        const shouldOverrideAgencyFields = Boolean(
            suppressImportBlockedAgencyDisplay ||
            suppressPlaceholderAgencyDisplay ||
            useResearchSuggestedDisplay ||
            useCanonicalDisplay ||
            forceCorrectedAgencyDisplay
        );
        if (shouldOverrideAgencyFields) {
            requestDetail.agency_name = resolvedAgencyName || requestDetail.agency_name;
            requestDetail.agency_email = resolvedAgencyEmail || null;
            requestDetail.portal_url = resolvedPortalUrl || null;
            requestDetail.portal_provider = resolvedPortalProvider || null;
            requestDetail.state = resolvedRequestState || requestDetail.state || null;
        } else {
            if (resolvedAgencyName) {
                requestDetail.agency_name = resolvedAgencyName;
            }
            if (resolvedAgencyEmail) {
                requestDetail.agency_email = resolvedAgencyEmail;
            }
            if (resolvedPortalUrl) {
                requestDetail.portal_url = resolvedPortalUrl;
            }
            if (resolvedPortalProvider) {
                requestDetail.portal_provider = resolvedPortalProvider;
            }
            if (resolvedRequestState) {
                requestDetail.state = resolvedRequestState;
            }
        }
        if (isPlaceholderAgencyEmail(requestDetail.agency_email)) {
            requestDetail.agency_email = null;
        }
        if (!requestDetail.agency_email && isTestAgencyEmail(caseData.agency_email)) {
            requestDetail.agency_email = normalizeAgencyEmailHint(caseData.agency_email);
            requestDetail.portal_url = null;
            requestDetail.portal_provider = null;
        }
        // Populate case-level attachments with direction for UI display
        requestDetail.attachments = (caseAttachments || []).map(att => ({
            id: att.id,
            filename: att.filename,
            content_type: att.content_type,
            size_bytes: att.size_bytes,
            download_url: `/api/monitor/attachments/${att.id}/download`,
            direction: att.message_id ? 'inbound' : 'outbound',
            message_id: att.message_id || null,
            extracted_text: att.extracted_text || null,
            has_extracted_text: !!att.extracted_text,
        }));
        if (!requestDetail.last_portal_screenshot_url) {
            const latestPortalScreenshot = await db.query(
                `SELECT COALESCE(metadata->>'persistent_url', metadata->>'url') AS screenshot_url
                   FROM activity_log
                  WHERE case_id = $1
                    AND event_type = 'portal_screenshot'
                  ORDER BY created_at DESC
                  LIMIT 1`,
                [requestId]
            );
            const fallbackPortalScreenshotUrl = String(latestPortalScreenshot.rows[0]?.screenshot_url || '').trim();
            if (fallbackPortalScreenshotUrl) {
                requestDetail.last_portal_screenshot_url = fallbackPortalScreenshotUrl;
            }
        }
        requestDetail.import_warnings = filterStaleImportWarnings(requestDetail.import_warnings, {
            originalAgencyName: primaryCaseAgency?.agency_name || caseData.agency_name,
            resolvedAgencyName,
            resolvedAgencyId,
            currentAgencyId: primaryCaseAgency?.agency_id || caseData.agency_id,
            currentAgencyEmail: primaryCaseAgency?.agency_email || caseData.agency_email,
            suppressPlaceholderAgencyDisplay,
            forceCorrectedAgencyDisplay,
            useResearchSuggestedDisplay,
        });
        const missingImportDeliveryPath =
            hasMissingImportDeliveryPath({
                agency_email: requestDetail.agency_email || caseData.agency_email,
                portal_url: requestDetail.portal_url || caseData.portal_url,
                import_warnings: requestDetail.import_warnings,
            }) &&
            !pendingProposal &&
            !effectiveActiveRun;
        const noCorrespondenceRecovery = getNoCorrespondenceRecovery({
            ...caseData,
            agency_email: requestDetail.agency_email || caseData.agency_email,
            portal_url: requestDetail.portal_url || caseData.portal_url,
            import_warnings: requestDetail.import_warnings,
        }, {
            activeProposal: pendingProposal,
            activeRun: effectiveActiveRun,
        });
        const firstSendPendingReview = shouldDisplayAsReadyToSendPendingReview({
            ...caseData,
            agency_email: requestDetail.agency_email || caseData.agency_email,
            portal_url: requestDetail.portal_url || caseData.portal_url,
            import_warnings: requestDetail.import_warnings,
        }, pendingProposal);

        // Keep workspace request fields aligned with derived state to prevent
        // transient "needs decision" UI while an execution run is active.
        const dbStatus = String(reviewStateCaseData?.status || '').toLowerCase();
        const isHumanReviewStatus = [
            'needs_human_review',
            'needs_human_fee_approval',
            'needs_phone_call',
            'needs_contact_info',
            'needs_rebuttal',
            'pending_fee_decision',
            'id_state'
        ].includes(dbStatus);
        requestDetail.review_state = review_state;
        requestDetail.control_state = control_state;
        requestDetail.control_mismatches = control_mismatches;
        let effectiveRequiresHuman =
            review_state === 'DECISION_REQUIRED' ||
            Boolean(reviewStateCaseData?.requires_human) ||
            isHumanReviewStatus;
        if (missingImportDeliveryPath) {
            requestDetail.status = 'NEEDS_HUMAN_REVIEW';
            if (!requestDetail.substatus || /agency_research_complete|research_followup_proposed/i.test(String(requestDetail.substatus))) {
                requestDetail.substatus = 'Imported case is missing a real delivery path. Add the correct agency email or portal before sending.';
            }
            requestDetail.pause_reason = 'IMPORT_REVIEW';
            requestDetail.review_state = 'IDLE';
            requestDetail.control_state = 'BLOCKED';
            requestDetail.control_mismatches = [];
            effectiveRequiresHuman = true;
        }
        if (noCorrespondenceRecovery?.mode === 'BLOCKED_IMPORT') {
            requestDetail.status = 'NEEDS_HUMAN_REVIEW';
            requestDetail.substatus = noCorrespondenceRecovery.substatus;
            requestDetail.pause_reason = 'IMPORT_REVIEW';
            requestDetail.review_state = 'IDLE';
            requestDetail.control_state = 'BLOCKED';
            requestDetail.control_mismatches = [];
            effectiveRequiresHuman = true;
        } else if (noCorrespondenceRecovery?.mode === 'READY_TO_SEND') {
            requestDetail.status = 'READY_TO_SEND';
            requestDetail.substatus = noCorrespondenceRecovery.substatus;
            requestDetail.pause_reason = 'INITIAL_REQUEST';
            requestDetail.review_state = 'IDLE';
            requestDetail.control_state = 'BLOCKED';
            requestDetail.control_mismatches = [];
            effectiveRequiresHuman = false;
        } else if (firstSendPendingReview) {
            requestDetail.status = 'READY_TO_SEND';
            requestDetail.pause_reason = requestDetail.pause_reason || 'INITIAL_REQUEST';
        }
        if (blockedImportReview) {
            requestDetail.status = 'NEEDS_HUMAN_REVIEW';
            requestDetail.substatus = importSafetyReasonDetail;
            requestDetail.pause_reason = 'IMPORT_REVIEW';
            requestDetail.review_state = 'IDLE';
            requestDetail.control_state = 'BLOCKED';
            requestDetail.control_mismatches = [];
            effectiveRequiresHuman = true;
        }
        if (contradictoryNoResponseProposal) {
            requestDetail.status = 'AWAITING_RESPONSE';
            requestDetail.substatus = requestDetail.substatus || 'No response needed — automated portal/account message';
            requestDetail.pause_reason = null;
            effectiveRequiresHuman = false;
        }
        if (
            pendingProposal
            && /^resolving:/i.test(String(requestDetail.substatus || ''))
        ) {
            requestDetail.substatus = `Proposal #${pendingProposal.id} pending review`;
        }
        if (review_state !== 'DECISION_REQUIRED' && !isHumanReviewStatus) {
            requestDetail.pause_reason = null;
        }
        if (missingImportDeliveryPath) {
            requestDetail.pause_reason = 'IMPORT_REVIEW';
        }
        if (staleWaitingRunWithoutProposal && noCorrespondenceRecovery && activeRun?.id) {
            const recoveredStatus = noCorrespondenceRecovery.mode === 'READY_TO_SEND'
                ? 'ready_to_send'
                : 'needs_human_review';
            const recoveredPauseReason = noCorrespondenceRecovery.mode === 'READY_TO_SEND'
                ? 'INITIAL_REQUEST'
                : 'IMPORT_REVIEW';
            const recoveredRequiresHuman = noCorrespondenceRecovery.mode !== 'READY_TO_SEND';
            db.query(
                `UPDATE cases
                 SET status = $2,
                     substatus = $3,
                     pause_reason = $4,
                     requires_human = $5,
                     updated_at = NOW()
                 WHERE id = $1`,
                [requestId, recoveredStatus, noCorrespondenceRecovery.substatus, recoveredPauseReason, recoveredRequiresHuman]
            ).catch((err) => {
                logger.warn('[workspace] failed to reconcile stale no-correspondence case status', {
                    case_id: requestId,
                    run_id: activeRun.id,
                    error: err.message,
                });
            });
            db.completeAgentRun(
                activeRun.id,
                null,
                `Recovered stale waiting run without proposal (${noCorrespondenceRecovery.mode})`
            ).catch((err) => {
                logger.warn('[workspace] failed to close stale waiting run', {
                    case_id: requestId,
                    run_id: activeRun.id,
                    error: err.message,
                });
            });
            db.logActivity(
                'stale_no_correspondence_recovered',
                `Recovered stale no-correspondence case as ${recoveredStatus}`,
                {
                    case_id: requestId,
                    run_id: activeRun.id,
                    recovery_mode: noCorrespondenceRecovery.mode,
                }
            ).catch((err) => {
                logger.warn('[workspace] failed to log stale no-correspondence recovery', {
                    case_id: requestId,
                    run_id: activeRun.id,
                    error: err.message,
                });
            });
        }
        const runStatus = String(activeRun?.status || '').toLowerCase();
        const hasActiveRun = ['created', 'queued', 'processing', 'running', 'waiting'].includes(runStatus);
        const portalStatus = String(caseData.active_portal_task_status || '').toUpperCase();
        const portalActive = portalStatus === 'PENDING' || portalStatus === 'IN_PROGRESS';
        const isManualHandoffReview =
            dbStatus === 'needs_contact_info' ||
            dbStatus === 'needs_phone_call' ||
            String(reviewStateCaseData?.pause_reason || '').toUpperCase() === 'RESEARCH_HANDOFF' ||
            String(reviewStateCaseData?.pause_reason || '').toUpperCase() === 'AGENCY_RESEARCH_COMPLETE' ||
            String(reviewStateCaseData?.pause_reason || '').toUpperCase() === 'IMPORT_REVIEW' ||
            (
                dbStatus === 'needs_human_review' &&
                String(reviewStateCaseData?.pause_reason || '').toUpperCase() === 'UNSPECIFIED' &&
                /ready to send via (portal|email)/i.test(String(reviewStateCaseData?.substatus || ''))
            );
        const shouldNormalizeStaleReviewStatus =
            isHumanReviewStatus &&
            !Boolean(reviewStateCaseData?.requires_human) &&
            review_state !== 'DECISION_REQUIRED' &&
            !pendingProposal &&
            !hasActiveRun &&
            !portalActive &&
            !isManualHandoffReview;

        if (shouldNormalizeStaleReviewStatus) {
            requestDetail.status = 'AWAITING_RESPONSE';
            requestDetail.substatus = requestDetail.substatus || 'Recovered from stale human-review status';
            effectiveRequiresHuman = false;
            requestDetail.pause_reason = null;
            db.query(
                `UPDATE cases
                 SET status = 'awaiting_response',
                     pause_reason = NULL,
                     updated_at = NOW()
                 WHERE id = $1
                   AND status = ANY($2::text[])
                   AND (requires_human = false OR requires_human IS NULL)`,
                [requestId, ['needs_human_review', 'needs_human_fee_approval', 'needs_phone_call', 'needs_contact_info', 'needs_rebuttal', 'pending_fee_decision']]
            ).catch((err) => {
                logger.warn('[workspace] failed to normalize stale review status', {
                    case_id: requestId,
                    error: err.message,
                });
            });
        }
        requestDetail.requires_human = effectiveRequiresHuman;

        res.json({
            success: true,
            request: requestDetail,
            timeline_events: timelineEvents,
            thread_messages: threadMessages,
            next_action_proposal: nextActionProposal,
            agency_summary: agencySummary,
            case_agencies: sortedCaseAgencies,
            agency_candidates: agencyCandidates,
            deadline_milestones: deadlineMilestones,
            state_deadline: stateDeadline,
            pending_proposal: pendingProposal,
            pending_proposals: pendingProposals,
            portal_helper: portalHelper,
            review_state: requestDetail.review_state,
            control_state: requestDetail.control_state,
            control_mismatches: requestDetail.control_mismatches,
            active_run: effectiveActiveRun,
            agent_decisions: agentDecisions,
            constraint_history: constraintHistory,
        });
    } catch (error) {
        console.error('Error fetching request workspace:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

module.exports = router;
