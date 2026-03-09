const db = require('./database');
const { buildRealCaseWhereClause } = require('../utils/analytics-test-filter');
const {
    detectCaseMetadataAgencyMismatch,
    deriveDisplayState,
    extractMetadataAgencyHint,
    isGenericAgencyLabel,
} = require('../utils/request-normalization');

function round1(value) {
    if (value == null || Number.isNaN(Number(value))) return null;
    return Math.round(Number(value) * 10) / 10;
}

function percent(numerator, denominator) {
    if (!denominator) return null;
    return round1((Number(numerator) / Number(denominator)) * 100);
}

function diffDays(startValue, endValue) {
    if (!startValue || !endValue) return null;
    const start = new Date(startValue);
    const end = new Date(endValue);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return null;
    return (end.getTime() - start.getTime()) / 86400000;
}

function isTerminalCaseStatus(status) {
    return ['completed', 'closed', 'denied', 'cancelled', 'withdrawn', 'draft'].includes(String(status || '').toLowerCase());
}

function resolveDepartmentIdentity(row) {
    const rawAgencyName = String(row.primary_agency_name || row.case_agency_name || '').trim();
    const metadataAgencyHint = extractMetadataAgencyHint(row.additional_details);
    const metadataAgencyMismatch = detectCaseMetadataAgencyMismatch({
        currentAgencyName: rawAgencyName,
        additionalDetails: row.additional_details,
    });

    let agencyName = rawAgencyName;

    if ((!agencyName || isGenericAgencyLabel(agencyName)) && metadataAgencyHint?.name) {
        agencyName = metadataAgencyHint.name;
    }

    if (metadataAgencyMismatch?.expectedAgencyName) {
        agencyName = metadataAgencyMismatch.expectedAgencyName;
    }

    agencyName = String(agencyName || '').trim();
    if (!agencyName || isGenericAgencyLabel(agencyName)) {
        return null;
    }

    return {
        name: agencyName,
        state: metadataAgencyMismatch?.expectedState
            || metadataAgencyHint?.state
            || deriveDisplayState(row.case_state, agencyName)
            || null,
    };
}

function departmentKey(identity) {
    return `${identity.name}::${identity.state || ''}`;
}

function sortByField(rows, field, { desc = true } = {}) {
    return [...rows].sort((a, b) => {
        const aValue = a[field];
        const bValue = b[field];
        if (aValue == null && bValue == null) return b.total_cases - a.total_cases;
        if (aValue == null) return 1;
        if (bValue == null) return -1;
        if (aValue === bValue) return b.total_cases - a.total_cases;
        return desc ? bValue - aValue : aValue - bValue;
    });
}

class DashboardService {
    /**
     * Get comprehensive KPI metrics for the autonomous FOIA bot
     */
    async getKPIMetrics() {
        try {
            const metrics = await Promise.all([
                this.getTotalCounts(),
                this.getMessageStats(),
                this.getResponseRates(),
                this.getDenialStats(),
                this.getAutoReplyStats(),
                this.getRecentActivity(),
                this.getStatusBreakdown(),
                this.getStateBreakdown(),
                this.getPerformanceMetrics()
            ]);

            return {
                totals: metrics[0],
                messages: metrics[1],
                responses: metrics[2],
                denials: metrics[3],
                autoReplies: metrics[4],
                recentActivity: metrics[5],
                statusBreakdown: metrics[6],
                stateBreakdown: metrics[7],
                performance: metrics[8],
                lastUpdated: new Date()
            };
        } catch (error) {
            console.error('Error getting KPI metrics:', error);
            throw error;
        }
    }

    /**
     * Total counts
     */
    async getTotalCounts() {
        const result = await db.query(`
            SELECT
                (SELECT COUNT(*) FROM cases) as total_cases,
                (SELECT COUNT(*) FROM cases WHERE status = 'sent') as requests_sent,
                (SELECT COUNT(*) FROM messages WHERE direction = 'inbound') as responses_received,
                (SELECT COUNT(*) FROM messages WHERE message_type = 'auto_reply') as auto_replies_sent,
                (SELECT COUNT(*) FROM response_analysis WHERE intent = 'denial') as denials_received,
                (SELECT COUNT(*) FROM email_threads WHERE status = 'active') as active_threads
        `);
        return result.rows[0];
    }

    /**
     * Message statistics (last 7/30 days)
     */
    async getMessageStats() {
        const result = await db.query(`
            SELECT
                COUNT(*) FILTER (WHERE direction = 'outbound' AND sent_at >= NOW() - INTERVAL '7 days') as sent_last_7_days,
                COUNT(*) FILTER (WHERE direction = 'outbound' AND sent_at >= NOW() - INTERVAL '30 days') as sent_last_30_days,
                COUNT(*) FILTER (WHERE direction = 'inbound' AND received_at >= NOW() - INTERVAL '7 days') as received_last_7_days,
                COUNT(*) FILTER (WHERE direction = 'inbound' AND received_at >= NOW() - INTERVAL '30 days') as received_last_30_days,
                COUNT(*) FILTER (WHERE message_type = 'auto_reply' AND sent_at >= NOW() - INTERVAL '7 days') as auto_replies_last_7_days,
                COUNT(*) FILTER (WHERE message_type = 'auto_reply' AND sent_at >= NOW() - INTERVAL '30 days') as auto_replies_last_30_days
            FROM messages
        `);
        return result.rows[0];
    }

    /**
     * Response rates and timing
     */
    async getResponseRates() {
        const result = await db.query(`
            SELECT
                COUNT(*) FILTER (WHERE status IN ('responded', 'completed')) as cases_with_responses,
                COUNT(*) FILTER (WHERE status = 'sent') as cases_awaiting_response,
                COUNT(*) FILTER (WHERE status = 'sent' AND send_date < NOW() - INTERVAL '7 days') as overdue_cases,
                ROUND(AVG(
                    EXTRACT(EPOCH FROM (last_response_date - send_date)) / 86400
                )::numeric, 1) as avg_response_time_days
            FROM cases
            WHERE status IN ('sent', 'responded', 'completed')
        `);
        return result.rows[0];
    }

    /**
     * Denial statistics by subtype
     */
    async getDenialStats() {
        const result = await db.query(`
            SELECT
                COUNT(*) as total_denials,
                COUNT(*) FILTER (WHERE full_analysis_json->>'denial_subtype' = 'overly_broad') as overly_broad,
                COUNT(*) FILTER (WHERE full_analysis_json->>'denial_subtype' = 'ongoing_investigation') as ongoing_investigation,
                COUNT(*) FILTER (WHERE full_analysis_json->>'denial_subtype' = 'no_records') as no_records,
                COUNT(*) FILTER (WHERE full_analysis_json->>'denial_subtype' = 'privacy_exemption') as privacy_exemption,
                COUNT(*) FILTER (WHERE full_analysis_json->>'denial_subtype' = 'excessive_fees') as excessive_fees,
                COUNT(*) FILTER (WHERE full_analysis_json->>'denial_subtype' = 'wrong_agency') as wrong_agency
            FROM response_analysis
            WHERE intent = 'denial'
        `);
        return result.rows[0];
    }

    /**
     * Auto-reply statistics
     */
    async getAutoReplyStats() {
        const result = await db.query(`
            SELECT
                COUNT(*) FILTER (WHERE status = 'sent') as sent,
                COUNT(*) FILTER (WHERE status = 'pending') as pending,
                COUNT(*) FILTER (WHERE requires_approval = true) as requiring_approval,
                ROUND(AVG(confidence_score)::numeric, 2) as avg_confidence
            FROM auto_reply_queue
        `);
        return result.rows[0];
    }

    /**
     * Recent activity (last 50 events)
     */
    async getRecentActivity() {
        const result = await db.query(`
            SELECT
                al.id,
                al.event_type,
                al.description,
                al.created_at,
                al.case_id,
                al.metadata,
                c.case_name,
                c.agency_name,
                m.direction,
                m.message_type,
                m.subject
            FROM activity_log al
            LEFT JOIN cases c ON al.case_id = c.id
            LEFT JOIN messages m ON al.message_id = m.id
            ORDER BY al.created_at DESC
            LIMIT 50
        `);
        return result.rows;
    }

    /**
     * Case status breakdown
     */
    async getStatusBreakdown() {
        const result = await db.query(`
            SELECT
                status,
                COUNT(*) as count,
                ROUND(COUNT(*) * 100.0 / SUM(COUNT(*)) OVER (), 1) as percentage
            FROM cases
            GROUP BY status
            ORDER BY count DESC
        `);
        return result.rows;
    }

    /**
     * State breakdown
     */
    async getStateBreakdown() {
        const result = await db.query(`
            SELECT
                c.state,
                sd.state_name,
                COUNT(*) as total_cases,
                COUNT(*) FILTER (WHERE c.status = 'sent') as sent,
                COUNT(*) FILTER (WHERE c.status = 'responded') as responded
            FROM cases c
            LEFT JOIN state_deadlines sd ON c.state = sd.state_code
            GROUP BY c.state, sd.state_name
            ORDER BY total_cases DESC
        `);
        return result.rows;
    }

    /**
     * Performance metrics
     */
    async getPerformanceMetrics() {
        const result = await db.query(`
            SELECT
                COUNT(*) FILTER (WHERE ra.intent = 'denial' AND arq.id IS NOT NULL) as denials_with_auto_reply,
                COUNT(*) FILTER (WHERE ra.intent = 'denial') as total_denials,
                ROUND(
                    COUNT(*) FILTER (WHERE ra.intent = 'denial' AND arq.id IS NOT NULL)::numeric * 100.0 /
                    NULLIF(COUNT(*) FILTER (WHERE ra.intent = 'denial'), 0),
                    1
                ) as auto_reply_coverage_pct
            FROM response_analysis ra
            LEFT JOIN auto_reply_queue arq ON ra.message_id = arq.message_id
        `);
        return result.rows[0];
    }

    /**
     * Get latest messages sent by the bot
     */
    async getLatestBotMessages(limit = 20) {
        const result = await db.query(`
            SELECT
                m.id,
                m.message_type,
                m.subject,
                m.body_text,
                m.to_email,
                m.sent_at,
                c.case_name,
                c.agency_name,
                c.subject_name,
                ra.intent as response_intent,
                ra.full_analysis_json->>'denial_subtype' as denial_subtype
            FROM messages m
            LEFT JOIN cases c ON m.case_id = c.id
            LEFT JOIN response_analysis ra ON ra.message_id = (
                SELECT id FROM messages
                WHERE thread_id = m.thread_id
                AND direction = 'inbound'
                AND received_at < m.sent_at
                ORDER BY received_at DESC
                LIMIT 1
            )
            WHERE m.direction = 'outbound'
            ORDER BY m.sent_at DESC
            LIMIT $1
        `, [limit]);
        return result.rows;
    }

    /**
     * Get hourly activity for the last 24 hours
     */
    async getHourlyActivity() {
        const result = await db.query(`
            SELECT
                date_trunc('hour', created_at) as hour,
                event_type,
                COUNT(*) as count
            FROM activity_log
            LEFT JOIN cases c ON c.id = activity_log.case_id
            WHERE created_at >= NOW() - INTERVAL '24 hours'
              AND (activity_log.case_id IS NULL OR ${buildRealCaseWhereClause('c')})
            GROUP BY date_trunc('hour', created_at), event_type
            ORDER BY hour DESC
        `);
        return result.rows;
    }

    /**
     * Get daily message volume (inbound vs outbound) for the last 30 days
     */
    async getMessageVolumeByDay() {
        const result = await db.query(`
            WITH days AS (
                SELECT generate_series(
                    (CURRENT_DATE - INTERVAL '29 days')::date,
                    CURRENT_DATE,
                    '1 day'::interval
                )::date AS day
            )
            SELECT
                d.day,
                COALESCE(SUM(CASE WHEN m.direction = 'inbound' THEN 1 ELSE 0 END), 0)::int AS inbound,
                COALESCE(SUM(CASE WHEN m.direction = 'outbound' THEN 1 ELSE 0 END), 0)::int AS outbound
            FROM days d
            LEFT JOIN messages m ON (
                (m.direction = 'inbound' AND m.received_at::date = d.day)
                OR (m.direction = 'outbound' AND m.sent_at::date = d.day)
            )
            LEFT JOIN cases c ON c.id = m.case_id
            WHERE m.id IS NULL OR ${buildRealCaseWhereClause('c')}
            GROUP BY d.day
            ORDER BY d.day
        `);

        const rows = result.rows;
        const totalInbound = rows.reduce((s, r) => s + r.inbound, 0);
        const totalOutbound = rows.reduce((s, r) => s + r.outbound, 0);
        const replyRate = totalInbound > 0
            ? Math.round((totalOutbound / totalInbound) * 100)
            : 0;

        return {
            days: rows,
            totalInbound,
            totalOutbound,
            replyRate
        };
    }

    /**
     * Per-department analytics leaderboards for the analytics dashboard.
     */
    async getDepartmentAnalytics({ limit = 10, minCases = 5, minReviews = 3 } = {}) {
        const result = await db.query(`
            SELECT
                c.id,
                c.agency_name AS case_agency_name,
                c.state AS case_state,
                c.status,
                c.send_date,
                c.last_response_date,
                c.deadline_date,
                c.additional_details,
                primary_ca.agency_name AS primary_agency_name,
                primary_ca.send_date AS primary_send_date,
                primary_ca.last_response_date AS primary_last_response_date,
                COALESCE(denials.has_denial, false) AS has_denial,
                COALESCE(reviews.total_reviews, 0)::int AS total_reviews,
                COALESCE(reviews.approve_count, 0)::int AS approve_count
            FROM cases c
            LEFT JOIN LATERAL (
                SELECT
                    ca.agency_name,
                    ca.send_date,
                    ca.last_response_date
                FROM case_agencies ca
                WHERE ca.case_id = c.id
                  AND ca.is_active = true
                ORDER BY ca.is_primary DESC, ca.updated_at DESC NULLS LAST, ca.id DESC
                LIMIT 1
            ) primary_ca ON true
            LEFT JOIN LATERAL (
                SELECT true AS has_denial
                FROM response_analysis ra
                JOIN messages m ON m.id = ra.message_id
                WHERE m.case_id = c.id
                  AND LOWER(COALESCE(ra.intent, '')) = 'denial'
                LIMIT 1
            ) denials ON true
            LEFT JOIN LATERAL (
                SELECT
                    COUNT(*) FILTER (
                        WHERE UPPER(COALESCE(p.human_decision->>'action', '')) IN ('APPROVE', 'ADJUST', 'DISMISS')
                    ) AS total_reviews,
                    COUNT(*) FILTER (
                        WHERE UPPER(COALESCE(p.human_decision->>'action', '')) = 'APPROVE'
                    ) AS approve_count
                FROM proposals p
                WHERE p.case_id = c.id
            ) reviews ON true
            WHERE ${buildRealCaseWhereClause('c')}
        `);

        const aggregates = new Map();
        const now = new Date();

        for (const row of result.rows) {
            const identity = resolveDepartmentIdentity(row);
            if (!identity) continue;

            const key = departmentKey(identity);
            const aggregate = aggregates.get(key) || {
                agency_name: identity.name,
                state: identity.state || null,
                total_cases: 0,
                sent_cases: 0,
                responded_cases: 0,
                completed_cases: 0,
                denied_cases: 0,
                open_cases: 0,
                overdue_cases: 0,
                total_reviews: 0,
                approve_count: 0,
                response_day_sum: 0,
                response_day_count: 0,
            };

            aggregate.total_cases += 1;

            const sendDate = row.primary_send_date || row.send_date || null;
            const responseDate = row.primary_last_response_date || row.last_response_date || null;
            const responseDays = diffDays(sendDate, responseDate);

            if (sendDate) {
                aggregate.sent_cases += 1;
            }
            if (responseDate) {
                aggregate.responded_cases += 1;
            }
            if (responseDays != null && responseDays >= 0) {
                aggregate.response_day_sum += responseDays;
                aggregate.response_day_count += 1;
            }
            if (String(row.status || '').toLowerCase() === 'completed') {
                aggregate.completed_cases += 1;
            }
            if (row.has_denial || String(row.status || '').toLowerCase() === 'denied') {
                aggregate.denied_cases += 1;
            }

            const isOpen = !isTerminalCaseStatus(row.status);
            if (isOpen) {
                aggregate.open_cases += 1;
            }

            if (
                isOpen
                && row.deadline_date
                && !responseDate
                && new Date(row.deadline_date).getTime() < now.getTime()
            ) {
                aggregate.overdue_cases += 1;
            }

            aggregate.total_reviews += Number(row.total_reviews) || 0;
            aggregate.approve_count += Number(row.approve_count) || 0;

            aggregates.set(key, aggregate);
        }

        const departments = Array.from(aggregates.values()).map((aggregate) => ({
            agency_name: aggregate.agency_name,
            state: aggregate.state,
            total_cases: aggregate.total_cases,
            sent_cases: aggregate.sent_cases,
            responded_cases: aggregate.responded_cases,
            completed_cases: aggregate.completed_cases,
            denied_cases: aggregate.denied_cases,
            open_cases: aggregate.open_cases,
            overdue_cases: aggregate.overdue_cases,
            total_reviews: aggregate.total_reviews,
            approve_count: aggregate.approve_count,
            response_rate: percent(aggregate.responded_cases, aggregate.sent_cases),
            avg_response_days: aggregate.response_day_count
                ? round1(aggregate.response_day_sum / aggregate.response_day_count)
                : null,
            completion_rate: percent(aggregate.completed_cases, aggregate.total_cases),
            denial_rate: percent(aggregate.denied_cases, aggregate.total_cases),
            overdue_rate: percent(aggregate.overdue_cases, aggregate.open_cases),
            approval_rate: percent(aggregate.approve_count, aggregate.total_reviews),
        }));

        const responseRateLeaders = sortByField(
            departments.filter((row) => row.sent_cases >= minCases && row.response_rate != null),
            'response_rate'
        ).slice(0, limit);

        const fastestResponseLeaders = sortByField(
            departments.filter((row) => row.responded_cases >= minCases && row.avg_response_days != null),
            'avg_response_days',
            { desc: false }
        ).slice(0, limit);

        const completionRateLeaders = sortByField(
            departments.filter((row) => row.total_cases >= minCases && row.completion_rate != null),
            'completion_rate'
        ).slice(0, limit);

        const approvalRateLeaders = sortByField(
            departments.filter((row) => row.total_reviews >= minReviews && row.approval_rate != null),
            'approval_rate'
        ).slice(0, limit);

        const highestDenialRate = sortByField(
            departments.filter((row) => row.total_cases >= minCases && row.denial_rate != null),
            'denial_rate'
        ).slice(0, limit);

        const mostOverdue = sortByField(
            departments.filter((row) => row.total_cases >= minCases && row.overdue_rate != null),
            'overdue_rate'
        ).slice(0, limit);

        return {
            departments_considered: departments.length,
            cases_considered: result.rows.length,
            sample_thresholds: {
                min_cases: minCases,
                min_reviews: minReviews,
            },
            leaderboards: {
                response_rate: responseRateLeaders,
                avg_response_time: fastestResponseLeaders,
                completion_rate: completionRateLeaders,
                approval_rate: approvalRateLeaders,
                denial_rate: highestDenialRate,
                overdue_rate: mostOverdue,
            },
            departments: sortByField(departments, 'total_cases').slice(0, Math.max(limit * 2, limit)),
        };
    }
}

module.exports = new DashboardService();
