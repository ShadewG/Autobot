ALTER TABLE phone_call_queue
    ADD COLUMN IF NOT EXISTS auto_call_mode VARCHAR(50),
    ADD COLUMN IF NOT EXISTS twilio_call_sid VARCHAR(64),
    ADD COLUMN IF NOT EXISTS twilio_call_status VARCHAR(50),
    ADD COLUMN IF NOT EXISTS twilio_call_started_at TIMESTAMP,
    ADD COLUMN IF NOT EXISTS twilio_call_completed_at TIMESTAMP,
    ADD COLUMN IF NOT EXISTS twilio_call_answered_by VARCHAR(64),
    ADD COLUMN IF NOT EXISTS twilio_recording_sid VARCHAR(64),
    ADD COLUMN IF NOT EXISTS twilio_recording_url TEXT,
    ADD COLUMN IF NOT EXISTS twilio_recording_status VARCHAR(50),
    ADD COLUMN IF NOT EXISTS twilio_transcript TEXT,
    ADD COLUMN IF NOT EXISTS twilio_transcript_status VARCHAR(50),
    ADD COLUMN IF NOT EXISTS twilio_transcript_summary TEXT;

CREATE INDEX IF NOT EXISTS idx_phone_call_queue_twilio_call_sid
    ON phone_call_queue (twilio_call_sid)
    WHERE twilio_call_sid IS NOT NULL;
