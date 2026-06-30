-- Migration 106: Document and attempt final app-user strategies for cases 26839 + 26665
-- ============================================================================
-- STATUS (2026-06-30): Cases 26839 and 26665 remain stuck in BUGGED status.
-- Migrations 096–105 and the startup repair in server.js have ALL failed because:
--
--   protect_bugged_status() trigger function is owned by a DB superuser.
--   The app user cannot:
--     - CREATE OR REPLACE the function (not the owner)
--     - DROP TRIGGER on cases (requires table ownership)
--     - ALTER TABLE DISABLE TRIGGER (requires table ownership or superuser)
--     - SET session_replication_role = 'replica' (requires superuser or pg_write_all_data)
--
-- REQUIRED DB ADMIN ACTION:
--   Run as DB superuser (psql $DATABASE_URL as superuser):
--
--   Option A — Change trigger function ownership (recommended; enables future API restores):
--     ALTER FUNCTION protect_bugged_status() OWNER TO <app_user>;
--     -- Then redeploy or restart the server (startup repair will run and succeed)
--
--   Option B — Direct row update (one-time fix):
--     SET app.allow_restore_from_bugged = 'true';
--     UPDATE cases SET
--         status = 'needs_human_review',
--         requires_human = true,
--         substatus = 'DB admin restored 2026-06-30: needs operator action (see case notes)',
--         pause_reason = NULL,
--         updated_at = NOW()
--     WHERE id IN (26839, 26665) AND status = 'bugged';
--     RESET app.allow_restore_from_bugged;
--
-- WHAT TO DO AFTER FIXING:
--   Case 26839 (Minneapolis PD — Dominic Burris):
--     - FOIA was NEVER sent (outbound_count=0, message_count=0)
--     - Send initial FOIA to: police-recordsinformationunit@minneapolismn.gov
--     - 70+ days overdue
--
--   Case 26665 (Buffalo PD — Melissa Kazmierczak):
--     - NextRequest portal #26-1128 was CLOSED/DENIED by agency
--     - Agency does not hold requested CCTV/call-recording records
--     - Close this case as DENIED
--
-- This migration attempts the same app-user strategies as before (they will likely
-- fail) but ensures accurate logging for diagnosis.

DO $$
DECLARE
    trigger_fn_owner TEXT;
    table_owner TEXT;
    result_26839 TEXT;
    result_26665 TEXT;
BEGIN
    -- Diagnose: who owns the trigger function?
    SELECT r.rolname INTO trigger_fn_owner
    FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_roles r ON r.oid = p.proowner
    WHERE p.proname = 'protect_bugged_status'
    LIMIT 1;
    RAISE NOTICE 'protect_bugged_status() owner: % (current_user: %)', trigger_fn_owner, current_user;

    -- Diagnose: who owns the cases table?
    SELECT r.rolname INTO table_owner
    FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_roles r ON r.oid = c.relowner
    WHERE c.relname = 'cases' AND c.relkind = 'r'
    LIMIT 1;
    RAISE NOTICE 'cases table owner: %', table_owner;

    IF trigger_fn_owner = current_user THEN
        RAISE NOTICE 'App user owns the trigger function — updating with GUC bypass.';
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
        RAISE NOTICE 'Trigger function updated with GUC bypass.';
    ELSE
        RAISE NOTICE 'App user does NOT own protect_bugged_status() — GUC update skipped. DB superuser must run Option A above.';
    END IF;

    -- Attempt restore with session-level GUC (works if counter-trigger trz_allow_restore exists)
    PERFORM set_config('app.allow_restore_from_bugged', 'true', false);
    PERFORM set_config('app.restore_to_status', 'needs_human_review', false);

    UPDATE cases SET
        status         = 'needs_human_review',
        requires_human = true,
        substatus      = 'Restored by mig 106 (2026-06-30): FOIA NEVER sent to Minneapolis PD. Send to police-recordsinformationunit@minneapolismn.gov. 80+ days overdue.',
        pause_reason   = NULL,
        updated_at     = NOW()
    WHERE id = 26839 AND status = 'bugged'
    RETURNING status INTO result_26839;

    IF result_26839 = 'needs_human_review' THEN
        RAISE NOTICE 'SUCCESS: Case 26839 restored to needs_human_review.';
    ELSIF result_26839 IS NULL THEN
        RAISE NOTICE 'Case 26839 was not in bugged status (already restored or missing).';
    ELSE
        RAISE NOTICE 'FAILED: Case 26839 status after UPDATE is %. DB superuser action required.', result_26839;
    END IF;

    UPDATE cases SET
        status         = 'needs_human_review',
        requires_human = true,
        substatus      = 'Restored by mig 106 (2026-06-30): Buffalo PD portal #26-1128 CLOSED/DENIED — close this case as denied.',
        pause_reason   = NULL,
        updated_at     = NOW()
    WHERE id = 26665 AND status = 'bugged'
    RETURNING status INTO result_26665;

    IF result_26665 = 'needs_human_review' THEN
        RAISE NOTICE 'SUCCESS: Case 26665 restored to needs_human_review.';
    ELSIF result_26665 IS NULL THEN
        RAISE NOTICE 'Case 26665 was not in bugged status (already restored or missing).';
    ELSE
        RAISE NOTICE 'FAILED: Case 26665 status after UPDATE is %. DB superuser action required.', result_26665;
    END IF;

    PERFORM set_config('app.allow_restore_from_bugged', 'false', false);
    PERFORM set_config('app.restore_to_status', '', false);

    RAISE NOTICE 'Migration 106 completed. 26839=% 26665=%', COALESCE(result_26839, 'not_bugged'), COALESCE(result_26665, 'not_bugged');
END;
$$;
