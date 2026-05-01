-- Restore all restorable BUGGED cases.
--
-- This migration is a safety net: it restores all cases that are stuck in BUGGED
-- due to the trg_protect_bugged_status trigger or the app-level guard in database.js,
-- bypassing both via the GUC set_config approach within a single DO block transaction.
--
-- It intentionally contains NO trigger DDL (no DROP/CREATE TRIGGER) so it cannot
-- crash the server regardless of the DB user's permissions.
--
-- Cases restored to needs_human_review:
--   26636  Denver PD            — stale import_warnings (email + portal valid)
--   26757  Tavares PD           — Notion page archived; email + portal valid
--   26758  Montgomery County PD — circuit-breaker trip; email + portal valid
--   26846  Colts Neck PD        — Notion disk-full error cleared; email + PDF form valid
--   26665  Buffalo PD           — $0.25 fee quoted (portal #26-1128); operator must accept fee
--   26692  St. Louis County PD  — confirmed duplicate of #26691; operator must close properly
--   26759  Surprise PD AZ       — Closed by user substatus; needs human review
--
-- Case intentionally left in BUGGED (human cancellation required):
--   26786  Baltimore PD         — confirmed duplicate of #26764; needs cancellation
--
-- After running this migration:
--   Cases 26636, 26757, 26758, 26846: Hermes can pick up and continue normally.
--   Case 26665: Operator must accept $0.25 fee at
--               https://cityofbuffalony.nextrequest.com/ (request #26-1128),
--               then manually trigger the agent (autopilot_mode=MANUAL).
--   Case 26692: Operator should cancel/close via the dashboard
--               (confirmed duplicate of #26691; closed_at is already set; autopilot=MANUAL).
--   Case 26759: Operator should review and decide next action.
--
-- Safe to run even if migrations 096, 097, or 098 were already applied.

DO $$
BEGIN
    -- Set GUC to bypass trg_protect_bugged_status trigger (if it exists with GUC check).
    PERFORM set_config('app.allow_restore_from_bugged', 'true', true);

    -- Restore all restorable BUGGED cases in one UPDATE.
    UPDATE cases
    SET
        status         = 'needs_human_review',
        requires_human = true,
        pause_reason   = NULL,
        substatus      = CASE id
                           WHEN 26636 THEN 'Restored: stale import_warnings cleared; valid email + portal — re-evaluating after ESCALATE dismissal'
                           WHEN 26757 THEN 'Restored: Notion page archived (month-old); deliverable via email/portal'
                           WHEN 26758 THEN 'Restored: circuit-breaker trip cleared; deliverable via email/portal'
                           WHEN 26846 THEN 'Restored: Notion disk-full error cleared; deliverable via email/PDF form'
                           WHEN 26665 THEN 'Restored: $0.25 fee quoted (portal #26-1128) — operator must accept fee on NextRequest, then trigger agent'
                           WHEN 26692 THEN 'Restored: legitimately closed by operator 2026-03-31 (duplicate of #26691) — operator should cancel/close this case'
                           WHEN 26759 THEN 'Restored: closed-by-user substatus — needs human review'
                         END,
        import_warnings = CASE id
                            WHEN 26636 THEN '[]'::jsonb
                            ELSE import_warnings
                          END,
        updated_at     = NOW()
    WHERE id IN (26636, 26757, 26758, 26846, 26665, 26692, 26759)
      AND status = 'bugged';

    RAISE NOTICE 'Migration 099: case UPDATE completed';
END;
$$;
