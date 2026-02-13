-- Users table
CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    email_handle VARCHAR(100) NOT NULL UNIQUE,
    email VARCHAR(255) GENERATED ALWAYS AS (email_handle || '@foib-request.com') STORED UNIQUE,
    active BOOLEAN DEFAULT true,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_users_email_handle ON users(email_handle);
CREATE INDEX IF NOT EXISTS idx_users_active ON users(active) WHERE active = true;

-- Add user_id FK to cases (nullable — existing cases stay unowned)
ALTER TABLE cases ADD COLUMN IF NOT EXISTS user_id INTEGER REFERENCES users(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_cases_user_id ON cases(user_id);

-- Add user_id FK to portal_accounts (nullable — existing accounts stay shared)
ALTER TABLE portal_accounts ADD COLUMN IF NOT EXISTS user_id INTEGER REFERENCES users(id) ON DELETE SET NULL;
