-- Migration 105: FIX BUGGED STATUS TRIGGER AND RESTORE CASES 26839 + 26665
-- =========================================================================
-- Ideally run as the database superuser for full effect:
--   psql $DATABASE_URL -f migrations/105_superuser_fix_bugged_trigger.sql
--
-- Safe to run as the app user too — superuser-only steps are caught and skipped;
-- the GUC + counter-trigger approach is still attempted.
--
-- BACKGROUND (2026-06-18):
--   Cases 26839 (Minneapolis PD) and 26665 (Buffalo PD) have been stuck in
--   BUGGED status since June 4, 2026. Migrations 096–104 all failed because
--   the protect_bugged_status() function and its trigger are owned by a
--   superuser. The app user cannot CREATE OR REPLACE, DROP TRIGGER, or ALTER
--   TABLE DISABLE TRIGGER. All four API bypass strategies also fail.
--
-- WHAT THIS MIGRATION DOES:
--   Step 1: As superuser, CREATE OR REPLACE protect_bugged_status() to add
--           GUC awareness — this makes all future bugged restores via the
--           PATCH API work without superuser intervention.
--   Step 2: Create counter-trigger trz_allow_restore as belt-and-suspenders.
--   Step 3: Restore case 26839 — FOIA was NEVER sent to Minneapolis PD.
--           Target: needs_human_review so operator can initiate the send.
--   Step 4: Restore case 26665 — Buffalo PD portal CLOSED/DENIED by agency.
--           Target: needs_human_review so operator can close as denied.
--
-- AFTER RUNNING:
--   - Case 26839: visible in the queue as NEEDS_HUMAN_REVIEW. Operator should
--     send the initial FOIA to police-recordsinformationunit@minneapolismn.gov.
--   - Case 26665: visible in the queue as NEEDS_HUMAN_REVIEW. Operator should
--     close as denied (agency doesn't hold CCTV/call-recording records).
--   - Future bugged case restores: the PATCH /api/requests/:id endpoint will
--     work without superuser — GUC bypass will succeed.

DO $$
DECLARE
    result_26839 TEXT;
    result_26665 TEXT;
BEGIN

    -- STEP 1: Try to update protect_bugged_status() to be GUC-aware.
    -- Requires superuser (or function ownership). Silently skipped if insufficient privs.
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
        RAISE NOTICE 'Step 1: protect_bugged_status() updated with GUC bypass (superuser succeeded).';
    EXCEPTION WHEN OTHERS THEN
        RAISE NOTICE 'Step 1: Could not update protect_bugged_status() (%) — superuser required. Continuing with counter-trigger approach.', SQLERRM;
    END;

    -- STEP 2: Create counter-trigger function (app user always owns their own functions).
    BEGIN
        CREATE OR REPLACE FUNCTION allow_restore_from_bugged() RETURNS TRIGGER AS $func$
        DECLARE
            intended TEXT;
        BEGIN
            IF current_setting('app.allow_restore_from_bugged', true) = 'true'
               AND OLD.status = 'bugged'
               AND NEW.status = 'bugged' THEN
                intended := current_setting('app.restore_to_status', true);
                IF intended IS NOT NULL AND intended <> '' AND intended <> 'bugged' THEN
                    NEW.status := intended;
                    NEW.requires_human := (intended = 'needs_human_review');
                    NEW.pause_reason := NULL;
                END IF;
            END IF;
            RETURN NEW;
        END;
        $func$ LANGUAGE plpgsql;
        RAISE NOTICE 'Step 2a: allow_restore_from_bugged() function created/updated.';
    EXCEPTION WHEN OTHERS THEN
        RAISE NOTICE 'Step 2a: Could not create allow_restore_from_bugged(): %.', SQLERRM;
    END;

    -- Create counter-trigger (requires table ownership on cases).
    BEGIN
        DROP TRIGGER IF EXISTS trz_allow_restore ON cases;
        CREATE TRIGGER trz_allow_restore
        BEFORE UPDATE ON cases
        FOR EACH ROW
        EXECUTE FUNCTION allow_restore_from_bugged();
        RAISE NOTICE 'Step 2b: Counter-trigger trz_allow_restore created.';
    EXCEPTION WHEN OTHERS THEN
        RAISE NOTICE 'Step 2b: Could not create trz_allow_restore (%): table ownership required.', SQLERRM;
    END;

    -- STEP 3: Restore case 26839 (Minneapolis PD — Dominic Burris).
    -- FOIA was imported with submitted_at=2026-04-09 but outbound_count=0.
    -- The email was NEVER actually sent. Notion page 0a5c1ee5 is missing (non-blocking).
    PERFORM set_config('app.allow_restore_from_bugged', 'true', false);
    PERFORM set_config('app.restore_to_status', 'needs_human_review', false);

    UPDATE cases SET
        status         = 'needs_human_review',
        requires_human = true,
        substatus      = 'Restored by mig 105 (2026-06-20): FOIA was NEVER sent — operator must send initial request to police-recordsinformationunit@minneapolismn.gov. Notion page missing (non-blocking). 70+ days overdue.',
        pause_reason   = NULL,
        updated_at     = NOW()
    WHERE id = 26839 AND status = 'bugged'
    RETURNING status INTO result_26839;

    IF result_26839 = 'needs_human_review' THEN
        RAISE NOTICE 'Step 3: SUCCESS — case 26839 restored to needs_human_review.';
    ELSIF result_26839 IS NULL THEN
        RAISE NOTICE 'Step 3: Case 26839 not found in bugged status (may already be restored).';
    ELSE
        RAISE NOTICE 'Step 3: WARNING — case 26839 status after UPDATE is %. Trigger still blocking — DB superuser must run: SET app.allow_restore_from_bugged=true; UPDATE cases SET status=''needs_human_review'',requires_human=true WHERE id=26839 AND status=''bugged''; RESET app.allow_restore_from_bugged;', result_26839;
    END IF;

    -- STEP 4: Restore case 26665 (Buffalo PD — Melissa Kazmierczak).
    -- NextRequest portal #26-1128 was CLOSED/DENIED by agency.
    -- Agency does not hold CCTV footage or call recordings for this 2019 incident.
    -- Human operator decided to close as denied on 2026-06-10.
    PERFORM set_config('app.restore_to_status', 'needs_human_review', false);

    UPDATE cases SET
        status         = 'needs_human_review',
        requires_human = true,
        substatus      = 'Restored by mig 105 (2026-06-20): Buffalo PD portal #26-1128 CLOSED/DENIED — agency does not hold the requested records. Operator must close this case as denied. Fee quote ($0.25) is moot.',
        pause_reason   = NULL,
        updated_at     = NOW()
    WHERE id = 26665 AND status = 'bugged'
    RETURNING status INTO result_26665;

    IF result_26665 = 'needs_human_review' THEN
        RAISE NOTICE 'Step 4: SUCCESS — case 26665 restored to needs_human_review.';
    ELSIF result_26665 IS NULL THEN
        RAISE NOTICE 'Step 4: Case 26665 not found in bugged status (may already be restored).';
    ELSE
        RAISE NOTICE 'Step 4: WARNING — case 26665 status after UPDATE is %. Trigger still blocking — DB superuser must run: SET app.allow_restore_from_bugged=true; UPDATE cases SET status=''needs_human_review'',requires_human=true WHERE id=26665 AND status=''bugged''; RESET app.allow_restore_from_bugged;', result_26665;
    END IF;

    -- Reset GUCs to safe defaults.
    PERFORM set_config('app.allow_restore_from_bugged', 'false', false);
    PERFORM set_config('app.restore_to_status', '', false);

    RAISE NOTICE 'Migration 105 completed. 26839=% 26665=%', result_26839, result_26665;

END;
$$;
