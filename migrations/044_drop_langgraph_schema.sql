-- 044_drop_langgraph_schema.sql
-- Drop the langgraph checkpoint schema entirely.
-- The agent pipeline has been fully migrated to Trigger.dev (cloud).
-- workers/agent-worker.js is no longer started; run-engine.js uses tasks.trigger() only.
-- The checkpoint tables (checkpoints, checkpoint_blobs, checkpoint_writes) contain only
-- historical data from the old pipeline and are no longer written to.
--
-- NOTE: The langgraph_thread_id column on agent_runs is KEPT — it is used as a
-- human-readable run-correlation string throughout the application (e.g. "initial:42:...",
-- "case:42:msg-99") and has no dependency on the langgraph schema.

DROP SCHEMA IF EXISTS langgraph CASCADE;
