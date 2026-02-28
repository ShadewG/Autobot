-- Expand allowed pause_reason values to cover case-runtime events.
-- Required for PR5 transitions (RESEARCH_HANDOFF, PORTAL_ABORTED) and
-- runtime failure fallback (AGENT_RUN_FAILED).

DO $$
BEGIN
    ALTER TABLE cases DROP CONSTRAINT IF EXISTS chk_pause_reason;

    ALTER TABLE cases ADD CONSTRAINT chk_pause_reason
        CHECK (pause_reason IS NULL OR pause_reason IN (
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
            'RESEARCH_HANDOFF',
            'PORTAL_ABORTED',
            'AGENT_RUN_FAILED'
        ));
END $$;

