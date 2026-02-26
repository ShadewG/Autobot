-- 042_schema_optimizations.sql
-- Schema performance optimizations based on production stat analysis.
-- Fixes: missing indexes, duplicate indexes, wrong FK, autovacuum, planner settings.
-- All index operations use CONCURRENTLY to avoid locking production tables.

-- =============================================================================
-- CRITICAL: Missing FK index on messages.case_id
-- Root cause of 2.4M sequential scans / 371M tuple reads on messages table.
-- Every AI pipeline run that loads case history does WHERE case_id = $1 with no index.
-- =============================================================================
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_messages_case_id
    ON public.messages (case_id);

-- =============================================================================
-- CRITICAL: Fix planner settings for SSD storage (Railway uses NVMe SSD)
-- random_page_cost=4 is the spinning-disk default and tells the planner that
-- random I/O is 4x more expensive than sequential — NOT true on SSD (should be ~1.1-1.2).
-- This single setting explains why the planner chooses sequential scans over indexes
-- even when an index exists and covers the query.
-- effective_io_concurrency should be 100-200 for NVMe (1 is single-disk HDD default).
-- =============================================================================
ALTER SYSTEM SET random_page_cost = 1.2;
ALTER SYSTEM SET effective_io_concurrency = 200;

-- Enable slow query logging so regressions become visible
ALTER SYSTEM SET log_min_duration_statement = 250;  -- ms: log queries > 250ms
ALTER SYSTEM SET track_io_timing = on;               -- enables pg_stat_statements I/O data

SELECT pg_reload_conf();

-- =============================================================================
-- HIGH: Missing indexes on response_analysis.case_id
-- Queried frequently in AI pipeline context loading: WHERE case_id = $1 ORDER BY created_at
-- =============================================================================
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_response_analysis_case_id
    ON public.response_analysis (case_id);

-- =============================================================================
-- HIGH: Missing composite indexes for common multi-column filter patterns
-- =============================================================================

-- Dashboard queue: WHERE user_id = $1 AND status = $2 (very common)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_cases_user_status
    ON public.cases (user_id, status);

-- Proposal lookup: WHERE case_id = $1 AND status IN (...) (every pipeline run)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_proposals_case_status
    ON public.proposals (case_id, status);

-- Latest agent run per case: WHERE case_id = $1 ORDER BY started_at DESC LIMIT 1
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_agent_runs_case_started_desc
    ON public.agent_runs (case_id, started_at DESC);

-- =============================================================================
-- HIGH: Remove duplicate/triplicate unique constraints on proposals
-- proposals.execution_key has 3 equivalent indexes (key, unique, constraint) — pick one
-- proposals.proposal_key has 3 equivalent indexes — pick one
-- These add ~3x write overhead and confuse the planner
-- =============================================================================

-- Keep proposals_execution_key_key (the constraint), drop the others
DROP INDEX CONCURRENTLY IF EXISTS proposals_execution_key_unique;
DROP INDEX CONCURRENTLY IF EXISTS idx_proposals_execution_key;

-- Keep proposals_proposal_key_key (the constraint), drop the others
DROP INDEX CONCURRENTLY IF EXISTS proposals_proposal_key_unique;
DROP INDEX CONCURRENTLY IF EXISTS idx_proposals_key;

-- =============================================================================
-- HIGH: Drop large unused indexes (zero scans since last reset)
-- These add write overhead on every INSERT/UPDATE without providing any reads
-- =============================================================================

-- Trigram index on agencies.name — 1048 kB for 1 row, never used
DROP INDEX CONCURRENTLY IF EXISTS idx_agencies_name_trgm;

-- Duplicate of idx_agencies_notion_page_id (which has 835K scans)
DROP INDEX CONCURRENTLY IF EXISTS agencies_notion_page_id_key;

-- GIN indexes never queried
DROP INDEX CONCURRENTLY IF EXISTS idx_cases_constraints;
DROP INDEX CONCURRENTLY IF EXISTS idx_cases_scope_items;
DROP INDEX CONCURRENTLY IF EXISTS idx_activity_log_meta;

-- Stale/unused column indexes
DROP INDEX CONCURRENTLY IF EXISTS idx_agencies_portal_url;
DROP INDEX CONCURRENTLY IF EXISTS idx_agencies_sync_status;
DROP INDEX CONCURRENTLY IF EXISTS idx_agent_runs_thread_id;
DROP INDEX CONCURRENTLY IF EXISTS idx_agent_runs_trigger_type;
DROP INDEX CONCURRENTLY IF EXISTS idx_cases_langgraph_thread_id;
DROP INDEX CONCURRENTLY IF EXISTS idx_cases_next_due_at;
DROP INDEX CONCURRENTLY IF EXISTS idx_cases_pause_reason;
DROP INDEX CONCURRENTLY IF EXISTS idx_cases_autopilot_mode;
DROP INDEX CONCURRENTLY IF EXISTS idx_proposals_thread_id;

-- Duplicate on cases.notion_page_id (idx_cases_notion_id with 1186 scans is kept)
DROP INDEX CONCURRENTLY IF EXISTS cases_notion_page_id_key;

-- Zero-scan indexes on tiny tables
DROP INDEX CONCURRENTLY IF EXISTS idx_messages_provider_message_id;
DROP INDEX CONCURRENTLY IF EXISTS idx_messages_sendgrid_id;

-- =============================================================================
-- HIGH: Tune autovacuum for small, high-update-rate tables
-- Default autovacuum fires when 20% of rows are dead. For a table with 1 row,
-- that means 0.2 dead rows — effectively never. For 8 rows it fires at 1.6 dead rows.
-- These thresholds make more sense for small, frequently-updated FOIA tables.
-- =============================================================================
ALTER TABLE public.agencies SET (
    autovacuum_vacuum_scale_factor = 0.0,
    autovacuum_analyze_scale_factor = 0.0,
    autovacuum_vacuum_threshold = 5,
    autovacuum_analyze_threshold = 10
);

ALTER TABLE public.cases SET (
    autovacuum_vacuum_scale_factor = 0.05,
    autovacuum_analyze_scale_factor = 0.05,
    autovacuum_vacuum_threshold = 5,
    autovacuum_analyze_threshold = 5
);

ALTER TABLE public.proposals SET (
    autovacuum_vacuum_scale_factor = 0.05,
    autovacuum_analyze_scale_factor = 0.05,
    autovacuum_vacuum_threshold = 5,
    autovacuum_analyze_threshold = 5
);

ALTER TABLE public.messages SET (
    autovacuum_vacuum_scale_factor = 0.05,
    autovacuum_analyze_scale_factor = 0.05,
    autovacuum_vacuum_threshold = 10,
    autovacuum_analyze_threshold = 10
);

ALTER TABLE public.agent_runs SET (
    autovacuum_vacuum_scale_factor = 0.05,
    autovacuum_analyze_scale_factor = 0.05,
    autovacuum_vacuum_threshold = 10,
    autovacuum_analyze_threshold = 10
);

ALTER TABLE public.follow_up_schedule SET (
    autovacuum_vacuum_scale_factor = 0.0,
    autovacuum_vacuum_threshold = 5,
    autovacuum_analyze_threshold = 5
);

ALTER TABLE public.generated_requests SET (
    autovacuum_vacuum_scale_factor = 0.05,
    autovacuum_vacuum_threshold = 5,
    autovacuum_analyze_threshold = 5
);

ALTER TABLE public.portal_tasks SET (
    autovacuum_vacuum_scale_factor = 0.05,
    autovacuum_vacuum_threshold = 5,
    autovacuum_analyze_threshold = 5
);

ALTER TABLE public.executions SET (
    autovacuum_vacuum_scale_factor = 0.05,
    autovacuum_vacuum_threshold = 5,
    autovacuum_analyze_threshold = 5
);

ALTER TABLE public.email_threads SET (
    autovacuum_vacuum_scale_factor = 0.05,
    autovacuum_vacuum_threshold = 5,
    autovacuum_analyze_threshold = 5
);

-- =============================================================================
-- MEDIUM: Immediate VACUUM ANALYZE on tables with severe bloat
-- Tables with >40% dead tuples and "never vacuumed" status
-- =============================================================================
VACUUM ANALYZE public.agencies;
VACUUM ANALYZE public.dead_letter_queue;
VACUUM ANALYZE public.foia_strategy_outcomes;
VACUUM ANALYZE public.case_agencies;
VACUUM ANALYZE public.portal_tasks;
VACUUM ANALYZE public.executions;
VACUUM ANALYZE public.follow_up_schedule;
VACUUM ANALYZE public.generated_requests;
VACUUM ANALYZE public.attachments;
VACUUM ANALYZE public.fee_history;
VACUUM ANALYZE public.email_threads;
VACUUM ANALYZE public.response_analysis;
VACUUM ANALYZE public.messages;
VACUUM ANALYZE public.proposals;
VACUUM ANALYZE public.cases;
VACUUM ANALYZE public.agent_runs;
VACUUM ANALYZE public.activity_log;

-- =============================================================================
-- MEDIUM: Remove duplicate columns (schema cleanup for cases table)
-- cases.scope_items (ARRAY) and cases.scope_items_jsonb (JSONB) are redundant.
-- cases.constraints (ARRAY) and cases.constraints_jsonb (JSONB) are redundant.
-- Check which is actually queried before dropping — JSONB is more flexible.
-- NOTE: Commented out — requires application code audit first to confirm which
-- columns are read/written before dropping. Uncomment after audit.
-- =============================================================================
-- ALTER TABLE public.cases DROP COLUMN IF EXISTS scope_items;       -- keep scope_items_jsonb
-- ALTER TABLE public.cases DROP COLUMN IF EXISTS constraints;       -- keep constraints_jsonb

-- =============================================================================
-- MEDIUM: Fix wrong FK on agent_runs.proposal_id
-- Currently points to auto_reply_queue.id (WRONG) — should reference proposals.id
-- Steps: null out orphan rows, add correct FK, drop old wrong FK
-- =============================================================================
-- Step 1: null out rows where proposal_id references auto_reply_queue, not proposals
UPDATE public.agent_runs ar
SET proposal_id = NULL
WHERE proposal_id IS NOT NULL
  AND NOT EXISTS (
      SELECT 1 FROM public.proposals p WHERE p.id = ar.proposal_id
  );

-- Step 2: Add correct FK (NOT VALID = fast, no full table scan required immediately)
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.table_constraints
        WHERE table_name = 'agent_runs'
          AND constraint_name = 'agent_runs_proposal_id_fkey_correct'
    ) THEN
        ALTER TABLE public.agent_runs
            ADD CONSTRAINT agent_runs_proposal_id_fkey_correct
            FOREIGN KEY (proposal_id) REFERENCES public.proposals(id) ON DELETE SET NULL NOT VALID;
    END IF;
END;
$$;

-- Step 3: Drop old wrong FK if it exists
ALTER TABLE public.agent_runs DROP CONSTRAINT IF EXISTS agent_runs_proposal_id_fkey;
