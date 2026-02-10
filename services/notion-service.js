const { Client } = require('@notionhq/client');
const db = require('./database');
const aiService = require('./ai-service');
const { extractEmails, extractUrls, isValidEmail } = require('../utils/contact-utils');
const { normalizePortalUrl, isSupportedPortalUrl, detectPortalProviderByUrl } = require('../utils/portal-utils');

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
    'portal_in_progress': 'Portal Submission',
    'portal_submission_failed': 'Portal Issue'
};

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
        this.enableAINormalization = process.env.ENABLE_NOTION_AI_NORMALIZATION !== 'false';
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
                enrichedCase.state = this.normalizeStateCode(enrichedCase.state);
                cases.push(enrichedCase);
            }

            return cases;
        } catch (error) {
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

        // Get title from any title property
        const titleProp = Object.values(props).find(p => p.type === 'title');
        const caseName = titleProp?.title?.[0]?.plain_text || 'Untitled Case';

        // Get portal URL if available (fall back to other portal-labeled fields)
        const portalUrl = this.getProperty(props, 'Portal', 'url') ||
                          this.findPortalInProperties(props);

        // Get Police Department relation ID
        const policeDeptRelation = props['Police Department'];
        const policeDeptId = policeDeptRelation?.relation?.[0]?.id || null;

        const statusValue =
            this.getPropertyWithFallback(props, this.liveStatusProperty, 'status') ||
            this.getPropertyWithFallback(props, this.legacyStatusProperty, 'select');

        return {
            notion_page_id: page.id,
            case_name: caseName,
            // Email will be fetched from related Police Department page
            agency_email: null, // Will be populated by enrichWithPoliceDepartment()
            police_dept_id: policeDeptId, // Store relation ID for fetching
            // ACTUAL NOTION FIELD: "Suspect" (not "Subject Name")
            subject_name: this.getProperty(props, 'Suspect', 'rich_text') ||
                         this.getProperty(props, 'Victim', 'rich_text') ||
                         caseName,
            // ACTUAL NOTION FIELD: "Police Department" name will be fetched from relation
            agency_name: null, // Will be populated by enrichWithPoliceDepartment()
            // State will be extracted by AI from page content
            state: null,
            // ACTUAL NOTION FIELDS: "Crime Date" or "Date of arrest"
            incident_date: this.getProperty(props, 'Crime Date', 'date') ||
                          this.getProperty(props, 'Date of arrest', 'date') ||
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
            portal_url: portalUrl
        };
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

        const dateFromText = pickLineValue([
            /date of the incident:\s*([^\n\r]+)/i,
            /incident date:\s*([^\n\r]+)/i,
            /on\s+([A-Za-z]+\s+\d{1,2},\s+\d{4})/i
        ]);
        if (dateFromText && !caseData.incident_date) {
            const parsed = new Date(dateFromText);
            if (!Number.isNaN(parsed.getTime())) {
                caseData.incident_date = parsed.toISOString().slice(0, 10);
            }
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

            console.log(`Enriched case with Police Dept: ${caseData.agency_name} (${caseData.agency_email})`);

        } catch (error) {
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
            case 'title':
                return (prop.title || [])
                    .map((part) => part.plain_text || '')
                    .join(' ')
                    .trim();
            case 'rich_text':
                return (prop.rich_text || [])
                    .map((part) => part.plain_text || '')
                    .join(' ')
                    .trim();
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
                model: 'gpt-4o-mini',
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
                model: 'gpt-5-mini',
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
            const availableProperties = await this.getPagePropertyNames(pageId);
            const propSet = new Set(availableProperties);
            const properties = {};

            const missingProps = (name) => {
                console.warn(`Skipping Notion update: property "${name}" not found on page ${pageId}`);
            };

            const liveStatusPropName = this.liveStatusProperty;

            if (updates.send_date) {
                if (propSet.has('Send Date')) {
                    properties['Send Date'] = {
                        date: { start: updates.send_date }
                    };
                } else {
                    missingProps('Send Date');
                }

                if (propSet.has('Request Day')) {
                    properties['Request Day'] = {
                        date: { start: updates.send_date }
                    };
                } else {
                    missingProps('Request Day');
                }
            }

            if (updates.last_response_date) {
                if (propSet.has('Last Response')) {
                    properties['Last Response'] = {
                        date: { start: updates.last_response_date }
                    };
                } else {
                    missingProps('Last Response');
                }
            }

            if (updates.days_overdue !== undefined) {
                if (propSet.has('Days Overdue')) {
                    properties['Days Overdue'] = {
                        number: updates.days_overdue
                    };
                } else {
                    missingProps('Days Overdue');
                }
            }

            if (updates.ai_summary) {
                if (propSet.has('AI Summary')) {
                    properties['AI Summary'] = {
                        rich_text: [{
                            text: { content: updates.ai_summary }
                        }]
                    };
                } else {
                    missingProps('AI Summary');
                }
            }

            if (updates.live_status) {
                if (propSet.has(liveStatusPropName)) {
                    const liveStatusPropertyInfo = await this.getDatabasePropertyInfo(liveStatusPropName);
                    if (liveStatusPropertyInfo?.type === 'status') {
                        properties[liveStatusPropName] = {
                            status: { name: updates.live_status }
                        };
                    } else {
                        properties[liveStatusPropName] = {
                            select: { name: updates.live_status }
                        };
                    }
                } else {
                    missingProps(liveStatusPropName);
                }
            }

            if (updates.live_substatus !== undefined) {
                if (propSet.has('Live Substatus')) {
                    properties['Live Substatus'] = {
                        rich_text: updates.live_substatus
                            ? [{ text: { content: updates.live_substatus } }]
                            : []
                    };
                } else {
                    missingProps('Live Substatus');
                }
            }

            if (updates.last_portal_status_text) {
                if (propSet.has('Last Portal Status')) {
                    properties['Last Portal Status'] = {
                        rich_text: [{
                            text: { content: updates.last_portal_status_text }
                        }]
                    };
                } else {
                    missingProps('Last Portal Status');
                }
            }

            if (updates.last_portal_updated_at) {
                if (propSet.has('Last Portal Updated')) {
                    properties['Last Portal Updated'] = {
                        date: { start: updates.last_portal_updated_at }
                    };
                } else {
                    missingProps('Last Portal Updated');
                }
            }

            if (updates.portal_task_url) {
                if (propSet.has('Portal Task URL')) {
                    properties['Portal Task URL'] = {
                        url: updates.portal_task_url
                    };
                } else {
                    missingProps('Portal Task URL');
                }
            }

            if (updates.portal_login_email) {
                if (propSet.has('Portal Login Email')) {
                    properties['Portal Login Email'] = {
                        email: updates.portal_login_email
                    };
                } else {
                    missingProps('Portal Login Email');
                }
            }

            if (updates.needs_human_review !== undefined) {
                if (propSet.has('Needs Human Review')) {
                    properties['Needs Human Review'] = {
                        checkbox: !!updates.needs_human_review
                    };
                } else {
                    missingProps('Needs Human Review');
                }
            }

            if (Object.keys(properties).length === 0) {
                console.warn(`No valid Notion properties to update for page ${pageId}`);
                return null;
            }

            const response = await this.notion.pages.update({
                page_id: pageId,
                properties
            });

            return response;
        } catch (error) {
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
                try {
                    // Check if case already exists in our database
                    const existing = await db.getCaseByNotionId(notionCase.notion_page_id);

                    if (existing) {
                        if (protectedStatuses.has(existing.status)) {
                            console.log(`Case ${existing.id} is in protected status (${existing.status}); ignoring Notion Ready status.`);
                            continue;
                        }

                        if (existing.status === 'ready_to_send') {
                            // Check if case has been queued - if not, re-queue it
                            if (!existing.queued_at) {
                                console.log(`Case ready_to_send but never queued - re-queuing: ${notionCase.case_name}`);
                                syncedCases.push(existing);
                            } else {
                                console.log(`Case already ready to send and queued (skipping): ${notionCase.case_name}`);
                            }
                            continue;
                        }

                        console.log(`Case status changed to "${status}" - updating and re-queuing: ${notionCase.case_name}`);

                        const updatedCase = await db.updateCase(existing.id, {
                            agency_name: notionCase.agency_name,
                            agency_email: notionCase.agency_email,
                            status: 'ready_to_send'
                        });

                        syncedCases.push(updatedCase);

                        await db.logActivity('case_status_changed', `Case status changed to "${status}" - re-queued: ${notionCase.case_name}`, {
                            case_id: existing.id
                        });

                        continue;
                    }

                    // Calculate deadline based on state
                    const deadline = await this.calculateDeadline(notionCase.state);
                    notionCase.deadline_date = deadline;

                    // Create new case
                    const newCase = await db.createCase(notionCase);
                    console.log(`Created new case: ${newCase.case_name}`);
                    syncedCases.push(newCase);

                    // Log activity
                    await db.logActivity('case_imported', `Imported case from Notion: ${newCase.case_name}`, {
                        case_id: newCase.id
                    });
                } catch (error) {
                    console.error(`Error syncing case ${notionCase.case_name}:`, error);
                }
            }

            return syncedCases;
        } catch (error) {
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
        try {
            const caseData = await db.getCaseById(caseId);
            if (!caseData) {
                console.error(`Case ${caseId} not found`);
                return;
            }

            // Skip test cases (they have fake notion_page_ids)
            if (caseData.notion_page_id?.startsWith('test-')) {
                console.log(`Skipping Notion sync for test case ${caseId}`);
                return;
            }

            const updates = {};
            const notionStatus = this.mapStatusToNotion(caseData.status);
            if (notionStatus) {
                updates.live_status = notionStatus;
            }

            if (caseData.send_date) {
                updates.send_date = caseData.send_date;
            }

            if (caseData.last_response_date) {
                updates.last_response_date = caseData.last_response_date;
            }

            if (caseData.days_overdue) {
                updates.days_overdue = caseData.days_overdue;
            }

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

            await this.updatePage(caseData.notion_page_id, updates);
            console.log(`Updated Notion page for case: ${caseData.case_name}`);
        } catch (error) {
            console.error('Error syncing status to Notion:', error);
        }
    }

    /**
     * Map our internal status to Notion status values
     */
    mapStatusToNotion(internalStatus) {
        const statusMap = {
            'ready_to_send': 'Ready to Send',
            'sent': 'Sent',
            'awaiting_response': 'Awaiting Response',
            'responded': 'Responded',
            'completed': 'Completed',
            'error': 'Error',
            'fee_negotiation': 'Fee Negotiation',
            'needs_human_fee_approval': 'Needs Human Approval',
            'needs_human_review': 'Needs Human Review',
            'portal_in_progress': 'Portal Submission',
            'portal_submission_failed': 'Portal Issue'
        };

        return statusMap[internalStatus] || internalStatus;
    }

    /**
     * Add AI summary to Notion page
     */
    async addAISummaryToNotion(caseId, summary) {
        try {
            const caseData = await db.getCaseById(caseId);
            if (!caseData) return;

            // Skip test cases (they have fake notion_page_ids)
            if (caseData.notion_page_id?.startsWith('test-')) {
                console.log(`Skipping AI summary sync for test case ${caseId}`);
                return;
            }

            await this.updatePage(caseData.notion_page_id, {
                ai_summary: summary
            });
        } catch (error) {
            console.error('Error adding AI summary to Notion:', error);
        }
    }

    async getPagePropertyNames(pageId) {
        const cacheEntry = this.pagePropertyCache.get(pageId);
        const now = Date.now();
        if (cacheEntry && (now - cacheEntry.cachedAt) < 5 * 60 * 1000) {
            return cacheEntry.properties;
        }

        const page = await this.notion.pages.retrieve({ page_id: pageId });
        const properties = Object.keys(page.properties || {});
        this.pagePropertyCache.set(pageId, {
            properties,
            cachedAt: now
        });
        return properties;
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
            console.log(`Fetching single Notion page: ${pageId}`);

            // Fetch the page
            const page = await this.notion.pages.retrieve({ page_id: pageId });

            // Fetch page content (blocks)
            let pageContent = '';
            try {
                const blocks = await this.notion.blocks.children.list({
                    block_id: pageId,
                    page_size: 100
                });

                // Extract text from blocks
                pageContent = blocks.results
                    .map(block => {
                        if (block.type === 'paragraph' && block.paragraph?.rich_text) {
                            return block.paragraph.rich_text.map(t => t.plain_text).join('');
                        }
                        if (block.type === 'heading_1' && block.heading_1?.rich_text) {
                            return block.heading_1.rich_text.map(t => t.plain_text).join('');
                        }
                        if (block.type === 'heading_2' && block.heading_2?.rich_text) {
                            return block.heading_2.rich_text.map(t => t.plain_text).join('');
                        }
                        if (block.type === 'heading_3' && block.heading_3?.rich_text) {
                            return block.heading_3.rich_text.map(t => t.plain_text).join('');
                        }
                        if (block.type === 'bulleted_list_item' && block.bulleted_list_item?.rich_text) {
                            return '- ' + block.bulleted_list_item.rich_text.map(t => t.plain_text).join('');
                        }
                        return '';
                    })
                    .filter(text => text.length > 0)
                    .join('\n');

                console.log(`Extracted ${pageContent.length} characters of content from page`);
            } catch (contentError) {
                console.warn('Could not fetch page content:', contentError.message);
            }

            // Parse the page
            const notionCase = this.parseNotionPage(page);

            // Export ALL case page property values so nothing is missed
            const allPropsText = this.formatAllPropertiesAsText(page.properties);

            // Enrich with police department data and fallback contact extraction from case page.
            await this.enrichWithPoliceDepartment(notionCase, page);

            // Combine: existing details + all properties + page content
            notionCase.additional_details = [
                notionCase.additional_details,
                allPropsText,
                pageContent ? pageContent.substring(0, 5000) : null
            ].filter(Boolean).join('\n\n').trim();
            this.enrichCaseFromNarrative(notionCase);

            if (!notionCase.portal_url) {
                const portalFromText = this.findPortalInText(notionCase.additional_details || pageContent || '');
                if (portalFromText) {
                    notionCase.portal_url = portalFromText;
                    console.log(`Detected portal URL from single-page import text: ${portalFromText}`);
                }
            }

            // Check if already exists
            const existing = await db.getCaseByNotionId(notionCase.notion_page_id);
            if (existing) {
                console.log(`Case already exists: ${notionCase.case_name}`);
                return existing;
            }

            notionCase.state = this.normalizeStateCode(notionCase.state);

            // Calculate deadline
            const deadline = await this.calculateDeadline(notionCase.state);
            notionCase.deadline_date = deadline;

            // Create case
            const newCase = await db.createCase(notionCase);
            console.log(`Created case from Notion page: ${newCase.case_name}`);

            // Log activity
            await db.logActivity('case_imported', `Imported case from Notion page: ${newCase.case_name}`, {
                case_id: newCase.id
            });

            return newCase;
        } catch (error) {
            console.error('Error processing single Notion page:', error);
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
                return prop.title?.map(t => t.plain_text).join(' ').trim() || null;
            case 'rich_text':
                return prop.rich_text?.map(t => t.plain_text).join(' ').trim() || null;
            case 'select':
            case 'status':
                return prop[prop.type]?.name || null;
            case 'multi_select':
                return prop.multi_select?.map(item => item.name) || [];
            case 'date':
                return prop.date?.start || null;
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
                return prop.relation?.map(rel => rel.id).filter(Boolean) || [];
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
                    return rollup.rich_text?.map(t => t.plain_text).join(' ').trim() || null;
                }
                if (rollup.type === 'title') {
                    return rollup.title?.map(t => t.plain_text).join(' ').trim() || null;
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
        assignIfEmpty('incident_date', normalized.incident_date);
        assignIfEmpty('incident_location', normalized.incident_location);
        assignIfEmpty('subject_name', normalized.subject_name);
        assignIfEmpty('additional_details', normalized.additional_details);

        if (normalized.records_requested?.length) {
            if (!updated.requested_records || updated.requested_records.length === 0 ||
                (Array.isArray(updated.requested_records) && updated.requested_records.length <= 2 && updated.requested_records.includes('Body cam footage'))) {
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
