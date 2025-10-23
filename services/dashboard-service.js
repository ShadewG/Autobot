const db = require('./database');

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
            WHERE created_at >= NOW() - INTERVAL '24 hours'
            GROUP BY date_trunc('hour', created_at), event_type
            ORDER BY hour DESC
        `);
        return result.rows;
    }
}

module.exports = new DashboardService();
