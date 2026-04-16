-- Diagnostic: report all triggers on cases table and their status
DO $$
DECLARE
    trigger_info TEXT;
    can_disable BOOLEAN := false;
BEGIN
    SELECT string_agg(
        tgname
        || ' enabled='    || tgenabled
        || ' type='       || tgtype::text
        || ' nargs='      || tgnargs::text,
        ' | '
    )
    INTO trigger_info
    FROM pg_catalog.pg_trigger t
    JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid
    WHERE c.relname = 'cases' AND NOT t.tgisinternal;

    RAISE EXCEPTION 'TRIGGER_REPORT: cases triggers=[%]', COALESCE(trigger_info, 'NONE');
END $$;
