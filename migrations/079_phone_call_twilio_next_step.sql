ALTER TABLE phone_call_queue
    ADD COLUMN IF NOT EXISTS twilio_next_step JSONB;
