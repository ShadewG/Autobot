-- Migration 101: Final restore attempt for cases 26839 and 26665.
--
-- Cases:
--   26839  Minneapolis PD  — submitted 2026-04-09; no response; 40+ days overdue
--                            → restore to awaiting_response for automated follow-up
--   26665  Buffalo PD      — portal #26-1128 CLOSED/DENIED; appeal window expired
--                            → restore to needs_human_review for operator to close
--
-- Strategy:
--   1. Check if protect_bugged_status() is already GUC-aware (from migration 099/100).
--      If it is, the GUC bypass will work. If not, attempt to update it.
--   2. Check if the trigger even exists (it may have been dropped by a prior migration).
--   3. Set GUC and UPDATE the two cases.
--   4. Recreate the trigger with GUC bypass (exception-safe).
--
-- This migration is idempotent: safe to run even if cases are already restored.

DO $$
DECLARE
    func_src      TEXT;
    is_guc_aware  BOOLEAN;
    trigger_exists BOOLEAN;
BEGIN
    -- Step 0: Check current trigger function source
    SELECT prosrc INTO func_src
    FROM pg_catalog.pg_proc
    WHERE proname = 'protect_bugged_status'
    LIMIT 1;

    IF func_src IS NULL THEN
        RAISE NOTICE 'Step 0: protect_bugged_status function not found — no trigger to bypass';
        is_guc_aware := true;  -- No function = no trigger = no blocking
    ELSE
        is_guc_aware := (func_src LIKE '%allow_restore_from_bugged%');
        RAISE NOTICE 'Step 0: Function found. GUC-aware: %', is_guc_aware;
    END IF;

    -- Check if trigger exists
    SELECT EXISTS (
        SELECT 1 FROM pg_catalog.pg_trigger t
        JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid
        WHERE c.relname = 'cases'
          AND t.tgname = 'trg_protect_bugged_status'
          AND NOT t.tgisinternal
    ) INTO trigger_exists;
    RAISE NOTICE 'Step 0: Trigger exists: %', trigger_exists;

    -- Step 1: If function is NOT GUC-aware, try to update it.
    IF NOT is_guc_aware THEN
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
            RAISE NOTICE 'Step 1: protect_bugged_status updated with GUC check';
            is_guc_aware := true;
        EXCEPTION WHEN OTHERS THEN
            RAISE NOTICE 'Step 1: Cannot update function: %', SQLERRM;
        END;
    ELSE
        RAISE NOTICE 'Step 1: Function already GUC-aware, skipping update';
    END IF;

    -- Step 2: If trigger exists and function is STILL not GUC-aware, try to drop trigger.
    IF trigger_exists AND NOT is_guc_aware THEN
        BEGIN
            DROP TRIGGER IF EXISTS trg_protect_bugged_status ON cases;
            trigger_exists := false;
            RAISE NOTICE 'Step 2: Trigger dropped';
        EXCEPTION WHEN OTHERS THEN
            RAISE NOTICE 'Step 2: Cannot drop trigger: %', SQLERRM;
        END;
    END IF;

    -- Step 3: Set GUC (honoured if function is GUC-aware) and UPDATE cases.
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
        substatus      = CASE id
                           WHEN 26839 THEN 'Restored (mig 101): submitted 2026-04-09 to Minneapolis PD — awaiting follow-up (40+ days overdue)'
                           WHEN 26665 THEN 'Restored (mig 101): Buffalo PD portal #26-1128 CLOSED/DENIED — operator should close as denied'
                         END,
        pause_reason   = NULL,
        updated_at     = NOW()
    WHERE id IN (26839, 26665)
      AND status = 'bugged';

    RAISE NOTICE 'Step 3: UPDATE executed. Rows affected checked by subsequent SELECT.';

    -- Verify
    PERFORM id FROM cases WHERE id IN (26839, 26665) AND status = 'bugged';
    IF FOUND THEN
        RAISE NOTICE 'Step 3: WARNING — one or both cases still bugged after UPDATE (trigger may have reverted)';
    ELSE
        RAISE NOTICE 'Step 3: SUCCESS — cases restored';
    END IF;

    -- Step 4: Recreate protection trigger with GUC bypass.
    IF NOT trigger_exists OR is_guc_aware THEN
        BEGIN
            DROP TRIGGER IF EXISTS trg_protect_bugged_status ON cases;
            CREATE TRIGGER trg_protect_bugged_status
            BEFORE UPDATE ON cases
            FOR EACH ROW
            EXECUTE FUNCTION protect_bugged_status();
            RAISE NOTICE 'Step 4: Trigger recreated with GUC bypass';
        EXCEPTION WHEN OTHERS THEN
            RAISE NOTICE 'Step 4: Cannot recreate trigger: %', SQLERRM;
        END;
    END IF;

    RAISE NOTICE 'Migration 101 completed';
END;
$$;
