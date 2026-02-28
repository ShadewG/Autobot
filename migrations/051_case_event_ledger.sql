-- Case event ledger: audit trail + idempotency for the case runtime state machine.
-- Every call to transitionCaseRuntime() inserts one row here.

CREATE TABLE IF NOT EXISTS case_event_ledger (
  id SERIAL PRIMARY KEY,
  case_id INTEGER NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  event TEXT NOT NULL,
  transition_key TEXT,
  context JSONB DEFAULT '{}',
  mutations_applied JSONB DEFAULT '{}',
  projection JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(case_id, transition_key)
);

CREATE INDEX IF NOT EXISTS idx_event_ledger_case
  ON case_event_ledger(case_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_event_ledger_key
  ON case_event_ledger(transition_key)
  WHERE transition_key IS NOT NULL;
