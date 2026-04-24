-- Add GUC variable bypass to the BUGGED status protection trigger.
-- The PATCH endpoint (case-updates.js) needs to restore bugged cases to
-- needs_human_review/ready_to_send, but the trigger was blocking all strategies.
-- Setting app.allow_restore_from_bugged = 'true' in a transaction now allows
-- the PATCH to succeed without requiring superuser or table ownership.

CREATE OR REPLACE FUNCTION protect_bugged_status() RETURNS TRIGGER AS $$
BEGIN
    -- Allow explicit operator bypass via session-local GUC variable.
    -- SET LOCAL app.allow_restore_from_bugged = 'true' in a transaction allows
    -- the PATCH /api/requests/:id endpoint to restore a bugged case.
    IF current_setting('app.allow_restore_from_bugged', true) = 'true' THEN
        RETURN NEW;
    END IF;

    -- Otherwise, prevent any status change away from 'bugged'.
    IF OLD.status = 'bugged' AND NEW.status != 'bugged' THEN
        NEW.status = 'bugged';
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Replace any existing bugged-protection trigger on cases with this one.
-- Uses IF NOT EXISTS / OR REPLACE pattern to be idempotent.
DROP TRIGGER IF EXISTS trg_protect_bugged_status ON cases;

CREATE TRIGGER trg_protect_bugged_status
BEFORE UPDATE ON cases
FOR EACH ROW
EXECUTE FUNCTION protect_bugged_status();
