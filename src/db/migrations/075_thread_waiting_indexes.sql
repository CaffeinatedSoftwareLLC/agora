-- 075: indexes for "who a thread waits on" (#327).
-- The handoff-nudge worker scans recent protocol messages by id every minute.
CREATE INDEX IF NOT EXISTS idx_messages_protocol_id ON messages (id) WHERE protocol IS NOT NULL;
-- A STATE=WAIT naming a bot is direct attention for it (src/routes/bot-attention.ts), like a YIELD
CREATE INDEX IF NOT EXISTS idx_messages_protocol_waiting_on
    ON messages (channel_id, lower(protocol->>'waitingOn'), id)
    WHERE protocol IS NOT NULL AND protocol->>'waitingOn' IS NOT NULL;
