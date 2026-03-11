-- Database-level dedup for cron activity log entries.
-- Prevents duplicate entries from zombie Railway instances during deploys.
-- Works regardless of application code version.

CREATE OR REPLACE FUNCTION dedup_cron_activity() RETURNS TRIGGER AS $$
BEGIN
  -- Dedup cron event types: only allow 1 entry per event_type per minute
  IF NEW.event_type IN ('notion_sync', 'daily_operator_digest') THEN
    IF EXISTS (
      SELECT 1 FROM activity_log
      WHERE event_type = NEW.event_type
      AND created_at >= date_trunc('minute', NOW())
    ) THEN
      RETURN NULL; -- silently skip duplicate
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS activity_dedup_cron ON activity_log;

CREATE TRIGGER activity_dedup_cron
BEFORE INSERT ON activity_log
FOR EACH ROW
EXECUTE FUNCTION dedup_cron_activity();
