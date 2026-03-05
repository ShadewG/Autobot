-- Migration 057: Prevent duplicate case creation by enforcing notion_page_id uniqueness
-- 1) Normalize Notion UUID page IDs to canonical 32-char lowercase format
-- 2) Resolve any historical collisions safely
-- 3) Enforce DB-level uniqueness for race-proof idempotency

-- Normalize whitespace first
UPDATE cases
SET notion_page_id = trim(notion_page_id)
WHERE notion_page_id IS NOT NULL
  AND notion_page_id <> trim(notion_page_id);

-- Canonicalize UUID-style Notion IDs: remove dashes + lowercase
UPDATE cases
SET notion_page_id = lower(regexp_replace(notion_page_id, '-', '', 'g'))
WHERE notion_page_id ~* '^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$';

-- If duplicates exist after normalization, preserve newest and mark older IDs as explicit legacy duplicates
WITH ranked AS (
    SELECT
        id,
        notion_page_id,
        ROW_NUMBER() OVER (
            PARTITION BY notion_page_id
            ORDER BY updated_at DESC NULLS LAST, created_at DESC NULLS LAST, id DESC
        ) AS rn
    FROM cases
)
UPDATE cases c
SET notion_page_id = c.notion_page_id || ':dup:' || c.id::text
FROM ranked r
WHERE c.id = r.id
  AND r.rn > 1;

-- Replace non-unique index with unique protection
DROP INDEX IF EXISTS idx_cases_notion_id;
CREATE UNIQUE INDEX IF NOT EXISTS idx_cases_notion_id_unique ON cases(notion_page_id);
