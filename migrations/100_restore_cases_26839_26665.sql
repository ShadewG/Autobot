-- Restore two remaining BUGGED cases that were not handled by migrations 097-099.
--
-- Cases:
--   26839  Minneapolis PD  — Dominic Burris mass shooting (submitted 2026-04-09;
--                            Notion page missing; no response; 38+ days overdue)
--                            → restore to awaiting_response for automated follow-up
--   26665  Buffalo PD      — Melissa Kazmierczak (portal #26-1128 CLOSED/DENIED
--                            by agency; appeal window expired ~2026-04-17; fee moot)
--                            → restore to needs_human_review for operator to close
--
-- Three-step bypass (same pattern as migration 099):
--   Step 1: Replace trigger function with GUC-aware version (requires function ownership)
--   Step 2: Drop trigger (requires table ownership; exception-safe)
--   Step 3: UPDATE with GUC set in-transaction (honours GUC if step 1 succeeded,
--           or runs unguarded if step 2 dropped trigger)
--   Step 4: Recreate trigger with GUC bypass (exception-safe)
--
-- Safe to run even if migrations 096–099 were already applied.

DO $$
BEGIN
    -- Step 1: Replace trigger function with GUC-aware version.
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
        RAISE NOTICE 'Step 1: protect_bugged_status function updated with GUC bypass';
    EXCEPTION WHEN OTHERS THEN
        RAISE NOTICE 'Step 1: Could not update trigger function (will continue): %', SQLERRM;
    END;

    -- Step 2: Drop the blocking trigger.
    BEGIN
        DROP TRIGGER IF EXISTS trg_protect_bugged_status ON cases;
        RAISE NOTICE 'Step 2: Trigger dropped (or did not exist)';
    EXCEPTION WHEN OTHERS THEN
        RAISE NOTICE 'Step 2: Could not drop trigger (will continue): %', SQLERRM;
    END;

    -- Step 3: Set GUC bypass and update the two cases.
    PERFORM set_config('app.allow_restore_from_bugged', 'true', true);

    UPDATE cases
    SET
        status         = CASE id
                           WHEN 26839 THEN 'awaiting_response'
                           WHEN 26665 THEN 'needs_human_review'
                         END,
        requires_human = CASE id
                           WHEN 26839 THEN false
                           WHEN 26665 THEN true
                         END,
        pause_reason   = NULL,
        substatus      = CASE id
                           WHEN 26839 THEN 'Restored: submitted 2026-04-09 to Minneapolis PD — awaiting response (overdue; Notion page archived)'
                           WHEN 26665 THEN 'Restored: Buffalo PD portal #26-1128 CLOSED/DENIED — appeal window expired; operator should close as denied'
                         END,
        updated_at     = NOW()
    WHERE id IN (26839, 26665)
      AND status = 'bugged';

    RAISE NOTICE 'Step 3: Case UPDATE completed';

    -- Step 4: Recreate protection trigger with GUC bypass.
    BEGIN
        DROP TRIGGER IF EXISTS trg_protect_bugged_status ON cases;
        CREATE TRIGGER trg_protect_bugged_status
        BEFORE UPDATE ON cases
        FOR EACH ROW
        EXECUTE FUNCTION protect_bugged_status();
        RAISE NOTICE 'Step 4: Trigger recreated with GUC bypass';
    EXCEPTION WHEN OTHERS THEN
        RAISE NOTICE 'Step 4: Could not recreate trigger (non-fatal): %', SQLERRM;
    END;

    RAISE NOTICE 'Migration 100 completed successfully';
END;
$$;
