const { Client } = require('@notionhq/client');
const db = require('./database');

class NotionService {
    constructor() {
        this.notion = new Client({ auth: process.env.NOTION_API_KEY });
        this.databaseId = process.env.NOTION_CASES_DATABASE_ID;
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

            return response.results.map(page => this.parseNotionPage(page));
        } catch (error) {
            console.error('Error fetching cases from Notion:', error);
            throw error;
        }
    }

    /**
     * Parse a Notion page into our case format
     */
    parseNotionPage(page) {
        const props = page.properties;

        // Get title from any title property
        const titleProp = Object.values(props).find(p => p.type === 'title');
        const caseName = titleProp?.title?.[0]?.plain_text || 'Untitled Case';

        return {
            notion_page_id: page.id,
            case_name: caseName,
            // Default to email for testing, or try to find it in properties
            agency_email: this.getProperty(props, 'Agency Email', 'email') ||
                         this.getProperty(props, 'Email', 'email') ||
                         process.env.DEFAULT_TEST_EMAIL ||
                         'shadewofficial@gmail.com',
            // Try different property names that might exist
            subject_name: this.getProperty(props, 'Subject Name', 'rich_text') ||
                         this.getProperty(props, 'Subject', 'rich_text') ||
                         this.getProperty(props, 'Name', 'rich_text') ||
                         caseName,
            agency_name: this.getProperty(props, 'Agency Name', 'rich_text') ||
                        this.getProperty(props, 'Agency', 'rich_text') ||
                        'Police Department',
            state: this.getProperty(props, 'State', 'select') ||
                  this.getProperty(props, 'Location', 'select') ||
                  'CA',
            incident_date: this.getProperty(props, 'Incident Date', 'date') ||
                          this.getProperty(props, 'Date', 'date') ||
                          null,
            incident_location: this.getProperty(props, 'Incident Location', 'rich_text') ||
                             this.getProperty(props, 'Location', 'rich_text') ||
                             '',
            requested_records: this.getProperty(props, 'Requested Records', 'multi_select') ||
                             this.getProperty(props, 'Records', 'multi_select') ||
                             ['Police report', 'Body cam footage'],
            additional_details: this.getProperty(props, 'Additional Details', 'rich_text') ||
                              this.getProperty(props, 'Details', 'rich_text') ||
                              this.getProperty(props, 'Notes', 'rich_text') ||
                              '',
            status: this.getProperty(props, 'Status', 'select') ||
                   'ready_to_send'
        };
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
            default:
                return null;
        }
    }

    /**
     * Update a Notion page with new properties
     */
    async updatePage(pageId, updates) {
        try {
            const properties = {};

            // Convert our updates to Notion property format
            if (updates.status) {
                properties.Status = {
                    select: { name: updates.status }
                };
            }

            if (updates.send_date) {
                properties['Send Date'] = {
                    date: { start: updates.send_date }
                };
            }

            if (updates.last_response_date) {
                properties['Last Response'] = {
                    date: { start: updates.last_response_date }
                };
            }

            if (updates.days_overdue !== undefined) {
                properties['Days Overdue'] = {
                    number: updates.days_overdue
                };
            }

            if (updates.ai_summary) {
                properties['AI Summary'] = {
                    rich_text: [{
                        text: { content: updates.ai_summary }
                    }]
                };
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
                        console.log(`Case already exists: ${notionCase.case_name}`);
                        syncedCases.push(existing);
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
            'error': 'Error'
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

            await this.updatePage(caseData.notion_page_id, {
                ai_summary: summary
            });
        } catch (error) {
            console.error('Error adding AI summary to Notion:', error);
        }
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
