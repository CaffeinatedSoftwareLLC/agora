-- Terminal sessions (#112, docs/agent-sessions.md "Terminal sessions"): an agent the user runs
-- in their own terminal, connected through agora-mcp with presence. It is a lightweight
-- session next to hosted ones: no profile, no host, no runs, no budget. It is live while
-- agora-mcp is connected (plus a grace period for reconnects) and ended when presence drops.
--
-- Hosted rows keep profile_id; terminal rows have none. Every query that needs a profile
-- inner-joins agent_profiles, so terminal rows never reach host claims, budgets, worktree
-- review, checkpoints or subtasks.

ALTER TABLE agent_sessions ADD COLUMN kind VARCHAR(8) NOT NULL DEFAULT 'hosted'
    CHECK (kind IN ('hosted', 'terminal'));
ALTER TABLE agent_sessions ALTER COLUMN profile_id DROP NOT NULL;
ALTER TABLE agent_sessions ADD CONSTRAINT agent_sessions_kind_profile
    CHECK ((kind = 'hosted') = (profile_id IS NOT NULL));
ALTER TABLE agent_sessions ADD CONSTRAINT agent_sessions_terminal_channel
    CHECK (kind = 'hosted' OR (thread_id IS NULL AND parent_session_id IS NULL));

-- What agora-mcp reports: its mode, working (calling tools) or idle, the tool calls it has
-- seen, and when it was last heard from (heartbeat; a stale row is ended by the sweeper).
-- Token use is unknown for most CLIs: tokens_used stays 0 and usage_known false ("n/a").
ALTER TABLE agent_sessions
    ADD COLUMN terminal_mode VARCHAR(8) CHECK (terminal_mode IN ('channel', 'mcp')),
    ADD COLUMN working BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN tool_calls INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN usage_known BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN seen_at TIMESTAMPTZ,
    -- The one-time "the terminal answers, the hosted session waits" notice was posted
    ADD COLUMN standby_notice_at TIMESTAMPTZ;

-- 'disconnected': a terminal session whose agora-mcp went away
ALTER TABLE agent_sessions DROP CONSTRAINT agent_sessions_end_reason_check;
ALTER TABLE agent_sessions ADD CONSTRAINT agent_sessions_end_reason_check
    CHECK (end_reason IN ('user', 'budget', 'replaced', 'access_lost', 'done', 'disconnected'));

-- At most one live hosted and one live terminal channel session per agent per channel
DROP INDEX idx_agent_sessions_live;
CREATE UNIQUE INDEX idx_agent_sessions_live ON agent_sessions(channel_id, bot_id)
    WHERE state = 'live' AND thread_id IS NULL AND kind = 'hosted';
CREATE UNIQUE INDEX idx_agent_sessions_live_terminal ON agent_sessions(channel_id, bot_id)
    WHERE state = 'live' AND kind = 'terminal';
CREATE INDEX idx_agent_sessions_terminal_seen ON agent_sessions(seen_at)
    WHERE state = 'live' AND kind = 'terminal';
