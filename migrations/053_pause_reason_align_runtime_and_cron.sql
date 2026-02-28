-- Align pause_reason constraint with runtime reducer + cron escalation values.
-- This supersedes prior pause_reason migrations with a complete allowlist.

DO $$
BEGIN
    ALTER TABLE cases DROP CONSTRAINT IF EXISTS chk_pause_reason;

    ALTER TABLE cases ADD CONSTRAINT chk_pause_reason
        CHECK (pause_reason IS NULL OR pause_reason IN (
            -- Existing decision/gating values
            'FEE_QUOTE',
            'SCOPE',
            'DENIAL',
            'ID_REQUIRED',
            'SENSITIVE',
            'CLOSE_ACTION',
            'TIMED_OUT',
            'PENDING_APPROVAL',
            'INITIAL_REQUEST',
            'EMAIL_FAILED',
            'LOOP_DETECTED',
            'CONFLICTING_SIGNALS',
            'UNSPECIFIED',

            -- Runtime reducer values
            'RESEARCH_HANDOFF',
            'PORTAL_ABORTED',
            'AGENT_RUN_FAILED',
            'EXECUTION_BLOCKED',
            'PORTAL_FAILED',
            'PORTAL_TIMED_OUT',
            'STUCK_PORTAL_TASK',
            'PORTAL_STUCK',

            -- PR6 cron escalation values
            'DEADLINE_CONTACT_CHANGED',
            'DEADLINE_PHONE_CALL',
            'DEADLINE_NO_CONTACT',
            'FEE_DECISION_NEEDED',
            'CLARIFICATION_NEEDED',
            'DENIAL_REBUTTAL_NEEDED',
            'PORTAL_REDIRECT',
            'EXECUTION_RETRY_EXHAUSTED'
        ));
END $$;

