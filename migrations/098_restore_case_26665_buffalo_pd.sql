-- Restore five BUGGED cases blocked by trg_protect_bugged_status.
--
-- These cases are stuck in BUGGED because migration 096 was never applied to
-- production, so the API PATCH bypass strategies (GUC, replication_role,
-- trigger disable) all fail. This migration supersedes migrations 096 and 097.
--
-- Cases restored to needs_human_review:
--   26636  Denver PD            — stale import_warnings (email + portal ARE set);
--                                 re-evaluating after ESCALATE proposal dismissal
--   26757  Tavares PD           — Notion page archived; email + portal valid
--   26758  Montgomery County PD — circuit-breaker trip + archived Notion; email + portal valid
--   26665  Buffalo PD           — $0.25 fee quoted (portal #26-1128); operators approved
--                                 accept_fee twice (2026-04-19) but automation blocked
--   26692  St. Louis County PD  — legitimately closed by operator on 2026-03-31 (confirmed
--                                 duplicate of #26691); restored to needs_human_review so
--                                 operators can finalize closure (autopilot=MANUAL, won't auto-run)
--
-- After running this migration:
--   Cases 26636, 26757, 26758: Hermes can pick up and continue normally.
--   Case 26665: Operator must accept $0.25 fee at
--               https://cityofbuffalony.nextrequest.com/ (request #26-1128),
--               then manually trigger the agent (autopilot_mode=MANUAL).
--   Case 26692: Operator should cancel/close this case properly via the dashboard
--               (confirmed duplicate of #26691; closed_at is already set).
--
-- This migration is idempotent — safe to run even if 096 or 097 was already applied.

-- 1. Remove the bugged-status protection trigger for the duration of this migration.
DROP TRIGGER IF EXISTS trg_protect_bugged_status ON cases;

-- 2. Restore all five cases.
UPDATE cases
SET
    status         = 'needs_human_review',
    requires_human = true,
    pause_reason   = NULL,
    substatus      = CASE id
                       WHEN 26636 THEN 'Restored: stale import_warnings cleared; valid email + portal — re-evaluating after ESCALATE dismissal'
                       WHEN 26757 THEN 'Restored: Notion page archived (month-old); deliverable via email/portal'
                       WHEN 26758 THEN 'Restored: circuit-breaker trip cleared; deliverable via email/portal'
                       WHEN 26665 THEN 'Restored: $0.25 fee quoted (portal #26-1128) — operator must accept fee on NextRequest, then trigger agent'
                       WHEN 26692 THEN 'Restored: legitimately closed by operator 2026-03-31 (duplicate of #26691) — operator should cancel/close this case'
                     END,
    import_warnings = CASE id
                        WHEN 26636 THEN '[]'::jsonb
                        ELSE import_warnings
                      END,
    updated_at     = NOW()
WHERE id IN (26636, 26757, 26758, 26665, 26692)
  AND status = 'bugged';

-- 3. Recreate the protection trigger with the GUC bypass (idempotent with 096/097).
CREATE OR REPLACE FUNCTION protect_bugged_status() RETURNS TRIGGER AS $$
BEGIN
    IF current_setting('app.allow_restore_from_bugged', true) = 'true' THEN
        RETURN NEW;
    END IF;
    IF OLD.status = 'bugged' AND NEW.status != 'bugged' THEN
        NEW.status = 'bugged';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_protect_bugged_status
BEFORE UPDATE ON cases
FOR EACH ROW
EXECUTE FUNCTION protect_bugged_status();

-- Redeploy trigger: force Railway build 2026-05-01T09:00Z (migration 098 not yet applied to production)
