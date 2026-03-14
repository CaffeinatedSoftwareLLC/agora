-- Thread close/reopen: NULL = open, non-null = closed timestamp
ALTER TABLE messages ADD COLUMN thread_closed_at TIMESTAMPTZ;

-- Recreate active threads index to exclude closed threads
DROP INDEX idx_messages_active_threads;
CREATE INDEX idx_messages_active_threads
  ON messages(channel_id, last_reply_at DESC)
  WHERE reply_count > 0 AND thread_closed_at IS NULL;
