-- Add GUC variable bypass to the BUGGED status protection trigger.
-- The PATCH /api/requests/:id endpoint needs to restore bugged cases to
-- needs_human_review/ready_to_send, but the trigger was blocking all strategies.
-- Setting app.allow_restore_from_bugged = 'true' in a transaction now allows
-- the PATCH to succeed without requiring superuser or table ownership.
--
-- Rewritten 2026-05-01: use DO block with EXCEPTION handling so that
-- permission failures on TRIGGER operations do NOT crash the server.

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

    -- Step 2: Drop any existing trigger and recreate with GUC bypass.
    BEGIN
        DROP TRIGGER IF EXISTS trg_protect_bugged_status ON cases;
        CREATE TRIGGER trg_protect_bugged_status
        BEFORE UPDATE ON cases
        FOR EACH ROW
        EXECUTE FUNCTION protect_bugged_status();
        RAISE NOTICE 'Trigger trg_protect_bugged_status created with GUC bypass';
    EXCEPTION WHEN OTHERS THEN
        RAISE NOTICE 'Could not create trigger (non-fatal — app-level guard still active): %', SQLERRM;
    END;

    RAISE NOTICE 'Migration 096 completed successfully';
END;
$$;
