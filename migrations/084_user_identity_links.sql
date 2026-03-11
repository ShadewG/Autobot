CREATE TABLE IF NOT EXISTS user_identity_links (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    provider VARCHAR(50) NOT NULL,
    provider_user_id VARCHAR(255) NOT NULL,
    provider_email VARCHAR(255),
    provider_username VARCHAR(255),
    discord_id VARCHAR(255),
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (provider, provider_user_id)
);

CREATE INDEX IF NOT EXISTS idx_user_identity_links_user_id
    ON user_identity_links(user_id);

CREATE INDEX IF NOT EXISTS idx_user_identity_links_provider_email
    ON user_identity_links(provider, provider_email);

CREATE INDEX IF NOT EXISTS idx_user_identity_links_discord_id
    ON user_identity_links(provider, discord_id);
