-- Adaptive Learning Tables for FOIA Request Optimization
-- These tables track strategy variations and their outcomes to learn what works

-- Table to store strategy outcomes
CREATE TABLE IF NOT EXISTS foia_strategy_outcomes (
    id SERIAL PRIMARY KEY,
    case_id INTEGER REFERENCES cases(id) ON DELETE CASCADE,
    agency_name TEXT NOT NULL,
    state VARCHAR(2),
    strategy_config JSONB NOT NULL,  -- Stores the strategy used
    outcome_type VARCHAR(50) NOT NULL,  -- full_approval, partial_approval, denial, etc.
    outcome_score INTEGER NOT NULL,  -- Calculated score based on outcome
    response_time_days INTEGER,  -- How long it took to respond
    created_at TIMESTAMP DEFAULT NOW()
);

-- Create indexes for strategy outcomes
CREATE INDEX IF NOT EXISTS idx_strategy_outcomes_agency ON foia_strategy_outcomes(agency_name);
CREATE INDEX IF NOT EXISTS idx_strategy_outcomes_state ON foia_strategy_outcomes(state);
CREATE INDEX IF NOT EXISTS idx_strategy_outcomes_score ON foia_strategy_outcomes(outcome_score);
CREATE INDEX IF NOT EXISTS idx_strategy_outcomes_created ON foia_strategy_outcomes(created_at);

-- Table to store learned insights (aggregated knowledge)
CREATE TABLE IF NOT EXISTS foia_learned_insights (
    id SERIAL PRIMARY KEY,
    agency_name TEXT NOT NULL,
    state VARCHAR(2),
    best_strategies JSONB,  -- Top performing strategies
    worst_strategies JSONB,  -- Poor performing strategies
    sample_size INTEGER NOT NULL,  -- Number of data points
    last_updated TIMESTAMP DEFAULT NOW(),

    UNIQUE(agency_name, state)
);

-- Create indexes for learned insights
CREATE INDEX IF NOT EXISTS idx_learned_insights_agency ON foia_learned_insights(agency_name);
CREATE INDEX IF NOT EXISTS idx_learned_insights_state ON foia_learned_insights(state);

-- Table to track A/B test experiments
CREATE TABLE IF NOT EXISTS foia_experiments (
    id SERIAL PRIMARY KEY,
    experiment_name TEXT NOT NULL,
    description TEXT,
    control_strategy JSONB NOT NULL,
    variant_strategy JSONB NOT NULL,
    started_at TIMESTAMP DEFAULT NOW(),
    ended_at TIMESTAMP,
    status VARCHAR(20) DEFAULT 'active'  -- active, completed, cancelled
);

-- Create index for experiments
CREATE INDEX IF NOT EXISTS idx_experiments_status ON foia_experiments(status);

-- Table to track which cases were part of experiments
CREATE TABLE IF NOT EXISTS foia_experiment_cases (
    id SERIAL PRIMARY KEY,
    experiment_id INTEGER REFERENCES foia_experiments(id) ON DELETE CASCADE,
    case_id INTEGER REFERENCES cases(id) ON DELETE CASCADE,
    variant_group VARCHAR(20) NOT NULL,  -- control or variant
    created_at TIMESTAMP DEFAULT NOW()
);

-- Create indexes for experiment cases
CREATE INDEX IF NOT EXISTS idx_experiment_cases_experiment ON foia_experiment_cases(experiment_id);
CREATE INDEX IF NOT EXISTS idx_experiment_cases_case ON foia_experiment_cases(case_id);

-- Add strategy_used field to cases table if it doesn't exist
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name='cases' AND column_name='strategy_used'
    ) THEN
        ALTER TABLE cases ADD COLUMN strategy_used JSONB;
    END IF;
END $$;

-- Add outcome_recorded field to cases table
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name='cases' AND column_name='outcome_recorded'
    ) THEN
        ALTER TABLE cases ADD COLUMN outcome_recorded BOOLEAN DEFAULT FALSE;
    END IF;
END $$;

-- Add outcome_type field to cases table
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name='cases' AND column_name='outcome_type'
    ) THEN
        ALTER TABLE cases ADD COLUMN outcome_type VARCHAR(50);
    END IF;
END $$;

COMMENT ON TABLE foia_strategy_outcomes IS 'Tracks outcomes of different FOIA request strategies for learning';
COMMENT ON TABLE foia_learned_insights IS 'Aggregated insights about which strategies work best for each agency/state';
COMMENT ON TABLE foia_experiments IS 'A/B test experiments comparing different request strategies';
COMMENT ON TABLE foia_experiment_cases IS 'Links cases to experiments for tracking variant performance';
