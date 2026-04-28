-- Restore specific BUGGED cases to needs_human_review.
--
-- Cases restored:
--   26636  Denver PD         — stuck after ESCALATE proposal dismissal; valid email + portal
--   26757  Tavares PD        — Notion page archived (month-old); valid email + portal
--   26758  Montgomery Co PD  — circuit-breaker trip + archived Notion; valid email + portal
--   26846  Colts Neck PD     — notion_service error (PG disk-full at 04:26 UTC); valid email + PDF form
--
-- Cases intentionally left in BUGGED (human decision needed):
--   26692  St. Louis County PD — operator closed the case; needs human review to properly close or re-open
--   26786  Baltimore PD        — confirmed duplicate of case #26764 (Taijah Addison / Baltimore PD); needs cancellation
--
-- Strategy: drop the protection trigger, perform the updates, then recreate the
-- GUC-aware trigger (same as migration 096).  This is safe because:
--   • DROP TRIGGER IF EXISTS is a no-op if migration 096 was never applied.
--   • The recreated trigger is identical to migration 096 and idempotent.

-- 1. Remove the bugged-status protection trigger for the duration of this migration.
DROP TRIGGER IF EXISTS trg_protect_bugged_status ON cases;

-- 2. Restore the four cases.
UPDATE cases
SET
    status         = 'needs_human_review',
    requires_human = true,
    pause_reason   = NULL,
    substatus      = CASE id
                       WHEN 26636 THEN 'Restored: was stuck after ESCALATE proposal dismissal'
                       WHEN 26757 THEN 'Restored: Notion page archived (month-old); deliverable via email/portal'
                       WHEN 26758 THEN 'Restored: circuit-breaker trip cleared; deliverable via email/portal'
                       WHEN 26846 THEN 'Restored: Notion disk-full error cleared; deliverable via email/PDF form'
                     END,
    -- Clear stale import_warnings for case 26636 (email + portal are both set,
    -- making the MISSING_EMAIL / MISSING_DELIVERY_PATH warnings factually wrong).
    import_warnings = CASE id
                        WHEN 26636 THEN '[]'::jsonb
                        ELSE import_warnings
                      END,
    updated_at     = NOW()
WHERE id IN (26636, 26757, 26758, 26846)
  AND status = 'bugged';

-- 3. Recreate the protection trigger with the GUC bypass (idempotent with 096).
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

-- Redeploy trigger: force Railway restart 2026-04-28T08:44Z
