const express = require('express');
const router = express.Router();
const db = require('../services/database');
const agencyNotionSync = require('../services/agency-notion-sync');

const US_STATE_NAMES = {
    alabama: 'AL',
    alaska: 'AK',
    arizona: 'AZ',
    arkansas: 'AR',
    california: 'CA',
    colorado: 'CO',
    connecticut: 'CT',
    delaware: 'DE',
    'district of columbia': 'DC',
    florida: 'FL',
    georgia: 'GA',
    hawaii: 'HI',
    idaho: 'ID',
    illinois: 'IL',
    indiana: 'IN',
    iowa: 'IA',
    kansas: 'KS',
    kentucky: 'KY',
    louisiana: 'LA',
    maine: 'ME',
    maryland: 'MD',
    massachusetts: 'MA',
    michigan: 'MI',
    minnesota: 'MN',
    mississippi: 'MS',
    missouri: 'MO',
    montana: 'MT',
    nebraska: 'NE',
    nevada: 'NV',
    'new hampshire': 'NH',
    'new jersey': 'NJ',
    'new mexico': 'NM',
    'new york': 'NY',
    'north carolina': 'NC',
    'north dakota': 'ND',
    ohio: 'OH',
    oklahoma: 'OK',
    oregon: 'OR',
    pennsylvania: 'PA',
    'rhode island': 'RI',
    'south carolina': 'SC',
    'south dakota': 'SD',
    tennessee: 'TN',
    texas: 'TX',
    utah: 'UT',
    vermont: 'VT',
    virginia: 'VA',
    washington: 'WA',
    'west virginia': 'WV',
    wisconsin: 'WI',
    wyoming: 'WY',
};

const US_STATE_CODES = new Set(Object.values(US_STATE_NAMES));

function normalizeStateToken(value) {
    if (!value || value === '{}') return null;
    const trimmed = String(value).trim().replace(/[.,]+$/, '');
    if (!trimmed) return null;

    const upper = trimmed.toUpperCase();
    if (US_STATE_CODES.has(upper)) return upper;

    return US_STATE_NAMES[trimmed.toLowerCase()] || null;
}

function extractTrailingAgencyState(name) {
    let remaining = String(name || '').trim();
    if (!remaining) return null;

    while (true) {
        const match = remaining.match(/^(.*?),\s*([^,]+)$/);
        if (!match) break;
        const suffixState = normalizeStateToken(match[2]);
        if (suffixState) return suffixState;
        remaining = match[1].trim();
    }

    return null;
}

function stripTrailingAgencyState(name) {
    let cleaned = String(name || '').trim();
    if (!cleaned) return cleaned;

    const targetState = extractTrailingAgencyState(cleaned);
    if (!targetState) return cleaned;

    while (true) {
        const match = cleaned.match(/^(.*?),\s*([^,]+)$/);
        if (!match) break;
        const suffixState = normalizeStateToken(match[2]);
        if (suffixState !== targetState) break;
        cleaned = match[1].trim();
    }

    return cleaned || String(name || '').trim();
}

function normalizeAgencyState(state, agencyName, caseState) {
    return (
        normalizeStateToken(state) ||
        extractTrailingAgencyState(agencyName) ||
        normalizeStateToken(caseState) ||
        null
    );
}

function normalizeAgencyListKey(row) {
    const name = stripTrailingAgencyState(row?.name || '')
        .toLowerCase()
        .replace(/[^\w\s]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    const state = normalizeAgencyState(row?.state, row?.name, row?.case_state) || '';
    return `${name}|${state}`;
}

function scoreAgencyRow(row) {
    return (
        (parseInt(row.total_requests, 10) || 0) * 10 +
        (row.portal_url ? 3 : 0) +
        (row.email_main ? 2 : 0) +
        (row.email_foia ? 2 : 0) +
        (normalizeAgencyState(row.state, row.name, row.case_state) ? 1 : 0)
    );
}

function dedupeAgencyRows(rows = []) {
    const deduped = new Map();

    for (const row of rows) {
        const name = String(row?.name || '').trim();
        if (!name) continue;
        if (/^[a-z]{2,4}$/i.test(name) && !/\s/.test(name)) {
            continue;
        }

        const key = normalizeAgencyListKey(row);
        const existing = deduped.get(key);
        if (!existing || scoreAgencyRow(row) > scoreAgencyRow(existing)) {
            deduped.set(key, row);
        }
    }

    return Array.from(deduped.values());
}

/**
 * GET /api/agencies
 * List all agencies from the agencies table
 */
router.get('/', async (req, res) => {
    try {
        const { state, search, limit = 100, offset = 0 } = req.query;

        let whereClause = 'WHERE 1=1';
        const params = [];
        let paramIndex = 1;

        if (state) {
            whereClause += ` AND state = $${paramIndex}`;
            params.push(state);
            paramIndex++;
        }

        if (search) {
            whereClause += ` AND name ILIKE $${paramIndex}`;
            params.push(`%${search}%`);
            paramIndex++;
        }

        // Get agencies with case stats
        const result = await db.query(`
            SELECT
                a.*,
                COALESCE(stats.total_requests, 0) as total_requests,
                COALESCE(stats.completed_requests, 0) as completed_requests,
                COALESCE(stats.avg_response_days, 0) as avg_response_days,
                stats.last_activity_at
            FROM agencies a
            LEFT JOIN LATERAL (
                SELECT
                    COUNT(*) as total_requests,
                    COUNT(*) FILTER (WHERE status = 'completed') as completed_requests,
                    AVG(
                        CASE WHEN last_response_date IS NOT NULL AND send_date IS NOT NULL
                        THEN EXTRACT(EPOCH FROM (last_response_date - send_date)) / 86400
                        END
                    )::INTEGER as avg_response_days,
                    MAX(updated_at) as last_activity_at,
                    MAX(NULLIF(c.state, '{}')) as case_state
                FROM cases c
                WHERE c.agency_id = a.id OR c.agency_name = a.name
            ) stats ON true
            ${whereClause}
            ORDER BY COALESCE(stats.total_requests, 0) DESC, a.name ASC
            LIMIT $${paramIndex} OFFSET $${paramIndex + 1}
        `, [...params, parseInt(limit), parseInt(offset)]);

        // Get total count
        const countResult = await db.query(
            `SELECT COUNT(*) FROM agencies ${whereClause}`,
            params
        );

        const agencies = dedupeAgencyRows(result.rows).map(row => ({
            id: String(row.id),
            name: stripTrailingAgencyState(row.name),
            state: normalizeAgencyState(row.state, row.name, row.case_state),
            county: row.county || null,
            submission_method: row.portal_url ? 'PORTAL' : (row.email_main ? 'EMAIL' : 'UNKNOWN'),
            portal_url: row.portal_url || null,
            portal_provider: row.portal_provider || null,
            email_main: row.email_main || null,
            email_foia: row.email_foia || null,
            phone: row.phone || null,
            default_autopilot_mode: row.default_autopilot_mode || 'SUPERVISED',
            total_requests: parseInt(row.total_requests) || 0,
            completed_requests: parseInt(row.completed_requests) || 0,
            avg_response_days: row.avg_response_days != null && Number(row.avg_response_days) >= 0
                ? Number(row.avg_response_days)
                : null,
            rating: row.rating ? parseFloat(row.rating) : null,
            last_activity_at: row.last_activity_at || null,
            last_info_verified_at: row.last_info_verified_at || null,
            sync_status: row.sync_status,
            notion_page_id: row.notion_page_id || null,
            notes: row.notes || null
        }));

        res.json({
            success: true,
            count: agencies.length,
            total: agencies.length,
            agencies
        });
    } catch (error) {
        console.error('Error fetching agencies:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

/**
 * GET /api/agencies/:id
 * Get single agency details
 */
router.get('/:id', async (req, res) => {
    try {
        const agencyId = parseInt(req.params.id);

        const result = await db.query('SELECT * FROM agencies WHERE id = $1', [agencyId]);

        if (result.rows.length === 0) {
            return res.status(404).json({
                success: false,
                error: 'Agency not found'
            });
        }

        const row = result.rows[0];

        // Get stats for this agency
        const statsResult = await db.query(`
            SELECT
                COUNT(*) as total_requests,
                COUNT(*) FILTER (WHERE status = 'completed') as completed_requests,
                COUNT(*) FILTER (WHERE status IN ('needs_human_review', 'needs_human_fee_approval')) as pending_review,
                COUNT(*) FILTER (WHERE fee_quote_jsonb IS NOT NULL AND (fee_quote_jsonb->>'amount') IS NOT NULL) as has_fees,
                SUM(COALESCE((fee_quote_jsonb->>'amount')::numeric, 0)) as total_fees,
                AVG(
                    CASE WHEN last_response_date IS NOT NULL AND send_date IS NOT NULL
                    THEN EXTRACT(EPOCH FROM (last_response_date - send_date)) / 86400
                    END
                )::INTEGER as avg_response_days,
                MIN(send_date) as first_request_at,
                MAX(updated_at) as last_activity_at
            FROM cases
            WHERE agency_id = $1 OR agency_name = $2
        `, [agencyId, row.name]);

        const stats = statsResult.rows[0];

        // Get recent requests
        const requestsResult = await db.query(`
            SELECT id, case_name, subject_name, status, send_date, last_response_date
            FROM cases
            WHERE agency_id = $1 OR agency_name = $2
            ORDER BY updated_at DESC
            LIMIT 10
        `, [agencyId, row.name]);

        // Get comments
        const commentsResult = await db.query(`
            SELECT * FROM agency_comments
            WHERE agency_id = $1
            ORDER BY created_at DESC
            LIMIT 20
        `, [agencyId]);

        const agency = {
            id: String(row.id),
            name: row.name,
            state: (row.state && row.state !== '{}') ? row.state : null,
            county: row.county || null,
            address: row.address || null,
            mailing_address: row.mailing_address || null,
            submission_method: row.portal_url ? 'PORTAL' : (row.email_main ? 'EMAIL' : 'UNKNOWN'),
            portal_url: row.portal_url || null,
            portal_url_alt: row.portal_url_alt || null,
            portal_provider: row.portal_provider || null,
            request_form_url: row.request_form_url || null,
            preferred_method: row.preferred_method || 'EMAIL',
            email_main: row.email_main || null,
            email_foia: row.email_foia || null,
            phone: row.phone || null,
            fax: row.fax || null,
            contact_name: row.contact_name || null,
            default_autopilot_mode: row.default_autopilot_mode || 'SUPERVISED',
            rating: row.rating ? parseFloat(row.rating) : null,
            stats: {
                total_requests: parseInt(stats.total_requests) || 0,
                completed_requests: parseInt(stats.completed_requests) || 0,
                pending_review: parseInt(stats.pending_review) || 0,
                has_fees: parseInt(stats.has_fees) || 0,
                total_fees: parseFloat(stats.total_fees) || 0,
                avg_response_days: stats.avg_response_days || null,
                first_request_at: stats.first_request_at || null,
                last_activity_at: stats.last_activity_at || null
            },
            recent_requests: requestsResult.rows.map(r => ({
                id: String(r.id),
                case_name: r.case_name,
                subject_name: r.subject_name,
                status: r.status,
                send_date: r.send_date,
                last_response_date: r.last_response_date
            })),
            submission_details: {
                allows_in_house_redaction: row.allows_in_house_redaction || false,
                bwc_availability: row.bwc_availability || null,
                forms_required: row.forms_required || false,
                id_required: row.id_required || false,
                notarization_required: row.notarization_required || false
            },
            fee_behavior: {
                typical_fee_min: row.typical_fee_min != null ? parseFloat(row.typical_fee_min) : null,
                typical_fee_max: row.typical_fee_max != null ? parseFloat(row.typical_fee_max) : null,
                typical_fee_range: row.typical_fee_min != null && row.typical_fee_max != null
                    ? `$${parseFloat(row.typical_fee_min).toFixed(0)}–$${parseFloat(row.typical_fee_max).toFixed(0)}`
                    : row.typical_fee_min != null ? `$${parseFloat(row.typical_fee_min).toFixed(0)}+`
                    : null,
                waiver_success_rate: row.fee_waiver_success_rate != null ? parseFloat(row.fee_waiver_success_rate) : null,
            },
            comments: commentsResult.rows.map(c => ({
                id: c.id,
                author: c.author,
                content: c.content,
                created_at: c.created_at
            })),
            sync: {
                notion_page_id: row.notion_page_id || null,
                sync_status: row.sync_status,
                last_synced_from_notion: row.last_synced_from_notion,
                last_synced_to_notion: row.last_synced_to_notion
            },
            last_info_verified_at: row.last_info_verified_at || null,
            verified_by: row.verified_by || null,
            notes: row.notes || null
        };

        res.json({
            success: true,
            agency
        });
    } catch (error) {
        console.error('Error fetching agency:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

/**
 * PUT /api/agencies/:id
 * Update agency details
 */
router.put('/:id', async (req, res) => {
    try {
        const agencyId = parseInt(req.params.id);
        const updates = req.body;

        // Allowed fields for update
        const allowedFields = [
            'name', 'state', 'county', 'address', 'mailing_address',
            'email_main', 'email_foia', 'phone', 'fax', 'contact_name',
            'portal_url', 'portal_url_alt', 'portal_provider', 'request_form_url',
            'preferred_method', 'allows_in_house_redaction', 'bwc_availability',
            'forms_required', 'id_required', 'notarization_required',
            'rating', 'typical_fee_min', 'typical_fee_max', 'fee_waiver_success_rate',
            'default_autopilot_mode', 'notes', 'last_info_verified_at', 'verified_by'
        ];

        const updateFields = [];
        const updateValues = [];
        let paramIndex = 1;

        for (const [key, value] of Object.entries(updates)) {
            if (allowedFields.includes(key)) {
                updateFields.push(`${key} = $${paramIndex}`);
                updateValues.push(value);
                paramIndex++;
            }
        }

        if (updateFields.length === 0) {
            return res.status(400).json({
                success: false,
                error: 'No valid fields to update'
            });
        }

        updateValues.push(agencyId);

        await db.query(
            `UPDATE agencies SET ${updateFields.join(', ')} WHERE id = $${paramIndex}`,
            updateValues
        );

        res.json({
            success: true,
            message: 'Agency updated'
        });
    } catch (error) {
        console.error('Error updating agency:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

/**
 * POST /api/agencies/:id/comments
 * Add a comment to an agency
 */
router.post('/:id/comments', async (req, res) => {
    try {
        const agencyId = parseInt(req.params.id);
        const { content, author = 'System' } = req.body;

        if (!content) {
            return res.status(400).json({
                success: false,
                error: 'Content is required'
            });
        }

        const result = await db.query(
            `INSERT INTO agency_comments (agency_id, author, content)
             VALUES ($1, $2, $3)
             RETURNING *`,
            [agencyId, author, content]
        );

        res.json({
            success: true,
            comment: result.rows[0]
        });
    } catch (error) {
        console.error('Error adding comment:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// =========================================================================
// NOTION SYNC ENDPOINTS
// =========================================================================

/**
 * GET /api/agencies/sync/status
 * Get sync status summary
 */
router.get('/sync/status', async (req, res) => {
    try {
        const status = await agencyNotionSync.getSyncStatus();
        const needingSync = await agencyNotionSync.getAgenciesNeedingSync();

        res.json({
            success: true,
            status: {
                ...status,
                agencies_needing_sync: needingSync.length
            },
            agencies_needing_sync: needingSync.slice(0, 10)
        });
    } catch (error) {
        console.error('Error getting sync status:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

/**
 * POST /api/agencies/sync/from-notion
 * Trigger sync from Notion to database
 */
router.post('/sync/from-notion', async (req, res) => {
    try {
        const { fullSync = false, limit = 100 } = req.body;

        const result = await agencyNotionSync.syncFromNotion({ fullSync, limit });

        res.json({
            success: true,
            message: 'Sync from Notion completed',
            result
        });
    } catch (error) {
        console.error('Error syncing from Notion:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

/**
 * POST /api/agencies/:id/sync/to-notion
 * Push a single agency to Notion
 */
router.post('/:id/sync/to-notion', async (req, res) => {
    try {
        const agencyId = parseInt(req.params.id);
        const result = await agencyNotionSync.syncAgencyToNotion(agencyId);

        res.json({
            success: true,
            message: 'Agency synced to Notion',
            result
        });
    } catch (error) {
        console.error('Error syncing to Notion:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

/**
 * POST /api/agencies/:id/sync/comments
 * Sync comments from Notion for an agency
 */
router.post('/:id/sync/comments', async (req, res) => {
    try {
        const agencyId = parseInt(req.params.id);
        const result = await agencyNotionSync.syncCommentsFromNotion(agencyId);

        res.json({
            success: true,
            message: 'Comments synced from Notion',
            synced: result.synced
        });
    } catch (error) {
        console.error('Error syncing comments:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

module.exports = router;
