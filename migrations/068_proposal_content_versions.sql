CREATE TABLE IF NOT EXISTS proposal_content_versions (
    id SERIAL PRIMARY KEY,
    proposal_id INTEGER NOT NULL REFERENCES proposals(id) ON DELETE CASCADE,
    version_number INTEGER NOT NULL,
    change_source VARCHAR(50) NOT NULL,
    actor_id TEXT,
    draft_subject TEXT,
    draft_body_text TEXT,
    draft_body_html TEXT,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(proposal_id, version_number)
);

CREATE INDEX IF NOT EXISTS idx_proposal_content_versions_proposal_id
    ON proposal_content_versions(proposal_id, version_number DESC);
