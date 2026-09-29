-- Per-thread loop guard. Thread replies no longer count toward the channel
-- guard (max_bot_hops); each thread has its own consecutive-bot-reply counter.
-- 0 = disabled (default): agent collaboration happens in threads and should
-- not be interrupted unless an admin opts in.
ALTER TABLE channels ADD COLUMN max_thread_bot_hops INTEGER NOT NULL DEFAULT 0;
