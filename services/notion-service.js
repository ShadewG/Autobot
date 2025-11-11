const { Client } = require('@notionhq/client');
const db = require('./database');
const { extractEmails, extractUrls, isValidEmail } = require('../utils/contact-utils');
const { normalizePortalUrl, isSupportedPortalUrl } = require('../utils/portal-utils');

class NotionService {
    constructor() {
        this.notion = new Client({ auth: process.env.NOTION_API_KEY });
        this.databaseId = process.env.NOTION_CASES_DATABASE_ID;
        this.pagePropertyCache = new Map();
    }

    /**
     * Fetch cases from Notion database with a specific status
     */
    async fetchCasesWithStatus(status = 'Ready to Send') {
        try {
            const response = await this.notion.databases.query({
                database_id: this.databaseId,
                filter: {
                    property: 'Status',
                    select: {
                        equals: status
                    }
                }
            });

            // Parse pages and enrich with police department data
            const cases = [];
            for (const page of response.results) {
        const caseData = this.parseNotionPage(page);
        const fullPageText = await this.getFullPagePlainText(page.id);
        if (fullPageText) {
            caseData.full_page_text = fullPageText;
            caseData.additional_details = [caseData.additional_details, fullPageText]
                .filter(Boolean)
                .join('\n\n')
                .trim();
        }
        if (!caseData.portal_url) {
            const portalFromText = this.findPortalInText(caseData.additional_details || fullPageText || '');
            if (portalFromText) {
                caseData.portal_url = portalFromText;
                console.log(`Detected portal URL from page text: ${portalFromText}`);
            }
        }
        const enrichedCase = await this.enrichWithPoliceDepartment(caseData, page);
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
            const enrichedCase = await this.enrichWithPoliceDepartment(caseData, page);

            // Extract state from page content if not already set
            if (!enrichedCase.state) {
                const pageContent = await this.getFullPagePlainText(page.id);
                enrichedCase.state = await this.extractStateWithAI(enrichedCase, pageContent);
            }

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
                             ['Police report', 'Body cam footage'],
            // ACTUAL NOTION FIELDS: "Case Summary" and "Notes" (rollup)
            additional_details: this.getProperty(props, 'Case Summary', 'rich_text') ||
                              this.getProperty(props, 'Notes', 'rich_text') ||
                              '',
            status: this.getProperty(props, 'Status', 'select') ||
                   'ready_to_send',
            // Add portal URL for reference
            portal_url: portalUrl
        };
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

            // Export ALL fields from Police Department database for AI analysis
            const allFieldsData = {};
            Object.entries(deptProps).forEach(([fieldName, prop]) => {
                let value = null;
                switch (prop.type) {
                    case 'title':
                        value = prop.title?.map(t => t.plain_text).join('') || null;
                        break;
                    case 'rich_text':
                        value = prop.rich_text?.map(t => t.plain_text).join(' ').trim() || null;
                        break;
                    case 'email':
                        value = prop.email || null;
                        break;
                    case 'url':
                        value = prop.url || null;
                        break;
                    case 'select':
                        value = prop.select?.name || null;
                        break;
                    case 'multi_select':
                        value = prop.multi_select?.map(s => s.name).join(', ') || null;
                        break;
                    case 'number':
                        value = prop.number?.toString() || null;
                        break;
                    case 'phone_number':
                        value = prop.phone_number || null;
                        break;
                }
                if (value) {
                    allFieldsData[fieldName] = value;
                }
            });

            // Use GPT-5 to intelligently extract and prioritize contact info
            const { emailCandidate, portalCandidate } = await this.extractContactsWithAI(allFieldsData, caseData);

            // NO FALLBACK - return null if not found
            caseData.agency_email = emailCandidate || null;

            if (!caseData.portal_url && portalCandidate) {
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

    /**
     * Get property value from Notion page based on type
     */
    getProperty(properties, name, type) {
        const prop = properties[name];
        if (!prop) return null;

        switch (type) {
            case 'title':
                return prop.title?.[0]?.plain_text || '';
            case 'rich_text':
                return prop.rich_text?.[0]?.plain_text || '';
            case 'email':
                return prop.email || '';
            case 'select':
                return prop.select?.name || '';
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
    async extractContactsWithAI(allFieldsData, caseData) {
        try {
            const OpenAI = require('openai');
            const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

            const prompt = `You are analyzing a Police Department database record to find contact information for submitting public records requests.

POLICE DEPARTMENT FIELDS:
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
                model: 'gpt-4o-mini',
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

            const urls = extractUrls(value);
            urls.forEach(url => {
                const normalized = normalizePortalUrl(url);
                if (normalized && !portals.includes(normalized)) {
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
                            if (normalizedToken && !portals.includes(normalizedToken)) {
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
        for (const rawUrl of urls) {
            const normalized = normalizePortalUrl(rawUrl);
            if (normalized && isSupportedPortalUrl(normalized)) {
                return normalized;
            }
        }
        return null;
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

            // Convert our updates to Notion property format
            if (updates.status) {
                if (propSet.has('Status')) {
                    properties.Status = {
                        select: { name: updates.status }
                    };
                } else {
                    missingProps('Status');
                }
            }

            if (updates.send_date) {
                if (propSet.has('Send Date')) {
                    properties['Send Date'] = {
                        date: { start: updates.send_date }
                    };
                } else {
                    missingProps('Send Date');
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
                if (propSet.has('Live Status')) {
                    properties['Live Status'] = {
                        select: { name: updates.live_status }
                    };
                } else {
                    missingProps('Live Status');
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
    async syncCasesFromNotion(status = 'Ready to Send') {
        try {
            console.log(`Syncing cases with status: ${status}`);
            const notionCases = await this.fetchCasesWithStatus(status);
            console.log(`Found ${notionCases.length} cases in Notion`);

            const syncedCases = [];

            for (const notionCase of notionCases) {
                try {
                    // Check if case already exists in our database
                    const existing = await db.getCaseByNotionId(notionCase.notion_page_id);

                    if (existing) {
                        console.log(`Case already exists (skipping re-send): ${notionCase.case_name}`);
                        // Don't add to syncedCases - only new cases should be queued
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

            const updates = {
                status: this.mapStatusToNotion(caseData.status)
            };

            if (caseData.send_date) {
                updates.send_date = caseData.send_date;
            }

            if (caseData.last_response_date) {
                updates.last_response_date = caseData.last_response_date;
            }

            if (caseData.days_overdue) {
                updates.days_overdue = caseData.days_overdue;
            }

            const liveStatus = this.mapStatusToNotion(caseData.status) || caseData.status;
            if (liveStatus) {
                updates.live_status = liveStatus;
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

    /**
     * Fetch and process a single Notion page by ID
     */
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

            // Enrich with police department data
            await this.enrichWithPoliceDepartment(notionCase);

            // Add page content as additional details if we have it
            if (pageContent && !notionCase.additional_details) {
                notionCase.additional_details = pageContent.substring(0, 5000); // Limit to 5000 chars
            } else if (pageContent) {
                notionCase.additional_details += '\n\n--- Page Content ---\n' + pageContent.substring(0, 5000);
            }

            // Check if already exists
            const existing = await db.getCaseByNotionId(notionCase.notion_page_id);
            if (existing) {
                console.log(`Case already exists: ${notionCase.case_name}`);
                return existing;
            }

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
}

module.exports = new NotionService();
