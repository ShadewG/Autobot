-- 040_eval_cases.sql
-- Eval infrastructure: track cases where AI decisions can be evaluated against human ground truth

CREATE TABLE IF NOT EXISTS eval_cases (
    id SERIAL PRIMARY KEY,
    proposal_id INTEGER REFERENCES proposals(id) ON DELETE SET NULL,
    case_id INTEGER REFERENCES cases(id) ON DELETE CASCADE,
    trigger_message_id INTEGER,
    -- The correct action according to the human (can differ from proposal.action_type)
    expected_action VARCHAR(50) NOT NULL,
    notes TEXT,
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE(proposal_id)
);

CREATE INDEX IF NOT EXISTS idx_eval_cases_case_id ON eval_cases(case_id);
CREATE INDEX IF NOT EXISTS idx_eval_cases_is_active ON eval_cases(is_active);

CREATE TABLE IF NOT EXISTS eval_runs (
    id SERIAL PRIMARY KEY,
    eval_case_id INTEGER REFERENCES eval_cases(id) ON DELETE CASCADE,
    -- What the AI produced (stored proposal action_type)
    predicted_action VARCHAR(50),
    -- Objective: did AI pick the right action?
    action_correct BOOLEAN,
    -- LLM judge score 1-5
    judge_score INTEGER CHECK (judge_score BETWEEN 1 AND 5),
    judge_reasoning TEXT,
    -- null if correct; one of: WRONG_CLASSIFICATION, WRONG_ROUTING, THRESHOLD_ERROR, DRAFT_QUALITY, POLICY_VIOLATION, CONTEXT_MISSED
    failure_category VARCHAR(100),
    pipeline_output JSONB,
    ran_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_eval_runs_eval_case_id ON eval_runs(eval_case_id);
CREATE INDEX IF NOT EXISTS idx_eval_runs_ran_at ON eval_runs(ran_at);
