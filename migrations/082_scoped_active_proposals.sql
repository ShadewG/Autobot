DROP INDEX IF EXISTS idx_proposals_one_active_per_case;

CREATE UNIQUE INDEX IF NOT EXISTS idx_proposals_one_active_per_case_scope
    ON proposals (case_id, COALESCE(case_agency_id, -1))
    WHERE status IN ('PENDING_APPROVAL', 'BLOCKED', 'DECISION_RECEIVED', 'PENDING_PORTAL');
