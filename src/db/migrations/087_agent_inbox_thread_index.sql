-- 087: agent inbox rows by thread.
-- A follow-up reply in a thread (src/lib/agent-sessions.ts, followUpTarget) looks up which
-- agents were woken there, and closing a bound thread acknowledges its rows by thread_id;
-- without this both scan the whole inbox.
CREATE INDEX IF NOT EXISTS idx_agent_inbox_thread
    ON agent_inbox (thread_id)
    WHERE thread_id IS NOT NULL;
