-- 086: threads per channel by latest reply, open or closed (#40).
-- A channel audio overview picks the most recently active threads; a thread closed
-- seconds after its last reply still counts. idx_messages_active_threads only holds
-- open threads, so without this the closed-inclusive lookup scans the whole channel.
CREATE INDEX IF NOT EXISTS idx_messages_thread_activity
    ON messages (channel_id, last_reply_at DESC)
    WHERE reply_count > 0;
