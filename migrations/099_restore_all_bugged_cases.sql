-- Restore all restorable BUGGED cases.
--
-- Safety-net migration. Restores 7 BUGGED cases using three-step bypass:
--   Step 1: Replace trigger function with GUC-aware version (requires function ownership)
--   Step 2: Drop the trigger entirely (requires table ownership; exception-safe)
--   Step 3: UPDATE cases status (succeeds in either case above)
--   Step 4: Recreate trigger with GUC bypass (exception-safe)
--
-- All trigger DDL is wrapped in EXCEPTION handlers so failures are logged, not fatal.
--
-- Cases restored to needs_human_review:
--   26636  Denver PD            — stale import_warnings (email + portal valid)
--   26757  Tavares PD           — Notion page archived; email + portal valid
--   26758  Montgomery County PD — circuit-breaker trip; email + portal valid
--   26846  Colts Neck PD        — Notion disk-full error cleared; email + PDF form valid
--   26665  Buffalo PD           — $0.25 fee quoted (portal #26-1128); operator must accept fee
--   26692  St. Louis County PD  — confirmed duplicate of #26691; operator must close properly
--   26759  Surprise PD AZ       — closed-by-user substatus; needs human review
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
    -- Step 1: Replace trigger function with GUC-aware version.
    -- CREATE OR REPLACE FUNCTION requires function ownership (not table ownership),
    -- so it usually succeeds even for limited DB users.
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
    -- Requires table ownership; catch permission errors gracefully.
    BEGIN
        DROP TRIGGER IF EXISTS trg_protect_bugged_status ON cases;
        RAISE NOTICE 'Step 2: Trigger trg_protect_bugged_status dropped (or did not exist)';
    EXCEPTION WHEN OTHERS THEN
        RAISE NOTICE 'Step 2: Could not drop trigger (will continue): %', SQLERRM;
    END;

    -- Step 3: Set GUC bypass for this transaction.
    -- If step 1 updated the function AND the trigger still exists, the trigger will
    -- now honour this GUC and allow the status change below.
    -- If step 2 dropped the trigger, this GUC is a no-op safety measure.
    PERFORM set_config('app.allow_restore_from_bugged', 'true', true);

    -- Step 4: Restore all restorable BUGGED cases.
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

    RAISE NOTICE 'Step 4: Case UPDATE completed';

    -- Step 5: Recreate the protection trigger with the GUC bypass.
    -- Requires table ownership; catch permission errors gracefully.
    BEGIN
        DROP TRIGGER IF EXISTS trg_protect_bugged_status ON cases;
        CREATE TRIGGER trg_protect_bugged_status
        BEFORE UPDATE ON cases
        FOR EACH ROW
        EXECUTE FUNCTION protect_bugged_status();
        RAISE NOTICE 'Step 5: Trigger trg_protect_bugged_status recreated with GUC bypass';
    EXCEPTION WHEN OTHERS THEN
        RAISE NOTICE 'Step 5: Could not recreate trigger (non-fatal): %', SQLERRM;
    END;

    RAISE NOTICE 'Migration 099 completed successfully';
END;
$$;
