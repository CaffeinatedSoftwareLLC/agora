-- 052: Task board and subtask delegation (docs/task-board.md).
-- 051 is reserved for project context (C1); 053/054 for other branches.

-- ─── Sessions scoped to one thread ───
-- A task card's session and a subtask's session each work in their own thread, next to
-- the agent's channel session. thread_id NULL is an ordinary channel session.
ALTER TABLE agent_sessions
    ADD COLUMN thread_id CHAR(26) REFERENCES messages(id) ON DELETE CASCADE,
    -- A subtask's parent: the child spends the parent's token budget
    ADD COLUMN parent_session_id CHAR(26) REFERENCES agent_sessions(id) ON DELETE SET NULL,
    -- Where a subtask's summary goes: the thread the parent delegated from (NULL: the channel)
    ADD COLUMN report_thread_id CHAR(26) REFERENCES messages(id) ON DELETE SET NULL,
    -- A subtask's title (a task card's title lives on the card)
    ADD COLUMN title VARCHAR(200);

-- At most one live session per agent per channel, and per agent per thread
DROP INDEX idx_agent_sessions_live;
CREATE UNIQUE INDEX idx_agent_sessions_live ON agent_sessions(channel_id, bot_id) WHERE state = 'live' AND thread_id IS NULL;
CREATE UNIQUE INDEX idx_agent_sessions_live_thread ON agent_sessions(thread_id, bot_id) WHERE state = 'live' AND thread_id IS NOT NULL;
CREATE INDEX idx_agent_sessions_parent ON agent_sessions(parent_session_id) WHERE parent_session_id IS NOT NULL;

-- 'done': a subtask posted its summary and was shelved
ALTER TABLE agent_sessions DROP CONSTRAINT agent_sessions_end_reason_check;
ALTER TABLE agent_sessions ADD CONSTRAINT agent_sessions_end_reason_check
    CHECK (end_reason IN ('user', 'budget', 'replaced', 'access_lost', 'done'));

-- 'delegate': a subtask's brief (to the child) or its summary (back to the parent)
ALTER TABLE agent_inbox DROP CONSTRAINT agent_inbox_reason_check;
ALTER TABLE agent_inbox ADD CONSTRAINT agent_inbox_reason_check
    CHECK (reason IN ('direct', 'handoff', 'protocol', 'command', 'lurk', 'delegate'));

-- 'pr_status': the host reads the session branch's pull request with `gh pr view`
ALTER TABLE agent_workspace_commands DROP CONSTRAINT agent_workspace_commands_action_check;
ALTER TABLE agent_workspace_commands ADD CONSTRAINT agent_workspace_commands_action_check
    CHECK (action IN ('diff','discard','commit','merge','pr','restore','fork','pr_status'));

-- ─── Task cards: one board per channel ───
CREATE TABLE task_cards (
    id            CHAR(26) PRIMARY KEY,
    server_id     CHAR(26) NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    channel_id    CHAR(26) NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    title         VARCHAR(200) NOT NULL CHECK (length(btrim(title)) > 0),
    -- Short enough that the kickoff notice fits a wake's 4000-character message limit
    description   TEXT NOT NULL DEFAULT '' CHECK (length(description) <= 3000),
    status        VARCHAR(12) NOT NULL DEFAULT 'todo' CHECK (status IN ('todo', 'in_progress', 'review', 'done')),
    -- The assignee agent
    profile_id    CHAR(26) REFERENCES agent_profiles(id) ON DELETE SET NULL,
    -- The worktree session the card started, and the thread it works in
    session_id    CHAR(26) REFERENCES agent_sessions(id) ON DELETE SET NULL,
    thread_id     CHAR(26) REFERENCES messages(id) ON DELETE SET NULL,
    -- Pull request state, from the session's workspace commands (pr, merge, pr_status)
    pr_url        VARCHAR(2048),
    pr_state      VARCHAR(8) CHECK (pr_state IN ('open', 'draft', 'merged', 'closed')),
    pr_checked_at TIMESTAMPTZ,
    merged_sha    VARCHAR(64),
    created_by    CHAR(26) REFERENCES users(id) ON DELETE SET NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_task_cards_channel ON task_cards(channel_id, id);
CREATE UNIQUE INDEX idx_task_cards_session ON task_cards(session_id) WHERE session_id IS NOT NULL;

-- Written and read only by the server as the table owner, after the route's own checks
ALTER TABLE task_cards ENABLE ROW LEVEL SECURITY;
