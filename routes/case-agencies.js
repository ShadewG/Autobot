const express = require('express');
const router = express.Router();
const db = require('../services/database');
const notionService = require('../services/notion-service');
const pdContactService = require('../services/pd-contact-service');
const { normalizePortalUrl, detectPortalProviderByUrl } = require('../utils/portal-utils');
const { normalizeAgencyEmailHint, findCanonicalAgency } = require('../services/canonical-agency');
const {
    extractMetadataAgencyHint,
    detectCaseMetadataAgencyMismatch,
    extractResearchSuggestedAgency,
    isPlaceholderAgencyEmail,
    shouldSuppressPlaceholderAgencyDisplay,
} = require('../utils/request-normalization');

function firstNonEmpty(...values) {
    for (const value of values) {
        if (typeof value === 'string' && value.trim()) {
            return value.trim();
        }
    }
    return null;
}

function normalizeAgencyNameKey(name = '') {
    return String(name || '')
        .toLowerCase()
        .replace(/,\s*[a-z]{2}$/i, '')
        .replace(/,\s*(alabama|alaska|arizona|arkansas|california|colorado|connecticut|delaware|district of columbia|florida|georgia|hawaii|idaho|illinois|indiana|iowa|kansas|kentucky|louisiana|maine|maryland|massachusetts|michigan|minnesota|mississippi|missouri|montana|nebraska|nevada|new hampshire|new jersey|new mexico|new york|north carolina|north dakota|ohio|oklahoma|oregon|pennsylvania|rhode island|south carolina|south dakota|tennessee|texas|utah|vermont|virginia|washington|west virginia|wisconsin|wyoming)$/i, '')
        .replace(/[^a-z0-9\s]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function normalizeEmailKey(email = '') {
    const value = normalizeAgencyEmailHint(email);
    return value ? value.toLowerCase() : null;
}

function normalizePortalKey(portalUrl = '') {
    const normalized = normalizePortalUrl(portalUrl);
    return normalized ? normalized.toLowerCase() : null;
}

function dedupeCanonicalCaseAgencies(caseAgencies = []) {
    const deduped = new Map();

    for (const agency of caseAgencies) {
        const dedupeKey =
            [normalizeAgencyNameKey(agency?.agency_name), normalizeEmailKey(agency?.agency_email), normalizePortalKey(agency?.portal_url)]
                .filter(Boolean)
                .join('|')
            || `case-agency-${agency?.id ?? deduped.size + 1}`;

        const existing = deduped.get(dedupeKey);
        if (!existing) {
            deduped.set(dedupeKey, agency);
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

function buildExistingContactFallback(caseAgency, caseData) {
    const existingEmail = firstNonEmpty(
        caseAgency?.agency_email,
        caseAgency?.is_primary ? caseData?.agency_email : null,
        caseAgency?.is_primary ? caseData?.alternate_agency_email : null
    );
    const existingPortalUrl = firstNonEmpty(
        normalizePortalUrl(caseAgency?.portal_url),
        caseAgency?.is_primary ? normalizePortalUrl(caseData?.portal_url) : null
    );
    const existingPortalProvider = firstNonEmpty(
        caseAgency?.portal_provider,
        caseAgency?.is_primary ? caseData?.portal_provider : null
    );

    if (!existingEmail && !existingPortalUrl) {
        return null;
    }

    return {
        agency_email: existingEmail,
        portal_url: existingPortalUrl,
        portal_provider: existingPortalProvider,
    };
}

async function canonicalizeCaseAgency(caseAgency, caseData) {
    const researchSuggestedAgency = extractResearchSuggestedAgency(caseData?.contact_research_notes);
    const metadataAgencyHint = extractMetadataAgencyHint(caseData?.additional_details);
    const metadataAgencyMismatch = detectCaseMetadataAgencyMismatch({
        currentAgencyName: caseAgency?.agency_name || caseData?.agency_name,
        additionalDetails: caseData?.additional_details,
    });
    const shouldPreferResearchDisplay = Boolean(
        researchSuggestedAgency
        && ['case_row_backfill', 'case_row_fallback'].includes(caseAgency?.added_source)
        && isPlaceholderAgencyEmail(caseAgency?.agency_email || caseData?.agency_email)
        && !normalizePortalUrl(caseAgency?.portal_url || caseData?.portal_url)
    );
    const suppressPlaceholderDisplay = shouldSuppressPlaceholderAgencyDisplay({
        contactResearchNotes: caseData?.contact_research_notes,
        agencyEmail: caseAgency?.agency_email || caseData?.agency_email,
        portalUrl: caseAgency?.portal_url || caseData?.portal_url,
        addedSource: caseAgency?.added_source,
    });
    const canonicalAgency = await findCanonicalAgency(db, {
        portalUrl: (shouldPreferResearchDisplay || suppressPlaceholderDisplay) ? null : caseAgency?.portal_url,
        portalMailbox: (shouldPreferResearchDisplay || suppressPlaceholderDisplay) ? null : (caseAgency?.agency_email || caseData?.agency_email || null),
        agencyEmail: (shouldPreferResearchDisplay || suppressPlaceholderDisplay) ? null : caseAgency?.agency_email,
        agencyName: shouldPreferResearchDisplay ? researchSuggestedAgency.name : caseAgency?.agency_name,
        stateHint: caseData?.state,
    });

    const resolvedPortalUrl = [
        suppressPlaceholderDisplay ? null : caseAgency?.portal_url,
        canonicalAgency?.portal_url,
        canonicalAgency?.portal_url_alt,
    ].map((value) => normalizePortalUrl(value)).find(Boolean) || null;
    const resolvedFallbackName =
        metadataAgencyMismatch?.expectedAgencyName ||
        metadataAgencyHint?.name ||
        null;

    return {
        ...caseAgency,
        agency_id: suppressPlaceholderDisplay
            ? null
            : shouldPreferResearchDisplay
            ? (canonicalAgency?.id || null)
            : (canonicalAgency?.id || caseAgency?.agency_id || null),
        agency_name: suppressPlaceholderDisplay
            ? (resolvedFallbackName || 'Unknown agency')
            : (canonicalAgency?.name || (shouldPreferResearchDisplay ? researchSuggestedAgency?.name : caseAgency?.agency_name)),
        agency_email: suppressPlaceholderDisplay
            ? null
            : shouldPreferResearchDisplay
            ? (normalizeAgencyEmailHint(canonicalAgency?.email_foia)
                || normalizeAgencyEmailHint(canonicalAgency?.email_main)
                || null)
            : (normalizeAgencyEmailHint(caseAgency?.agency_email)
            || normalizeAgencyEmailHint(canonicalAgency?.email_foia)
            || normalizeAgencyEmailHint(canonicalAgency?.email_main)
            || null),
        portal_url: suppressPlaceholderDisplay ? null : resolvedPortalUrl,
        portal_provider: suppressPlaceholderDisplay
            ? null
            :
            caseAgency?.portal_provider
            || canonicalAgency?.portal_provider
            || detectPortalProviderByUrl(resolvedPortalUrl)?.name
            || null,
    };
}

/**
 * GET /api/cases/:id/agencies
 * List all agencies for a case
 */
router.get('/:id/agencies', async (req, res) => {
    try {
        const caseId = parseInt(req.params.id, 10);
        if (!caseId) return res.status(400).json({ success: false, error: 'Invalid case id' });

        const includeInactive = req.query.includeInactive === 'true';
        const [caseData, agencies] = await Promise.all([
            db.getCaseById(caseId),
            db.getCaseAgencies(caseId, includeInactive),
        ]);
        const canonicalAgencies = await Promise.all(
            agencies.map((agency) => canonicalizeCaseAgency(agency, caseData))
        );
        res.json({ success: true, agencies: dedupeCanonicalCaseAgencies(canonicalAgencies) });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * POST /api/cases/:id/agencies
 * Add an agency to a case
 */
router.post('/:id/agencies', express.json(), async (req, res) => {
    try {
        const caseId = parseInt(req.params.id, 10);
        if (!caseId) return res.status(400).json({ success: false, error: 'Invalid case id' });

        const { agency_name, agency_email, portal_url, portal_provider, notes, added_source } = req.body;
        if (!agency_name) return res.status(400).json({ success: false, error: 'agency_name is required' });

        // Try to find matching agency in agencies table
        const matchedAgency = await db.findAgencyByName(agency_name);

        const normalizedPortalUrl = normalizePortalUrl(portal_url || matchedAgency?.portal_url || null);

        const caseAgency = await db.addCaseAgency(caseId, {
            agency_name,
            agency_email: agency_email || matchedAgency?.email_main || null,
            portal_url: normalizedPortalUrl,
            portal_provider: portal_provider || detectPortalProviderByUrl(normalizedPortalUrl)?.name || null,
            agency_id: matchedAgency?.id || null,
            notes,
            added_source: added_source || 'manual'
        });

        await db.logActivity('case_agency_added', `Added agency "${agency_name}" to case ${caseId}`, {
            case_id: caseId,
            case_agency_id: caseAgency.id,
            added_source: added_source || 'manual'
        });

        res.json({ success: true, case_agency: caseAgency });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * PATCH /api/cases/:id/agencies/:caId
 * Update agency fields
 */
router.patch('/:id/agencies/:caId', express.json(), async (req, res) => {
    try {
        const caseAgencyId = parseInt(req.params.caId, 10);
        if (!caseAgencyId) return res.status(400).json({ success: false, error: 'Invalid case_agency id' });

        const allowed = [
            'agency_name', 'agency_email', 'portal_url', 'portal_provider',
            'status', 'substatus', 'notes', 'contact_research_notes'
        ];
        const updates = {};
        for (const key of allowed) {
            if (req.body[key] !== undefined) updates[key] = req.body[key];
        }
        if (updates.portal_url !== undefined) {
            updates.portal_url = normalizePortalUrl(updates.portal_url);
        }
        if (updates.portal_url && !updates.portal_provider) {
            updates.portal_provider = detectPortalProviderByUrl(updates.portal_url)?.name || null;
        }

        const updated = await db.updateCaseAgency(caseAgencyId, updates);
        if (!updated) return res.status(404).json({ success: false, error: 'Case agency not found' });

        res.json({ success: true, case_agency: updated });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * DELETE /api/cases/:id/agencies/:caId
 * Remove (deactivate) an agency
 */
router.delete('/:id/agencies/:caId', async (req, res) => {
    try {
        const caseAgencyId = parseInt(req.params.caId, 10);
        if (!caseAgencyId) return res.status(400).json({ success: false, error: 'Invalid case_agency id' });

        const removed = await db.removeCaseAgency(caseAgencyId);
        if (!removed) return res.status(404).json({ success: false, error: 'Case agency not found' });

        await db.logActivity('case_agency_removed', `Removed agency "${removed.agency_name}" from case ${removed.case_id}`, {
            case_id: removed.case_id,
            case_agency_id: caseAgencyId
        });

        res.json({ success: true, removed });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * POST /api/cases/:id/agencies/:caId/set-primary
 * Switch primary agency
 */
router.post('/:id/agencies/:caId/set-primary', async (req, res) => {
    try {
        const caseId = parseInt(req.params.id, 10);
        const caseAgencyId = parseInt(req.params.caId, 10);
        if (!caseId || !caseAgencyId) return res.status(400).json({ success: false, error: 'Invalid ids' });

        const newPrimary = await db.switchPrimaryAgency(caseId, caseAgencyId);
        if (!newPrimary) return res.status(404).json({ success: false, error: 'Case agency not found' });

        await db.logActivity('case_agency_primary_switched', `Switched primary agency to "${newPrimary.agency_name}" for case ${caseId}`, {
            case_id: caseId,
            case_agency_id: caseAgencyId
        });

        res.json({ success: true, primary: newPrimary });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * POST /api/cases/:id/agencies/:caId/research
 * Re-run contact research for a specific case agency and update fields.
 */
router.post('/:id/agencies/:caId/research', express.json(), async (req, res) => {
    try {
        const caseId = parseInt(req.params.id, 10);
        const caseAgencyId = parseInt(req.params.caId, 10);
        if (!caseId || !caseAgencyId) return res.status(400).json({ success: false, error: 'Invalid ids' });

        const caseData = await db.getCaseById(caseId);
        if (!caseData) return res.status(404).json({ success: false, error: 'Case not found' });

        const caseAgency = await db.getCaseAgencyById(caseAgencyId);
        if (!caseAgency || caseAgency.case_id !== caseId) {
            return res.status(404).json({ success: false, error: 'Case agency not found' });
        }

        const reuseExistingSignals = async (reason, extraMeta = {}) => {
            const fallback = buildExistingContactFallback(caseAgency, caseData);
            if (!fallback) {
                return null;
            }

            const research = {
                source: 'existing-case-data',
                reused_existing_channels: true,
                fallback_reason: reason,
                contact_email: fallback.agency_email,
                portal_url: fallback.portal_url,
                portal_provider: fallback.portal_provider,
                ...extraMeta,
            };

            const mergedNotes = JSON.stringify({
                researched_at: new Date().toISOString(),
                ...research,
            });

            const updated = await db.updateCaseAgency(caseAgencyId, {
                agency_email: fallback.agency_email || caseAgency.agency_email || null,
                portal_url: fallback.portal_url || caseAgency.portal_url || null,
                portal_provider: fallback.portal_provider || caseAgency.portal_provider || null,
                status: caseAgency.status || 'pending',
                contact_research_notes: mergedNotes,
            });

            await db.logActivity(
                'case_agency_research_reused_existing',
                `Agency research reused existing contact info for "${caseAgency.agency_name}"`,
                {
                    case_id: caseId,
                    case_agency_id: caseAgencyId,
                    fallback_reason: reason,
                    reused_email: fallback.agency_email || null,
                    reused_portal: fallback.portal_url || null,
                    ...extraMeta,
                }
            );

            res.json({ success: true, case_agency: updated, research });
            return updated;
        };

        const existingFallback = buildExistingContactFallback(caseAgency, caseData);
        if (existingFallback) {
            const reused = await reuseExistingSignals('existing_channels_available', { immediate_reuse: true });
            if (reused) {
                return;
            }
        }

        const RESEARCH_TIMEOUT_MS = 30_000;
        let lookup;
        try {
            lookup = await Promise.race([
                pdContactService.lookupContact(
                    caseAgency.agency_name,
                    caseData.state,
                    { forceSearch: true }
                ),
                new Promise((_, reject) =>
                    setTimeout(() => reject(new Error('Research lookup timed out after 30s')), RESEARCH_TIMEOUT_MS)
                ),
            ]);
        } catch (timeoutErr) {
            if (timeoutErr.message.includes('timed out')) {
                const reused = await reuseExistingSignals('lookup_timed_out', { timed_out: true });
                if (reused) {
                    return;
                }
                return res.status(504).json({
                    success: false,
                    error: 'Agency research timed out after 30 seconds. Try again or add contact info manually.',
                });
            }
            throw timeoutErr;
        }
        if (!lookup) {
            const reused = await reuseExistingSignals('lookup_returned_no_data');
            if (reused) {
                return;
            }
            await db.logActivity(
                'case_agency_research_failed',
                `Agency research found no contact info for "${caseAgency.agency_name}"`,
                { case_id: caseId, case_agency_id: caseAgencyId }
            );
            return res.status(404).json({ success: false, error: 'No contact data found' });
        }

        const mergedNotes = JSON.stringify({
            researched_at: new Date().toISOString(),
            source: lookup.source || 'pd-contact',
            confidence: lookup.confidence || null,
            notes: lookup.notes || null,
            result: lookup,
        });

        const updated = await db.updateCaseAgency(caseAgencyId, {
            agency_email: lookup.contact_email || caseAgency.agency_email || null,
            portal_url: lookup.portal_url || caseAgency.portal_url || null,
            portal_provider: lookup.portal_provider || caseAgency.portal_provider || null,
            status: caseAgency.status || 'pending',
            contact_research_notes: mergedNotes,
        });

        await db.logActivity(
            'case_agency_researched',
            `Updated contact research for "${caseAgency.agency_name}"`,
            {
                case_id: caseId,
                case_agency_id: caseAgencyId,
                source: lookup.source || null,
                confidence: lookup.confidence || null,
                found_email: lookup.contact_email || null,
                found_portal: lookup.portal_url || null,
            }
        );

        res.json({ success: true, case_agency: updated, research: lookup });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * POST /api/cases/:id/agencies/from-notion
 * Add an agency from a Notion page URL or ID
 */
router.post('/:id/agencies/from-notion', express.json(), async (req, res) => {
    try {
        const caseId = parseInt(req.params.id, 10);
        if (!caseId) return res.status(400).json({ success: false, error: 'Invalid case id' });

        let { notion_url } = req.body;
        if (!notion_url) return res.status(400).json({ success: false, error: 'notion_url is required' });

        // Extract page ID from Notion URL or raw ID
        let pageId = notion_url.trim();
        // Handle full URLs like https://www.notion.so/Page-Title-abc123def456...
        const urlMatch = pageId.match(/([a-f0-9]{32}|[a-f0-9-]{36})(?:\?|$)/i);
        if (urlMatch) {
            pageId = urlMatch[1];
        }
        // Remove dashes for consistent format
        pageId = pageId.replace(/-/g, '');

        if (!/^[a-f0-9]{32}$/i.test(pageId)) {
            return res.status(400).json({ success: false, error: 'Could not extract a valid Notion page ID from the URL' });
        }

        // Format as UUID
        const formattedId = `${pageId.slice(0,8)}-${pageId.slice(8,12)}-${pageId.slice(12,16)}-${pageId.slice(16,20)}-${pageId.slice(20)}`;

        // Check if this agency already exists in agencies table
        let agency = await db.query(
            'SELECT * FROM agencies WHERE notion_page_id = $1 OR notion_page_id = $2',
            [pageId, formattedId]
        );
        agency = agency.rows[0];

        if (!agency) {
            // Fetch from Notion and create the agency record
            try {
                const page = await notionService.notion.pages.retrieve({ page_id: formattedId });
                const props = page.properties;

                // Extract title
                const titleProp = Object.values(props).find(p => p.type === 'title');
                const agencyName = titleProp?.title?.[0]?.plain_text || 'Unknown Agency';

                // Extract key fields
                const getText = (name) => {
                    const p = props[name];
                    if (!p) return null;
                    if (p.type === 'rich_text') return p.rich_text?.[0]?.plain_text || null;
                    if (p.type === 'email') return p.email || null;
                    if (p.type === 'phone_number') return p.phone_number || null;
                    if (p.type === 'url') return p.url || null;
                    if (p.type === 'select') return p.select?.name || null;
                    return null;
                };

                // Try common Notion field names for agency data
                const emailFoia = getText('FOIA Email') || getText('Email FOIA') || getText('Records Email') || getText('Email');
                const emailMain = getText('Email Main') || getText('General Email') || emailFoia;
                const portalUrl = getText('Portal URL') || getText('Portal') || getText('Online Portal');
                const state = getText('State');
                const phone = getText('Phone') || getText('Phone Number');

                // Insert into agencies table
                const insertResult = await db.query(`
                    INSERT INTO agencies (notion_page_id, name, state, email_main, email_foia, phone, portal_url, sync_status)
                    VALUES ($1, $2, $3, $4, $5, $6, $7, 'synced')
                    RETURNING *
                `, [formattedId, agencyName, state, emailMain, emailFoia, phone, portalUrl]);
                agency = insertResult.rows[0];
            } catch (notionErr) {
                return res.status(400).json({ success: false, error: 'Failed to fetch Notion page: ' + notionErr.message });
            }
        }

        // Add as case agency
        const caseAgency = await db.addCaseAgency(caseId, {
            agency_name: agency.name,
            agency_email: agency.email_foia || agency.email_main || null,
            portal_url: agency.portal_url || null,
            portal_provider: agency.portal_provider || null,
            agency_id: agency.id,
            added_source: 'notion_import'
        });

        await db.logActivity('case_agency_added', `Added agency "${agency.name}" from Notion to case ${caseId}`, {
            case_id: caseId,
            case_agency_id: caseAgency.id,
            notion_page_id: formattedId,
            added_source: 'notion_import'
        });

        res.json({ success: true, case_agency: caseAgency, agency });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

module.exports = router;
