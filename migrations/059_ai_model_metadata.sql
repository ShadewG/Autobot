-- Migration: 059_ai_model_metadata.sql
-- Description: Store AI model/usage metadata on response analyses and proposals

ALTER TABLE response_analysis
  ADD COLUMN IF NOT EXISTS model_id TEXT,
  ADD COLUMN IF NOT EXISTS prompt_tokens INTEGER,
  ADD COLUMN IF NOT EXISTS completion_tokens INTEGER,
  ADD COLUMN IF NOT EXISTS latency_ms INTEGER;

ALTER TABLE proposals
  ADD COLUMN IF NOT EXISTS decision_model_id TEXT,
  ADD COLUMN IF NOT EXISTS decision_prompt_tokens INTEGER,
  ADD COLUMN IF NOT EXISTS decision_completion_tokens INTEGER,
  ADD COLUMN IF NOT EXISTS decision_latency_ms INTEGER,
  ADD COLUMN IF NOT EXISTS draft_model_id TEXT,
  ADD COLUMN IF NOT EXISTS draft_prompt_tokens INTEGER,
  ADD COLUMN IF NOT EXISTS draft_completion_tokens INTEGER,
  ADD COLUMN IF NOT EXISTS draft_latency_ms INTEGER;

COMMENT ON COLUMN response_analysis.model_id IS 'Model identifier captured from the classifier AI call.';
COMMENT ON COLUMN response_analysis.prompt_tokens IS 'Prompt/input tokens used by the classifier AI call.';
COMMENT ON COLUMN response_analysis.completion_tokens IS 'Completion/output tokens used by the classifier AI call.';
COMMENT ON COLUMN response_analysis.latency_ms IS 'Wall-clock latency in milliseconds for the classifier AI call.';

COMMENT ON COLUMN proposals.decision_model_id IS 'Model identifier captured from the decide-next-action AI call.';
COMMENT ON COLUMN proposals.decision_prompt_tokens IS 'Prompt/input tokens used by the decision AI call.';
COMMENT ON COLUMN proposals.decision_completion_tokens IS 'Completion/output tokens used by the decision AI call.';
COMMENT ON COLUMN proposals.decision_latency_ms IS 'Wall-clock latency in milliseconds for the decision AI call.';
COMMENT ON COLUMN proposals.draft_model_id IS 'Model identifier captured from the draft-generation AI call.';
COMMENT ON COLUMN proposals.draft_prompt_tokens IS 'Prompt/input tokens used by the draft-generation AI call.';
COMMENT ON COLUMN proposals.draft_completion_tokens IS 'Completion/output tokens used by the draft-generation AI call.';
COMMENT ON COLUMN proposals.draft_latency_ms IS 'Wall-clock latency in milliseconds for the draft-generation AI call.';
