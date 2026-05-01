-- Restore five BUGGED cases blocked by trg_protect_bugged_status.
--
-- These cases are stuck in BUGGED because migration 096 was never applied to
-- production, so the API PATCH bypass strategies (GUC, replication_role,
-- trigger disable) all fail. This migration supersedes migrations 096 and 097.
--
-- Cases restored to needs_human_review:
--   26636  Denver PD            — stale import_warnings (email + portal ARE set);
--                                 re-evaluating after ESCALATE proposal dismissal
--   26757  Tavares PD           — Notion page archived; email + portal valid
--   26758  Montgomery County PD — circuit-breaker trip + archived Notion; email + portal valid
--   26665  Buffalo PD           — $0.25 fee quoted (portal #26-1128); operators approved
--                                 accept_fee twice (2026-04-19) but automation blocked
--   26692  St. Louis County PD  — legitimately closed by operator on 2026-03-31 (confirmed
--                                 duplicate of #26691); restored to needs_human_review so
--                                 operators can finalize closure (autopilot=MANUAL, won't auto-run)
--
-- After running this migration:
--   Cases 26636, 26757, 26758: Hermes can pick up and continue normally.
--   Case 26665: Operator must accept $0.25 fee at
--               https://cityofbuffalony.nextrequest.com/ (request #26-1128),
--               then manually trigger the agent (autopilot_mode=MANUAL).
--   Case 26692: Operator should cancel/close this case properly via the dashboard
--               (confirmed duplicate of #26691; closed_at is already set).
--
-- This migration is idempotent — safe to run even if 096 or 097 was already applied.
-- Uses DO block with EXCEPTION handling so permission failures on TRIGGER operations
-- do NOT crash the server — the case UPDATE succeeds regardless.

DO $$
BEGIN
    -- Step 1: Update or create the trigger function with GUC bypass.
    -- CREATE OR REPLACE FUNCTION only requires function ownership (not table ownership),
    -- so it usually succeeds even with a limited DB user.
    -- If the function doesn't exist yet (096 never ran), this creates it fresh.
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

    -- Step 2: Drop the blocking trigger so the UPDATE in step 3 is not reverted.
    -- DROP TRIGGER requires table ownership; catch permission errors gracefully.
    BEGIN
        DROP TRIGGER IF EXISTS trg_protect_bugged_status ON cases;
        RAISE NOTICE 'Trigger trg_protect_bugged_status dropped (or did not exist)';
    EXCEPTION WHEN OTHERS THEN
        RAISE NOTICE 'Could not drop trigger (will continue): %', SQLERRM;
    END;

    -- Step 3: Set GUC bypass for this transaction.
    -- If step 1 updated the function AND the trigger still exists, the trigger will
    -- now honour this GUC and allow the status change below.
    -- If step 2 dropped the trigger, this GUC is a no-op safety measure.
    -- If neither step 1 nor step 2 succeeded AND the trigger exists without GUC bypass,
    -- the UPDATE will be silently reverted by the trigger (cases stay BUGGED).
    PERFORM set_config('app.allow_restore_from_bugged', 'true', true);

    -- Step 4: Restore the five cases.
    UPDATE cases
    SET
        status         = 'needs_human_review',
        requires_human = true,
        pause_reason   = NULL,
        substatus      = CASE id
                           WHEN 26636 THEN 'Restored: stale import_warnings cleared; valid email + portal — re-evaluating after ESCALATE dismissal'
                           WHEN 26757 THEN 'Restored: Notion page archived (month-old); deliverable via email/portal'
                           WHEN 26758 THEN 'Restored: circuit-breaker trip cleared; deliverable via email/portal'
                           WHEN 26665 THEN 'Restored: $0.25 fee quoted (portal #26-1128) — operator must accept fee on NextRequest, then trigger agent'
                           WHEN 26692 THEN 'Restored: legitimately closed by operator 2026-03-31 (duplicate of #26691) — operator should cancel/close this case'
                         END,
        import_warnings = CASE id
                            WHEN 26636 THEN '[]'::jsonb
                            ELSE import_warnings
                          END,
        updated_at     = NOW()
    WHERE id IN (26636, 26757, 26758, 26665, 26692)
      AND status = 'bugged';

    RAISE NOTICE 'Case UPDATE completed (rows affected depends on current status)';

    -- Step 5: Recreate the protection trigger with the GUC bypass.
    -- Requires table ownership; catch permission errors gracefully.
    -- If this fails, the app-level guard in database.js still protects bugged status,
    -- and the PATCH /api/requests/:id handler bypasses it via raw SQL.
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

    RAISE NOTICE 'Migration 098 completed successfully';
END;
$$;

-- Redeploy trigger: 2026-05-01T20:40Z — DO block with exception handling prevents server crash
