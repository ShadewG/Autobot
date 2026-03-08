-- User feedback: bug reports, feature requests, and changelog
CREATE TABLE IF NOT EXISTS user_feedback (
    id SERIAL PRIMARY KEY,
    type VARCHAR(30) NOT NULL CHECK (type IN ('bug_report', 'feature_request')),
    case_id INTEGER REFERENCES cases(id) ON DELETE SET NULL,
    title VARCHAR(200) NOT NULL,
    description TEXT NOT NULL,
    priority VARCHAR(20) DEFAULT 'medium' CHECK (priority IN ('low', 'medium', 'high', 'critical')),
    status VARCHAR(20) NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'in_progress', 'resolved', 'closed', 'wont_fix')),
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_by_email VARCHAR(255),
    resolved_at TIMESTAMPTZ,
    resolved_notes TEXT,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_user_feedback_type ON user_feedback(type, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_user_feedback_case_id ON user_feedback(case_id) WHERE case_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_user_feedback_status ON user_feedback(status, created_at DESC);

CREATE TABLE IF NOT EXISTS changelog_entries (
    id SERIAL PRIMARY KEY,
    version VARCHAR(20),
    title VARCHAR(200) NOT NULL,
    description TEXT NOT NULL,
    category VARCHAR(30) NOT NULL DEFAULT 'improvement' CHECK (category IN ('feature', 'fix', 'improvement', 'breaking')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_changelog_entries_created_at ON changelog_entries(created_at DESC);
