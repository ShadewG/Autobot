const { Client } = require('@notionhq/client');
const db = require('./database');
const aiService = require('./ai-service');
const pdContactService = require('./pd-contact-service');
const errorTrackingService = require('./error-tracking-service');
const { extractEmails, extractUrls, isValidEmail } = require('../utils/contact-utils');
const { normalizePortalUrl, isSupportedPortalUrl, detectPortalProviderByUrl } = require('../utils/portal-utils');
const { detectCaseMetadataAgencyMismatch, evaluateImportAutoDispatchSafety } = require('../utils/request-normalization');
const dns = require('dns').promises;

/**
 * Validate a newly imported case and return any warnings.
 * Runs email format + MX check, agency directory lookup, state match, and metadata mismatch detection.
 */
async function validateImportedCase(caseData) {
    const warnings = [];

    // 1. Email format validation
    if (caseData.agency_email && caseData.agency_email !== IMPORT_PLACEHOLDER_EMAIL) {
        if (!isValidEmail(caseData.agency_email)) {
            warnings.push({
                type: 'INVALID_EMAIL_FORMAT',
                message: `Agency email "${caseData.agency_email}" has invalid format`,
                field: 'agency_email',
            });
        } else {
            // 2. MX record lookup
            try {
                const domain = caseData.agency_email.split('@')[1];
                await dns.resolveMx(domain);
            } catch (err) {
                warnings.push({
                    type: 'NO_MX_RECORD',
                    message: `No MX records found for domain "${caseData.agency_email.split('@')[1]}" — email may not be deliverable`,
                    field: 'agency_email',
                });
            }
        }
    } else if (!caseData.portal_url) {
        warnings.push({
            type: 'MISSING_EMAIL',
            message: 'No agency email and no portal URL — case cannot be sent',
            field: 'agency_email',
        });
    }

    // 3. Agency directory lookup
    if (caseData.agency_name) {
        const agency = await db.findAgencyByName(caseData.agency_name, caseData.state);
        if (!agency) {
            warnings.push({
                type: 'AGENCY_NOT_IN_DIRECTORY',
                message: `Agency "${caseData.agency_name}" not found in directory`,
                field: 'agency_name',
            });
        } else if (caseData.state && agency.state && agency.state !== '{}' && agency.state !== caseData.state) {
            // 4. State mismatch
            warnings.push({
                type: 'STATE_MISMATCH',
                message: `Case state "${caseData.state}" does not match agency state "${agency.state}" for "${agency.name}"`,
                field: 'state',
            });
        }
    }

    // 5. Metadata agency mismatch detection
    const mismatch = detectCaseMetadataAgencyMismatch({
        currentAgencyName: caseData.agency_name,
        additionalDetails: caseData.additional_details,
    });
    if (mismatch) {
        warnings.push({
            type: 'AGENCY_METADATA_MISMATCH',
            message: `Agency name "${mismatch.currentAgencyName}" may not match case details which reference "${mismatch.expectedAgencyName}"`,
            field: 'agency_name',
            expected: mismatch.expectedAgencyName,
            expectedState: mismatch.expectedState,
        });
    }

    return warnings.length > 0 ? warnings : null;
}

// Lazy-load dispatch helper to avoid circular dependency
let _dispatchReadyToSend = null;
function getDispatchFn() {
    if (!_dispatchReadyToSend) {
        try {
            _dispatchReadyToSend = require('./dispatch-helper').dispatchReadyToSend;
        } catch (e) {
            console.warn('[notion] Failed to load dispatch-helper, will retry next call:', e.message);
            return null;
        }
    }
    return _dispatchReadyToSend;
}

const STATE_ABBREVIATIONS = {
    'alabama': 'AL', 'alaska': 'AK', 'arizona': 'AZ', 'arkansas': 'AR', 'california': 'CA',
    'colorado': 'CO', 'connecticut': 'CT', 'delaware': 'DE', 'district of columbia': 'DC',
    'florida': 'FL', 'georgia': 'GA', 'hawaii': 'HI', 'idaho': 'ID', 'illinois': 'IL',
    'indiana': 'IN', 'iowa': 'IA', 'kansas': 'KS', 'kentucky': 'KY', 'louisiana': 'LA',
    'maine': 'ME', 'maryland': 'MD', 'massachusetts': 'MA', 'michigan': 'MI',
    'minnesota': 'MN', 'mississippi': 'MS', 'missouri': 'MO', 'montana': 'MT',
    'nebraska': 'NE', 'nevada': 'NV', 'new hampshire': 'NH', 'new jersey': 'NJ',
    'new mexico': 'NM', 'new york': 'NY', 'north carolina': 'NC', 'north dakota': 'ND',
    'ohio': 'OH', 'oklahoma': 'OK', 'oregon': 'OR', 'pennsylvania': 'PA',
    'rhode island': 'RI', 'south carolina': 'SC', 'south dakota': 'SD', 'tennessee': 'TN',
    'texas': 'TX', 'utah': 'UT', 'vermont': 'VT', 'virginia': 'VA', 'washington': 'WA',
    'west virginia': 'WV', 'wisconsin': 'WI', 'wyoming': 'WY'
};

const NOTION_STATUS_MAP = {
    'ready_to_send': 'Ready to Send',
    'sent': 'Sent',
    'awaiting_response': 'Awaiting Response',
    'responded': 'Responded',
    'completed': 'Completed',
    'error': 'Error',
    'fee_negotiation': 'Fee Negotiation',
    'needs_human_fee_approval': 'Needs Human Approval',
    'needs_human_review': 'Needs Human Review',
    'needs_contact_info': 'Needs Human Review',
    'portal_in_progress': 'Portal Submission',
    'portal_submission_failed': 'Portal Issue',
    'needs_phone_call': 'Needs Phone Call',
    'pending': 'Ready to Send',
    'pending_fee_decision': 'Needs Human Approval',
    'id_state': 'ID State',
};

const IMPORT_PLACEHOLDER_EMAIL = 'pending-research@intake.autobot';

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableNotionError(error) {
    const status = Number(error?.status);
    const message = String(error?.message || '');
    if ([429, 500, 502, 503, 504].includes(status)) return true;
    return /(rate limit|temporar|timeout|ECONNRESET|ENOTFOUND|EAI_AGAIN)/i.test(message);
}

function isNotionObjectNotFoundError(error) {
    const status = Number(error?.status);
    const code = String(error?.code || error?.body?.code || '');
    const message = String(error?.message || '');
    if (status === 404) return true;
    if (/object_not_found/i.test(code)) return true;
    return /could not find (page|block) with id/i.test(message);
}

function normalizeNotionText(value) {
    return String(value || '')
        .replace(/&nbsp;|&#160;/gi, ' ')
        .replace(/\u00a0/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function stripImportBoilerplate(value) {
    return normalizeNotionText(value)
        .replace(/https?:\/\/\S+/gi, ' ')
        .replace(/\b(summary not available|not available|case summary|individuals involved|legal details|notion fields)\b/gi, ' ')
        .replace(/\b(last status change|researcher|sub-status|live status|status|title)\s*:/gi, ' ')
        .replace(/\b(import|research|ready to send)\b/gi, ' ')
        .replace(/[|:_#*`>\-]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function hasMeaningfulImportContent(value) {
    const stripped = stripImportBoilerplate(value);
    if (!stripped) return false;
    const words = stripped.split(/\s+/).filter(Boolean);
    return stripped.length >= 24 && words.length >= 4;
}

function hasValidNotionPageId(pageId) {
    const normalized = db.normalizeNotionPageId(pageId);
    return Boolean(normalized && /^[0-9a-f]{32}$/i.test(normalized));
}

function normalizeImportedDateValue(value) {
    const raw = normalizeNotionText(value);
    if (!raw) return null;

    const formatCalendarDate = (year, month, day) => {
        const yyyy = String(year).padStart(4, '0');
        const mm = String(month).padStart(2, '0');
        const dd = String(day).padStart(2, '0');
        return `${yyyy}-${mm}-${dd}`;
    };

    if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
        return raw;
    }

    const isoDateTimeMatch = raw.match(/^(\d{4}-\d{2}-\d{2})[T\s]/);
    if (isoDateTimeMatch) {
        return isoDateTimeMatch[1];
    }

    const monthYearMatch = raw.match(/^([A-Za-z]+)\s+(\d{4})$/);
    if (monthYearMatch) {
        const months = {
            january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
            july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
        };
        const month = months[String(monthYearMatch[1]).toLowerCase()];
        if (month) {
            return formatCalendarDate(monthYearMatch[2], month, 1);
        }
    }

    const parsed = new Date(raw);
    if (Number.isNaN(parsed.getTime())) {
        return null;
    }

    return formatCalendarDate(parsed.getFullYear(), parsed.getMonth() + 1, parsed.getDate());
}

const POLICE_DEPARTMENT_FIELD_SPECS = [
    { name: 'Department Name' },
    { name: 'Address' },
    { name: 'Mailing Address' },
    { name: 'County' },
    { name: 'State' },
    { name: 'Contact Email' },
    { name: 'Contact Phone' },
    { name: 'Fax No.' },
    { name: 'Email Correspondence' },
    { name: 'Name Of Officer/Employee Contacted' },
    { name: 'Portal/ Online Form' },
    { name: 'Portal/ Online Form (1)' },
    { name: 'Request Form' },
    { name: 'Allows In House Redaction' },
    { name: 'BWC Availability' },
    { name: 'Rating' },
    { name: 'Cases Requested' },
    { name: 'Cases requested' },
    { name: 'Calls' },
    { name: 'Last Info Verified' },
    { name: 'Notes' }
];

class NotionService {
    constructor() {
        this.notion = new Client({ auth: process.env.NOTION_API_KEY });
        this.databaseId = process.env.NOTION_CASES_DATABASE_ID;
        this.pagePropertyCache = new Map();
        this.resolvedPropertyCache = new Map();
        this.liveStatusProperty = process.env.NOTION_LIVE_STATUS_PROPERTY || 'Live Status';
        this.legacyStatusProperty = process.env.NOTION_STATUS_PROPERTY || 'Status';
        this.statusAutoProperty = process.env.NOTION_STATUS_AUTO_PROPERTY || 'Status Auto';
        this.statusAutoValue = process.env.NOTION_STATUS_AUTO_VALUE || 'Auto';
        this.databaseSchema = null;
        this.databaseSchemaFetchedAt = 0;
        this.submissionMemoryCache = new Map(); // pageId -> { data, fetchedAt }
        this.statusSyncQueues = new Map(); // caseId -> { running, pending, promise }
        this.enableAINormalization = process.env.ENABLE_NOTION_AI_NORMALIZATION !== 'false';
    }

    async quarantineMissingCasePage(caseData, operation, error) {
        if (!caseData?.id || !hasValidNotionPageId(caseData?.notion_page_id) || !isNotionObjectNotFoundError(error)) {
            return false;
        }

        const missingPageId = db.normalizeNotionPageId(caseData.notion_page_id);
        const quarantinedPageId = `missing:${caseData.id}:${missingPageId}`;
        const existingWarnings = Array.isArray(caseData.import_warnings)
            ? caseData.import_warnings
            : Array.isArray(caseData.import_warnings_json)
                ? caseData.import_warnings_json
                : [];

        const warning = {
            type: 'NOTION_PAGE_MISSING',
            message: `Stored Notion page is no longer accessible; sync disabled after ${operation}`,
            field: 'notion_page_id',
            notion_page_id: missingPageId,
            operation,
            detected_at: new Date().toISOString(),
        };

        const mergedWarnings = existingWarnings.some((entry) => (
            entry
            && entry.type === warning.type
            && String(entry.notion_page_id || '') === String(warning.notion_page_id)
        ))
            ? existingWarnings
            : [...existingWarnings, warning];

        this.pagePropertyCache.delete(missingPageId);

        await db.query(
            `UPDATE cases
             SET notion_page_id = $3,
                 last_notion_synced_at = NULL,
                 import_warnings = $2::jsonb,
                 updated_at = NOW()
             WHERE id = $1
               AND notion_page_id IS NOT NULL`,
            [caseData.id, JSON.stringify(mergedWarnings), quarantinedPageId]
        );

        await db.logActivity('notion_page_missing', `Disabled Notion sync for missing page ${missingPageId}`, {
            case_id: caseData.id,
            source_service: 'notion_service',
            operation,
            notion_page_id: missingPageId,
            error: String(error?.message || error).substring(0, 500),
        });

        return true;
    }

    applyImportReadinessGuard(caseData, options = {}) {
        if (!caseData) return [];

        const warnings = Array.isArray(caseData.import_warnings) ? [...caseData.import_warnings] : [];
        const placeholderTitle = normalizeNotionText(caseData.case_name) === '' || caseData.case_name === 'Untitled Case';
        const hasRequestedRecords = Array.isArray(caseData.requested_records) && caseData.requested_records.length > 0;
        const hasSummary = hasMeaningfulImportContent(caseData.additional_details);
        const hasPageNarrative = hasMeaningfulImportContent(options.pageContent || '');
        const hasRequestSignals = hasRequestedRecords || hasSummary || hasPageNarrative;
        const hasDeliveryPath = Boolean(normalizeNotionText(caseData.agency_email) || normalizeNotionText(caseData.portal_url));

        if (placeholderTitle) {
            warnings.push({
                type: 'PLACEHOLDER_TITLE',
                message: 'Notion page title is blank or placeholder text',
                field: 'case_name',
            });
        }

        if (!hasRequestSignals) {
            warnings.push({
                type: 'MISSING_REQUEST_CONTENT',
                message: 'Notion page has no substantive request content yet',
                field: 'additional_details',
            });
        }

        if (placeholderTitle && !hasRequestSignals) {
            caseData.status = 'needs_human_review';
            caseData.import_warnings = warnings;
            return warnings;
        }

        if (hasRequestSignals && !hasDeliveryPath) {
            warnings.push({
                type: 'MISSING_DELIVERY_PATH',
                message: 'Case has request content but no portal URL or agency email after import research',
                field: 'agency_email',
            });
            if (!['needs_human_review', 'needs_human_fee_approval', 'needs_phone_call'].includes(caseData.status)) {
                caseData.status = 'needs_contact_info';
            }
        }

        const importSafety = evaluateImportAutoDispatchSafety({
            caseName: caseData.case_name,
            subjectName: caseData.subject_name,
            agencyName: caseData.agency_name,
            additionalDetails: caseData.additional_details,
            importWarnings: warnings,
            agencyEmail: caseData.agency_email,
            portalUrl: caseData.portal_url,
        });

        if (importSafety.metadataMismatch && !warnings.some((warning) => warning.type === 'AGENCY_METADATA_MISMATCH')) {
            warnings.push({
                type: 'AGENCY_METADATA_MISMATCH',
                message: `Agency name "${importSafety.metadataMismatch.currentAgencyName}" may not match case details which reference "${importSafety.metadataMismatch.expectedAgencyName}"`,
                field: 'agency_name',
                expected: importSafety.metadataMismatch.expectedAgencyName,
                expectedState: importSafety.metadataMismatch.expectedState,
            });
        }

        if (importSafety.shouldBlockAutoDispatch) {
            caseData.status = 'needs_human_review';
        }

        caseData.import_warnings = warnings;
        return warnings;
    }

    normalizeImportedDateValue(value) {
        return normalizeImportedDateValue(value);
    }

    applyImportDeliveryFallback(caseData) {
        if (!caseData) return caseData;
        if (caseData.portal_url || caseData.agency_email) return caseData;
        if (caseData.status !== 'needs_contact_info') return caseData;

        caseData.agency_email = IMPORT_PLACEHOLDER_EMAIL;
        return caseData;
    }

    applySinglePageAIResult(caseData, aiResult) {
        if (!caseData || !aiResult) return caseData;

        if (aiResult.case_name) caseData.case_name = aiResult.case_name;
        if (aiResult.agency_name) caseData.agency_name = aiResult.agency_name;
        if (aiResult.state) caseData.state = aiResult.state;
        if (aiResult.incident_date) caseData.incident_date = this.normalizeImportedDateValue(aiResult.incident_date);
        if (aiResult.incident_location) caseData.incident_location = aiResult.incident_location;
        if (aiResult.subject_name) caseData.subject_name = aiResult.subject_name;
        if (aiResult.additional_details) caseData.additional_details = aiResult.additional_details;
        if (aiResult.records_requested?.length) caseData.requested_records = aiResult.records_requested;
        if (aiResult.tags?.length) caseData.tags = aiResult.tags;
        if (aiResult.portal_url) caseData.portal_url = aiResult.portal_url;
        if (aiResult.agency_email) caseData.agency_email = aiResult.agency_email;

        return caseData;
    }

    /**
     * Map Notion status to internal database status
     */
    mapNotionStatusToInternal(notionStatus) {
        if (!notionStatus) return 'ready_to_send';

        // Find matching internal status
        for (const [internal, notion] of Object.entries(NOTION_STATUS_MAP)) {
            if (notion === notionStatus) {
                return internal;
            }
        }

        // Default mapping for common cases
        const statusLower = notionStatus.toLowerCase();
        if (statusLower.includes('ready')) return 'ready_to_send';
        if (statusLower.includes('sent')) return 'sent';
        if (statusLower.includes('awaiting') || statusLower.includes('pending')) return 'awaiting_response';
        if (statusLower.includes('response') || statusLower.includes('responded')) return 'responded';
        if (statusLower.includes('complete')) return 'completed';
        if (statusLower.includes('error') || statusLower.includes('issue')) return 'error';
        if (statusLower.includes('fee')) return 'fee_negotiation';
        if (statusLower.includes('review')) return 'needs_human_review';
        if (statusLower.includes('portal')) return 'portal_in_progress';

        return 'ready_to_send'; // Default fallback
    }

    /**
     * Fetch cases from Notion database with a specific status
     */
    async fetchCasesWithStatus(status = 'Ready To Send') {
        try {
            const resolvedLiveStatus = await this.resolvePropertyName(this.liveStatusProperty);
            let statusPropertyName = resolvedLiveStatus;
            let statusPropertyInfo = await this.getDatabasePropertyInfo(statusPropertyName);

            if (!statusPropertyInfo) {
                console.warn(`Live status property "${this.liveStatusProperty}" not found; falling back to legacy property "${this.legacyStatusProperty}"`);
                statusPropertyName = await this.resolvePropertyName(this.legacyStatusProperty);
                statusPropertyInfo = await this.getDatabasePropertyInfo(statusPropertyName);
            }

            if (!statusPropertyInfo) {
                throw new Error(`No status property found on Notion database ${this.databaseId}`);
            }

            const filterKey = statusPropertyInfo.type === 'status' ? 'status' : 'select';
            const normalizedStatusValue = this.normalizeStatusValue(status, statusPropertyInfo);

            console.log(`\n=== NOTION QUERY DEBUG ===`);
            console.log(`Input status: "${status}"`);
            console.log(`Property name: "${statusPropertyName}"`);
            console.log(`Property type: "${statusPropertyInfo.type}"`);
            console.log(`Filter key: "${filterKey}"`);
            console.log(`Normalized value: "${normalizedStatusValue}"`);
            console.log(`Property options:`, JSON.stringify(statusPropertyInfo[statusPropertyInfo.type]?.options, null, 2));
            console.log(`=========================\n`);

            const filters = [
                {
                    property: statusPropertyName,
                    [filterKey]: {
                        is_not_empty: true
                    }
                },
                {
                    property: statusPropertyName,
                    [filterKey]: {
                        equals: normalizedStatusValue
                    }
                }
            ];

            // NOTE: Status Auto filter removed - sync all cases with matching Live Status
            // If you want to re-enable filtering by Status = "Auto", uncomment below:
            /*
            const resolvedAutoProperty = this.statusAutoProperty
                ? await this.resolvePropertyName(this.statusAutoProperty)
                : null;
            const statusAutoPropertyInfo = resolvedAutoProperty
                ? await this.getDatabasePropertyInfo(resolvedAutoProperty)
                : null;

            if (statusAutoPropertyInfo) {
                const normalizedAutoValue = ['status', 'select'].includes(statusAutoPropertyInfo.type)
                    ? this.normalizeStatusValue(this.statusAutoValue, statusAutoPropertyInfo)
                    : this.statusAutoValue;
                const autoFilter = this.buildPropertyEqualsFilter(
                    resolvedAutoProperty,
                    statusAutoPropertyInfo,
                    normalizedAutoValue
                );
                if (autoFilter) {
                    filters.push(autoFilter);
                }
            }
            */

            const response = [];
            let hasMore = true;
            let cursor = undefined;

            while (hasMore) {
                const query = await this.notion.databases.query({
                    database_id: this.databaseId,
                    filter: filters.length === 1 ? filters[0] : { and: filters },
                    start_cursor: cursor,
                    page_size: 100
                });

                response.push(...query.results);
                hasMore = query.has_more;
                cursor = query.next_cursor;
            }

            // Parse pages and enrich with police department data
            const cases = [];
            for (const page of response) {
                let caseData = this.parseNotionPage(page);

                // Export ALL case page property values so nothing is missed
                const allPropsText = this.formatAllPropertiesAsText(page.properties);
                const fullPageText = await this.getFullPagePlainText(page.id);

                caseData.additional_details = [caseData.additional_details, allPropsText, fullPageText]
                    .filter(Boolean)
                    .join('\n\n')
                    .trim();
                if (fullPageText) {
                    caseData.full_page_text = fullPageText;
                }

                if (this.enableAINormalization) {
                    const normalized = await aiService.normalizeNotionCase({
                        properties: this.preparePropertiesForAI(page.properties),
                        full_text: fullPageText
                    });
                    caseData = this.applyNormalizedCaseData(caseData, normalized);
                }
                caseData = this.enrichCaseFromNarrative(caseData);

                // Enrich with PD data first — portal URL from PD card takes priority
                const enrichedCase = await this.enrichWithPoliceDepartment(caseData, page);

                // Text fallback only if PD didn't provide a portal URL
                if (!enrichedCase.portal_url) {
                    const portalFromText = this.findPortalInText(enrichedCase.additional_details || fullPageText || '');
                    if (portalFromText) {
                        enrichedCase.portal_url = portalFromText;
                        console.log(`Detected portal URL from page text: ${portalFromText}`);
                    }
                }

                // pd-contact lookup: try dedicated service first
                let pdContactHandled = false;
                if (enrichedCase.agency_name) {
                    try {
                        const pdResult = await pdContactService.lookupContact(
                            enrichedCase.agency_name,
                            enrichedCase.state || enrichedCase.incident_location
                        );
                        if (pdResult) {
                            if (pdResult.portal_url) {
                                const normalized = normalizePortalUrl(pdResult.portal_url);
                                if (normalized && isSupportedPortalUrl(normalized)) {
                                    enrichedCase.portal_url = normalized;
                                    enrichedCase.portal_provider = pdResult.portal_provider || detectPortalProviderByUrl(normalized)?.name || null;
                                    pdContactHandled = true;
                                }
                            }
                            if (pdResult.contact_email && !enrichedCase.agency_email) {
                                enrichedCase.agency_email = pdResult.contact_email;
                                pdContactHandled = true;
                            }
                        }
                    } catch (pdErr) {
                        console.log(`pd-contact lookup failed for "${enrichedCase.agency_name}": ${pdErr.message}`);
                    }
                }

                // Unified Firecrawl contact search fallback: find portal, email, phone in one call
                if (!pdContactHandled && enrichedCase.agency_name) {
                    const contacts = await this.searchForAgencyContacts(enrichedCase.agency_name, enrichedCase.state);
                    if (contacts?.portal_url && contacts.portal_confidence !== 'low') {
                        const normalized = normalizePortalUrl(contacts.portal_url);
                        if (normalized && isSupportedPortalUrl(normalized)) {
                            enrichedCase.portal_url = normalized;
                            if (contacts.provider && contacts.provider !== 'other') {
                                enrichedCase.portal_provider = contacts.provider;
                            }
                        }
                    }
                    if (!enrichedCase.agency_email && contacts?.email && contacts.email_confidence !== 'low') {
                        enrichedCase.agency_email = contacts.email;
                        console.log(`Unified contact search found email: ${contacts.email}`);
                    }
                }

                enrichedCase.state = this.normalizeStateCode(enrichedCase.state);
                cases.push(enrichedCase);
            }

            return cases;
        } catch (error) {
            await errorTrackingService.captureException(error, {
                sourceService: 'notion_service',
                operation: 'fetch_cases_with_status',
                retryable: isRetryableNotionError(error),
                metadata: {
                    status,
                    databaseId: this.databaseId,
                },
            });
            console.error('Error fetching cases from Notion:', error);
            throw error;
        }
    }

    /**
     * Fetch a single Notion page by ID
     */
    async fetchPageById(pageId) {
        try {
            // Remove hyphens if present for API call
            const cleanPageId = pageId.replace(/-/g, '');

            console.log(`Fetching Notion page: ${cleanPageId}`);
            const page = await this.notion.pages.retrieve({ page_id: cleanPageId });

            const caseData = this.parseNotionPage(page);
            const pageContent = await this.getFullPagePlainText(page.id);
            if (pageContent) {
                caseData.full_page_text = pageContent;
                caseData.additional_details = [caseData.additional_details, pageContent]
                    .filter(Boolean)
                    .join('\n\n')
                    .trim();
            }
            this.enrichCaseFromNarrative(caseData);
            const enrichedCase = await this.enrichWithPoliceDepartment(caseData, page);

            // Extract state from page content if not already set
            if (!enrichedCase.state) {
                enrichedCase.state = await this.extractStateWithAI(enrichedCase, pageContent);
            }
            enrichedCase.state = this.normalizeStateCode(enrichedCase.state);

            enrichedCase.state = this.normalizeStateCode(enrichedCase.state);
            return enrichedCase;
        } catch (error) {
            await errorTrackingService.captureException(error, {
                sourceService: 'notion_service',
                operation: 'fetch_page_by_id',
                retryable: isRetryableNotionError(error),
                metadata: {
                    pageId,
                },
            });
            console.error(`Error fetching Notion page ${pageId}:`, error);
            throw error;
        }
    }

    /**
     * Parse a Notion page into our case format
     * Note: This returns a partial case object. Call enrichWithPoliceDepartment()
     * to fetch related police department data including email.
     */
    parseNotionPage(page) {
        const props = page.properties;

        // Get title from any title property (sanitize HTML entities like &nbsp;)
        const titleProp = Object.values(props).find(p => p.type === 'title');
        const rawTitle = normalizeNotionText(titleProp?.title?.[0]?.plain_text || '');
        const caseName = rawTitle || 'Untitled Case';

        // Get portal URL if available (fall back to other portal-labeled fields)
        const portalUrl = this.getProperty(props, 'Portal', 'url') ||
                          this.findPortalInProperties(props);

        // Get Police Department relation IDs (may have multiple)
        const policeDeptRelation = props['Police Department'];
        const policeDeptIds = (policeDeptRelation?.relation || []).map(r => r.id).filter(Boolean);
        const policeDeptId = policeDeptIds[0] || null;

        const statusValue =
            this.getPropertyWithFallback(props, this.liveStatusProperty, 'status') ||
            this.getPropertyWithFallback(props, this.legacyStatusProperty, 'select');

        return {
            notion_page_id: page.id,
            case_name: caseName,
            // Email will be fetched from related Police Department page
            agency_email: null, // Will be populated by enrichWithPoliceDepartment()
            police_dept_id: policeDeptId, // Store relation ID for fetching
            additional_police_dept_ids: policeDeptIds.slice(1), // Additional PDs beyond the primary
            // ACTUAL NOTION FIELD: "Suspect" (not "Subject Name")
            subject_name: this.getProperty(props, 'Suspect', 'rich_text') ||
                         this.getProperty(props, 'Victim', 'rich_text') ||
                         caseName,
            // ACTUAL NOTION FIELD: "Police Department" name will be fetched from relation
            agency_name: null, // Will be populated by enrichWithPoliceDepartment()
            // State will be extracted by AI from page content
            state: null,
            // ACTUAL NOTION FIELDS: "Crime Date" or "Date of arrest"
            incident_date: this.normalizeImportedDateValue(this.getProperty(props, 'Crime Date', 'date')) ||
                          this.normalizeImportedDateValue(this.getProperty(props, 'Date of arrest', 'date')) ||
                          null,
            // ACTUAL NOTION FIELD: "Location"
            incident_location: this.getProperty(props, 'Location', 'rich_text') ||
                             this.getProperty(props, 'City ', 'select') ||
                             '',
            // ACTUAL NOTION FIELD: "What to Request"
            requested_records: this.getProperty(props, 'What to Request', 'multi_select') ||
                             this.getProperty(props, 'Included Records', 'multi_select') ||
                             [],
            // ACTUAL NOTION FIELDS: "Case Summary" and "Notes" (rollup)
            additional_details: this.getProperty(props, 'Case Summary', 'rich_text') ||
                              this.getProperty(props, 'Notes', 'rich_text') ||
                              '',
            status: this.mapNotionStatusToInternal(statusValue),
            // Add portal URL for reference
            portal_url: portalUrl,
            // Extract assigned person name for user_id resolution
            assigned_person: this.getAssignedPerson(props)
        };
    }

    /**
     * Extract the assigned person's name from Notion people-type properties.
     * Checks common property names: "Assigned", "Assignee", "Assigned To", "Owner".
     */
    getAssignedPerson(props) {
        const candidates = ['Assigned', 'Assignee', 'Assigned To', 'Owner', 'Outreacher'];
        for (const name of candidates) {
            const prop = props[name];
            if (prop?.type === 'people' && prop.people?.length > 0) {
                return prop.people[0].name || null;
            }
        }
        return null;
    }

    async resolveAssignedUserId(assignedPerson) {
        if (!assignedPerson) return null;
        const rawName = String(assignedPerson).trim();
        if (!rawName) return null;

        const localName = rawName;

        // Preferred: explicit user.notion_name mapping from Settings.
        let user = await db.getUserByNotionName(rawName);
        if (!user && localName !== rawName) {
            user = await db.getUserByNotionName(localName);
        }
        // Fallback: legacy local display-name mapping.
        if (!user) {
            user = await db.getUserByName(localName);
        }
        return user ? user.id : null;
    }

    enrichCaseFromNarrative(caseData) {
        if (!caseData) return caseData;
        const text = String(caseData.additional_details || '').trim();
        if (!text) return caseData;

        const pickLineValue = (patterns) => {
            for (const pattern of patterns) {
                const match = text.match(pattern);
                if (match && match[1]) return match[1].trim();
            }
            return null;
        };

        const subjectFromText = pickLineValue([
            /suspect name:\s*([^\n\r]+)/i,
            /subject name:\s*([^\n\r]+)/i,
            /suspect:\s*([^\n\r]+)/i
        ]);
        if (subjectFromText && (!caseData.subject_name || caseData.subject_name === caseData.case_name)) {
            caseData.subject_name = subjectFromText;
        }

        const locationFromText = pickLineValue([
            /location of the incident:\s*([^\n\r]+)/i,
            /incident location:\s*([^\n\r]+)/i
        ]);
        if (locationFromText && !caseData.incident_location) {
            caseData.incident_location = locationFromText;
        }

        const agencyFromText = pickLineValue([
            /(?:^|\n)\s*pd:\s*([^\n\r]+)/i,
            /(?:^|\n)\s*police department:\s*([^\n\r]+)/i,
            /(?:^|\n)\s*agency:\s*([^\n\r]+)/i
        ]);
        if (agencyFromText && (!caseData.agency_name || caseData.agency_name === 'Police Department')) {
            caseData.agency_name = agencyFromText
                .replace(/\\\[/g, '[')
                .replace(/\\\]/g, ']')
                .replace(/\[[^\]]+\]\([^)]+\)/g, (match) => match.replace(/\[([^\]]+)\]\([^)]+\)/, '$1'))
                .trim();
        }

        const dateFromText = pickLineValue([
            /date of the incident:\s*([^\n\r]+)/i,
            /incident date:\s*([^\n\r]+)/i,
            /on\s+([A-Za-z]+\s+\d{1,2},\s+\d{4})/i
        ]);
        if (dateFromText && !caseData.incident_date) {
            caseData.incident_date = this.normalizeImportedDateValue(dateFromText) || caseData.incident_date;
        }

        const hasRequestedRecords = Array.isArray(caseData.requested_records) && caseData.requested_records.length > 0;
        if (!hasRequestedRecords) {
            const lower = text.toLowerCase();
            const inferred = [];
            const addIf = (cond, label) => { if (cond && !inferred.includes(label)) inferred.push(label); };

            addIf(lower.includes('incident report') || lower.includes('offense report') || lower.includes('police report'), 'Incident report');
            addIf(lower.includes('arrest report'), 'Arrest report');
            addIf(lower.includes('body camera') || lower.includes('body cam') || lower.includes('bwc'), 'Body camera footage');
            addIf(lower.includes('dash camera') || lower.includes('dashcam') || lower.includes('in-car'), 'Dash camera footage');
            addIf(lower.includes('911') || lower.includes('dispatch audio') || lower.includes('radio traffic'), '911/dispatch audio');
            addIf(lower.includes('surveillance') || lower.includes('cctv') || lower.includes('security camera'), 'Surveillance video');
            addIf(lower.includes('interview') || lower.includes('interrogation'), 'Interview/interrogation recordings');
            addIf(lower.includes('photograph'), 'Scene/evidence photographs');

            if (inferred.length) {
                caseData.requested_records = inferred;
            }
        }

        return caseData;
    }

    /**
     * Fetch police department details from related page and enrich case data
     */
    async enrichWithPoliceDepartment(caseData, notionPage = null) {
        if (!caseData.police_dept_id) {
            console.warn('No police department relation found');
            caseData.agency_email = null;
            caseData.agency_name = 'Police Department';
            if (notionPage) {
                this.applyFallbackContactsFromPage(caseData, notionPage);
            }
            return caseData;
        }

        try {
            // Fetch the related Police Department page
            const deptPage = await this.notion.pages.retrieve({
                page_id: caseData.police_dept_id
            });

            const deptProps = deptPage.properties;

            // AI normalization for police department page
            let normalizedPD = null;
            if (this.enableAINormalization) {
                const deptText = await this.getFullPagePlainText(caseData.police_dept_id);
                normalizedPD = await aiService.normalizeNotionCase({
                    properties: this.preparePropertiesForAI(deptProps),
                    full_text: deptText
                });
            }

            this.applyNormalizedPDData(caseData, normalizedPD);

            // Fallback contact extraction for any remaining gaps
            const priorityFields = this.exportPoliceDepartmentFields(deptProps);
            const allFieldsData = this.preparePropertiesForAI(deptProps);
            const fieldsPayload = {
                priority_fields: priorityFields,
                all_fields: allFieldsData
            };

            let { emailCandidate, portalCandidate } = await this.extractContactsWithAI(fieldsPayload, caseData);

            // NO FALLBACK - return null if not found
            caseData.agency_email = emailCandidate || null;

            // If AI/regex didn't find a portal URL, scan ALL PD fields directly
            if (!portalCandidate) {
                portalCandidate = this.extractFirstUrlFromProperties(deptProps);
                if (portalCandidate) {
                    console.log(`Extracted portal URL directly from PD fields: ${portalCandidate}`);
                }
            }

            // PD-sourced portal URL always overrides text-extracted ones
            if (portalCandidate) {
                caseData.portal_url = portalCandidate;
            }

            const deptTitleProp = Object.values(deptProps).find(p => p.type === 'title');
            caseData.agency_name = deptTitleProp?.title?.[0]?.plain_text || 'Police Department';

            // Feature 4: Extract PD Rating as case priority (1-5 scale)
            const ratingProp = deptProps['Rating'] || deptProps['rating'];
            if (ratingProp?.type === 'number' && ratingProp.number != null) {
                caseData.priority = Math.max(0, Math.min(5, Math.round(ratingProp.number)));
            } else if (ratingProp?.type === 'select' && ratingProp.select?.name) {
                const parsed = parseInt(ratingProp.select.name, 10);
                if (!isNaN(parsed)) caseData.priority = Math.max(0, Math.min(5, parsed));
            }

            console.log(`Enriched case with Police Dept: ${caseData.agency_name} (${caseData.agency_email})`);

        } catch (error) {
            errorTrackingService.captureException(error, {
                sourceService: 'notion_service',
                operation: 'enrich_with_police_department',
                retryable: isRetryableNotionError(error),
                metadata: {
                    policeDeptId: caseData.police_dept_id || null,
                    notionPageId: notionPage?.id || null,
                    caseName: caseData.case_name || null,
                },
            }).catch(() => null);
            console.error('Error fetching police department details:', error.message);
            // NO FALLBACK - return null so it flags for human review
            caseData.agency_email = null;
            caseData.agency_name = 'Police Department';
            if (notionPage) {
                this.applyFallbackContactsFromPage(caseData, notionPage);
            }
        }

        if (notionPage) {
            this.applyFallbackContactsFromPage(caseData, notionPage);
        }

        return caseData;
    }

    applyFallbackContactsFromPage(caseData, page) {
        try {
            const props = page.properties || {};
            for (const [name, prop] of Object.entries(props)) {
                const type = prop.type;
                const val = this.getProperty(props, name, type);
                if (!val) continue;

                extractEmails(val).forEach(email => {
                    if (isValidEmail(email) && (!caseData.agency_email || caseData.agency_email === (process.env.DEFAULT_TEST_EMAIL || 'shadewofficial@gmail.com'))) {
                        caseData.agency_email = email.trim();
                    } else if (isValidEmail(email) && caseData.agency_email !== email) {
                        caseData.alternate_agency_email = caseData.alternate_agency_email || email.trim();
                    }
                });

                if (!caseData.portal_url) {
                    const portalCandidate = this.detectContactChannels([val]).portalCandidate;
                    if (portalCandidate) {
                        caseData.portal_url = portalCandidate;
                    }
                }
            }
        } catch (error) {
            console.warn('Failed to apply fallback contacts from page:', error.message);
        }
    }

    applyNormalizedPDData(caseData, normalized) {
        if (!normalized) return;
        if (normalized.contact_emails?.length) {
            caseData.agency_email = normalized.contact_emails[0];
            if (normalized.contact_emails[1]) {
                caseData.alternate_agency_email = normalized.contact_emails[1];
            }
        }
        if (!caseData.portal_url && normalized.portal_urls?.length) {
            const portal = normalized.portal_urls.map(normalizePortalUrl).find(u => u && isSupportedPortalUrl(u));
            if (portal) {
                caseData.portal_url = portal;
            }
        }
        if (normalized.agency_name && (!caseData.agency_name || caseData.agency_name === 'Police Department')) {
            caseData.agency_name = normalized.agency_name;
        }
    }

    /**
     * Get property value from Notion page based on type
     */
    getProperty(properties, name, type) {
        const prop = properties[name];
        if (!prop) return null;

        switch (type) {
            case 'title': {
                const t = normalizeNotionText((prop.title || [])
                    .map((part) => part.plain_text || '')
                    .join(' '));
                return t || null;
            }
            case 'rich_text': {
                const t = normalizeNotionText((prop.rich_text || [])
                    .map((part) => part.plain_text || '')
                    .join(' '));
                return t || null;
            }
            case 'email':
                return prop.email || '';
            case 'select':
                return prop.select?.name || prop.status?.name || '';
            case 'status':
                return prop.status?.name || prop.select?.name || '';
            case 'multi_select':
                return prop.multi_select?.map(item => item.name) || [];
            case 'date':
                return prop.date?.start || null;
            case 'number':
                return prop.number || null;
            case 'url':
                return prop.url || '';
            case 'relation':
                // For relation fields, we can't get the actual name directly
                // We would need to fetch the related page
                // For now, return the first relation ID or empty string
                return prop.relation?.[0]?.id || '';
            case 'rollup':
                return this.extractPlainValue(prop);
            default:
                return null;
        }
    }

    /**
     * Get full page plain text content from all blocks
     */
    async getFullPagePlainText(pageId) {
        try {
            const blocks = await this.notion.blocks.children.list({
                block_id: pageId.replace(/-/g, '')
            });

            let text = '';
            for (const block of blocks.results) {
                const blockText = this.extractTextFromBlock(block);
                if (blockText) text += blockText + ' ';
            }

            return text.trim();
        } catch (error) {
            console.error('Error getting page text:', error.message);
            return '';
        }
    }

    /**
     * Extract text from a Notion block
     */
    extractTextFromBlock(block) {
        if (!block) return '';

        switch (block.type) {
            case 'paragraph':
                return block.paragraph?.rich_text?.map(t => t.plain_text).join('') || '';
            case 'heading_1':
                return block.heading_1?.rich_text?.map(t => t.plain_text).join('') || '';
            case 'heading_2':
                return block.heading_2?.rich_text?.map(t => t.plain_text).join('') || '';
            case 'heading_3':
                return block.heading_3?.rich_text?.map(t => t.plain_text).join('') || '';
            case 'bulleted_list_item':
                return block.bulleted_list_item?.rich_text?.map(t => t.plain_text).join('') || '';
            case 'numbered_list_item':
                return block.numbered_list_item?.rich_text?.map(t => t.plain_text).join('') || '';
            case 'to_do':
                return block.to_do?.rich_text?.map(t => t.plain_text).join('') || '';
            case 'quote':
                return block.quote?.rich_text?.map(t => t.plain_text).join('') || '';
            case 'callout':
                return block.callout?.rich_text?.map(t => t.plain_text).join('') || '';
            default:
                return '';
        }
    }

    /**
     * Extract US state from page content using AI
     */
    async extractStateWithAI(caseData, pageContent) {
        try {
            const OpenAI = require('openai');
            const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

            const prompt = `Extract the US state for this police incident case.

CASE INFO:
Case Name: ${caseData.case_name || 'Unknown'}
Agency: ${caseData.agency_name || 'Unknown'}
Location: ${caseData.incident_location || 'Unknown'}

FULL PAGE CONTENT:
${pageContent.substring(0, 2000)}

TASK:
Identify the US state (2-letter code) where this incident occurred.

Look for:
- State names in the content
- City/location names that indicate a state
- Agency names that include state info
- Any explicit state mentions

Return ONLY the 2-letter state code (e.g., "CA", "TX", "NY") or null if you cannot determine it with confidence.

Respond with JSON:
{
  "state": "XX or null",
  "confidence": "high/medium/low",
  "reasoning": "brief explanation"
}`;

            const response = await openai.chat.completions.create({
                model: 'gpt-5.2-2025-12-11',
                messages: [{ role: 'user', content: prompt }],
                response_format: { type: 'json_object' }
            });

            const result = JSON.parse(response.choices[0].message.content);
            console.log(`AI state extraction for ${caseData.agency_name}: ${result.state} (${result.confidence}) - ${result.reasoning}`);

            return result.state || null;

        } catch (error) {
            console.error('AI state extraction failed:', error.message);
            return null;
        }
    }

    /**
     * Use GPT-5 to intelligently extract contact info from ALL PD fields
     * Prioritizes portal > email, and finds the best contact method
     */
    async extractContactsWithAI(fieldsPayload = {}, caseData) {
        try {
            const OpenAI = require('openai');
            const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

            const priorityFields = fieldsPayload.priority_fields || {};
            const allFieldsData = fieldsPayload.all_fields || fieldsPayload || {};

            const prompt = `You are analyzing a Police Department database record to find contact information for submitting public records requests.

PRIORITY POLICE DEPARTMENT FIELDS:
${JSON.stringify(priorityFields, null, 2)}

FULL FIELD EXPORT:
${JSON.stringify(allFieldsData, null, 2)}

AGENCY NAME: ${caseData.agency_name || 'Unknown'}

TASK:
Extract and prioritize contact methods for submitting FOIA/public records requests.

PRIORITY ORDER:
1. Portal/Online submission URL (highest priority - govqa.us, nextrequest.com, etc.)
2. Records request email address
3. General agency email

Return ONLY valid, working contact information. Do not return example/placeholder emails or broken links.

Respond with JSON:
{
  "portal_url": "full portal URL or null",
  "email": "best email address or null",
  "confidence": "high/medium/low",
  "reasoning": "brief explanation of what you found"
}`;

            const response = await openai.chat.completions.create({
                model: 'gpt-5.2-2025-12-11',
                messages: [{ role: 'user', content: prompt }],
                response_format: { type: 'json_object' }
            });

            const result = JSON.parse(response.choices[0].message.content);
            console.log(`AI contact extraction: ${result.reasoning}`);

            return {
                portalCandidate: result.portal_url || null,
                emailCandidate: result.email || null
            };

        } catch (error) {
            console.error('AI contact extraction failed, falling back to regex:', error.message);
            // Fallback to original regex-based detection
            const allValues = Object.values(allFieldsData);
            return this.detectContactChannels(allValues);
        }
    }

    detectContactChannels(values = []) {
        const emails = [];
        const portals = [];

        values.forEach((value) => {
            if (!value) {
                return;
            }

            extractEmails(value).forEach(email => {
                if (isValidEmail(email)) {
                    emails.push(email.trim());
                }
            });

            const rawText = Array.isArray(value) ? value.join(' ') : String(value || '');
            const urls = extractUrls(value);
            urls.forEach(url => {
                const normalized = normalizePortalUrl(url);
                if (normalized && this.isLikelyPortalUrl(normalized, rawText) && !portals.includes(normalized)) {
                    portals.push(normalized);
                }
            });

            if (!urls.length) {
                const raw = (Array.isArray(value) ? value.join(' ') : String(value)).trim();
                if (raw) {
                    raw.split(/[\s,;]+/).forEach((token) => {
                        if (!token) return;
                        const cleanToken = token.replace(/[),.]+$/, '');
                        if (cleanToken.includes('.') && !cleanToken.includes('@')) {
                            const normalizedToken = normalizePortalUrl(cleanToken);
                            if (normalizedToken && this.isLikelyPortalUrl(normalizedToken, raw) && !portals.includes(normalizedToken)) {
                                portals.push(normalizedToken);
                            }
                        }
                    });
                }
            }
        });

        return {
            emailCandidate: emails[0] || null,
            portalCandidate: portals.find(url => isSupportedPortalUrl(url)) || portals[0] || null
        };
    }

    findPortalInProperties(properties = {}) {
        for (const [name, prop] of Object.entries(properties)) {
            const lowerName = name.toLowerCase();
            if (!lowerName.includes('portal') && !lowerName.includes('request link') && !lowerName.includes('submission')) {
                continue;
            }

            let candidate = null;
            switch (prop.type) {
                case 'url':
                    candidate = prop.url;
                    break;
                case 'rich_text':
                    candidate = prop.rich_text?.map(t => t.plain_text).join(' ');
                    break;
                case 'title':
                    candidate = prop.title?.map(t => t.plain_text).join(' ');
                    break;
                case 'rollup':
                    candidate = this.extractPlainValue(prop);
                    break;
                default:
                    break;
            }

            if (!candidate) {
                continue;
            }

            const portalCandidate = this.detectContactChannels([candidate]).portalCandidate;
            if (portalCandidate) {
                return portalCandidate;
            }
        }

        return null;
    }

    /**
     * Scan ALL properties for URLs, prioritizing portal-named fields.
     * Used as a broad fallback when AI and regex extraction fail.
     */
    extractFirstUrlFromProperties(properties = {}) {
        const portalFieldUrls = [];
        const otherFieldUrls = [];

        for (const [name, prop] of Object.entries(properties)) {
            const urls = [];

            // Direct URL for url-type properties
            if (prop.type === 'url' && prop.url) {
                urls.push(prop.url);
            }

            // Also extract URLs embedded in text content
            const textValue = this.extractPlainValue(prop);
            if (textValue) {
                for (const u of extractUrls(String(textValue))) {
                    if (!urls.includes(u)) urls.push(u);
                }
            }

            if (!urls.length) continue;

            const lowerName = name.toLowerCase();
            const isPortalField = lowerName.includes('portal') ||
                                  lowerName.includes('request form') ||
                                  lowerName.includes('online form') ||
                                  lowerName.includes('submission');

            for (const url of urls) {
                const normalized = normalizePortalUrl(url);
                if (normalized && isSupportedPortalUrl(normalized)) {
                    if (isPortalField) {
                        portalFieldUrls.push(normalized);
                    } else {
                        otherFieldUrls.push(normalized);
                    }
                }
            }
        }

        return portalFieldUrls[0] || otherFieldUrls[0] || null;
    }

    async getFullPagePlainText(blockId, depth = 0) {
        try {
            const lines = [];
            let cursor = undefined;
            do {
                const response = await this.notion.blocks.children.list({
                    block_id: blockId,
                    page_size: 100,
                    start_cursor: cursor
                });

                for (const block of response.results) {
                    const text = this.extractTextFromBlock(block);
                    if (text) {
                        lines.push(text);
                    }

                    if (block.has_children) {
                        const childText = await this.getFullPagePlainText(block.id, depth + 1);
                        if (childText) {
                            lines.push(childText);
                        }
                    }
                }

                cursor = response.has_more ? response.next_cursor : null;
            } while (cursor);

            return lines.join('\n').trim();
        } catch (error) {
            await errorTrackingService.captureException(error, {
                sourceService: 'notion_service',
                operation: 'get_full_page_plain_text',
                retryable: isRetryableNotionError(error),
                metadata: { blockId, depth },
            });
            console.warn(`Failed to fetch full page text for block ${blockId}:`, error.message);
            return '';
        }
    }

    extractTextFromBlock(block) {
        if (!block || !block.type) {
            return '';
        }

        const type = block.type;
        const richText = block[type]?.rich_text || [];

        const plain = richText
            .map(part => part.plain_text || '')
            .join('')
            .trim();

        if (!plain) {
            return '';
        }

        if (['heading_1', 'heading_2', 'heading_3'].includes(type)) {
            return `\n${plain.toUpperCase()}\n`;
        }

        if (type === 'bulleted_list_item' || type === 'numbered_list_item') {
            return `• ${plain}`;
        }

        if (type === 'to_do') {
            const checkbox = block.to_do?.checked ? '[x]' : '[ ]';
            return `${checkbox} ${plain}`;
        }

        return plain;
    }

    findPortalInText(text = '') {
        if (!text) {
            return null;
        }
        const urls = extractUrls(text);
        const urlPortalHints = [
            'portal', 'records-request', 'public-records', 'open-records',
            'request-center', 'nextrequest', 'govqa', 'mycusthelp',
            'justfoia', '/webapp/_rs/', 'foia', 'publicrecords',
            'openrecords', 'records_request'
        ];

        for (const rawUrl of urls) {
            const normalized = normalizePortalUrl(rawUrl);
            if (!normalized || !isSupportedPortalUrl(normalized)) continue;

            // Known portal provider domain — always accept
            if (detectPortalProviderByUrl(normalized)) {
                return normalized;
            }

            // Only accept URLs that contain portal keywords in the URL itself.
            // This avoids picking up article/news links from free-form text.
            const lowerUrl = normalized.toLowerCase();
            if (urlPortalHints.some(h => lowerUrl.includes(h))) {
                return normalized;
            }
        }
        return null;
    }

    /**
     * Unified Firecrawl search for all agency contact info (portal, email, phone).
     * One search call returns everything; individual functions delegate here.
     * Caches results per agency+state for the lifetime of this service instance.
     */
    async searchForAgencyContacts(agencyName, state) {
        const cacheKey = `${agencyName}||${state || ''}`.toLowerCase();
        if (this._contactSearchCache?.has(cacheKey)) {
            return this._contactSearchCache.get(cacheKey);
        }

        const result = { portal_url: null, provider: null, portal_confidence: 'low', email: null, email_confidence: 'low', phone: null, phone_confidence: 'low', reasoning: '' };

        try {
            const firecrawlApiKey = process.env.FIRECRAWL_API_KEY;
            let searchContext = '';

            if (firecrawlApiKey) {
                try {
                    const query = `${agencyName} ${state || ''} public records FOIA request portal email phone contact`;
                    const firecrawlRes = await fetch('https://api.firecrawl.dev/v1/search', {
                        method: 'POST',
                        headers: {
                            'Authorization': `Bearer ${firecrawlApiKey}`,
                            'Content-Type': 'application/json',
                        },
                        body: JSON.stringify({ query, limit: 6 }),
                        signal: AbortSignal.timeout(20_000),
                    });
                    if (firecrawlRes.ok) {
                        const firecrawlData = await firecrawlRes.json();
                        const results = firecrawlData?.data || [];
                        if (results.length > 0) {
                            const formatted = results.map(r => `[${r.title || r.metadata?.title || 'No title'}] ${r.url || ''}\n${r.description || r.markdown?.substring(0, 2000) || ''}`);
                            searchContext = `\n\nWEB SEARCH RESULTS:\n${formatted.join('\n---\n')}`;
                            console.log(`Firecrawl unified search returned ${results.length} results for "${agencyName}"`);
                        }
                    } else {
                        console.warn(`Firecrawl unified search failed (${firecrawlRes.status})`);
                    }
                } catch (fcErr) {
                    console.warn('Firecrawl unified search error:', fcErr.message);
                }
            }

            const Anthropic = require('@anthropic-ai/sdk');
            const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

            const response = await anthropic.messages.create({
                model: process.env.CLAUDE_MODEL || 'claude-sonnet-4-6',
                max_tokens: 500,
                messages: [{
                    role: 'user',
                    content: `Find all contact information for submitting public records / FOIA requests to: ${agencyName}${state ? `, ${state}` : ''}.${searchContext}

Return ONLY valid JSON with ALL of these fields:
{
  "portal_url": "https://..." or null,
  "provider": "govqa|nextrequest|justfoia|other" or null,
  "portal_confidence": "high|medium|low",
  "email": "records@agency.gov" or null,
  "email_confidence": "high|medium|low",
  "phone": "+1XXXXXXXXXX" or null,
  "phone_confidence": "high|medium|low",
  "reasoning": "brief explanation of what was found"
}

Only include contacts you are confident about. Set confidence to "low" if uncertain.`
                }],
            });

            const text = response.content[0].text?.trim() || '';
            const jsonMatch = text.match(/\{[\s\S]*\}/);
            if (jsonMatch) {
                const parsed = JSON.parse(jsonMatch[0]);
                Object.assign(result, parsed);
                console.log(`Unified contact search for "${agencyName}": portal=${result.portal_url || 'none'} email=${result.email || 'none'} phone=${result.phone || 'none'}`);
            }
        } catch (error) {
            console.error(`Unified contact search failed for "${agencyName}":`, error.message);
            result.reasoning = error.message;
        }

        if (!this._contactSearchCache) this._contactSearchCache = new Map();
        this._contactSearchCache.set(cacheKey, result);
        return result;
    }

    /**
     * Use Firecrawl search + Anthropic to find or verify a portal URL for an agency.
     * Returns { portal_url, provider, confidence, reasoning } or null values on failure.
     */
    async searchForPortalUrl(agencyName, state, existingPortalUrl = null) {
        try {
            const firecrawlApiKey = process.env.FIRECRAWL_API_KEY;
            let searchContext = '';

            if (firecrawlApiKey) {
                try {
                    const query = `${agencyName} ${state || ''} public records portal GovQA NextRequest JustFOIA request`;
                    const firecrawlRes = await fetch('https://api.firecrawl.dev/v1/search', {
                        method: 'POST',
                        headers: {
                            'Authorization': `Bearer ${firecrawlApiKey}`,
                            'Content-Type': 'application/json',
                        },
                        body: JSON.stringify({ query, limit: 6 }),
                        signal: AbortSignal.timeout(20_000),
                    });
                    if (firecrawlRes.ok) {
                        const firecrawlData = await firecrawlRes.json();
                        const results = firecrawlData?.data || [];
                        if (results.length > 0) {
                            const formatted = results.map(r => `[${r.title || r.metadata?.title || 'No title'}] ${r.url || ''}\n${r.description || r.markdown?.substring(0, 2000) || ''}`);
                            searchContext = `\n\nWEB SEARCH RESULTS:\n${formatted.join('\n---\n')}`;
                            console.log(`Firecrawl returned ${results.length} results for portal search of "${agencyName}"`);
                        }
                    } else {
                        console.warn(`Firecrawl portal search failed (${firecrawlRes.status})`);
                    }
                } catch (fcErr) {
                    console.warn('Firecrawl portal search error:', fcErr.message);
                }
            }

            const Anthropic = require('@anthropic-ai/sdk');
            const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

            const existingContext = existingPortalUrl
                ? `\nWe currently have this URL on file: ${existingPortalUrl}\nConfirm if this is the correct records request submission portal, or find the correct one.`
                : '';

            const response = await anthropic.messages.create({
                model: process.env.CLAUDE_MODEL || 'claude-sonnet-4-6',
                max_tokens: 400,
                messages: [{
                    role: 'user',
                    content: `Find the official online public records request portal URL for: ${agencyName}${state ? `, ${state}` : ''}.${existingContext}
Look for GovQA, NextRequest, JustFOIA portals, or the agency's own online records request form.
Only return a URL you are confident is the correct records request submission page, not a general info page.${searchContext}

Return ONLY valid JSON: {"portal_url": "https://...", "provider": "govqa|nextrequest|justfoia|other|null", "confidence": "high|medium|low", "reasoning": "one sentence"}
If you cannot find a portal, return: {"portal_url": null, "provider": null, "confidence": "low", "reasoning": "..."}`
                }],
            });

            const text = response.content[0].text?.trim() || '';
            const jsonMatch = text.match(/\{[\s\S]*\}/);
            if (jsonMatch) {
                const result = JSON.parse(jsonMatch[0]);
                console.log(`Portal search for "${agencyName}": ${result.portal_url || '(none)'} [${result.confidence}] - ${result.reasoning}`);
                return result;
            }

            console.warn(`Portal search for "${agencyName}": could not parse response`);
            return { portal_url: null, provider: null, confidence: 'low', reasoning: 'Failed to parse search response' };
        } catch (error) {
            console.error(`Portal search failed for "${agencyName}":`, error.message);
            return { portal_url: null, provider: null, confidence: 'low', reasoning: error.message };
        }
    }

    /**
     * Look up phone number from Notion Police Department relation page.
     * @param {string} notionPageId - The case page ID in Notion
     * @returns {{ phone: string|null, pdPageId: string|null }} - Phone number and PD page ID
     */
    async lookupPhoneFromNotion(notionPageId) {
        try {
            const page = await this.notion.pages.retrieve({ page_id: notionPageId.replace(/-/g, '') });
            const policeDeptRelation = page.properties['Police Department'];
            const policeDeptId = policeDeptRelation?.relation?.[0]?.id;
            if (!policeDeptId) return { phone: null, pdPageId: null };

            const deptPage = await this.notion.pages.retrieve({ page_id: policeDeptId });
            const phone = this.extractPlainValue(deptPage.properties['Contact Phone']);
            if (phone && String(phone).trim()) {
                console.log(`Found phone from Notion PD page: ${phone}`);
                return { phone: String(phone).trim(), pdPageId: policeDeptId };
            }
            return { phone: null, pdPageId: policeDeptId };
        } catch (error) {
            console.warn('Notion phone lookup failed:', error.message);
            return { phone: null, pdPageId: null };
        }
    }

    /**
     * Use Firecrawl search + Anthropic to find a phone number for an agency.
     * @param {string} agencyName
     * @param {string} state
     * @returns {{ phone: string|null, confidence: string, reasoning: string }}
     */
    async searchForAgencyPhone(agencyName, state) {
        try {
            const firecrawlApiKey = process.env.FIRECRAWL_API_KEY;
            let searchContext = '';

            if (firecrawlApiKey) {
                try {
                    const query = `${agencyName} ${state || ''} records division FOIA phone number contact`;
                    const firecrawlRes = await fetch('https://api.firecrawl.dev/v1/search', {
                        method: 'POST',
                        headers: {
                            'Authorization': `Bearer ${firecrawlApiKey}`,
                            'Content-Type': 'application/json',
                        },
                        body: JSON.stringify({ query, limit: 5 }),
                        signal: AbortSignal.timeout(20_000),
                    });
                    if (firecrawlRes.ok) {
                        const firecrawlData = await firecrawlRes.json();
                        const results = firecrawlData?.data || [];
                        if (results.length > 0) {
                            const formatted = results.map(r => `[${r.title || r.metadata?.title || 'No title'}] ${r.url || ''}\n${r.description || r.markdown?.substring(0, 2000) || ''}`);
                            searchContext = `\n\nWEB SEARCH RESULTS:\n${formatted.join('\n---\n')}`;
                            console.log(`Firecrawl returned ${results.length} results for phone search of "${agencyName}"`);
                        }
                    } else {
                        console.warn(`Firecrawl phone search failed (${firecrawlRes.status})`);
                    }
                } catch (fcErr) {
                    console.warn('Firecrawl phone search error:', fcErr.message);
                }
            }

            const Anthropic = require('@anthropic-ai/sdk');
            const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

            const response = await anthropic.messages.create({
                model: process.env.CLAUDE_MODEL || 'claude-sonnet-4-6',
                max_tokens: 300,
                messages: [{
                    role: 'user',
                    content: `Find the phone number for the records division or main line of: ${agencyName}${state ? `, ${state}` : ''}.
Look for a records division phone number, FOIA phone number, or general agency phone number.${searchContext}

Return ONLY valid JSON: {"phone": "+1XXXXXXXXXX", "confidence": "high|medium|low", "reasoning": "one sentence"}
If you cannot find a phone number, return: {"phone": null, "confidence": "low", "reasoning": "..."}`
                }],
            });

            const text = response.content[0].text?.trim() || '';
            const jsonMatch = text.match(/\{[\s\S]*\}/);
            if (jsonMatch) {
                const result = JSON.parse(jsonMatch[0]);
                console.log(`Phone search for "${agencyName}": ${result.phone || '(none)'} [${result.confidence}] - ${result.reasoning}`);
                if (result.phone && result.confidence !== 'low') {
                    return result;
                }
            }

            return { phone: null, confidence: 'low', reasoning: 'No phone found' };
        } catch (error) {
            console.error(`Phone search failed for "${agencyName}":`, error.message);
            return { phone: null, confidence: 'low', reasoning: error.message };
        }
    }

    /**
     * Use Firecrawl search + Anthropic to find a records request email for an agency.
     * Used as fallback when no portal URL or email is found.
     */
    async searchForAgencyEmail(agencyName, state) {
        try {
            const firecrawlApiKey = process.env.FIRECRAWL_API_KEY;
            let searchContext = '';

            if (firecrawlApiKey) {
                try {
                    const query = `${agencyName} ${state || ''} records request FOIA email address contact`;
                    const firecrawlRes = await fetch('https://api.firecrawl.dev/v1/search', {
                        method: 'POST',
                        headers: {
                            'Authorization': `Bearer ${firecrawlApiKey}`,
                            'Content-Type': 'application/json',
                        },
                        body: JSON.stringify({ query, limit: 5 }),
                        signal: AbortSignal.timeout(20_000),
                    });
                    if (firecrawlRes.ok) {
                        const firecrawlData = await firecrawlRes.json();
                        const results = firecrawlData?.data || [];
                        if (results.length > 0) {
                            const formatted = results.map(r => `[${r.title || r.metadata?.title || 'No title'}] ${r.url || ''}\n${r.description || r.markdown?.substring(0, 2000) || ''}`);
                            searchContext = `\n\nWEB SEARCH RESULTS:\n${formatted.join('\n---\n')}`;
                            console.log(`Firecrawl returned ${results.length} results for email search of "${agencyName}"`);
                        }
                    } else {
                        console.warn(`Firecrawl email search failed (${firecrawlRes.status})`);
                    }
                } catch (fcErr) {
                    console.warn('Firecrawl email search error:', fcErr.message);
                }
            }

            const Anthropic = require('@anthropic-ai/sdk');
            const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

            const response = await anthropic.messages.create({
                model: process.env.CLAUDE_MODEL || 'claude-sonnet-4-6',
                max_tokens: 300,
                messages: [{
                    role: 'user',
                    content: `Find the email address for submitting public records / FOIA requests to: ${agencyName}${state ? `, ${state}` : ''}.
Look for a records division email, FOIA email, or general agency email that accepts records requests.${searchContext}

Return ONLY valid JSON: {"email": "address@example.gov", "confidence": "high|medium|low", "reasoning": "one sentence"}
If you cannot find an email, return: {"email": null, "confidence": "low", "reasoning": "..."}`
                }],
            });

            const text = response.content[0].text?.trim() || '';
            const jsonMatch = text.match(/\{[\s\S]*\}/);
            if (jsonMatch) {
                const result = JSON.parse(jsonMatch[0]);
                console.log(`Email search for "${agencyName}": ${result.email || '(none)'} [${result.confidence}] - ${result.reasoning}`);
                if (result.email && result.confidence !== 'low') {
                    return result;
                }
            }

            return { email: null, confidence: 'low', reasoning: 'No email found' };
        } catch (error) {
            console.error(`Email search failed for "${agencyName}":`, error.message);
            return { email: null, confidence: 'low', reasoning: error.message };
        }
    }

    isLikelyPortalUrl(url, contextText = '') {
        const normalized = normalizePortalUrl(url);
        if (!normalized || !isSupportedPortalUrl(normalized)) {
            return false;
        }

        // Strong signal: known portal provider hostname.
        if (detectPortalProviderByUrl(normalized)) {
            return true;
        }

        const lowerUrl = normalized.toLowerCase();
        const lowerContext = String(contextText || '').toLowerCase();
        const portalHints = [
            'portal',
            'records request',
            'public records',
            'open records',
            'request center',
            'nextrequest',
            'govqa',
            'mycusthelp',
            'justfoia',
            '/webapp/_rs/'
        ];

        // Must include portal-like patterns in URL or nearby text.
        return portalHints.some(h => lowerUrl.includes(h) || lowerContext.includes(h));
    }

    /**
     * Update a Notion page with new properties
     */
    async updatePage(pageId, updates) {
        try {
            if (!hasValidNotionPageId(pageId)) {
                throw new Error(`Invalid Notion page ID: ${pageId}`);
            }
            const availableProperties = await this.getPagePropertyNames(pageId);
            const propSet = new Set(availableProperties);
            const properties = {};

            // Helper: set a property if it exists on the page
            const setDate = (name, value) => {
                if (!value) return;
                if (propSet.has(name)) properties[name] = { date: { start: value } };
            };
            const setRichText = (name, value) => {
                if (value === undefined) return;
                if (propSet.has(name)) properties[name] = {
                    rich_text: value ? [{ text: { content: String(value).substring(0, 2000) } }] : []
                };
            };
            const setNumber = (name, value) => {
                if (value === undefined || value === null) return;
                const num = Number(value);
                if (isNaN(num)) return;
                if (propSet.has(name)) properties[name] = { number: num };
            };
            const setCheckbox = (name, value) => {
                if (value === undefined) return;
                if (propSet.has(name)) properties[name] = { checkbox: !!value };
            };
            const setUrl = (name, value) => {
                if (!value) return;
                if (propSet.has(name)) properties[name] = { url: value };
            };

            const liveStatusPropName = this.liveStatusProperty;

            // Request date (Notion property: "Request Date")
            setDate('Request Date', updates.send_date);

            // Last response date
            setDate('Last Response', updates.last_response_date);

            // AI Summary
            setRichText('AI Summary', updates.ai_summary);

            // Live Status (select or status type — auto-detect)
            if (updates.live_status && propSet.has(liveStatusPropName)) {
                const liveStatusPropertyInfo = await this.getDatabasePropertyInfo(liveStatusPropName);
                if (liveStatusPropertyInfo?.type === 'status') {
                    properties[liveStatusPropName] = { status: { name: updates.live_status } };
                } else {
                    properties[liveStatusPropName] = { select: { name: updates.live_status } };
                }
            }

            // Live Substatus
            setRichText('Live Substatus', updates.live_substatus);

            // Portal fields
            setRichText('Last Portal Status', updates.last_portal_status_text);
            setDate('Last Portal Updated', updates.last_portal_updated_at);
            setUrl('Portal Task URL', updates.portal_task_url);

            // Portal Login Email — auto-detect property type (email vs rich_text)
            if (updates.portal_login_email && propSet.has('Portal Login Email')) {
                const portalEmailPropInfo = await this.getDatabasePropertyInfo('Portal Login Email');
                if (portalEmailPropInfo?.type === 'email') {
                    properties['Portal Login Email'] = { email: updates.portal_login_email };
                } else {
                    properties['Portal Login Email'] = {
                        rich_text: [{ text: { content: String(updates.portal_login_email).substring(0, 2000) } }]
                    };
                }
            }

            // Human review flag
            setCheckbox('Needs Human Review', updates.needs_human_review);

            // --- Additional useful properties ---

            // Request number (portal reference number)
            setRichText('Request NR', updates.request_number);

            // Fee/price amount
            setNumber('Price', updates.fee_amount);

            // Expected response date (statutory deadline)
            setDate('Expected Response Date', updates.expected_response_date);

            // Follow-up tracking
            setDate('Follow Up Sent', updates.last_followup_date);
            setDate('last follow-up date', updates.last_followup_date);

            // Last status change timestamp
            setDate('Last Status Change', updates.last_status_change);

            // Failure reason (portal failures, etc.)
            setRichText('Failure Reason', updates.failure_reason);

            // Denial tracking
            setRichText('Denial Reason', updates.denial_reason);
            setDate('Case Denied Date', updates.denial_date);

            if (Object.keys(properties).length === 0) {
                console.warn(`No valid Notion properties to update for page ${pageId}`);
                return null;
            }

            const maxAttempts = 4;
            for (let attempt = 1; attempt <= maxAttempts; attempt++) {
                try {
                    const response = await this.notion.pages.update({
                        page_id: pageId,
                        properties
                    });
                    return response;
                } catch (error) {
                    const retryable = isRetryableNotionError(error);
                    if (!retryable || attempt === maxAttempts) {
                        throw error;
                    }
                    const delayMs = Math.min(4000, 300 * Math.pow(2, attempt - 1));
                    console.warn(`[Notion] updatePage retry ${attempt}/${maxAttempts} for page ${pageId} in ${delayMs}ms: ${error.message}`);
                    await sleep(delayMs);
                }
            }
            return null;
        } catch (error) {
            if (isNotionObjectNotFoundError(error)) {
                this.pagePropertyCache.delete(pageId);
                throw error;
            }
            await errorTrackingService.captureException(error, {
                sourceService: 'notion_service',
                operation: 'update_page',
                retryable: isRetryableNotionError(error),
                metadata: {
                    pageId,
                    updateKeys: Object.keys(updates || {}),
                },
            });
            console.error('Error updating Notion page:', error);
            throw error;
        }
    }

    /**
     * Sync cases from Notion to our database
     */
    async syncCasesFromNotion(status = 'Ready To Send') {
        try {
            console.log(`Syncing cases with status: ${status}`);
            const notionCases = await this.fetchCasesWithStatus(status);
            console.log(`Found ${notionCases.length} cases in Notion`);

            const syncedCases = [];
            const statusKey = status.toLowerCase().replace(/ /g, '_');
            const protectedStatuses = new Set([
                'portal_in_progress',
                'needs_human_review',
                'needs_human_fee_approval',
                'sent',
                'awaiting_response',
                'responded',
                'completed'
            ]);

            for (const notionCase of notionCases) {
                let existing = null;
                try {
                    // Check if case already exists in our database
                    existing = await db.getCaseByNotionId(notionCase.notion_page_id);

                    if (existing) {
                        if (protectedStatuses.has(existing.status)) {
                            console.log(`Case ${existing.id} is in protected status (${existing.status}); ignoring Notion Ready status.`);
                            continue;
                        }

                        if (existing.status === 'ready_to_send') {
                            if (!existing.queued_at) {
                                const dispatch = getDispatchFn();
                                if (dispatch) {
                                    try { await dispatch(existing.id, { source: 'notion_sync' }); } catch (e) {
                                        if (e.code !== '23505') console.warn(`[notion_sync] Dispatch failed for case ${existing.id}:`, e.message);
                                    }
                                }
                                syncedCases.push(existing);
                            }
                            continue;
                        }

                        console.log(`Case status changed to "${status}" - updating and re-queuing: ${notionCase.case_name}`);

                        const updatedCase = await db.updateCase(existing.id, {
                            agency_name: notionCase.agency_name,
                            agency_email: notionCase.agency_email,
                            status: 'ready_to_send',
                            last_notion_synced_at: new Date(),
                        });

                        // Dispatch via Run Engine so the case is picked up immediately
                        const dispatch = getDispatchFn();
                        if (dispatch) {
                            try { await dispatch(existing.id, { source: 'notion_sync' }); } catch (e) {
                                console.warn(`Failed to dispatch re-synced case ${existing.id}:`, e.message);
                            }
                        }

                        syncedCases.push(updatedCase);

                        await db.logActivity('case_status_changed', `Case status changed to "${status}" - re-queued: ${notionCase.case_name}`, {
                            case_id: existing.id
                        });

                        continue;
                    }

                    // Resolve assigned person to user_id
                    if (notionCase.assigned_person) {
                        try {
                            const userId = await this.resolveAssignedUserId(notionCase.assigned_person);
                            if (userId) {
                                notionCase.user_id = userId;
                                const user = await db.getUserById(userId);
                                console.log(`Assigned case to user: ${user?.name || userId} (${user?.email || 'n/a'})`);
                            } else {
                                console.warn(`No matching user for Notion assignee: ${notionCase.assigned_person}`);
                            }
                        } catch (err) {
                            console.warn(`Failed to resolve assigned user: ${err.message}`);
                        }
                    }

                    this.applyImportReadinessGuard(notionCase);

                    // Calculate deadline based on state
                    const deadline = await this.calculateDeadline(notionCase.state);
                    notionCase.deadline_date = deadline;

                    // Create new case
                    const newCase = await db.createCase(notionCase);
                    console.log(`Created new case: ${newCase.case_name}`);
                    syncedCases.push(newCase);

                    // Validate imported case and store warnings
                    try {
                        const importWarnings = [
                            ...(Array.isArray(notionCase.import_warnings) ? notionCase.import_warnings : []),
                            ...((await validateImportedCase(notionCase)) || []),
                        ];
                        if (importWarnings.length > 0) {
                            await db.query(
                                'UPDATE cases SET import_warnings = $1, last_notion_synced_at = NOW() WHERE id = $2',
                                [JSON.stringify(importWarnings), newCase.id]
                            );
                            console.warn(`Import warnings for case ${newCase.id}:`, importWarnings.map(w => w.type).join(', '));
                        }
                    } catch (valErr) {
                        console.warn(`Failed to validate imported case ${newCase.id}:`, valErr.message);
                    }

                    // Set last synced timestamp (even if validation had no warnings)
                    await db.query('UPDATE cases SET last_notion_synced_at = NOW() WHERE id = $1 AND last_notion_synced_at IS NULL', [newCase.id]);

                    // Log activity
                    await db.logActivity('case_imported', `Imported case from Notion: ${newCase.case_name}`, {
                        case_id: newCase.id
                    });
                } catch (error) {
                    await errorTrackingService.captureException(error, {
                        sourceService: 'notion_service',
                        operation: 'sync_case_from_notion',
                        caseId: existing?.id || null,
                        retryable: isRetryableNotionError(error),
                        metadata: {
                            notionPageId: notionCase.notion_page_id,
                            caseName: notionCase.case_name,
                            statusKey,
                        },
                    });
                    console.error(`Error syncing case ${notionCase.case_name}:`, error);
                }
            }

            return syncedCases;
        } catch (error) {
            await errorTrackingService.captureException(error, {
                sourceService: 'notion_service',
                operation: 'sync_cases_from_notion',
                retryable: isRetryableNotionError(error),
                metadata: {
                    status,
                },
            });
            console.error('Error syncing cases from Notion:', error);
            throw error;
        }
    }

    /**
     * Calculate deadline date based on state's response time
     */
    async calculateDeadline(stateCode, fromDate = new Date()) {
        if (!stateCode) {
            // Default to 10 business days if no state specified
            return this.addBusinessDays(fromDate, 10);
        }

        const stateDeadline = await db.getStateDeadline(stateCode);
        const days = stateDeadline?.response_days || 10;

        return this.addBusinessDays(fromDate, days);
    }

    /**
     * Add business days to a date (skip weekends)
     */
    addBusinessDays(date, days) {
        const result = new Date(date);
        let addedDays = 0;

        while (addedDays < days) {
            result.setDate(result.getDate() + 1);
            const dayOfWeek = result.getDay();

            // Skip weekends (0 = Sunday, 6 = Saturday)
            if (dayOfWeek !== 0 && dayOfWeek !== 6) {
                addedDays++;
            }
        }

        return result;
    }

    /**
     * Update Notion page status based on our database changes
     */
    async syncStatusToNotion(caseId) {
        const key = String(caseId);
        let queueState = this.statusSyncQueues.get(key);
        if (!queueState) {
            queueState = { running: false, pending: false, promise: null };
            this.statusSyncQueues.set(key, queueState);
        }

        queueState.pending = true;
        if (queueState.running) {
            return queueState.promise;
        }

        queueState.running = true;
        queueState.promise = (async () => {
            try {
                while (queueState.pending) {
                    queueState.pending = false;
                    await this._syncStatusToNotion(caseId);
                }
            } finally {
                queueState.running = false;
                queueState.promise = null;
                if (!queueState.pending) {
                    this.statusSyncQueues.delete(key);
                }
            }
        })();

        return queueState.promise;
    }

    async _syncStatusToNotion(caseId) {
        let caseData = null;
        try {
            caseData = await db.getCaseById(caseId);
            if (!caseData) {
                console.error(`Case ${caseId} not found`);
                return;
            }

            // Skip test/synthetic cases or malformed page IDs.
            if (!hasValidNotionPageId(caseData.notion_page_id)) {
                console.log(`Skipping Notion sync for test case ${caseId}`);
                return;
            }

            const updates = {};
            const notionStatus = this.mapStatusToNotion(caseData.status);
            if (notionStatus) {
                updates.live_status = notionStatus;
            }

            // Core dates
            if (caseData.send_date) {
                updates.send_date = caseData.send_date;
            }
            if (caseData.last_response_date) {
                updates.last_response_date = caseData.last_response_date;
            }

            // Substatus & portal fields
            if (caseData.substatus !== undefined) {
                updates.live_substatus = caseData.substatus || '';
            }
            if (caseData.last_portal_status) {
                updates.last_portal_status_text = caseData.last_portal_status;
            }
            if (caseData.last_portal_status_at) {
                updates.last_portal_updated_at = caseData.last_portal_status_at;
            }
            if (caseData.last_portal_task_url || caseData.last_portal_recording_url) {
                updates.portal_task_url = caseData.last_portal_task_url || caseData.last_portal_recording_url;
            }
            if (caseData.last_portal_account_email) {
                updates.portal_login_email = caseData.last_portal_account_email;
            }
            updates.needs_human_review = ['needs_human_review', 'needs_human_fee_approval'].includes(caseData.status);

            // Request number (portal reference)
            if (caseData.portal_request_number) {
                updates.request_number = caseData.portal_request_number;
            }

            // Fee amount from fee_quote_jsonb
            if (caseData.fee_quote_jsonb?.amount != null) {
                updates.fee_amount = caseData.fee_quote_jsonb.amount;
            }

            // Deadline / expected response date
            if (caseData.deadline_date) {
                updates.expected_response_date = caseData.deadline_date;
            }

            // Last status change
            if (caseData.updated_at) {
                updates.last_status_change = caseData.updated_at;
            }

            // Escalation/failure/denial reasons
            if (caseData.escalation_reason) {
                const isDenied = caseData.status === 'completed' && caseData.outcome_type === 'denied';
                if (isDenied) {
                    updates.denial_reason = caseData.escalation_reason;
                    if (caseData.closed_at) {
                        updates.denial_date = caseData.closed_at;
                    }
                } else if (['error', 'portal_submission_failed'].includes(caseData.status)) {
                    updates.failure_reason = caseData.escalation_reason;
                }
            }

            // Follow-up date (best-effort, don't let failure block sync)
            try {
                const followup = await db.getFollowUpScheduleByCaseId(caseId);
                if (followup?.last_followup_sent_at) {
                    updates.last_followup_date = followup.last_followup_sent_at;
                }
            } catch (_) { /* non-critical */ }

            await this.updatePage(caseData.notion_page_id, updates);
            // Track successful outbound sync
            await db.query('UPDATE cases SET last_notion_synced_at = NOW() WHERE id = $1', [caseId]);
            console.log(`Updated Notion page for case: ${caseData.case_name}`);
        } catch (error) {
            const quarantined = await this.quarantineMissingCasePage(caseData, 'sync_status_to_notion', error).catch(() => false);
            await errorTrackingService.captureException(error, {
                sourceService: 'notion_service',
                operation: 'sync_status_to_notion',
                caseId,
                retryable: quarantined ? false : isRetryableNotionError(error),
                metadata: {
                    notionPageId: caseData?.notion_page_id || null,
                    caseStatus: caseData?.status || null,
                    quarantinedMissingPage: quarantined,
                },
            });
            console.error('Error syncing status to Notion:', error);
            // Log to activity_log so sync failures are visible in dashboard
            try {
                await db.logActivity('notion_sync_error', `Notion sync failed for case ${caseId}`, {
                    case_id: caseId,
                    error: String(error?.message || error).substring(0, 500),
                    status: error?.status || null,
                });
            } catch (_) { /* don't let logging failure mask original error */ }
        }
    }

    /**
     * Map our internal status to Notion status values
     */
    mapStatusToNotion(internalStatus) {
        // Use the single canonical NOTION_STATUS_MAP plus extra outbound-only mappings
        const extraMappings = {
            'cancelled': 'Completed',
            'closed': 'Completed',
        };
        if (NOTION_STATUS_MAP[internalStatus]) return NOTION_STATUS_MAP[internalStatus];
        if (extraMappings[internalStatus]) return extraMappings[internalStatus];
        console.warn(`[Notion] No Live Status mapping for internal status "${internalStatus}"`);
        return null;
    }

    /**
     * Add AI summary to Notion page
     */
    async addAISummaryToNotion(caseId, summary) {
        try {
            const caseData = await db.getCaseById(caseId);
            if (!caseData) return;

            if (!hasValidNotionPageId(caseData.notion_page_id)) {
                console.log(`Skipping AI summary sync for test case ${caseId}`);
                return;
            }

            await this.updatePage(caseData.notion_page_id, {
                ai_summary: summary
            });
        } catch (error) {
            const caseData = await db.getCaseById(caseId).catch(() => null);
            const quarantined = await this.quarantineMissingCasePage(caseData, 'add_ai_summary', error).catch(() => false);
            await errorTrackingService.captureException(error, {
                sourceService: 'notion_service',
                operation: 'add_ai_summary',
                caseId,
                retryable: quarantined ? false : isRetryableNotionError(error),
                metadata: {
                    notionPageId: caseData?.notion_page_id || null,
                    quarantinedMissingPage: quarantined,
                },
            });
            console.error('Error adding AI summary to Notion:', error);
        }
    }

    /**
     * Add a submission memory comment to the case's Notion page (and optionally the PD page).
     * Tagged with [BOT:SUBMISSION] so we can filter them later.
     */
    async addSubmissionComment(caseId, submissionInfo) {
        const caseData = await db.getCaseById(caseId).catch(() => null);
        const hasValidCasePage = hasValidNotionPageId(caseData?.notion_page_id);
        const sanitizeNotes = (n) => n ? String(n).replace(/[\r\n]+/g, ' | ') : null;

        const date = new Date().toISOString().split('T')[0];
        const lines = [
            `[BOT:SUBMISSION] ${date}`,
            `Portal: ${submissionInfo.portal_url || '-'}`,
            `Provider: ${submissionInfo.provider || '-'}`,
            `Account: ${submissionInfo.account_email || '-'}`,
            `Status: ${submissionInfo.status || 'completed'}`,
            `Confirmation #: ${submissionInfo.confirmation_number || '-'}`,
        ];
        if (submissionInfo.notes) lines.push(`Notes: ${sanitizeNotes(submissionInfo.notes)}`);
        const text = lines.join('\n');

        // Comment on the case Notion page (independent of PD comment)
        if (hasValidCasePage) {
            try {
                await this.notion.comments.create({
                    parent: { page_id: caseData.notion_page_id },
                    rich_text: [{ type: 'text', text: { content: text } }]
                });
                console.log(`📝 Submission comment added to case #${caseId} Notion page`);
            } catch (err) {
                const quarantined = await this.quarantineMissingCasePage(caseData, 'add_submission_comment_case', err).catch(() => false);
                await errorTrackingService.captureException(err, {
                    sourceService: 'notion_service',
                    operation: 'add_submission_comment_case',
                    caseId,
                    retryable: quarantined ? false : isRetryableNotionError(err),
                    metadata: {
                        notionPageId: caseData?.notion_page_id || null,
                        quarantinedMissingPage: quarantined,
                    },
                });
                console.error(`Failed to add case submission comment for case ${caseId}:`, err.message);
            }
        }

        // Comment on the PD's Notion page if linked (separate try so case failure doesn't block this)
        if (hasValidNotionPageId(submissionInfo.agency_notion_page_id)) {
            try {
                const pdLines = [
                    `[BOT:SUBMISSION] ${date} — Case #${caseId} (${caseData?.case_name || ''})`,
                    `Portal: ${submissionInfo.portal_url || '-'}`,
                    `Provider: ${submissionInfo.provider || '-'}`,
                    `Account: ${submissionInfo.account_email || '-'}`,
                    `Status: ${submissionInfo.status || 'completed'}`,
                    `Confirmation #: ${submissionInfo.confirmation_number || '-'}`,
                ];
                if (submissionInfo.notes) pdLines.push(`Notes: ${sanitizeNotes(submissionInfo.notes)}`);

                await this.notion.comments.create({
                    parent: { page_id: submissionInfo.agency_notion_page_id },
                    rich_text: [{ type: 'text', text: { content: pdLines.join('\n') } }]
                });
                console.log(`📝 Submission comment added to PD Notion page for case #${caseId}`);
                this.submissionMemoryCache.delete(submissionInfo.agency_notion_page_id);
            } catch (err) {
                await errorTrackingService.captureException(err, {
                    sourceService: 'notion_service',
                    operation: 'add_submission_comment_agency',
                    caseId,
                    retryable: isRetryableNotionError(err),
                    metadata: { agencyNotionPageId: submissionInfo.agency_notion_page_id || null },
                });
                console.error(`Failed to add PD submission comment for case ${caseId}:`, err.message);
            }
        }
    }

    /**
     * Retrieve past submission memory from a PD's Notion page comments.
     * Returns structured info about previous submissions to the same department.
     */
    async getSubmissionMemory(agencyNotionPageId) {
        if (!hasValidNotionPageId(agencyNotionPageId)) return [];

        // Check cache (5 min TTL)
        const cached = this.submissionMemoryCache.get(agencyNotionPageId);
        if (cached && (Date.now() - cached.fetchedAt) < 5 * 60 * 1000) {
            return cached.data;
        }

        try {
            // Paginate through all comments (Notion default page size is 100)
            let allResults = [];
            let startCursor;
            do {
                const params = { block_id: agencyNotionPageId };
                if (startCursor) params.start_cursor = startCursor;
                const page = await this.notion.comments.list(params);
                allResults = allResults.concat(page.results || []);
                startCursor = page.has_more ? page.next_cursor : null;
            } while (startCursor);

            const submissionComments = allResults
                .filter(c => {
                    const text = c.rich_text?.map(t => t.plain_text).join('') || '';
                    return text.startsWith('[BOT:SUBMISSION]');
                })
                .map(c => {
                    const text = c.rich_text?.map(t => t.plain_text).join('') || '';
                    const parsed = {};
                    for (const line of text.split('\n')) {
                        const match = line.match(/^(\w[\w\s#]*?):\s*(.+)$/);
                        if (match) parsed[match[1].trim().toLowerCase().replace(/\s+/g, '_')] = match[2].trim();
                    }
                    return {
                        raw: text,
                        date: c.created_time,
                        portal: parsed.portal || null,
                        provider: parsed.provider || null,
                        account: parsed.account || null,
                        status: parsed.status || null,
                        confirmation: parsed['confirmation_#'] || null,
                        notes: parsed.notes || null
                    };
                })
                .sort((a, b) => (a.date || '').localeCompare(b.date || ''));
            // Cap cache at 200 unique keys — only evict when inserting a new key
            if (!this.submissionMemoryCache.has(agencyNotionPageId) && this.submissionMemoryCache.size >= 200) {
                const oldest = this.submissionMemoryCache.keys().next().value;
                this.submissionMemoryCache.delete(oldest);
            }
            this.submissionMemoryCache.set(agencyNotionPageId, { data: submissionComments, fetchedAt: Date.now() });
            return submissionComments;
        } catch (error) {
            await errorTrackingService.captureException(error, {
                sourceService: 'notion_service',
                operation: 'get_submission_memory',
                retryable: isRetryableNotionError(error),
                metadata: { agencyNotionPageId },
            });
            console.error(`Failed to read submission memory for page ${agencyNotionPageId}:`, error.message);
            return [];
        }
    }

    /**
     * Get a summary string of past submissions for injection into Skyvern workflow context.
     */
    async getSubmissionMemorySummary(caseId) {
        try {
            const caseAgencies = await db.getCaseAgencies(caseId);
            const primary = caseAgencies?.find(a => a.is_primary) || caseAgencies?.[0];
            if (!primary?.agency_notion_page_id) return null;

            const memories = await this.getSubmissionMemory(primary.agency_notion_page_id);
            if (memories.length === 0) return null;

            const successful = memories.filter(m => {
                const s = (m.status || '').toLowerCase();
                return s === 'completed' || s === 'succeeded' || s === 'success';
            });
            const lastEntry = memories[memories.length - 1];

            if (successful.length === 0) {
                return `Previous submission attempt on ${lastEntry.date?.split('T')[0] || '?'} via ${lastEntry.provider || lastEntry.portal || '?'} — status: ${lastEntry.status || 'unknown'}. ${lastEntry.notes || ''}`.trim();
            }

            const lastSuccess = successful[successful.length - 1];
            let summary = `Previously submitted successfully on ${lastSuccess.date?.split('T')[0] || '?'} via ${lastSuccess.provider || lastSuccess.portal || '?'} (account: ${lastSuccess.account || '?'}, confirmation: ${lastSuccess.confirmation || 'N/A'}).`;

            // Append recent failure context if the most recent attempt was a failure
            const lastStatus = (lastEntry.status || '').toLowerCase();
            if (lastEntry !== lastSuccess && lastStatus !== 'completed' && lastStatus !== 'succeeded' && lastStatus !== 'success') {
                summary += ` However, most recent attempt on ${lastEntry.date?.split('T')[0] || '?'} failed: ${lastEntry.notes || lastEntry.status || 'unknown'}.`;
            }

            return summary.trim();
        } catch (error) {
            console.error(`Failed to get submission memory summary for case ${caseId}:`, error.message);
            return null;
        }
    }

    async getPagePropertyNames(pageId) {
        if (!hasValidNotionPageId(pageId)) {
            throw new Error(`Invalid Notion page ID: ${pageId}`);
        }
        const cacheEntry = this.pagePropertyCache.get(pageId);
        const now = Date.now();
        if (cacheEntry && (now - cacheEntry.cachedAt) < 5 * 60 * 1000) {
            return cacheEntry.properties;
        }

        try {
            const page = await this.notion.pages.retrieve({ page_id: pageId });
            const properties = Object.keys(page.properties || {});
            this.pagePropertyCache.set(pageId, {
                properties,
                cachedAt: now
            });
            return properties;
        } catch (error) {
            if (isNotionObjectNotFoundError(error)) {
                this.pagePropertyCache.delete(pageId);
                throw error;
            }
            await errorTrackingService.captureException(error, {
                sourceService: 'notion_service',
                operation: 'get_page_property_names',
                retryable: isRetryableNotionError(error),
                metadata: { pageId },
            });
            throw error;
        }
    }

    async getDatabaseSchemaProperties() {
        const now = Date.now();
        if (this.databaseSchema && (now - this.databaseSchemaFetchedAt) < 5 * 60 * 1000) {
            return this.databaseSchema;
        }

        try {
            const database = await this.notion.databases.retrieve({
                database_id: this.databaseId
            });
            this.databaseSchema = database.properties || {};
            this.databaseSchemaFetchedAt = now;
            return this.databaseSchema;
        } catch (error) {
            await errorTrackingService.captureException(error, {
                sourceService: 'notion_service',
                operation: 'get_database_schema_properties',
                retryable: isRetryableNotionError(error),
                metadata: { databaseId: this.databaseId },
            });
            console.error('Failed to retrieve Notion database schema:', error.message);
            return null;
        }
    }

    async getDatabasePropertyInfo(propertyName) {
        const properties = await this.getDatabaseSchemaProperties();
        return properties?.[propertyName] || null;
    }

    buildPropertyEqualsFilter(propertyName, propertyInfo, value) {
        if (!propertyName || !propertyInfo || value === undefined || value === null) {
            return null;
        }

        const type = propertyInfo.type;
        switch (type) {
            case 'status':
            case 'select':
                return {
                    property: propertyName,
                    [type]: {
                        equals: value
                    }
                };
            case 'multi_select':
                return {
                    property: propertyName,
                    multi_select: {
                        contains: value
                    }
                };
            case 'checkbox':
                return {
                    property: propertyName,
                    checkbox: {
                        equals: value === true || value === 'true'
                    }
                };
            case 'rich_text':
                return {
                    property: propertyName,
                    rich_text: {
                        contains: value
                    }
                };
            case 'title':
                return {
                    property: propertyName,
                    title: {
                        contains: value
                    }
                };
            default:
                return null;
        }
    }

    normalizeStatusValue(value, propertyInfo) {
        if (!value || !propertyInfo) {
            console.log(`[normalizeStatusValue] Early return - value: ${value}, propertyInfo: ${propertyInfo}`);
            return value;
        }

        const canon = (name = '') => name.toLowerCase().replace(/[^a-z0-9]/g, '');
        const target = canon(value);
        const optionsContainer = propertyInfo[propertyInfo.type];
        const options = optionsContainer?.options || [];

        console.log(`[normalizeStatusValue] Input: "${value}" -> Canonical: "${target}"`);
        console.log(`[normalizeStatusValue] Available options:`, options.map(o => `"${o.name}"`));

        const directMatch = options.find(opt => opt?.name === value);
        if (directMatch) {
            console.log(`[normalizeStatusValue] Direct match found: "${directMatch.name}"`);
            return directMatch.name;
        }

        console.log(`[normalizeStatusValue] No direct match, trying canonical...`);
        const canonicalMatch = options.find(opt => {
            const optCanon = canon(opt?.name);
            const matches = optCanon === target;
            console.log(`[normalizeStatusValue]   "${opt.name}" -> "${optCanon}" === "${target}": ${matches}`);
            return matches;
        });

        if (canonicalMatch) {
            console.log(`[normalizeStatusValue] Canonical match found: "${canonicalMatch.name}"`);
            return canonicalMatch.name;
        }

        console.warn(`Status value "${value}" not found on property "${propertyInfo.name || 'unknown'}"; using original value`);
        return value;
    }

    /**
     * Fetch and process a single Notion page by ID
     */
    normalizeStateCode(value) {
        if (!value) return null;
        const trimmed = value.trim();
        if (!trimmed) return null;

        const upper = trimmed.toUpperCase();
        if (/^[A-Z]{2}$/.test(upper)) {
            return upper;
        }

        const parenMatch = trimmed.match(/\(([A-Za-z]{2})\)/);
        if (parenMatch) {
            return parenMatch[1].toUpperCase();
        }

        const abbreviationMatch = trimmed.match(/\b([A-Za-z]{2})\b/);
        if (abbreviationMatch) {
            const candidate = abbreviationMatch[1].toUpperCase();
            if (/^[A-Z]{2}$/.test(candidate)) {
                return candidate;
            }
        }

        const cleaned = trimmed
            .toLowerCase()
            .replace(/[^a-z\s]/g, ' ')
            .replace(/\b(state|states|commonwealth|of|department|police|sheriff|county)\b/g, '')
            .replace(/\s+/g, ' ')
            .trim();

        if (STATE_ABBREVIATIONS[cleaned]) {
            return STATE_ABBREVIATIONS[cleaned];
        }

        const match = Object.entries(STATE_ABBREVIATIONS).find(([name]) => cleaned.startsWith(name));
        if (match) {
            return match[1];
        }

        console.warn(`Unable to normalize state value "${value}"; leaving blank to avoid DB errors`);
        return null;
    }

    async processSinglePage(pageId) {
        try {
            if (!hasValidNotionPageId(pageId)) {
                throw new Error(`Invalid Notion page ID: ${pageId}`);
            }
            console.log(`[import] Fetching Notion page: ${pageId}`);

            // Step 1: Fetch case page + blocks
            const page = await this.notion.pages.retrieve({ page_id: pageId });

            let pageContent = '';
            try {
                const blocks = await this.notion.blocks.children.list({
                    block_id: pageId,
                    page_size: 100
                });
                pageContent = blocks.results
                    .map(block => this.extractTextFromBlock(block))
                    .filter(text => text.length > 0)
                    .join('\n');
                console.log(`[import] Extracted ${pageContent.length} chars of content`);
            } catch (contentError) {
                await errorTrackingService.captureException(contentError, {
                    sourceService: 'notion_service',
                    operation: 'process_single_page_fetch_content',
                    retryable: isRetryableNotionError(contentError),
                    metadata: { pageId },
                });
                console.warn('[import] Could not fetch page content:', contentError.message);
            }

            const notionCase = this.parseNotionPage(page);

            // Step 2: Dedup check FIRST — before any AI calls
            const existing = await db.getCaseByNotionId(notionCase.notion_page_id);
            if (existing) {
                console.log(`[import] Case already exists: ${notionCase.case_name}`);
                return existing;
            }

            // Step 3: Fetch PD page + text (if relation exists)
            let deptPage = null;
            let deptText = '';
            if (notionCase.police_dept_id) {
                try {
                    deptPage = await this.notion.pages.retrieve({ page_id: notionCase.police_dept_id });
                    deptText = await this.getFullPagePlainText(notionCase.police_dept_id);
                } catch (pdErr) {
                    await errorTrackingService.captureException(pdErr, {
                        sourceService: 'notion_service',
                        operation: 'process_single_page_fetch_police_dept',
                        retryable: isRetryableNotionError(pdErr),
                        metadata: {
                            pageId,
                            policeDeptId: notionCase.police_dept_id,
                        },
                    });
                    console.warn(`[import] Failed to fetch PD page: ${pdErr.message}`);
                }
            }

            // Step 4: Single AI call — normalize case + extract contacts
            const casePropsForAI = this.preparePropertiesForAI(page.properties);
            const pdPropsForAI = deptPage ? this.preparePropertiesForAI(deptPage.properties) : null;

            const aiResult = await aiService.normalizeAndExtractContacts(
                casePropsForAI, pageContent, pdPropsForAI, deptText
            );

            this.applySinglePageAIResult(notionCase, aiResult);

            // Apply agency name from PD page title (more reliable than AI extraction)
            if (deptPage) {
                const deptTitleProp = Object.values(deptPage.properties).find(p => p.type === 'title');
                notionCase.agency_name = deptTitleProp?.title?.[0]?.plain_text || notionCase.agency_name || 'Police Department';

                // Extract PD Rating as case priority
                const ratingProp = deptPage.properties['Rating'] || deptPage.properties['rating'];
                if (ratingProp?.type === 'number' && ratingProp.number != null) {
                    notionCase.priority = Math.max(0, Math.min(5, Math.round(ratingProp.number)));
                } else if (ratingProp?.type === 'select' && ratingProp.select?.name) {
                    const parsed = parseInt(ratingProp.select.name, 10);
                    if (!isNaN(parsed)) notionCase.priority = Math.max(0, Math.min(5, parsed));
                }

                // Direct URL extraction from PD fields as fallback
                if (!notionCase.portal_url) {
                    const directPortal = this.extractFirstUrlFromProperties(deptPage.properties);
                    if (directPortal) {
                        notionCase.portal_url = directPortal;
                        console.log(`[import] Portal URL from PD fields: ${directPortal}`);
                    }
                }
            }

            // Fallback contacts from case page properties
            this.applyFallbackContactsFromPage(notionCase, page);

            // Enrich additional_details with all property text + page content
            const allPropsText = this.formatAllPropertiesAsText(page.properties);
            notionCase.additional_details = [
                notionCase.additional_details,
                allPropsText,
                pageContent ? pageContent.substring(0, 5000) : null
            ].filter(Boolean).join('\n\n').trim();
            this.enrichCaseFromNarrative(notionCase);

            // Regex portal fallback from text
            if (!notionCase.portal_url) {
                const portalFromText = this.findPortalInText(notionCase.additional_details || pageContent || '');
                if (portalFromText) {
                    notionCase.portal_url = portalFromText;
                    console.log(`[import] Portal URL from text scan: ${portalFromText}`);
                }
            }

            // Normalize portal URL
            if (notionCase.portal_url) {
                const normalized = normalizePortalUrl(notionCase.portal_url);
                if (normalized && isSupportedPortalUrl(normalized)) {
                    notionCase.portal_url = normalized;
                    notionCase.portal_provider = notionCase.portal_provider || detectPortalProviderByUrl(normalized)?.name || null;
                } else {
                    notionCase.portal_url = null;
                }
            }

            notionCase.state = this.normalizeStateCode(notionCase.state);
            notionCase.incident_date = this.normalizeImportedDateValue(notionCase.incident_date);

            // Step 5: Firecrawl fallback — ONLY if still missing portal_url or agency_email
            if ((!notionCase.portal_url || !notionCase.agency_email) && notionCase.agency_name) {
                try {
                    console.log(`[import] Missing ${!notionCase.portal_url ? 'portal' : ''}${!notionCase.portal_url && !notionCase.agency_email ? '+' : ''}${!notionCase.agency_email ? 'email' : ''}, trying Firecrawl...`);
                    const pdResult = await pdContactService.lookupContact(
                        notionCase.agency_name,
                        notionCase.state || notionCase.incident_location
                    );
                    if (pdResult) {
                        if (pdResult.portal_url && !notionCase.portal_url) {
                            const normalized = normalizePortalUrl(pdResult.portal_url);
                            if (normalized && isSupportedPortalUrl(normalized)) {
                                notionCase.portal_url = normalized;
                                notionCase.portal_provider = pdResult.portal_provider || detectPortalProviderByUrl(normalized)?.name || null;
                            }
                        }
                        if (pdResult.contact_email && !notionCase.agency_email) {
                            notionCase.agency_email = pdResult.contact_email;
                        }
                    }
                } catch (pdErr) {
                    console.log(`[import] Firecrawl lookup failed for "${notionCase.agency_name}": ${pdErr.message}`);
                }
            }

            this.applyImportReadinessGuard(notionCase, { pageContent });
            this.applyImportDeliveryFallback(notionCase);

            // Step 6: Resolve user, calculate deadline, create case

            // Resolve assigned person to user_id
            if (notionCase.assigned_person) {
                try {
                    const userId = await this.resolveAssignedUserId(notionCase.assigned_person);
                    if (userId) {
                        notionCase.user_id = userId;
                        const user = await db.getUserById(userId);
                        console.log(`[import] Assigned to user: ${user?.name || userId}`);
                    } else {
                        console.warn(`[import] No matching user for assignee: ${notionCase.assigned_person}`);
                    }
                } catch (err) {
                    console.warn(`[import] Failed to resolve assigned user: ${err.message}`);
                }
            }

            const deadline = await this.calculateDeadline(notionCase.state);
            notionCase.deadline_date = deadline;
            notionCase.incident_date = this.normalizeImportedDateValue(notionCase.incident_date);

            const newCase = await db.createCase(notionCase);
            console.log(`[import] Created case: ${newCase.case_name} (${newCase.id})`);

            // Import additional Police Departments as case_agencies
            const additionalPDIds = notionCase.additional_police_dept_ids || [];
            if (additionalPDIds.length > 0) {
                for (const pdId of additionalPDIds) {
                    try {
                        const addlDeptPage = await this.notion.pages.retrieve({ page_id: pdId });
                        const deptProps = addlDeptPage.properties;
                        const titleProp = Object.values(deptProps).find(p => p.type === 'title');
                        const pdName = titleProp?.title?.[0]?.plain_text || 'Unknown PD';

                        let pdEmail = null;
                        let pdPortalUrl = null;
                        for (const [, prop] of Object.entries(deptProps)) {
                            if (prop.type === 'email' && prop.email) pdEmail = prop.email;
                            if (prop.type === 'url' && prop.url) pdPortalUrl = prop.url;
                        }

                        await db.addCaseAgency(newCase.id, {
                            agency_name: pdName,
                            agency_email: pdEmail,
                            portal_url: pdPortalUrl,
                            added_source: 'notion_import'
                        });
                        console.log(`[import] Added additional agency "${pdName}"`);
                    } catch (pdErr) {
                        await errorTrackingService.captureException(pdErr, {
                            sourceService: 'notion_service',
                            operation: 'process_single_page_import_additional_pd',
                            caseId: newCase.id,
                            retryable: isRetryableNotionError(pdErr),
                            metadata: {
                                pageId,
                                policeDeptId: pdId,
                            },
                        });
                        console.warn(`[import] Failed to import additional PD ${pdId}: ${pdErr.message}`);
                    }
                }
            }

            // Update Notion status
            try {
                await this.updatePage(notionCase.notion_page_id, {
                    live_status: this.mapStatusToNotion(newCase.status)
                });
                const availableProps = await this.getPagePropertyNames(notionCase.notion_page_id);
                if (availableProps.includes(this.legacyStatusProperty)) {
                    await this.notion.pages.update({
                        page_id: notionCase.notion_page_id,
                        properties: {
                            [this.legacyStatusProperty]: {
                                select: { name: this.statusAutoValue }
                            }
                        }
                    });
                }
            } catch (syncErr) {
                console.warn('[import] Failed to update Notion status:', syncErr.message);
            }

            // Run import validation (same as bulk sync)
            try {
                const importWarnings = [
                    ...(Array.isArray(notionCase.import_warnings) ? notionCase.import_warnings : []),
                    ...((await validateImportedCase(newCase)) || []),
                ];
                if (importWarnings.length > 0) {
                    await db.query(
                        'UPDATE cases SET import_warnings = $1 WHERE id = $2',
                        [JSON.stringify(importWarnings), newCase.id]
                    );
                    console.warn(`[import] Import warnings for case ${newCase.id}:`, importWarnings.map(w => w.type).join(', '));
                }
            } catch (valErr) {
                console.warn('[import] Validation check failed:', valErr.message);
            }

            await db.logActivity('case_imported', `Imported case from Notion page: ${newCase.case_name}`, {
                case_id: newCase.id
            });

            return newCase;
        } catch (error) {
            await errorTrackingService.captureException(error, {
                sourceService: 'notion_service',
                operation: 'process_single_page',
                retryable: isRetryableNotionError(error),
                metadata: {
                    pageId,
                },
            });
            console.error('[import] Error processing Notion page:', error);
            throw error;
        }
    }

    exportPoliceDepartmentFields(properties = {}) {
        const exportData = {};
        POLICE_DEPARTMENT_FIELD_SPECS.forEach(({ name }) => {
            const prop = properties[name];
            exportData[name] = prop ? this.extractPlainValue(prop) : null;
        });
        return exportData;
    }

    /**
     * Format ALL property values as a readable text block.
     * Ensures no case data is lost regardless of which Notion field it lives in.
     */
    formatAllPropertiesAsText(properties = {}) {
        const lines = [];
        for (const [name, prop] of Object.entries(properties)) {
            const value = this.extractPlainValue(prop);
            if (!value) continue;
            const text = Array.isArray(value) ? value.filter(Boolean).join(', ') : String(value);
            if (!text.trim()) continue;
            lines.push(`${name}: ${text.trim()}`);
        }
        return lines.length ? '--- Notion Fields ---\n' + lines.join('\n') : '';
    }

    preparePropertiesForAI(properties = {}) {
        const result = {};
        for (const [name, prop] of Object.entries(properties)) {
            result[name] = this.extractPlainValue(prop);
        }
        return result;
    }

    extractPlainValue(prop) {
        if (!prop || !prop.type) return null;
        switch (prop.type) {
            case 'title':
                return normalizeNotionText(prop.title?.map(t => t.plain_text).join(' ')) || null;
            case 'rich_text':
                return normalizeNotionText(prop.rich_text?.map(t => t.plain_text).join(' ')) || null;
            case 'select':
            case 'status':
                return prop[prop.type]?.name || null;
            case 'multi_select':
                return prop.multi_select?.map(item => item.name) || [];
            case 'date':
                return normalizeImportedDateValue(prop.date?.start) || null;
            case 'number':
                return prop.number || null;
            case 'email':
                return prop.email || null;
            case 'url':
                return prop.url || null;
            case 'people':
                return prop.people?.map(p => p.name || p.email).filter(Boolean) || [];
            case 'phone_number':
                return prop.phone_number || null;
            case 'checkbox':
                return !!prop.checkbox;
            case 'files':
                return prop.files?.map(f => f.name || f.file?.url).filter(Boolean) || [];
            case 'relation':
                return null;
            case 'rollup': {
                const rollup = prop.rollup;
                if (!rollup) return null;
                if (rollup.type === 'array') {
                    const items = rollup.array
                        .map(item => this.extractPlainValue(item))
                        .filter(Boolean);
                    return items.length ? items.join(' ') : null;
                }
                if (rollup.type === 'number') {
                    return rollup.number;
                }
                if (rollup.type === 'date') {
                    return rollup.date?.start || null;
                }
                if (rollup.type === 'rich_text') {
                    return normalizeNotionText(rollup.rich_text?.map(t => t.plain_text).join(' ')) || null;
                }
                if (rollup.type === 'title') {
                    return normalizeNotionText(rollup.title?.map(t => t.plain_text).join(' ')) || null;
                }
                return null;
            }
            default:
                return null;
        }
    }

    applyNormalizedCaseData(caseData, normalized) {
        if (!normalized) return caseData;
        const updated = { ...caseData };

        const assignIfEmpty = (field, value) => {
            if (!value) return;
            if (Array.isArray(value) && value.length === 0) return;
            if (!updated[field] || (Array.isArray(updated[field]) && updated[field].length === 0)) {
                updated[field] = value;
            }
        };

        assignIfEmpty('case_name', normalized.case_name);
        assignIfEmpty('agency_name', normalized.agency_name);
        const normalizedState = this.normalizeStateCode(normalized.state);
        assignIfEmpty('state', normalizedState);
        assignIfEmpty('incident_date', this.normalizeImportedDateValue(normalized.incident_date));
        assignIfEmpty('incident_location', normalized.incident_location);
        assignIfEmpty('subject_name', normalized.subject_name);
        assignIfEmpty('additional_details', normalized.additional_details);

        if (normalized.records_requested?.length) {
            const current = Array.isArray(updated.requested_records) ? updated.requested_records : [];
            // Upgrade if empty, or if only 1-2 generic items (AI normalization is more thorough)
            if (current.length === 0 || (current.length <= 2 && normalized.records_requested.length > current.length)) {
                updated.requested_records = normalized.records_requested;
            }
        }

        if ((!updated.agency_email || updated.agency_email === (process.env.DEFAULT_TEST_EMAIL || '')) &&
            normalized.contact_emails?.length) {
            updated.agency_email = normalized.contact_emails[0];
            updated.alternate_agency_email = normalized.contact_emails[1] || updated.alternate_agency_email;
        }

        if (!updated.portal_url && normalized.portal_urls?.length) {
            const portalFromAI = normalized.portal_urls.map(normalizePortalUrl).find(url => url && isSupportedPortalUrl(url));
            if (portalFromAI) {
                updated.portal_url = portalFromAI;
                console.log(`🤖 AI normalization provided portal URL: ${portalFromAI}`);
            }
        }

        // Feature 3: AI-generated tags
        if (normalized.tags?.length) {
            updated.tags = normalized.tags;
        }

        return updated;
    }

    getPropertyWithFallback(properties, preferredName, type) {
        if (!properties || !preferredName) {
            return this.getProperty(properties || {}, preferredName, type);
        }
        const direct = this.getProperty(properties, preferredName, type);
        if (direct) {
            return direct;
        }
        const match = Object.keys(properties).find(
            (key) => key.toLowerCase() === preferredName.toLowerCase()
        );
        if (match && match !== preferredName) {
            return this.getProperty(properties, match, type);
        }
        return direct;
    }

    async resolvePropertyName(preferredName) {
        if (!preferredName) return preferredName;
        const cacheKey = preferredName.toLowerCase();
        if (this.resolvedPropertyCache.has(cacheKey)) {
            return this.resolvedPropertyCache.get(cacheKey);
        }

        const properties = await this.getDatabaseSchemaProperties();
        if (!properties) {
            return preferredName;
        }

        if (properties[preferredName]) {
            this.resolvedPropertyCache.set(cacheKey, preferredName);
            return preferredName;
        }

        const match = Object.keys(properties).find(
            (key) => key.toLowerCase() === preferredName.toLowerCase()
        );

        const resolved = match || preferredName;
        this.resolvedPropertyCache.set(cacheKey, resolved);
        if (match) {
            console.log(`Resolved Notion property "${preferredName}" -> "${match}"`);
        }
        return resolved;
    }
}

module.exports = new NotionService();
