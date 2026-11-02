-- 'session_end': a terminal session its agent ended itself. agora-mcp's Claude Code SessionEnd
-- hook calls POST /bots/@me/terminal-sessions/end when the session exits or is cleared, so the
-- session ends now instead of after the disconnect grace period (docs/claude-code-hooks.md).
ALTER TABLE agent_sessions DROP CONSTRAINT agent_sessions_end_reason_check;
ALTER TABLE agent_sessions ADD CONSTRAINT agent_sessions_end_reason_check
    CHECK (end_reason IN ('user', 'budget', 'replaced', 'access_lost', 'done', 'disconnected', 'session_end'));
