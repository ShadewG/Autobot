-- AI Decision Lessons: operational memory for better decision-making
-- Stores lessons learned from outcomes + manually-added rules
-- Queried before AI makes decisions to provide context

CREATE TABLE IF NOT EXISTS ai_decision_lessons (
    id SERIAL PRIMARY KEY,
    category VARCHAR(50) NOT NULL,          -- 'portal', 'denial', 'fee', 'followup', 'agency', 'general'
    trigger_pattern TEXT NOT NULL,           -- when to apply: "denial with ongoing investigation", "portal failed 2+ times"
    lesson TEXT NOT NULL,                    -- what to do differently
    source VARCHAR(20) DEFAULT 'manual',    -- 'manual' or 'auto'
    source_case_id INT,                     -- optional: case that generated this lesson
    priority INT DEFAULT 5,                 -- 1-10, higher = applied first
    times_applied INT DEFAULT 0,
    active BOOLEAN DEFAULT true,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_lessons_category ON ai_decision_lessons(category);
CREATE INDEX IF NOT EXISTS idx_lessons_active ON ai_decision_lessons(active) WHERE active = true;
