const express = require('express');
const router = express.Router();
const db = require('../services/database');

/**
 * GET /api/agencies
 * List all agencies (derived from cases)
 */
router.get('/', async (req, res) => {
    try {
        // Aggregate agency info from cases since we don't have a dedicated agencies table
        const result = await db.query(`
            SELECT
                agency_name as name,
                state,
                portal_url,
                portal_provider,
                COUNT(*) as total_requests,
                COUNT(*) FILTER (WHERE status = 'completed') as completed_requests,
                AVG(
                    CASE WHEN last_response_date IS NOT NULL AND send_date IS NOT NULL
                    THEN EXTRACT(EPOCH FROM (last_response_date - send_date)) / 86400
                    END
                )::INTEGER as avg_response_days,
                MAX(updated_at) as last_activity_at
            FROM cases
            WHERE agency_name IS NOT NULL
            GROUP BY agency_name, state, portal_url, portal_provider
            ORDER BY total_requests DESC
            LIMIT 100
        `);

        const agencies = result.rows.map((row, index) => ({
            id: String(index + 1), // Generate ID from index since we don't have a real ID
            name: row.name,
            state: row.state || '—',
            submission_method: row.portal_url ? 'PORTAL' : 'EMAIL',
            portal_url: row.portal_url || null,
            portal_provider: row.portal_provider || null,
            default_autopilot_mode: 'SUPERVISED', // Default
            total_requests: parseInt(row.total_requests) || 0,
            completed_requests: parseInt(row.completed_requests) || 0,
            avg_response_days: row.avg_response_days || null,
            last_activity_at: row.last_activity_at || null,
            notes: null
        }));

        res.json({
            success: true,
            count: agencies.length,
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
 * Get single agency details (by name, since we use index-based IDs)
 */
router.get('/:id', async (req, res) => {
    try {
        const agencyId = parseInt(req.params.id);

        // First, get the list of agencies to map ID to name
        const listResult = await db.query(`
            SELECT DISTINCT agency_name as name, state, portal_url, portal_provider
            FROM cases
            WHERE agency_name IS NOT NULL
            ORDER BY agency_name
        `);

        if (agencyId < 1 || agencyId > listResult.rows.length) {
            return res.status(404).json({
                success: false,
                error: 'Agency not found'
            });
        }

        const agencyRow = listResult.rows[agencyId - 1];
        const agencyName = agencyRow.name;

        // Get detailed stats for this agency
        const statsResult = await db.query(`
            SELECT
                COUNT(*) as total_requests,
                COUNT(*) FILTER (WHERE status = 'completed') as completed_requests,
                COUNT(*) FILTER (WHERE status IN ('needs_human_review', 'needs_human_fee_approval')) as pending_review,
                COUNT(*) FILTER (WHERE last_fee_quote_amount IS NOT NULL) as has_fees,
                SUM(COALESCE(last_fee_quote_amount, 0)) as total_fees,
                AVG(
                    CASE WHEN last_response_date IS NOT NULL AND send_date IS NOT NULL
                    THEN EXTRACT(EPOCH FROM (last_response_date - send_date)) / 86400
                    END
                )::INTEGER as avg_response_days,
                MIN(send_date) as first_request_at,
                MAX(updated_at) as last_activity_at
            FROM cases
            WHERE agency_name = $1
        `, [agencyName]);

        const stats = statsResult.rows[0];

        // Get recent requests for this agency
        const requestsResult = await db.query(`
            SELECT id, case_name, subject_name, status, send_date, last_response_date
            FROM cases
            WHERE agency_name = $1
            ORDER BY updated_at DESC
            LIMIT 10
        `, [agencyName]);

        const agency = {
            id: String(agencyId),
            name: agencyName,
            state: agencyRow.state || '—',
            submission_method: agencyRow.portal_url ? 'PORTAL' : 'EMAIL',
            portal_url: agencyRow.portal_url || null,
            portal_provider: agencyRow.portal_provider || null,
            default_autopilot_mode: 'SUPERVISED',
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
                forms_required: false,
                id_required: false,
                notarization_required: false
            },
            fee_behavior: {
                typical_fee_range: null,
                waiver_success_rate: null
            },
            notes: null
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

module.exports = router;
