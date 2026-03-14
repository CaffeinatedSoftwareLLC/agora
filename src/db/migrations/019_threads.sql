-- Thread support: reply chains on parent messages
-- thread_id points to the parent message; replies are regular message rows
-- reply_count and last_reply_at are denormalized on the parent for fast queries

-- ON DELETE CASCADE is a safety net; soft-delete is the normal path so FK never fires
ALTER TABLE messages
  ADD COLUMN thread_id CHAR(26) REFERENCES messages(id) ON DELETE CASCADE,
  ADD COLUMN reply_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN last_reply_at TIMESTAMPTZ;

-- Fetch replies in a thread, ordered oldest-first by ULID (ULID IS the timestamp)
CREATE INDEX idx_messages_thread_replies
  ON messages(thread_id, id ASC)
  WHERE thread_id IS NOT NULL;

-- Active threads per channel, ordered by most recent reply
CREATE INDEX idx_messages_active_threads
  ON messages(channel_id, last_reply_at DESC)
  WHERE reply_count > 0;
