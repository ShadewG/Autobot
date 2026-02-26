-- 043_langgraph_retention.sql
-- LangGraph checkpoint retention policy to prevent unbounded table growth.
-- At current growth rate (~18K rows per 39 cases), 10K cases would produce ~4.6M rows
-- totaling ~1.7GB of checkpoint data.

-- Create a function to prune LangGraph checkpoints.
-- Strategy:
--   - Active cases (cases not closed): keep last 50 checkpoints per thread
--   - Closed cases: keep last 5 checkpoints per thread
--   - Delete checkpoint_blobs and checkpoint_writes for pruned checkpoints
--   - Run on a schedule (daily via Trigger.dev cron task)

CREATE OR REPLACE FUNCTION langgraph.prune_old_checkpoints(
    keep_active INT DEFAULT 50,
    keep_closed INT DEFAULT 5
)
RETURNS TABLE(deleted_checkpoints BIGINT, deleted_blobs BIGINT, deleted_writes BIGINT)
LANGUAGE plpgsql AS $$
DECLARE
    v_deleted_checkpoints BIGINT := 0;
    v_deleted_blobs BIGINT := 0;
    v_deleted_writes BIGINT := 0;
    batch_size INT := 500;
    deleted INT;
BEGIN
    -- Delete checkpoint_writes for orphaned checkpoints (no matching checkpoint row)
    LOOP
        WITH to_delete AS (
            SELECT cw.thread_id, cw.checkpoint_ns, cw.checkpoint_id
            FROM langgraph.checkpoint_writes cw
            WHERE NOT EXISTS (
                SELECT 1 FROM langgraph.checkpoints c
                WHERE c.thread_id = cw.thread_id
                  AND c.checkpoint_ns = cw.checkpoint_ns
                  AND c.checkpoint_id = cw.checkpoint_id
            )
            LIMIT batch_size
        )
        DELETE FROM langgraph.checkpoint_writes cw
        USING to_delete d
        WHERE cw.thread_id = d.thread_id
          AND cw.checkpoint_ns = d.checkpoint_ns
          AND cw.checkpoint_id = d.checkpoint_id;

        GET DIAGNOSTICS deleted = ROW_COUNT;
        v_deleted_writes := v_deleted_writes + deleted;
        EXIT WHEN deleted < batch_size;
    END LOOP;

    -- Delete checkpoint_blobs for orphaned checkpoints
    LOOP
        WITH to_delete AS (
            SELECT cb.thread_id, cb.checkpoint_ns, cb.checkpoint_id
            FROM langgraph.checkpoint_blobs cb
            WHERE NOT EXISTS (
                SELECT 1 FROM langgraph.checkpoints c
                WHERE c.thread_id = cb.thread_id
                  AND c.checkpoint_ns = cb.checkpoint_ns
                  AND c.checkpoint_id = cb.checkpoint_id
            )
            LIMIT batch_size
        )
        DELETE FROM langgraph.checkpoint_blobs cb
        USING to_delete d
        WHERE cb.thread_id = d.thread_id
          AND cb.checkpoint_ns = d.checkpoint_ns
          AND cb.checkpoint_id = d.checkpoint_id;

        GET DIAGNOSTICS deleted = ROW_COUNT;
        v_deleted_blobs := v_deleted_blobs + deleted;
        EXIT WHEN deleted < batch_size;
    END LOOP;

    -- Prune old checkpoints: keep only the N most recent per thread
    -- Uses NTILE/ROW_NUMBER to rank checkpoints within each thread
    LOOP
        WITH ranked AS (
            SELECT
                thread_id,
                checkpoint_ns,
                checkpoint_id,
                ROW_NUMBER() OVER (
                    PARTITION BY thread_id
                    ORDER BY checkpoint_id DESC
                ) AS rn,
                -- Closed cases get smaller retention window
                CASE
                    WHEN EXISTS (
                        SELECT 1 FROM public.cases c
                        WHERE c.langgraph_thread_id = thread_id
                          AND c.status IN ('completed', 'closed')
                    )
                    THEN keep_closed
                    ELSE keep_active
                END AS keep_count
            FROM langgraph.checkpoints
        ),
        to_prune AS (
            SELECT thread_id, checkpoint_ns, checkpoint_id
            FROM ranked
            WHERE rn > keep_count
            LIMIT batch_size
        )
        DELETE FROM langgraph.checkpoints c
        USING to_prune p
        WHERE c.thread_id = p.thread_id
          AND c.checkpoint_ns = p.checkpoint_ns
          AND c.checkpoint_id = p.checkpoint_id;

        GET DIAGNOSTICS deleted = ROW_COUNT;
        v_deleted_checkpoints := v_deleted_checkpoints + deleted;
        EXIT WHEN deleted < batch_size;
    END LOOP;

    RETURN QUERY SELECT v_deleted_checkpoints, v_deleted_blobs, v_deleted_writes;
END;
$$;

-- Add index on checkpoints to support the retention pruning query efficiently
-- (already has index on thread_id from LangGraph schema, but add composite if missing)
CREATE INDEX IF NOT EXISTS idx_langgraph_checkpoints_thread_id
    ON langgraph.checkpoints (thread_id, checkpoint_id DESC);
