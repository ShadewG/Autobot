/**
 * Agency Notion Sync Service
 *
 * Two-way sync between PostgreSQL agencies table and Notion Police Departments database.
 *
 * Sync directions:
 * - FROM Notion: Pull Police Department pages and update/create local agencies
 * - TO Notion: Push local agency changes back to Notion
 *
 * Features:
 * - Conflict detection using sync_hash
 * - Comment syncing
 * - Audit logging
 * - Incremental sync support
 */

const { Client } = require('@notionhq/client');
const crypto = require('crypto');
const db = require('./database');

// Field mapping: Notion property name -> PostgreSQL column
const NOTION_TO_DB_FIELD_MAP = {
    'Department Name': 'name',
    'Address': 'address',
    'Mailing Address': 'mailing_address',
    'County': 'county',
    'State': 'state',
    'Contact Email': 'email_main',
    'Contact Phone': 'phone',
    'Fax No.': 'fax',
    'Name Of Officer/Employee Contacted': 'contact_name',
    'Email Correspondence': 'email_foia',
    'Portal/ Online Form': 'portal_url',
    'Portal/ Online Form (1)': 'portal_url_alt',
    'Request Form': 'request_form_url',
    'Allows In House Redaction': 'allows_in_house_redaction',
    'BWC Availability': 'bwc_availability',
    'Rating': 'rating',
    'Last Info Verified': 'last_info_verified_at',
    'Notes': 'notes'
};

// Reverse mapping for pushing to Notion
const DB_TO_NOTION_FIELD_MAP = Object.fromEntries(
    Object.entries(NOTION_TO_DB_FIELD_MAP).map(([k, v]) => [v, k])
);

class AgencyNotionSyncService {
    constructor() {
        this.notion = new Client({ auth: process.env.NOTION_API_KEY });
        this.policeDeptDatabaseId = process.env.NOTION_POLICE_DEPT_DATABASE_ID;
        this.syncInProgress = false;
    }

    /**
     * Calculate hash of agency data for change detection
     */
    calculateSyncHash(data) {
        const normalized = JSON.stringify(data, Object.keys(data).sort());
        return crypto.createHash('sha256').update(normalized).digest('hex').substring(0, 64);
    }

    /**
     * Extract plain value from Notion property
     */
    extractNotionValue(prop) {
        if (!prop) return null;

        switch (prop.type) {
            case 'title':
                return prop.title?.[0]?.plain_text || null;
            case 'rich_text':
                return prop.rich_text?.map(t => t.plain_text).join('') || null;
            case 'number':
                return prop.number;
            case 'select':
                return prop.select?.name || null;
            case 'multi_select':
                return prop.multi_select?.map(s => s.name).join(', ') || null;
            case 'date':
                return prop.date?.start || null;
            case 'checkbox':
                return prop.checkbox;
            case 'url':
                return prop.url;
            case 'email':
                return prop.email;
            case 'phone_number':
                return prop.phone_number;
            case 'relation':
                return prop.relation?.map(r => r.id) || [];
            default:
                return null;
        }
    }

    /**
     * Convert Notion page to agency data
     */
    notionPageToAgency(page) {
        const props = page.properties;
        const agency = {
            notion_page_id: page.id
        };

        for (const [notionField, dbField] of Object.entries(NOTION_TO_DB_FIELD_MAP)) {
            const value = this.extractNotionValue(props[notionField]);
            if (value !== null && value !== undefined) {
                agency[dbField] = value;
            }
        }

        // Normalize state to 2-letter code
        if (agency.state && agency.state.length > 2) {
            agency.state = this.normalizeStateCode(agency.state);
        }

        // Parse rating as decimal
        if (agency.rating && typeof agency.rating === 'string') {
            agency.rating = parseFloat(agency.rating) || null;
        }

        return agency;
    }

    /**
     * Normalize state name to 2-letter code
     */
    normalizeStateCode(state) {
        if (!state) return null;
        if (state.length === 2) return state.toUpperCase();

        const STATE_MAP = {
            'alabama': 'AL', 'alaska': 'AK', 'arizona': 'AZ', 'arkansas': 'AR',
            'california': 'CA', 'colorado': 'CO', 'connecticut': 'CT', 'delaware': 'DE',
            'florida': 'FL', 'georgia': 'GA', 'hawaii': 'HI', 'idaho': 'ID',
            'illinois': 'IL', 'indiana': 'IN', 'iowa': 'IA', 'kansas': 'KS',
            'kentucky': 'KY', 'louisiana': 'LA', 'maine': 'ME', 'maryland': 'MD',
            'massachusetts': 'MA', 'michigan': 'MI', 'minnesota': 'MN', 'mississippi': 'MS',
            'missouri': 'MO', 'montana': 'MT', 'nebraska': 'NE', 'nevada': 'NV',
            'new hampshire': 'NH', 'new jersey': 'NJ', 'new mexico': 'NM', 'new york': 'NY',
            'north carolina': 'NC', 'north dakota': 'ND', 'ohio': 'OH', 'oklahoma': 'OK',
            'oregon': 'OR', 'pennsylvania': 'PA', 'rhode island': 'RI', 'south carolina': 'SC',
            'south dakota': 'SD', 'tennessee': 'TN', 'texas': 'TX', 'utah': 'UT',
            'vermont': 'VT', 'virginia': 'VA', 'washington': 'WA', 'west virginia': 'WV',
            'wisconsin': 'WI', 'wyoming': 'WY', 'district of columbia': 'DC'
        };

        return STATE_MAP[state.toLowerCase()] || state.substring(0, 2).toUpperCase();
    }

    /**
     * Build Notion properties from agency data
     */
    agencyToNotionProperties(agency) {
        const properties = {};

        for (const [dbField, notionField] of Object.entries(DB_TO_NOTION_FIELD_MAP)) {
            const value = agency[dbField];
            if (value === null || value === undefined) continue;

            // Determine property type based on field
            if (notionField === 'Department Name') {
                properties[notionField] = {
                    title: [{ text: { content: String(value) } }]
                };
            } else if (['Allows In House Redaction'].includes(notionField)) {
                properties[notionField] = { checkbox: Boolean(value) };
            } else if (['Rating'].includes(notionField)) {
                properties[notionField] = { number: parseFloat(value) || null };
            } else if (['Last Info Verified'].includes(notionField)) {
                properties[notionField] = {
                    date: value ? { start: new Date(value).toISOString().split('T')[0] } : null
                };
            } else if (['Portal/ Online Form', 'Portal/ Online Form (1)', 'Request Form'].includes(notionField)) {
                properties[notionField] = { url: value || null };
            } else {
                // Default to rich_text
                properties[notionField] = {
                    rich_text: [{ text: { content: String(value).substring(0, 2000) } }]
                };
            }
        }

        return properties;
    }

    /**
     * Sync all agencies FROM Notion
     */
    async syncFromNotion(options = {}) {
        const { fullSync = false, limit = 100 } = options;

        if (this.syncInProgress) {
            throw new Error('Sync already in progress');
        }

        if (!this.policeDeptDatabaseId) {
            throw new Error('NOTION_POLICE_DEPT_DATABASE_ID environment variable not set');
        }

        this.syncInProgress = true;
        const syncLog = {
            direction: 'from_notion',
            type: fullSync ? 'full' : 'incremental',
            started_at: new Date(),
            created: 0,
            updated: 0,
            skipped: 0,
            errors: []
        };

        try {
            console.log(`Starting ${syncLog.type} sync from Notion...`);

            // Fetch all Police Department pages
            let hasMore = true;
            let startCursor = undefined;
            let processedCount = 0;

            while (hasMore && processedCount < limit) {
                const response = await this.notion.databases.query({
                    database_id: this.policeDeptDatabaseId,
                    start_cursor: startCursor,
                    page_size: Math.min(100, limit - processedCount)
                });

                for (const page of response.results) {
                    try {
                        const result = await this.syncSingleAgencyFromNotion(page, fullSync);
                        syncLog[result.action]++;
                        processedCount++;
                    } catch (err) {
                        syncLog.errors.push({
                            page_id: page.id,
                            error: err.message
                        });
                        console.error(`Error syncing page ${page.id}:`, err.message);
                    }
                }

                hasMore = response.has_more;
                startCursor = response.next_cursor;
            }

            syncLog.completed_at = new Date();
            console.log(`Sync from Notion completed: ${syncLog.created} created, ${syncLog.updated} updated, ${syncLog.skipped} skipped, ${syncLog.errors.length} errors`);

            return syncLog;

        } finally {
            this.syncInProgress = false;
        }
    }

    /**
     * Sync a single agency from Notion page
     */
    async syncSingleAgencyFromNotion(page, forceUpdate = false) {
        const agencyData = this.notionPageToAgency(page);
        const newHash = this.calculateSyncHash(agencyData);

        // Check if agency exists
        const existing = await db.query(
            'SELECT * FROM agencies WHERE notion_page_id = $1',
            [page.id]
        );

        if (existing.rows.length > 0) {
            const existingAgency = existing.rows[0];

            // Skip if hash matches and not forcing update
            if (!forceUpdate && existingAgency.sync_hash === newHash) {
                return { action: 'skipped', agency_id: existingAgency.id };
            }

            // Update existing agency
            const updateFields = [];
            const updateValues = [];
            let paramIndex = 1;

            for (const [key, value] of Object.entries(agencyData)) {
                if (key !== 'notion_page_id') {
                    updateFields.push(`${key} = $${paramIndex}`);
                    updateValues.push(value);
                    paramIndex++;
                }
            }

            updateFields.push(`sync_hash = $${paramIndex}`);
            updateValues.push(newHash);
            paramIndex++;

            updateFields.push(`last_synced_from_notion = $${paramIndex}`);
            updateValues.push(new Date());
            paramIndex++;

            updateFields.push(`sync_status = $${paramIndex}`);
            updateValues.push('synced');
            paramIndex++;

            updateValues.push(existingAgency.id);

            await db.query(
                `UPDATE agencies SET ${updateFields.join(', ')} WHERE id = $${paramIndex}`,
                updateValues
            );

            // Log the sync
            await this.logSync(existingAgency.id, page.id, 'from_notion', 'success', agencyData);

            return { action: 'updated', agency_id: existingAgency.id };

        } else {
            // Create new agency
            const columns = Object.keys(agencyData);
            const values = Object.values(agencyData);
            columns.push('sync_hash', 'last_synced_from_notion', 'sync_status');
            values.push(newHash, new Date(), 'synced');

            const placeholders = values.map((_, i) => `$${i + 1}`).join(', ');

            const result = await db.query(
                `INSERT INTO agencies (${columns.join(', ')}) VALUES (${placeholders}) RETURNING id`,
                values
            );

            const newId = result.rows[0].id;

            // Log the sync
            await this.logSync(newId, page.id, 'from_notion', 'success', agencyData);

            return { action: 'created', agency_id: newId };
        }
    }

    /**
     * Sync a single agency TO Notion
     */
    async syncAgencyToNotion(agencyId) {
        const result = await db.query('SELECT * FROM agencies WHERE id = $1', [agencyId]);
        if (result.rows.length === 0) {
            throw new Error(`Agency ${agencyId} not found`);
        }

        const agency = result.rows[0];
        const properties = this.agencyToNotionProperties(agency);

        if (agency.notion_page_id) {
            // Update existing Notion page
            await this.notion.pages.update({
                page_id: agency.notion_page_id,
                properties
            });

            await db.query(
                `UPDATE agencies SET last_synced_to_notion = $1, sync_status = 'synced' WHERE id = $2`,
                [new Date(), agencyId]
            );

            await this.logSync(agencyId, agency.notion_page_id, 'to_notion', 'success', properties);

            return { action: 'updated', notion_page_id: agency.notion_page_id };

        } else {
            // Create new Notion page
            const newPage = await this.notion.pages.create({
                parent: { database_id: this.policeDeptDatabaseId },
                properties
            });

            await db.query(
                `UPDATE agencies SET notion_page_id = $1, last_synced_to_notion = $2, sync_status = 'synced' WHERE id = $3`,
                [newPage.id, new Date(), agencyId]
            );

            await this.logSync(agencyId, newPage.id, 'to_notion', 'success', properties);

            return { action: 'created', notion_page_id: newPage.id };
        }
    }

    /**
     * Sync comments for an agency
     */
    async syncCommentsFromNotion(agencyId) {
        const result = await db.query(
            'SELECT notion_page_id FROM agencies WHERE id = $1',
            [agencyId]
        );

        if (result.rows.length === 0 || !result.rows[0].notion_page_id) {
            return { synced: 0 };
        }

        const pageId = result.rows[0].notion_page_id;

        // Fetch comments from Notion
        const comments = await this.notion.comments.list({
            block_id: pageId
        });

        let syncedCount = 0;

        for (const comment of comments.results) {
            const content = comment.rich_text?.map(t => t.plain_text).join('') || '';
            const author = comment.created_by?.name || 'Unknown';

            // Check if comment already exists
            const existing = await db.query(
                'SELECT id FROM agency_comments WHERE notion_comment_id = $1',
                [comment.id]
            );

            if (existing.rows.length === 0) {
                await db.query(
                    `INSERT INTO agency_comments (agency_id, notion_comment_id, author, content, created_at, synced_from_notion)
                     VALUES ($1, $2, $3, $4, $5, true)`,
                    [agencyId, comment.id, author, content, comment.created_time]
                );
                syncedCount++;
            }
        }

        return { synced: syncedCount };
    }

    /**
     * Log sync operation
     */
    async logSync(agencyId, notionPageId, direction, status, fieldsChanged = null) {
        await db.query(
            `INSERT INTO agency_sync_log (agency_id, notion_page_id, sync_direction, sync_type, fields_changed, status, completed_at)
             VALUES ($1, $2, $3, 'manual', $4, $5, NOW())`,
            [agencyId, notionPageId, direction, JSON.stringify(fieldsChanged), status]
        );
    }

    /**
     * Get sync status for all agencies
     */
    async getSyncStatus() {
        const result = await db.query(`
            SELECT
                COUNT(*) as total,
                COUNT(*) FILTER (WHERE sync_status = 'synced') as synced,
                COUNT(*) FILTER (WHERE sync_status = 'pending') as pending,
                COUNT(*) FILTER (WHERE sync_status = 'error') as errors,
                COUNT(*) FILTER (WHERE notion_page_id IS NOT NULL) as linked_to_notion,
                MAX(last_synced_from_notion) as last_sync_from_notion,
                MAX(last_synced_to_notion) as last_sync_to_notion
            FROM agencies
        `);

        return result.rows[0];
    }

    /**
     * Find agencies needing sync (changed locally since last Notion sync)
     */
    async getAgenciesNeedingSync() {
        const result = await db.query(`
            SELECT id, name, updated_at, last_synced_to_notion
            FROM agencies
            WHERE last_synced_to_notion IS NULL
               OR updated_at > last_synced_to_notion
            ORDER BY updated_at DESC
            LIMIT 100
        `);

        return result.rows;
    }
}

module.exports = new AgencyNotionSyncService();
