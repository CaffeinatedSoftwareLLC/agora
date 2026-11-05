-- Terminal session state (#230, docs/agent-sessions.md "Terminal sessions"). A terminal agent
-- whose CLI ran out of context keeps its agora-mcp process, so presence alone kept saying
-- "connected" while nobody answered. agora-mcp already reports chat_wait (Listening) and tool
-- calls (Activity); these columns keep that per terminal session, plus what the agent itself
-- reports through the agent_status tool.
--
-- listening:       a chat_wait is open (always true for a Claude Code Channel socket)
-- idle_since:      when the session became neither working nor listening; NULL while it is either
-- last_tool:       the last agora-mcp tool it called (chat_wait excluded)
-- context_percent: context window used, as the agent reported it (agent_status)
-- usage_percent:   plan or rate-limit window used, with its label ("5h window")
-- status_note:     the agent's own short status line
-- status_at:       when it last reported through agent_status
-- limit_warned_at: the one "hand off before the limit" notice (>= 80%) was posted
ALTER TABLE agent_sessions
    ADD COLUMN listening BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN idle_since TIMESTAMPTZ,
    ADD COLUMN last_tool VARCHAR(64),
    ADD COLUMN context_percent SMALLINT CHECK (context_percent BETWEEN 0 AND 100),
    ADD COLUMN usage_percent SMALLINT CHECK (usage_percent BETWEEN 0 AND 100),
    ADD COLUMN usage_label VARCHAR(60),
    ADD COLUMN status_note VARCHAR(200),
    ADD COLUMN status_at TIMESTAMPTZ,
    ADD COLUMN limit_warned_at TIMESTAMPTZ;
