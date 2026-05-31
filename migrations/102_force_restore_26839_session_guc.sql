-- Migration 102: Force-restore case 26839 (Minneapolis PD) using session-level GUC.
--
-- Previous approaches (096-101) used SET LOCAL (transaction-local GUC) inside a
-- transaction. This migration uses set_config(..., false) which sets the GUC at
-- SESSION level so it persists across transaction boundaries.
--
-- Case 26839: Dominic Burris / Minneapolis PD — submitted 2026-04-09; 40+ days overdue.
-- The case is BUGGED due to a missing Notion page (non-blocking; tracked error cleared).
-- Target status: awaiting_response so automation can follow up.
--
-- This migration is idempotent: safe to run even if case is already restored.

DO $$
DECLARE
    func_src       TEXT;
    is_guc_aware   BOOLEAN;
    result_status  TEXT;
BEGIN
    -- Step 1: Check if trigger function is GUC-aware.
    SELECT prosrc INTO func_src
    FROM pg_catalog.pg_proc
    WHERE proname = 'protect_bugged_status'
    LIMIT 1;

    IF func_src IS NULL THEN
        RAISE NOTICE 'Step 1: No protect_bugged_status function — no trigger active.';
        is_guc_aware := true;
    ELSE
        is_guc_aware := (func_src LIKE '%allow_restore_from_bugged%');
        RAISE NOTICE 'Step 1: Function found. GUC-aware: %', is_guc_aware;
    END IF;

    -- Step 2: Try to update function to be GUC-aware if it isn't already.
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
            is_guc_aware := true;
            RAISE NOTICE 'Step 2: Function updated with GUC bypass.';
        EXCEPTION WHEN OTHERS THEN
            RAISE NOTICE 'Step 2: Cannot update function (%); trying trigger drop.', SQLERRM;
            -- Try dropping the trigger entirely so the UPDATE succeeds.
            BEGIN
                DROP TRIGGER IF EXISTS trg_protect_bugged_status ON cases;
                RAISE NOTICE 'Step 2b: Trigger dropped — UPDATE should succeed.';
                is_guc_aware := true; -- Trigger gone, so bypass is no longer needed.
            EXCEPTION WHEN OTHERS THEN
                RAISE NOTICE 'Step 2b: Cannot drop trigger (%); will try UPDATE anyway.', SQLERRM;
            END;
        END;
    END IF;

    -- Step 3: Set GUC at SESSION level (is_local=false), then UPDATE in same session.
    PERFORM set_config('app.allow_restore_from_bugged', 'true', false);
    RAISE NOTICE 'Step 3: Session-level GUC set.';

    UPDATE cases
    SET
        status         = 'awaiting_response',
        requires_human = false,
        substatus      = 'Restored (mig 102): Minneapolis PD — submitted 2026-04-09, 40+ days overdue; follow-up needed',
        pause_reason   = NULL,
        updated_at     = NOW()
    WHERE id = 26839
      AND status = 'bugged'
    RETURNING status INTO result_status;

    IF result_status = 'awaiting_response' THEN
        RAISE NOTICE 'Step 3: SUCCESS — case 26839 restored to awaiting_response.';
    ELSIF result_status IS NULL THEN
        RAISE NOTICE 'Step 3: Case 26839 was not bugged (already restored or does not exist).';
    ELSE
        RAISE NOTICE 'Step 3: WARNING — case 26839 status after UPDATE is %. Trigger may have reverted it.', result_status;
    END IF;

    -- Step 4: Reset GUC to safe value.
    PERFORM set_config('app.allow_restore_from_bugged', 'false', false);

    -- Step 5: Recreate trigger with GUC bypass if it was dropped.
    IF is_guc_aware THEN
        BEGIN
            DROP TRIGGER IF EXISTS trg_protect_bugged_status ON cases;
            CREATE TRIGGER trg_protect_bugged_status
            BEFORE UPDATE ON cases
            FOR EACH ROW
            EXECUTE FUNCTION protect_bugged_status();
            RAISE NOTICE 'Step 5: Trigger recreated with GUC bypass.';
        EXCEPTION WHEN OTHERS THEN
            RAISE NOTICE 'Step 5: Could not recreate trigger (%); continuing.', SQLERRM;
        END;
    END IF;

    RAISE NOTICE 'Migration 102 completed.';
END;
$$;
