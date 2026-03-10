-- Migration 081: Backfill typed dismissal reasons on historical proposal decisions
--
-- This lets the circuit breaker and decision prompt distinguish:
-- - wrong_action
-- - reprocess
-- - superseded_by_manual_action
-- - stale_after_case_change
-- - system_auto_dismiss

UPDATE proposals
SET human_decision =
    CASE
        WHEN COALESCE(human_decision->>'dismissal_type', '') <> '' THEN human_decision
        WHEN COALESCE(human_decision->>'auto_dismiss_reason', '') = 'reset_to_last_inbound'
            THEN human_decision || '{"dismissal_type":"stale_after_case_change"}'::jsonb
        WHEN COALESCE(human_decision->>'auto_dismiss_reason', '') <> ''
            THEN human_decision || '{"dismissal_type":"system_auto_dismiss"}'::jsonb
        WHEN LOWER(COALESCE(human_decision->>'supersededByAction', '')) = 'reprocess'
            OR LOWER(COALESCE(human_decision->>'reason', '')) LIKE '%reprocess%'
            THEN human_decision || '{"dismissal_type":"reprocess"}'::jsonb
        WHEN COALESCE(human_decision->>'supersededByAction', '') <> ''
            OR LOWER(COALESCE(human_decision->>'reason', '')) LIKE 'superseded by human review action:%'
            OR LOWER(COALESCE(human_decision->>'reason', '')) LIKE '%superseded%'
            THEN human_decision || '{"dismissal_type":"superseded_by_manual_action"}'::jsonb
        ELSE human_decision || '{"dismissal_type":"wrong_action"}'::jsonb
    END,
    updated_at = NOW()
WHERE status = 'DISMISSED'
  AND human_decision IS NOT NULL
  AND COALESCE(human_decision->>'dismissal_type', '') = '';
