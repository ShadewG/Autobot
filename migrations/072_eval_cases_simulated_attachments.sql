ALTER TABLE eval_cases
    ADD COLUMN IF NOT EXISTS simulated_attachments_jsonb JSONB;
