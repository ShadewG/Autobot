ALTER TABLE messages
    ADD COLUMN IF NOT EXISTS normalized_body_text TEXT,
    ADD COLUMN IF NOT EXISTS normalized_body_source VARCHAR(50),
    ADD COLUMN IF NOT EXISTS is_substantive BOOLEAN;

CREATE OR REPLACE FUNCTION autobot_extract_message_text(raw_text TEXT, raw_html TEXT)
RETURNS TABLE(normalized_text TEXT, body_source VARCHAR)
LANGUAGE plpgsql
AS $$
DECLARE
    text_candidate TEXT := BTRIM(COALESCE(raw_text, ''));
    html_candidate TEXT := BTRIM(COALESCE(raw_html, ''));
BEGIN
    IF text_candidate <> '' THEN
        normalized_text := text_candidate;
        body_source := 'body_text';
    ELSIF html_candidate <> '' THEN
        normalized_text := html_candidate;
        normalized_text := regexp_replace(normalized_text, '(?is)<style[^>]*>.*?</style>', ' ', 'g');
        normalized_text := regexp_replace(normalized_text, '(?is)<script[^>]*>.*?</script>', ' ', 'g');
        normalized_text := regexp_replace(normalized_text, '(?i)<br\\s*/?>', E'\n', 'g');
        normalized_text := regexp_replace(normalized_text, '(?i)</(p|div|li|tr|h[1-6]|blockquote)>', E'\n', 'g');
        normalized_text := regexp_replace(normalized_text, '(?i)<li[^>]*>', E'• ', 'g');
        normalized_text := regexp_replace(normalized_text, '(?i)&nbsp;|&#160;', ' ', 'g');
        normalized_text := regexp_replace(normalized_text, '(?i)&amp;', '&', 'g');
        normalized_text := regexp_replace(normalized_text, '(?i)&quot;', '"', 'g');
        normalized_text := regexp_replace(normalized_text, '(?i)&#39;|&apos;', '''', 'g');
        normalized_text := regexp_replace(normalized_text, '(?i)&lt;', '<', 'g');
        normalized_text := regexp_replace(normalized_text, '(?i)&gt;', '>', 'g');
        normalized_text := regexp_replace(normalized_text, '<[^>]+>', ' ', 'g');
        body_source := 'body_html';
    ELSE
        normalized_text := '';
        body_source := NULL;
    END IF;

    normalized_text := regexp_replace(COALESCE(normalized_text, ''), E'\r', '', 'g');
    normalized_text := regexp_replace(normalized_text, E'[ \t]+\n', E'\n', 'g');
    normalized_text := regexp_replace(normalized_text, E'\n[ \t]+', E'\n', 'g');
    normalized_text := regexp_replace(normalized_text, E'[ \t]{2,}', ' ', 'g');
    normalized_text := regexp_replace(normalized_text, E'\n{3,}', E'\n\n', 'g');
    normalized_text := BTRIM(normalized_text);

    RETURN NEXT;
END;
$$;

CREATE OR REPLACE FUNCTION autobot_is_substantive_message(
    msg_direction TEXT,
    msg_subject TEXT,
    normalized_text TEXT,
    msg_portal_notification BOOLEAN,
    msg_type TEXT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
AS $$
DECLARE
    combined TEXT := lower(trim(coalesce(msg_subject, '') || E'\n' || coalesce(normalized_text, '')));
BEGIN
    IF combined = '' THEN
        RETURN FALSE;
    END IF;

    IF lower(coalesce(msg_direction, '')) <> 'inbound' THEN
        RETURN TRUE;
    END IF;

    IF lower(coalesce(msg_type, '')) = 'portal_system' THEN
        RETURN FALSE;
    END IF;

    IF coalesce(msg_portal_notification, FALSE)
       AND combined ~ '(temporary password|password assistance|unlock (your )?(public )?portal account|unlock your account|account unlock|account locked|reset (your )?password|welcome to .*records center|verify your email|email confirmation|account activation|portal account|login id|create a permanent password|track and monitor the status of your request|records center account|access your account online|sign in to your account)'
       AND combined !~ '(denied|denial|withheld|withhold|exempt|fee|cost|invoice|payment|clarif|please provide|mailing address|request form|records ready|attached records|responsive records|download|wrong agency|not the correct agency|no records|ongoing investigation|release|redact|public records request|open records request)'
    THEN
        RETURN FALSE;
    END IF;

    RETURN TRUE;
END;
$$;

CREATE OR REPLACE FUNCTION autobot_messages_normalize_before_write()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    thread_case_id INTEGER;
    extracted RECORD;
BEGIN
    IF NEW.case_id IS NULL AND NEW.thread_id IS NOT NULL THEN
        SELECT case_id
        INTO thread_case_id
        FROM email_threads
        WHERE id = NEW.thread_id
        LIMIT 1;

        IF thread_case_id IS NOT NULL THEN
            NEW.case_id := thread_case_id;
        END IF;
    END IF;

    SELECT normalized_text, body_source
    INTO extracted
    FROM autobot_extract_message_text(NEW.body_text, NEW.body_html);

    NEW.normalized_body_text := extracted.normalized_text;
    NEW.normalized_body_source := extracted.body_source;
    NEW.is_substantive := autobot_is_substantive_message(
        NEW.direction,
        NEW.subject,
        extracted.normalized_text,
        COALESCE(NEW.portal_notification, FALSE),
        NEW.message_type
    );

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_messages_normalize_before_write ON messages;

CREATE TRIGGER trg_messages_normalize_before_write
BEFORE INSERT OR UPDATE OF case_id, thread_id, direction, subject, body_text, body_html, portal_notification, message_type
ON messages
FOR EACH ROW
EXECUTE FUNCTION autobot_messages_normalize_before_write();

UPDATE messages m
SET case_id = COALESCE(m.case_id, src.thread_case_id),
    normalized_body_text = src.normalized_text,
    normalized_body_source = src.body_source,
    is_substantive = autobot_is_substantive_message(
        m.direction,
        m.subject,
        src.normalized_text,
        COALESCE(m.portal_notification, FALSE),
        m.message_type
    )
FROM (
    SELECT m2.id,
           t.case_id AS thread_case_id,
           extracted.normalized_text,
           extracted.body_source
    FROM messages m2
    LEFT JOIN email_threads t ON t.id = m2.thread_id
    CROSS JOIN LATERAL autobot_extract_message_text(m2.body_text, m2.body_html) AS extracted(normalized_text, body_source)
) src
WHERE src.id = m.id;

CREATE INDEX IF NOT EXISTS idx_messages_case_direction_substantive
    ON messages(case_id, direction, is_substantive, received_at DESC, created_at DESC);
