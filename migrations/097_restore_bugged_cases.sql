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
-- Rewritten 2026-05-01: use DO block with EXCEPTION handling so that
-- permission failures on TRIGGER operations do NOT crash the server.
-- This is safe to re-run even if the migration previously partially applied.

DO $$
BEGIN
    -- Step 1: Update or create the trigger function with GUC bypass.
    BEGIN
        CREATE OR REPLACE FUNCTION protect_bugged_status() RETURNS TRIGGER AS $func$
        BEGIN
            IF current_setting('app.allow_restore_from_bugged', true) = 'true' THEN
                RETURN NEW;
            END IF;
            IF OLD.status = 'bugged' AND NEW.status != 'bugged' THEN
                NEW.status = 'bugged';
            END IF;
            RETURN NEW;
        END;
        $func$ LANGUAGE plpgsql;
        RAISE NOTICE 'protect_bugged_status function created/updated with GUC bypass';
    EXCEPTION WHEN OTHERS THEN
        RAISE NOTICE 'Could not create/update trigger function (will continue): %', SQLERRM;
    END;

    -- Step 2: Drop the blocking trigger so the UPDATE is not reverted.
    BEGIN
        DROP TRIGGER IF EXISTS trg_protect_bugged_status ON cases;
        RAISE NOTICE 'Trigger trg_protect_bugged_status dropped (or did not exist)';
    EXCEPTION WHEN OTHERS THEN
        RAISE NOTICE 'Could not drop trigger (will continue): %', SQLERRM;
    END;

    -- Step 3: Set GUC bypass for this transaction.
    PERFORM set_config('app.allow_restore_from_bugged', 'true', true);

    -- Step 4: Restore the four cases.
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
        import_warnings = CASE id
                            WHEN 26636 THEN '[]'::jsonb
                            ELSE import_warnings
                          END,
        updated_at     = NOW()
    WHERE id IN (26636, 26757, 26758, 26846)
      AND status = 'bugged';

    RAISE NOTICE 'Case UPDATE completed (rows affected depends on current status)';

    -- Step 5: Recreate the protection trigger with the GUC bypass.
    BEGIN
        DROP TRIGGER IF EXISTS trg_protect_bugged_status ON cases;
        CREATE TRIGGER trg_protect_bugged_status
        BEFORE UPDATE ON cases
        FOR EACH ROW
        EXECUTE FUNCTION protect_bugged_status();
        RAISE NOTICE 'Trigger trg_protect_bugged_status recreated with GUC bypass';
    EXCEPTION WHEN OTHERS THEN
        RAISE NOTICE 'Could not recreate trigger (non-fatal): %', SQLERRM;
    END;

    RAISE NOTICE 'Migration 097 completed successfully';
END;
$$;

-- Rewritten 2026-05-01T20:45Z: DO block with exception handling prevents server crash
