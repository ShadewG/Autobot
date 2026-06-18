-- Migration 105: FIX BUGGED STATUS TRIGGER AND RESTORE CASES 26839 + 26665
-- =========================================================================
-- REQUIRES SUPERUSER — run as the database superuser:
--   psql $DATABASE_URL -f migrations/105_superuser_fix_bugged_trigger.sql
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
--   Step 2: Restore case 26839 — FOIA was NEVER sent to Minneapolis PD.
--           Target: needs_human_review so operator can initiate the send.
--   Step 3: Restore case 26665 — Buffalo PD portal CLOSED/DENIED by agency.
--           Target: needs_human_review so operator can close as denied.
--
-- AFTER RUNNING:
--   - Case 26839: visible in the queue as NEEDS_HUMAN_REVIEW. Operator should
--     send the initial FOIA to police-recordsinformationunit@minneapolismn.gov.
--   - Case 26665: visible in the queue as NEEDS_HUMAN_REVIEW. Operator should
--     close as denied (agency doesn't hold CCTV/call-recording records).
--   - Future bugged case restores: the PATCH /api/requests/:id endpoint will
--     work without superuser — GUC bypass will succeed.

BEGIN;

-- STEP 1: Update trigger function to be GUC-aware.
-- As superuser this will succeed even if previously blocked.
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

RAISE NOTICE 'Step 1: protect_bugged_status() updated with GUC bypass.';

-- Also create/replace the counter-trigger function from mig 104 (belt-and-suspenders).
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

-- Recreate counter-trigger trz_allow_restore (fires after trg_protect_bugged_status).
DROP TRIGGER IF EXISTS trz_allow_restore ON cases;
CREATE TRIGGER trz_allow_restore
BEFORE UPDATE ON cases
FOR EACH ROW
EXECUTE FUNCTION allow_restore_from_bugged();

RAISE NOTICE 'Step 1b: Counter-trigger trz_allow_restore created.';

-- STEP 2: Restore case 26839 (Minneapolis PD — Dominic Burris).
-- FOIA was imported with submitted_at=2026-04-09 but outbound_count=0.
-- The email was NEVER actually sent. Notion page 0a5c1ee5-... is missing (non-blocking).
SET app.allow_restore_from_bugged = 'true';

UPDATE cases SET
    status         = 'needs_human_review',
    requires_human = true,
    substatus      = 'Restored by DB admin (mig 105, 2026-06-18): FOIA was NEVER sent — operator must send initial request to police-recordsinformationunit@minneapolismn.gov. Notion page is missing (delete the notion_page_id field or recreate the page). Case is 70+ days overdue.',
    pause_reason   = NULL,
    updated_at     = NOW()
WHERE id = 26839 AND status = 'bugged';

RAISE NOTICE 'Step 2: Case 26839 restored — rows updated: %', FOUND;

-- STEP 3: Restore case 26665 (Buffalo PD — Melissa Kazmierczak).
-- NextRequest portal #26-1128 was CLOSED/DENIED by agency.
-- Agency does not hold CCTV footage or call recordings for this 2019 incident.
-- Operator action: close as denied.
UPDATE cases SET
    status         = 'needs_human_review',
    requires_human = true,
    substatus      = 'Restored by DB admin (mig 105, 2026-06-18): Buffalo PD portal #26-1128 CLOSED/DENIED — agency does not hold the requested records. Operator must close this case as denied. Fee quote ($0.25) is moot — records do not exist.',
    pause_reason   = NULL,
    updated_at     = NOW()
WHERE id = 26665 AND status = 'bugged';

RAISE NOTICE 'Step 3: Case 26665 restored — rows updated: %', FOUND;

RESET app.allow_restore_from_bugged;

COMMIT;

-- Verify the results:
SELECT id, status, substatus, updated_at
FROM cases
WHERE id IN (26839, 26665)
ORDER BY id;
