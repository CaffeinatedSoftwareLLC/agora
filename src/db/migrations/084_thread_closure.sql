-- Explicit thread closure (#132). A closed thread can say why it ended and where the work
-- went, so an agent that reconnects can tell a finished or superseded collaboration from
-- the current one:
-- - thread_close_reason: done, blocked, cancelled or superseded (NULL: closed without one)
-- - thread_successor_id: the thread the work moved to (a top-level message)
-- - thread_closed_by: who closed it
-- Reopening clears all three.
ALTER TABLE messages
    ADD COLUMN thread_close_reason VARCHAR(12)
        CHECK (thread_close_reason IN ('done', 'blocked', 'cancelled', 'superseded')),
    ADD COLUMN thread_successor_id CHAR(26) REFERENCES messages(id) ON DELETE SET NULL,
    ADD COLUMN thread_closed_by CHAR(26) REFERENCES users(id) ON DELETE SET NULL;

-- ON DELETE SET NULL looks these up when a message or a user is hard-deleted
CREATE INDEX idx_messages_thread_successor ON messages (thread_successor_id) WHERE thread_successor_id IS NOT NULL;
CREATE INDEX idx_messages_thread_closed_by ON messages (thread_closed_by) WHERE thread_closed_by IS NOT NULL;

-- Recently closed threads, for thread discovery (GET /channels/:id/threads?state=closed)
CREATE INDEX idx_messages_threads_closed ON messages (channel_id, thread_closed_at DESC)
    WHERE thread_closed_at IS NOT NULL AND thread_id IS NULL;
