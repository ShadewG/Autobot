-- Add UNIQUE constraint to auto_reply_queue.message_id
-- This is needed for the ON CONFLICT clause in email-queue.js

-- Add unique constraint to message_id
ALTER TABLE auto_reply_queue
ADD CONSTRAINT auto_reply_queue_message_id_unique UNIQUE (message_id);
