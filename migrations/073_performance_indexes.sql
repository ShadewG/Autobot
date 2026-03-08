-- Performance indexes for common query patterns
-- Identified from services/database.js, routes/api.js, routes/requests/case-management.js,
-- and services/quality-report-service.js

-- =============================================================================
-- activity_log: 7163 rows, heavily queried by case_id in LATERAL joins
-- (getHumanReviewCases, phone call queue, quality reports)
-- =============================================================================
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_activity_log_case_id
    ON activity_log (case_id, created_at DESC)
    WHERE case_id IS NOT NULL;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_activity_log_case_event_type
    ON activity_log (case_id, event_type, created_at DESC)
    WHERE case_id IS NOT NULL;

-- =============================================================================
-- messages: 455 rows (growing), queried by case_id+direction, sendgrid_message_id
-- =============================================================================

-- Composite index for getLatestInboundMessage, getLastOutboundTime,
-- and all LATERAL subqueries filtering by case_id+direction
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_messages_case_direction
    ON messages (case_id, direction, created_at DESC);

-- sendgrid_message_id lookup (email event processing, delivery status updates)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_messages_sendgrid_message_id
    ON messages (sendgrid_message_id)
    WHERE sendgrid_message_id IS NOT NULL;

-- =============================================================================
-- cases: 207 rows (growing), many dashboard/reporting queries
-- =============================================================================

-- Dashboard listing: ORDER BY created_at DESC LIMIT N
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_cases_created_at_desc
    ON cases (created_at DESC);

-- Human review & dead-end case queries: ORDER BY updated_at DESC
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_cases_updated_at_desc
    ON cases (updated_at DESC);

-- Compliance/outcomes dashboards: GROUP BY state, WHERE state IS NOT NULL
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_cases_state
    ON cases (state)
    WHERE state IS NOT NULL;

-- Agency intelligence fallback: WHERE agency_name = $1
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_cases_agency_name
    ON cases (agency_name)
    WHERE agency_name IS NOT NULL;

-- Quality report: WHERE closed_at > NOW() - interval
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_cases_closed_at
    ON cases (closed_at DESC)
    WHERE closed_at IS NOT NULL;

-- Batch status: WHERE tags @> ARRAY[$1]::text[]
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_cases_tags
    ON cases USING gin (tags)
    WHERE tags IS NOT NULL;

-- Overdue cases: WHERE deadline_date < NOW() AND last_response_date IS NULL
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_cases_deadline_date
    ON cases (deadline_date)
    WHERE deadline_date IS NOT NULL AND last_response_date IS NULL;

-- =============================================================================
-- proposals: 681 rows, queried by created_at, human_decided_at
-- =============================================================================

-- Sorted listing per case: ORDER BY created_at DESC
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_proposals_case_created
    ON proposals (case_id, created_at DESC);

-- Quality report: WHERE human_decided_at > NOW() - interval
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_proposals_human_decided_at
    ON proposals (human_decided_at DESC)
    WHERE human_decided_at IS NOT NULL;

-- Human review queue: WHERE status = 'PENDING_APPROVAL' AND requires_human = true
-- ORDER BY created_at DESC
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_proposals_pending_human
    ON proposals (created_at DESC)
    WHERE status = 'PENDING_APPROVAL' AND requires_human = true;

-- =============================================================================
-- auto_reply_queue: queried by case_id+status
-- =============================================================================
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_auto_reply_queue_case_status
    ON auto_reply_queue (case_id, status);

-- =============================================================================
-- response_analysis: 179 rows, queried by intent for denial analysis
-- =============================================================================
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_response_analysis_intent
    ON response_analysis (intent)
    WHERE intent IS NOT NULL;

-- Case-level analysis lookup with sort: WHERE case_id ORDER BY created_at DESC
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_response_analysis_case_created
    ON response_analysis (case_id, created_at DESC)
    WHERE case_id IS NOT NULL;

-- =============================================================================
-- executions: 302 rows, frequently queried by case_id with sort
-- =============================================================================
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_executions_case_created
    ON executions (case_id, created_at DESC);

-- =============================================================================
-- attachments: 137 rows, joined on message_id in quality reports and exports
-- =============================================================================
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_attachments_message_id
    ON attachments (message_id);

-- =============================================================================
-- eval_runs: queried by ran_at for quality reports
-- =============================================================================
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_eval_runs_ran_at
    ON eval_runs (ran_at DESC);
